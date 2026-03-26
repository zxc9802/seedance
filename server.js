import express from 'express'
import multer from 'multer'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createViteServer, loadEnv } from 'vite'
import { initDatabase, closePool } from './db/postgres.js'
import { insertUsageLog, updateUsageLogByTaskId } from './db/usage.js'
import adminRouter from './admin/api.js'

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
const materialApiBaseUrl = stripTrailingSlash(process.env.MATERIAL_API_BASE_URL || process.env.VIDEO_API_BASE_URL || 'http://8.137.157.96:9220')
const imageApiBaseUrl = stripTrailingSlash(process.env.IMAGE_API_BASE_URL || 'http://47.77.198.47:3001/v1')
const materialThirdChannel = Number(process.env.MATERIAL_THIRD_CHANNEL || 1)
const materialPollIntervalMs = Math.max(1000, Number(process.env.MATERIAL_POLL_INTERVAL_MS || 3000))
const materialPollTimeoutMs = Math.max(materialPollIntervalMs, Number(process.env.MATERIAL_POLL_TIMEOUT_MS || 180000))
const materialResourceTemplate = (process.env.MATERIAL_RESOURCE_TEMPLATE || '{materialId}').trim() || '{materialId}'
const mainAppUrl = stripTrailingSlash(process.env.MAIN_APP_URL || 'https://www.qycm.top')
const mainAppVideoEntryPath = normalizeMainAppEntryPath(process.env.MAIN_APP_VIDEO_ENTRY_PATH || '/bot/video-workbench-seedance')
const requireMainAppSso = readBooleanEnv(process.env.REQUIRE_MAIN_APP_SSO, isProduction)
const videoSiteSessionCookieName = process.env.VIDEO_SITE_SESSION_COOKIE_NAME?.trim() || 'veo_studio_session'
const videoSiteSessionTtlMinutes = Math.max(5, Number(process.env.VIDEO_SITE_SESSION_TTL_MINUTES || 720))
const videoSiteSessionTtlMs = videoSiteSessionTtlMinutes * 60 * 1000
const videoSiteSessionSecret = resolveVideoSiteSessionSecret()
const UPSTREAM_REQUEST_ID_HEADERS = ['x-oneapi-request-id', 'x-request-id', 'request-id']
const UPSTREAM_TRACE_ID_HEADERS = ['trace-id', 'x-trace-id', 'cf-ray']

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

