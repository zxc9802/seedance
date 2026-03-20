import express from 'express'
import multer from 'multer'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
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
const mainAppUrl = stripTrailingSlash(process.env.MAIN_APP_URL || 'https://www.qycm.top')
const mainAppVideoEntryPath = normalizeMainAppEntryPath(process.env.MAIN_APP_VIDEO_ENTRY_PATH || '/bot/video-workbench-seedance')
const requireMainAppSso = readBooleanEnv(process.env.REQUIRE_MAIN_APP_SSO, isProduction)
const videoSiteSessionCookieName = process.env.VIDEO_SITE_SESSION_COOKIE_NAME?.trim() || 'veo_studio_session'
const videoSiteSessionTtlMinutes = Math.max(5, Number(process.env.VIDEO_SITE_SESSION_TTL_MINUTES || 720))
const videoSiteSessionTtlMs = videoSiteSessionTtlMinutes * 60 * 1000
const videoSiteSessionSecret = resolveVideoSiteSessionSecret()

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
app.use((req, _, next) => {
  req.videoSiteSession = readVideoSiteSession(req)
  next()
})

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
    requireMainAppSso,
  })
})

app.get('/api/session', (req, res) => {
  const session = req.videoSiteSession
  if (!session) {
    res.status(401).json({
      success: false,
      message: 'Please launch VEO Studio from the main site first.',
      redirectUrl: buildMainAppVideoEntryUrl(mainAppUrl),
    })
    return
  }

  res.json({
    success: true,
    data: {
      user: session.user,
      mainAppUrl: session.mainAppUrl,
      expiresAt: new Date(session.expiresAt).toISOString(),
    },
  })
})

app.use(async (req, res, next) => {
  if (!requireMainAppSso) {
    next()
    return
  }

  if (shouldBypassSso(req)) {
    next()
    return
  }

  const session = req.videoSiteSession
  if (req.path.startsWith('/api/')) {
    if (session) {
      next()
      return
    }

    res.status(401).json({
      success: false,
      message: 'Please launch VEO Studio from the main site first.',
      redirectUrl: buildMainAppVideoEntryUrl(resolveRequestedMainAppUrl(req)),
    })
    return
  }

  if (!isHtmlDocumentRequest(req)) {
    next()
    return
  }

  if (session) {
    next()
    return
  }

  const ticket = readSingleQueryValue(req.query.ticket)
  const requestedMainAppUrl = resolveRequestedMainAppUrl(req)

  if (!ticket) {
    res.redirect(302, buildMainAppVideoEntryUrl(requestedMainAppUrl))
    return
  }

  try {
    const exchangeResult = await exchangeVideoSsoTicket(ticket, requestedMainAppUrl)
    writeVideoSiteSession(res, {
      token: exchangeResult.token,
      user: exchangeResult.user,
      mainAppUrl: requestedMainAppUrl,
    })
    res.redirect(302, normalizeStudioRedirectPath(exchangeResult.redirectPath))
  } catch (error) {
    console.error('[video-sso] Ticket exchange failed:', error)
    clearVideoSiteSession(res)
    res.redirect(302, buildMainAppVideoEntryUrl(requestedMainAppUrl))
  }
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

function normalizeMainAppEntryPath(value) {
  if (!value) return '/bot/video-workbench'
  const trimmed = value.trim()
  if (!trimmed.startsWith('/')) return '/bot/video-workbench'
  return trimmed
}

function readBooleanEnv(value, fallbackValue) {
  if (!value) return fallbackValue
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function resolveVideoSiteSessionSecret() {
  const candidates = [
    process.env.VIDEO_SITE_SESSION_SECRET,
    process.env.VIDEO_SSO_INTERNAL_SECRET,
    process.env.VIDEO_SECRET_KEY,
  ]

  for (const candidate of candidates) {
    const normalized = candidate?.trim()
    if (normalized) {
      return normalized
    }
  }

  if (!isProduction) {
    return 'veo-studio-dev-session-secret'
  }

  throw new Error('VIDEO_SITE_SESSION_SECRET is required in production when REQUIRE_MAIN_APP_SSO is enabled.')
}

function shouldBypassSso(req) {
  if (!requireMainAppSso) return true
  if (req.path === '/api/health') return true
  if (req.path.startsWith('/temp-assets/')) return true
  if (!isProduction && (
    req.path.startsWith('/@vite')
    || req.path.startsWith('/@react-refresh')
    || req.path.startsWith('/src/')
    || req.path.startsWith('/node_modules/')
  )) {
    return true
  }
  return false
}

function isHtmlDocumentRequest(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  if (req.path.startsWith('/api/')) return false
  if (req.path.startsWith('/temp-assets/')) return false
  if (path.extname(req.path)) return false
  if (!isProduction && (
    req.path.startsWith('/@vite')
    || req.path.startsWith('/@react-refresh')
    || req.path.startsWith('/src/')
    || req.path.startsWith('/node_modules/')
  )) {
    return false
  }

  const accept = req.get('accept') || ''
  return !accept || accept.includes('text/html') || accept.includes('*/*')
}

function parseCookieHeader(cookieHeader = '') {
  return cookieHeader
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce((cookies, item) => {
      const index = item.indexOf('=')
      if (index <= 0) return cookies
      const key = item.slice(0, index).trim()
      const value = item.slice(index + 1).trim()
      cookies[key] = decodeURIComponent(value)
      return cookies
    }, {})
}

function buildMainAppVideoEntryUrl(baseUrl) {
  return `${stripTrailingSlash(baseUrl || mainAppUrl)}${mainAppVideoEntryPath}`
}

function readSingleQueryValue(value) {
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0].trim() : ''
  return ''
}

function sanitizeMainAppUrl(value) {
  const candidate = value?.trim()
  if (!candidate) return null

  try {
    const requested = new URL(candidate)
    if (!['http:', 'https:'].includes(requested.protocol)) {
      return null
    }

    const configured = new URL(mainAppUrl)
    if (requested.origin === configured.origin) {
      return stripTrailingSlash(requested.origin)
    }

    if (!isProduction && isLocalHostname(requested.hostname)) {
      return stripTrailingSlash(requested.origin)
    }
  } catch {
    return null
  }

  return null
}

function resolveRequestedMainAppUrl(req) {
  return sanitizeMainAppUrl(readSingleQueryValue(req.query.mainApp)) || mainAppUrl
}

function isLocalHostname(hostname) {
  return ['localhost', '127.0.0.1', '0.0.0.0'].includes(hostname)
}

async function exchangeVideoSsoTicket(ticket, baseUrl) {
  const response = await fetch(`${stripTrailingSlash(baseUrl)}/api/video-sso/exchange`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ticket }),
  })

  const contentType = response.headers.get('content-type') || ''
  const payload = contentType.includes('application/json')
    ? await response.json()
    : await response.text()

  if (!response.ok) {
    const message = typeof payload === 'string'
      ? payload
      : payload?.message || payload?.error || 'SSO exchange failed.'
    throw new Error(message)
  }

  const data = payload?.data || payload
  if (!data?.token || !data?.user) {
    throw new Error('SSO exchange response is missing token or user.')
  }

  return {
    token: data.token,
    user: data.user,
    redirectPath: normalizeStudioRedirectPath(data.redirectPath),
  }
}

