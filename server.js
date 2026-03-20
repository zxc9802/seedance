import express from 'express'
import multer from 'multer'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createViteServer, loadEnv } from 'vite'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const isProduction = process.argv.includes('--production') || process.env.NODE_ENV === 'production'
const mode = isProduction ? 'production' : 'development'
const env = loadEnv(mode, __dirname, '')

for (const [key, value] of Object.entries(env)) {
  if (process.env[key] === undefined) {
    process.env[key] = value
  }
}

const port = Number(process.env.PORT || 5173)
const uploadDir = path.join(__dirname, '.temp_uploads')
const uploadTtlMinutes = Number(process.env.UPLOAD_TTL_MINUTES || 60)
const cleanupIntervalMinutes = Number(process.env.UPLOAD_CLEANUP_INTERVAL_MINUTES || 15)
const publicBaseUrl = stripTrailingSlash(process.env.PUBLIC_BASE_URL || '')
const videoApiBaseUrl = stripTrailingSlash(process.env.VIDEO_API_BASE_URL || 'http://8.137.157.96:9220')
const imageApiBaseUrl = stripTrailingSlash(process.env.IMAGE_API_BASE_URL || 'http://47.77.198.47:3001/v1')

fs.mkdirSync(uploadDir, { recursive: true })

const storage = multer.diskStorage({
  destination: (_, __, callback) => callback(null, uploadDir),
  filename: (_, file, callback) => {
    const extension = path.extname(file.originalname) || inferExtension(file.mimetype)
    callback(null, `${Date.now()}-${randomUUID()}${extension}`)
  },
})

const upload = multer({
  storage,
  limits: {
    fileSize: 64 * 1024 * 1024,
    files: 12,
  },
})

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '80mb' }))
app.use(express.urlencoded({ extended: true, limit: '80mb' }))
app.use('/temp-assets', express.static(uploadDir, {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', `public, max-age=${Math.max(60, uploadTtlMinutes * 60)}`)
  },
}))

app.get('/api/health', (_, res) => {
  res.json({
    success: true,
    mode,
    uploadTtlMinutes,
    publicBaseUrl: publicBaseUrl || null,
  })
})

app.post('/api/upload', upload.array('files', 12), (req, res) => {
  const files = Array.isArray(req.files) ? req.files : []
  if (files.length === 0) {
    res.status(400).json({ success: false, message: 'No files uploaded' })
    return
  }

  const baseUrl = resolveBaseUrl(req)
  const publiclyReachable = isLikelyPublicBaseUrl(baseUrl)
  const expiresAt = new Date(Date.now() + uploadTtlMinutes * 60 * 1000).toISOString()
  const payload = files.map((file) => ({
    name: file.originalname,
    size: file.size,
    mimeType: file.mimetype,
    url: `${baseUrl}/temp-assets/${encodeURIComponent(file.filename)}`,
    expiresAt,
  }))

  res.json({
    success: true,
    files: payload,
    publiclyReachable,
    message: publiclyReachable
      ? 'Upload succeeded.'
      : 'Upload succeeded. Set PUBLIC_BASE_URL to a public domain or tunnel before using these files as generation references.',
  })
})

app.post('/api/veo/generate', async (req, res) => {
  const missing = getMissingVideoConfig()
  if (missing.length > 0) {
    res.status(500).json({
      success: false,
      message: `Missing backend config: ${missing.join(', ')}`,
    })
    return
  }

  await proxyJson(req, res, `${videoApiBaseUrl}/openApi/generate`, {
    projectCode: process.env.VIDEO_PROJECT_CODE,
    'X-Access-Key': process.env.VIDEO_ACCESS_KEY,
    'X-Secret-Key': process.env.VIDEO_SECRET_KEY,
  })
})