app.post('/api/upload', upload.array('files', 12), async (req, res) => {
  const files = Array.isArray(req.files) ? req.files : []
  if (files.length === 0) {
    res.status(400).json({ success: false, message: 'No files uploaded' })
    return
  }

  try {
    const baseUrl = resolveBaseUrl(req)
    const publiclyReachable = isLikelyPublicBaseUrl(baseUrl)
    const expiresAt = new Date(Date.now() + uploadTtlMinutes * 60 * 1000).toISOString()
    const materialType = parseMaterialType(req.body?.materialType)
    const payload = []

    if (materialType !== null) {
      const missing = getMissingMaterialConfig()
      if (missing.length > 0) {
        res.status(500).json({
          success: false,
          message: `Missing backend config: ${missing.join(', ')}`,
        })
        return
      }
    }

    for (const file of files) {
      const url = `${baseUrl}/temp-assets/${encodeURIComponent(file.filename)}`
      const item = {
        name: file.originalname,
        size: file.size,
        mimeType: file.mimetype,
        url,
        resourceRef: url,
        expiresAt,
      }

      if (materialType !== null && publiclyReachable && file.mimetype.startsWith('image/')) {
        const material = await createMaterialReference({
          name: buildMaterialName(file.originalname),
          originalUrl: url,
          type: materialType,
        })
        item.materialId = material.materialId
        item.materialStatus = material.status
        item.resourceRef = material.resourceRef
      }

      payload.push(item)
    }

    res.json({
      success: true,
      files: payload,
      publiclyReachable,
      message: publiclyReachable
        ? 'Upload succeeded.'
        : 'Upload succeeded. Set PUBLIC_BASE_URL to a public domain or tunnel before using these files as generation references.',
    })
  } catch (error) {
    const statusCode = Number(error.statusCode) || 502
    res.status(statusCode).json({
      success: false,
      message: error.message || 'Upload failed',
    })
  }
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

  const body = req.body || {}
  await proxyJson(req, res, `${videoApiBaseUrl}/openApi/generate`, {
    projectCode: process.env.VIDEO_PROJECT_CODE,
    'X-Access-Key': process.env.VIDEO_ACCESS_KEY,
    'X-Secret-Key': process.env.VIDEO_SECRET_KEY,
  }, ({ payload, traceMetadata, status, url }) => {
    if (status >= 400) return
    const taskId = payload?.result?.taskId
      || payload?.data?.result?.taskId
      || payload?.data?.taskId
      || payload?.taskId
      || payload?.data?.id
    insertUsageLog({
      session: req.videoSiteSession,
      channel: 'aggregation',
      providerId: body.providerId || null,
      model: body.modelId || body.model || null,
      generationMode: body.mode || 't2v',
      prompt: body.prompt || null,
      aspectRatio: body.params?.aspectRatio || body.aspectRatio || null,
      resolution: body.params?.resolution || null,
      duration: body.params?.duration || null,
      sampleCount: body.sampleCount || 1,
      requestParams: body,
      engineTaskId: taskId || null,
      upstreamRequestId: traceMetadata?.requestId || null,
      upstreamTraceId: traceMetadata?.traceId || null,
      upstreamUrl: url,
    }).catch(() => {})
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
  }, ({ payload, traceMetadata }) => {
    const data = payload?.data || payload
    const taskId = req.body?.taskId || data?.taskId
    const rawStatus = data?.status ?? data?.state
    if (!taskId || rawStatus === undefined) return
    const isFinal = rawStatus === 2 || rawStatus === 3 || rawStatus === 'succeeded' || rawStatus === 'failed'
    if (!isFinal) return
    const succeeded = rawStatus === 2 || rawStatus === 'succeeded'
    updateUsageLogByTaskId(taskId, {
      status: succeeded ? 'succeeded' : 'failed',
      videoUrl: data?.videoUrl || data?.video_url || data?.resultUrl || null,
      errorMessage: succeeded ? null : (data?.message || data?.errorMessage || null),
      completedAt: new Date().toISOString(),
      upstreamRequestId: traceMetadata?.requestId || null,
      upstreamTraceId: traceMetadata?.traceId || null,
    }).catch(() => {})
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

  const body = req.body || {}
  await proxyJson(req, res, `${imageApiBaseUrl}/chat/completions`, {
    Authorization: `Bearer ${process.env.IMAGE_API_KEY}`,
  }, ({ payload, traceMetadata, status, url }) => {
    const succeeded = status < 400
    insertUsageLog({
      session: req.videoSiteSession,
      channel: 'image',
      providerId: body.providerId || 'gemini-image',
      model: body.model || null,
      generationMode: 'image',
      prompt: extractImagePromptText(body) || null,
      requestParams: {
        model: body.model,
        mediaCounts: extractImageMediaCounts(body),
      },
      upstreamRequestId: traceMetadata?.requestId || null,
      upstreamTraceId: traceMetadata?.traceId || null,
      upstreamUrl: url,
      status: succeeded ? 'succeeded' : 'failed',
      errorMessage: succeeded ? null : (payload?.error?.message || null),
    }).catch(() => {})
  })
})

const veoFastGenerateUrl = stripTrailingSlash(process.env.VEO_FAST_GENERATE_URL || 'http://pay.verveship.com')
const veoFastQueryUrl = stripTrailingSlash(process.env.VEO_FAST_QUERY_URL || 'http://pay.verveship.com')
const veoFastPromptMode = process.env.VEO_FAST_PROMPT_MODE
  || (veoFastGenerateUrl.includes('pay.verveship.com') ? 'instance' : 'top_level')

function summarizeBase64Field(value) {
  if (typeof value !== 'string') {
    return null
  }

  return {
    length: value.length,
    prefix: value.slice(0, 32),
    hasDataUrlPrefix: /^data:/i.test(value),
    containsBase64Marker: value.includes(';base64,'),
  }
}

function extractImagePromptText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const content = messages[messages.length - 1]?.content

  if (typeof content === 'string') {
    return content.trim()
  }

  if (!Array.isArray(content)) {
    return ''
  }

  return content
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join('\n')
}

function extractImageMediaCounts(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const content = messages[messages.length - 1]?.content
  if (!Array.isArray(content)) {
    return { images: 0, videos: 0, audios: 0 }
  }

  const imageCount = content.filter((item) => (
    item?.type === 'image_base64' || item?.type === 'image_url'
  )).length

  return { images: imageCount, videos: 0, audios: 0 }
}

function extractVeoFastReferenceCounts(normalizedBody) {
  const firstInstance = Array.isArray(normalizedBody?.instances) ? normalizedBody.instances[0] : null
  if (!firstInstance) {
    return { images: 0, videos: 0, audios: 0 }
  }

  const imageCount = [
    firstInstance.image,
    firstInstance.lastFrame,
    ...(Array.isArray(firstInstance.referenceImages) ? normalizedBody.instances[0].referenceImages.map((item) => item?.image) : []),
  ].filter(Boolean).length

  return { images: imageCount, videos: 0, audios: 0 }
}

function summarizeVeoFastResponse(contentType, buffer) {
  if (!buffer?.length) {
    return { empty: true }
  }

  const normalizedType = (contentType || '').toLowerCase()
  if (
    normalizedType.includes('application/json')
    || normalizedType.startsWith('text/')
  ) {
    const text = buffer.toString('utf8')
    try {
      return JSON.parse(text)
    } catch {
      return text.slice(0, 800)
    }
  }

  return {
    binary: true,
    size: buffer.length,
    contentType: contentType || 'unknown',
  }
}

function logVeoFastUpstream(route, taskId, response, buffer) {
  const contentType = response.headers.get('content-type') || ''
  console.log(
    `[veo-fast] ${route} ${taskId} -> ${response.status} ${contentType || 'unknown'}`,
    JSON.stringify(summarizeVeoFastResponse(contentType, buffer), null, 2),
  )
}

app.post('/api/veo-fast/generate', async (req, res) => {
  const apiKey = process.env.VEO_FAST_API_KEY?.trim()
  if (!apiKey) {
    res.status(500).json({
      success: false,
      message: 'Missing backend config: VEO_FAST_API_KEY',
    })
    return
  }

  const normalizedBody = normalizeVeoFastRequest(req.body, veoFastPromptMode)
  const debugBody = {
    model: normalizedBody?.model,
    hasInstances: Array.isArray(normalizedBody?.instances),
    instanceKeys: normalizedBody?.instances?.[0] ? Object.keys(normalizedBody.instances[0]) : [],
    topLevelPrompt: normalizedBody?.prompt ?? null,
    instancePrompt: normalizedBody?.instances?.[0]?.prompt ?? null,
    promptMode: veoFastPromptMode,
    parameters: normalizedBody?.parameters,
    bodySize: JSON.stringify(normalizedBody).length,
    imageBase64: summarizeBase64Field(
      normalizedBody?.instances?.[0]?.image?.bytesBase64Encoded,
    ),
    lastFrameBase64: summarizeBase64Field(
      normalizedBody?.instances?.[0]?.lastFrame?.bytesBase64Encoded,
    ),
    referenceImageBase64: Array.isArray(normalizedBody?.instances?.[0]?.referenceImages)
      ? normalizedBody.instances[0].referenceImages.slice(0, 3).map((item) => summarizeBase64Field(
        item?.image?.bytesBase64Encoded,
      ))
      : [],
  }
  console.log('[veo-fast] request debug:', JSON.stringify(debugBody, null, 2))

  const body = req.body || {}
  await proxyJsonWithBody(req, res, `${veoFastGenerateUrl}/v1/video/generations`, normalizedBody, {
    Authorization: `Bearer ${apiKey}`,
  }, ({ payload, traceMetadata, status, url }) => {
    if (status >= 400) return
    const taskId = payload?.task_id
      || payload?.data?.task_id
      || payload?.taskId
      || payload?.data?.taskId
      || payload?.name
      || payload?.id
    insertUsageLog({
      session: req.videoSiteSession,
      channel: 'veo_fast',
      providerId: body.providerId || 'veo31fast',
      model: normalizedBody?.model || body.model || null,
      generationMode: body.mode || 't2v',
      prompt: normalizedBody?.instances?.[0]?.prompt || normalizedBody?.prompt || body.prompt || null,
      aspectRatio: body.params?.aspectRatio || null,
      resolution: body.params?.resolution || null,
      duration: body.params?.duration || null,
      requestParams: {
        model: normalizedBody?.model,
        parameters: normalizedBody?.parameters,
        referenceCounts: extractVeoFastReferenceCounts(normalizedBody),
      },
      engineTaskId: taskId || null,
      upstreamRequestId: traceMetadata?.requestId || null,
      upstreamTraceId: traceMetadata?.traceId || null,
      upstreamUrl: url,
    }).catch(() => {})
  })
})

app.get('/api/veo-fast/status/:taskId', async (req, res) => {
  const apiKey = process.env.VEO_FAST_API_KEY?.trim()
  if (!apiKey) {
    res.status(500).json({
      success: false,
      message: 'Missing backend config: VEO_FAST_API_KEY',
    })
    return
  }

  try {
    const response = await fetch(`${veoFastQueryUrl}/v1/videos/${encodeURIComponent(req.params.taskId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    })

    const traceMetadata = extractUpstreamTraceMetadata(response)
    res.status(response.status)
    copyUpstreamResponseHeaders(res, response.headers)
    applyUpstreamTraceHeaders(res, traceMetadata)

    const buffer = Buffer.from(await response.arrayBuffer())
    logVeoFastUpstream('status', req.params.taskId, response, buffer)

    try {
      const contentType = response.headers.get('content-type') || ''
      if (contentType.includes('application/json')) {
        const parsed = JSON.parse(buffer.toString('utf8'))
        const state = parsed?.state || parsed?.status
        const normalizedState = typeof state === 'string' ? state.toLowerCase() : ''
        const directVideoUrl = parsed?.video_url || parsed?.videoUrl || null
        const succeeded = (
          normalizedState === 'succeeded'
          || normalizedState === 'completed'
          || ((parsed?.success === true) && Boolean(directVideoUrl))
        )
        const failed = normalizedState === 'failed'

        if (succeeded || failed) {
          updateUsageLogByTaskId(req.params.taskId, {
            status: succeeded ? 'succeeded' : 'failed',
            videoUrl: directVideoUrl,
            errorMessage: failed ? (parsed?.error?.message || parsed?.message || null) : null,
            completedAt: new Date().toISOString(),
            upstreamRequestId: traceMetadata?.requestId || null,
            upstreamTraceId: traceMetadata?.traceId || null,
          }).catch(() => {})
        }
      }
    } catch (_) {}

    res.end(buffer)
  } catch (error) {
    res.status(502).json({
      success: false,
      message: error.message || 'Upstream request failed',
    })
  }
})

app.get('/api/veo-fast/content/:taskId', async (req, res) => {
  const apiKey = process.env.VEO_FAST_API_KEY?.trim()
  if (!apiKey) {
    res.status(500).json({
      success: false,
      message: 'Missing backend config: VEO_FAST_API_KEY',
    })
    return
  }

  try {
    const response = await fetch(`${veoFastQueryUrl}/v1/videos/${encodeURIComponent(req.params.taskId)}/content`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    })

    res.status(response.status)
    copyUpstreamResponseHeaders(res, response.headers)
    applyUpstreamTraceHeaders(res, extractUpstreamTraceMetadata(response))

    const buffer = Buffer.from(await response.arrayBuffer())
    logVeoFastUpstream('content', req.params.taskId, response, buffer)
    res.end(buffer)
  } catch (error) {
    res.status(502).json({
      success: false,
      message: error.message || 'Upstream request failed',
    })
  }
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

app.use('/api/admin', adminRouter)
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'))
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

httpServer.listen(port, async () => {
  console.log(`[server] ${mode} listening on http://localhost:${port}`)
  await initDatabase()
})

async function proxyJson(req, res, url, extraHeaders = {}, onResponse = null) {
  return proxyJsonWithBody(req, res, url, req.body, extraHeaders, onResponse)
}

async function proxyJsonWithBody(req, res, url, body, extraHeaders = {}, onResponse = null) {
  try {
    const response = await fetch(url, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    })

    const buffer = Buffer.from(await response.arrayBuffer())
    const contentType = response.headers.get('content-type') || ''
    const parsedPayload = tryParseJsonBuffer(buffer, contentType)
    const traceMetadata = extractUpstreamTraceMetadata(response, parsedPayload)
    const tracedPayload = injectUpstreamTraceMetadata(parsedPayload, traceMetadata)

    if (onResponse) {
      try { onResponse({ payload: parsedPayload, traceMetadata, status: response.status, url }) } catch (_) {}
    }

    res.status(response.status)
    copyUpstreamResponseHeaders(res, response.headers)
    applyUpstreamTraceHeaders(res, traceMetadata)

    if (tracedPayload !== null) {
      res.type('application/json')
      res.end(JSON.stringify(tracedPayload))
      return
    }

    res.end(buffer)
  } catch (error) {
    res.status(502).json({
      success: false,
      message: error.message || 'Upstream request failed',
    })
  }
}

function copyUpstreamResponseHeaders(res, headers) {
  headers.forEach((value, key) => {
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
}

function applyUpstreamTraceHeaders(res, metadata) {
  if (metadata?.requestId && !res.getHeader('x-upstream-request-id')) {
    res.setHeader('x-upstream-request-id', metadata.requestId)
  }

  if (metadata?.traceId && !res.getHeader('x-upstream-trace-id')) {
    res.setHeader('x-upstream-trace-id', metadata.traceId)
  }
}

function tryParseJsonBuffer(buffer, contentType = '') {
  if (!isJsonContentType(contentType)) {
    return null
  }

  try {
    return JSON.parse(buffer.toString('utf8'))
  } catch {
    return null
  }
}

function isJsonContentType(contentType = '') {
  const normalized = contentType.toLowerCase()
  return normalized.includes('application/json') || normalized.includes('+json')
}

function injectUpstreamTraceMetadata(payload, metadata) {
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') {
    return payload
  }

  const nextPayload = { ...payload }

  if (metadata?.requestId && !readFirstString(nextPayload.requestId, nextPayload.request_id, nextPayload.RequestId)) {
    nextPayload.requestId = metadata.requestId
  }

  if (metadata?.traceId && !readFirstString(nextPayload.traceId, nextPayload.trace_id, nextPayload.TraceId)) {
    nextPayload.traceId = metadata.traceId
  }

  if (nextPayload.data && !Array.isArray(nextPayload.data) && typeof nextPayload.data === 'object') {
    nextPayload.data = { ...nextPayload.data }

    if (metadata?.requestId && !readFirstString(
      nextPayload.data.requestId,
      nextPayload.data.request_id,
      nextPayload.data.RequestId,
    )) {
      nextPayload.data.requestId = metadata.requestId
    }

    if (metadata?.traceId && !readFirstString(
      nextPayload.data.traceId,
      nextPayload.data.trace_id,
      nextPayload.data.TraceId,
    )) {
      nextPayload.data.traceId = metadata.traceId
    }
  }

  return nextPayload
}

function extractUpstreamTraceMetadata(responseOrHeaders, payload = null) {
  const headers = responseOrHeaders?.headers || responseOrHeaders
  const payloadTrace = extractTraceMetadataFromPayload(payload)
  const requestId = payloadTrace.requestId || readHeaderValue(headers, UPSTREAM_REQUEST_ID_HEADERS)
  const traceId = payloadTrace.traceId || readHeaderValue(headers, UPSTREAM_TRACE_ID_HEADERS)
  return { requestId, traceId }
}

function extractTraceMetadataFromPayload(payload) {
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') {
    return { requestId: null, traceId: null }
  }

  const requestId = readFirstString(
    payload.requestId,
    payload.request_id,
    payload.RequestId,
    payload.data?.requestId,
    payload.data?.request_id,
    payload.data?.RequestId,
    payload.error?.requestId,
    payload.error?.request_id,
    payload.error?.RequestId,
  )

  const traceId = readFirstString(
    payload.traceId,
    payload.trace_id,
    payload.TraceId,
    payload.data?.traceId,
    payload.data?.trace_id,
    payload.data?.TraceId,
    payload.error?.traceId,
    payload.error?.trace_id,
    payload.error?.TraceId,
  )

  return { requestId, traceId }
}

function readHeaderValue(headers, headerNames) {
  if (!headers) return null

  for (const headerName of headerNames) {
    const value = headers.get?.(headerName)
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }

  return null
}

function readFirstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }

  return null
}