function normalizeStudioRedirectPath(value) {
  if (typeof value !== 'string') return '/'
  const trimmed = value.trim()
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return '/'
  return trimmed
}

function signSessionPayload(payload) {
  return createHmac('sha256', videoSiteSessionSecret).update(payload).digest('base64url')
}

function writeVideoSiteSession(res, session) {
  const expiresAt = Date.now() + videoSiteSessionTtlMs
  const payload = Buffer.from(JSON.stringify({
    token: session.token,
    user: session.user,
    mainAppUrl: session.mainAppUrl,
    expiresAt,
  }), 'utf8').toString('base64url')
  const signature = signSessionPayload(payload)
  const cookieValue = `${payload}.${signature}`

  appendSetCookie(res, serializeCookie(videoSiteSessionCookieName, cookieValue, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isProduction,
    path: '/',
    maxAge: Math.floor(videoSiteSessionTtlMs / 1000),
  }))
}

function readVideoSiteSession(req) {
  const cookies = parseCookieHeader(req.headers.cookie)
  const rawValue = cookies[videoSiteSessionCookieName]
  if (!rawValue) return null

  const [payload, signature] = rawValue.split('.', 2)
  if (!payload || !signature) return null

  const expected = signSessionPayload(payload)
  const providedBuffer = Buffer.from(signature, 'utf8')
  const expectedBuffer = Buffer.from(expected, 'utf8')
  if (providedBuffer.length !== expectedBuffer.length) return null
  if (!timingSafeEqual(providedBuffer, expectedBuffer)) return null

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!data?.user || !data?.token || typeof data.expiresAt !== 'number') return null
    if (data.expiresAt <= Date.now()) return null
    return data
  } catch {
    return null
  }
}

function clearVideoSiteSession(res) {
  appendSetCookie(res, serializeCookie(videoSiteSessionCookieName, '', {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isProduction,
    path: '/',
    maxAge: 0,
  }))
}

function appendSetCookie(res, cookie) {
  const current = res.getHeader('Set-Cookie')
  if (!current) {
    res.setHeader('Set-Cookie', cookie)
    return
  }

  if (Array.isArray(current)) {
    res.setHeader('Set-Cookie', [...current, cookie])
    return
  }

  res.setHeader('Set-Cookie', [current, cookie])
}

function serializeCookie(name, value, options) {
  const parts = [`${name}=${encodeURIComponent(value)}`]
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`)
  if (options.path) parts.push(`Path=${options.path}`)
  if (options.httpOnly) parts.push('HttpOnly')
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`)
  if (options.secure) parts.push('Secure')
  return parts.join('; ')
}