app.post('/api/veo/queryResult', async (req, res) => {
  const missing = getMissingVideoConfig()
  if (missing.length > 0) {
    res.status(500).json({
      success: false,
      message: `Missing backend config: ${missing.join(', ')}`,
    })
    return
  }

  await proxyJson(req, res, `${videoApiBaseUrl}/openApi/queryResult`, {
    projectCode: process.env.VIDEO_PROJECT_CODE,
    'X-Access-Key': process.env.VIDEO_ACCESS_KEY,
    'X-Secret-Key': process.env.VIDEO_SECRET_KEY,
  })
})

app.post('/api/image/chat/completions', async (req, res) => {
  if (!process.env.IMAGE_API_KEY) {
    res.status(500).json({
      error: {
        message: 'Missing backend config: IMAGE_API_KEY',
        type: 'config_error',
      },
    })
    return
  }

  await proxyJson(req, res, `${imageApiBaseUrl}/chat/completions`, {
    Authorization: `Bearer ${process.env.IMAGE_API_KEY}`,
  })
})

const cleanupTimer = setInterval(() => {
  cleanupExpiredUploads().catch((error) => {
    console.error('[cleanup]', error)
  })
}, cleanupIntervalMinutes * 60 * 1000)
cleanupTimer.unref()
cleanupExpiredUploads().catch((error) => {
  console.error('[cleanup]', error)
})

const httpServer = createHttpServer(app)

if (!isProduction) {
  const vite = await createViteServer({
    root: __dirname,
    server: {
      middlewareMode: true,
      hmr: {
        server: httpServer,
      },
    },
    appType: 'spa',
  })

  app.use(vite.middlewares)
} else {
  const distDir = path.join(__dirname, 'dist')
  app.use(express.static(distDir))
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next()
      return
    }
    res.sendFile(path.join(distDir, 'index.html'))
  })
}

httpServer.listen(port, () => {
  console.log(`[server] ${mode} listening on http://localhost:${port}`)
})

async function proxyJson(req, res, url, extraHeaders = {}) {
  try {
    const response = await fetch(url, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
      body: JSON.stringify(req.body),
    })

    res.status(response.status)
    response.headers.forEach((value, key) => {
      const lowered = key.toLowerCase()
      if (
        lowered === 'content-length'
        || lowered === 'transfer-encoding'
        || lowered === 'connection'
        || lowered === 'content-encoding'
      ) {
        return
      }
      res.setHeader(key, value)
    })

    const buffer = Buffer.from(await response.arrayBuffer())
    res.end(buffer)
  } catch (error) {
    res.status(502).json({
      success: false,
      message: error.message || 'Upstream request failed',
    })
  }
}

function getMissingVideoConfig() {
  return [
    !process.env.VIDEO_PROJECT_CODE && 'VIDEO_PROJECT_CODE',
    !process.env.VIDEO_ACCESS_KEY && 'VIDEO_ACCESS_KEY',
    !process.env.VIDEO_SECRET_KEY && 'VIDEO_SECRET_KEY',
  ].filter(Boolean)
}

function resolveBaseUrl(req) {
  if (publicBaseUrl) return publicBaseUrl
  const forwardedProto = req.headers['x-forwarded-proto']
  const forwardedHost = req.headers['x-forwarded-host']
  const protocol = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto || req.protocol
  const host = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost || req.get('host')
  return `${protocol}://${host}`
}

async function cleanupExpiredUploads() {
  const entries = await fsp.readdir(uploadDir, { withFileTypes: true })
  const expiration = Date.now() - uploadTtlMinutes * 60 * 1000

  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile()) return
    const absolutePath = path.join(uploadDir, entry.name)
    const stat = await fsp.stat(absolutePath)
    if (stat.mtimeMs < expiration) {
      await fsp.unlink(absolutePath)
    }
  }))
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, '')
}

function inferExtension(mimeType = '') {
  const map = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
  }
  return map[mimeType] || ''
}

function isLikelyPublicBaseUrl(baseUrl) {
  try {
    const { hostname } = new URL(baseUrl)
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return false
    if (/^10\./.test(hostname)) return false
    if (/^192\.168\./.test(hostname)) return false
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)) return false
    return true
  } catch {
    return false
  }
}