function normalizeVeoFastRequest(body, promptMode) {
  const normalized = JSON.parse(JSON.stringify(body || {}))
  const firstInstance = Array.isArray(normalized.instances) ? normalized.instances[0] : null
  if (!firstInstance) return normalized

  if (promptMode === 'instance') {
    if (!firstInstance.prompt && normalized.prompt) {
      firstInstance.prompt = normalized.prompt
    }
    delete normalized.prompt
    return normalized
  }

  if (promptMode === 'top_level') {
    if (!normalized.prompt && firstInstance.prompt) {
      normalized.prompt = firstInstance.prompt
    }
    return normalized
  }

  if (promptMode === 'both') {
    if (!normalized.prompt && firstInstance.prompt) {
      normalized.prompt = firstInstance.prompt
    }
    if (!firstInstance.prompt && normalized.prompt) {
      firstInstance.prompt = normalized.prompt
    }
  }

  return normalized
}

async function createMaterialReference({ name, originalUrl, type }) {
  const createPayload = await requestJson(materialApiBaseUrl, '/openApi/material/create', buildMaterialHeaders(), {
    name,
    originalUrl,
    type,
    fileType: 1,
    thirdChannel: materialThirdChannel,
  })

  if (!createPayload?.success) {
    throw createHttpError(400, createPayload?.msg || createPayload?.message || 'Material creation failed.')
  }

  const materialId = createPayload?.data?.materialId
  if (!materialId) {
    throw createHttpError(502, 'Material creation succeeded but no materialId was returned.')
  }

  let currentStatus = Number(createPayload?.data?.status || 1)
  let lastError = createPayload?.data?.errorMsg || ''
  const deadline = Date.now() + materialPollTimeoutMs

  while (currentStatus === 1 && Date.now() < deadline) {
    await sleep(materialPollIntervalMs)
    const listPayload = await requestJson(materialApiBaseUrl, '/openApi/material/pageList', buildMaterialHeaders(), {
      materialId,
      pageNo: 1,
      pageSize: 10,
    })

    if (!listPayload?.success) {
      throw createHttpError(502, listPayload?.msg || listPayload?.message || 'Material status query failed.')
    }

    const records = Array.isArray(listPayload?.data?.records) ? listPayload.data.records : []
    const record = records.find((item) => item?.materialId === materialId) || records[0]
    if (!record) {
      continue
    }

    currentStatus = Number(record.status || currentStatus)
    lastError = record.errorMsg || lastError
  }

  if (currentStatus !== 2) {
    if (currentStatus === 3) {
      throw createHttpError(400, lastError || 'Material review failed.')
    }
    throw createHttpError(504, 'Material review timed out. Please retry later.')
  }

  return {
    materialId,
    status: currentStatus,
    resourceRef: formatMaterialResource(materialId),
  }
}

function buildMaterialHeaders() {
  return {
    projectCode: process.env.MATERIAL_PROJECT_CODE || process.env.VIDEO_PROJECT_CODE,
    'X-Access-Key': process.env.MATERIAL_ACCESS_KEY || process.env.VIDEO_ACCESS_KEY,
    'X-Secret-Key': process.env.MATERIAL_SECRET_KEY || process.env.VIDEO_SECRET_KEY,
  }
}

async function requestJson(baseUrl, endpoint, headers, body) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  })

  const contentType = response.headers.get('content-type') || ''
  const payload = contentType.includes('application/json')
    ? await response.json()
    : await response.text()

  if (!response.ok) {
    const message = typeof payload === 'string'
      ? payload
      : payload?.msg || payload?.message || payload?.error?.message || JSON.stringify(payload)
    throw createHttpError(response.status, message || 'Upstream request failed.')
  }

  return payload
}

function createHttpError(statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function getMissingVideoConfig() {
  return [
    !process.env.VIDEO_PROJECT_CODE && 'VIDEO_PROJECT_CODE',
    !process.env.VIDEO_ACCESS_KEY && 'VIDEO_ACCESS_KEY',
    !process.env.VIDEO_SECRET_KEY && 'VIDEO_SECRET_KEY',
  ].filter(Boolean)
}

function getMissingMaterialConfig() {
  return [
    !(process.env.MATERIAL_PROJECT_CODE || process.env.VIDEO_PROJECT_CODE) && 'MATERIAL_PROJECT_CODE|VIDEO_PROJECT_CODE',
    !(process.env.MATERIAL_ACCESS_KEY || process.env.VIDEO_ACCESS_KEY) && 'MATERIAL_ACCESS_KEY|VIDEO_ACCESS_KEY',
    !(process.env.MATERIAL_SECRET_KEY || process.env.VIDEO_SECRET_KEY) && 'MATERIAL_SECRET_KEY|VIDEO_SECRET_KEY',
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

function parseMaterialType(value) {
  const normalized = String(value || '').trim().toLowerCase()
  switch (normalized) {
    case '':
    case 'direct':
      return null
    case '1':
    case 'role':
      return 1
    case '2':
    case 'object':
      return 2
    case '3':
    case 'scene':
      return 3
    default:
      throw createHttpError(400, `Unsupported materialType: ${value}`)
  }
}

function buildMaterialName(originalName) {
  const parsed = path.parse(originalName || '')
  const baseName = (parsed.name || 'reference-image').trim()
  return baseName.slice(0, 80)
}

function formatMaterialResource(materialId) {
  if (!materialId) return materialId
  if (!materialResourceTemplate.includes('{materialId}')) {
    return materialId
  }
  // Default to the raw materialId. Override MATERIAL_RESOURCE_TEMPLATE if the provider expects a URI wrapper.
  return materialResourceTemplate.replaceAll('{materialId}', materialId)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
