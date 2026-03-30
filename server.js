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
const dashScopeBaseUrl = stripTrailingSlash(process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com')
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
const adminUserIdAllowlist = parseIdentityAllowlist(process.env.ADMIN_USER_IDS)
const adminUserAccountAllowlist = parseIdentityAllowlist(process.env.ADMIN_USER_ACCOUNTS)
const adminUserEmailAllowlist = parseIdentityAllowlist(process.env.ADMIN_USER_EMAILS)
const adminUserNameAllowlist = parseIdentityAllowlist(process.env.ADMIN_USER_NAMES)
const hasExplicitAdminAllowlist = [
  adminUserIdAllowlist,
  adminUserAccountAllowlist,
  adminUserEmailAllowlist,
  adminUserNameAllowlist,
].some((set) => set.size > 0)
const UPSTREAM_REQUEST_ID_HEADERS = ['x-oneapi-request-id', 'x-request-id', 'request-id']
const UPSTREAM_TRACE_ID_HEADERS = ['trace-id', 'x-trace-id', 'cf-ray']
const uploadedReferenceMetadata = new Map()

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
  res.setHeader('Cache-Control', 'no-store')

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
      isAdmin: isAdminUser(session.user),
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

  const ticket = readSingleQueryValue(req.query.ticket)
  const requestedMainAppUrl = resolveRequestedMainAppUrl(req)

  if (!ticket && session) {
    next()
    return
  }

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
    const expiresAtMs = Date.now() + uploadTtlMinutes * 60 * 1000
    const expiresAt = new Date(expiresAtMs).toISOString()
    const materialType = parseMaterialType(req.body?.materialType)
    const storageBackend = parseUploadStorageBackend(req.body?.storageBackend)
    const dashscopeModel = normalizeDashScopeUploadModel(req.body?.dashscopeModel)
    const payload = []

    if (storageBackend === 'dashscope') {
      const missing = getMissingDashScopeConfig()
      if (missing.length > 0) {
        res.status(500).json({
          success: false,
          message: `Missing backend config: ${missing.join(', ')}`,
        })
        return
      }
      if (!dashscopeModel) {
        res.status(400).json({
          success: false,
          message: 'dashscopeModel is required when storageBackend=dashscope.',
        })
        return
      }
    }

    if (materialType !== null && storageBackend !== 'dashscope') {
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

      if (storageBackend === 'dashscope') {
        const uploaded = await createDashScopeTemporaryReference({
          file,
          model: dashscopeModel,
        })
        item.url = uploaded.resourceRef
        item.resourceRef = uploaded.resourceRef
        item.expiresAt = uploaded.expiresAt
        item.storageBackend = 'dashscope'
        registerUploadedReference(item.resourceRef, file.size, uploaded.expiresAtMs)
      } else if (materialType !== null && publiclyReachable && file.mimetype.startsWith('image/')) {
        const material = await createMaterialReference({
          name: buildMaterialName(file.originalname),
          originalUrl: url,
          type: materialType,
        })
        item.materialId = material.materialId
        item.materialStatus = material.status
        item.resourceRef = material.resourceRef
        registerUploadedReference(item.url, file.size, expiresAtMs)
        registerUploadedReference(item.resourceRef, file.size, expiresAtMs)
      } else {
        registerUploadedReference(item.url, file.size, expiresAtMs)
        registerUploadedReference(item.resourceRef, file.size, expiresAtMs)
      }

      payload.push(item)
    }

    res.json({
      success: true,
      files: payload,
      publiclyReachable: storageBackend === 'dashscope' ? true : publiclyReachable,
      message: storageBackend === 'dashscope'
        ? 'Upload succeeded.'
        : publiclyReachable
        ? 'Upload succeeded.'
        : 'Upload succeeded. Set PUBLIC_BASE_URL to a public domain or tunnel before using these files as generation references.',
    })
  } catch (error) {
    const statusCode = Number(error.statusCode) || 502
    console.error('[upload] Request failed:', {
      statusCode,
      message: error?.message || null,
      stack: error?.stack || null,
      fileCount: files.length,
      files: files.map((file) => ({
        name: file.originalname,
        size: file.size,
        mimeType: file.mimetype,
        storedAs: file.filename,
      })),
      materialType: req.body?.materialType || null,
      baseUrl: resolveBaseUrl(req),
    })
    res.status(statusCode).json({
      success: false,
      message: error.message || 'Upload failed',
    })
  }
})

app.post('/api/veo/generate', async (req, res) => {
  console.log('[monitor-debug] /api/veo/generate hit:', {
    hasSession: Boolean(req.videoSiteSession?.user),
    userKeys: req.videoSiteSession?.user ? Object.keys(req.videoSiteSession.user) : [],
    modelId: req.body?.modelId || req.body?.model || null,
    mode: req.body?.mode || req.body?.params?.mode || null,
  })
  const missing = getMissingVideoConfig()
  if (missing.length > 0) {
    res.status(500).json({
      success: false,
      message: `Missing backend config: ${missing.join(', ')}`,
    })
    return
  }

  const body = req.body || {}
  const mediaSummary = resolveUsageMediaSummary(body, parseUsageMediaSummaryHeader(req))
  await proxyJson(req, res, `${videoApiBaseUrl}/openApi/generate`, {
    projectCode: process.env.VIDEO_PROJECT_CODE,
    'X-Access-Key': process.env.VIDEO_ACCESS_KEY,
    'X-Secret-Key': process.env.VIDEO_SECRET_KEY,
  }, ({ payload, traceMetadata, status, url }) => {
    try {
      const taskId = extractAggregationTaskId(payload)
      console.log('[monitor-debug] /api/veo/generate upstream:', {
        status,
        taskId: taskId || null,
        requestId: traceMetadata?.requestId || null,
        traceId: traceMetadata?.traceId || null,
        payloadKeys: payload && typeof payload === 'object' && !Array.isArray(payload) ? Object.keys(payload) : [],
        payloadDataKeys: payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data) ? Object.keys(payload.data) : [],
      })
      if (status >= 400) return
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
        requestParams: attachUsageMediaSummary(body, mediaSummary),
        engineTaskId: taskId || null,
        upstreamRequestId: traceMetadata?.requestId || null,
        upstreamTraceId: traceMetadata?.traceId || null,
        upstreamUrl: url,
      }).catch((error) => {
        console.error('[monitor-debug] insertUsageLog promise rejected:', error)
      })
    } catch (error) {
      console.error('[monitor-debug] /api/veo/generate monitor callback failed:', error)
    }
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
    try {
      const taskId = extractAggregationTaskId(payload) || normalizeTaskIdValue(req.body?.taskId)
      const queryFailedMessage = payload?.success === false
        ? (extractAggregationMessage(payload) || '查询任务状态失败')
        : null
      const finalStatus = normalizeAggregationFinalStatus(extractAggregationStatus(payload))
      const finalMessage = finalStatus && finalStatus !== 'succeeded'
        ? extractAggregationMessage(payload)
        : null
      console.log('[monitor-debug] /api/veo/queryResult upstream:', {
        taskId: taskId || null,
        finalStatus: finalStatus || null,
        requestId: traceMetadata?.requestId || null,
        traceId: traceMetadata?.traceId || null,
      })
      if (taskId && queryFailedMessage) {
        updateUsageLogByTaskId(taskId, {
          status: 'failed',
          videoUrl: null,
          errorMessage: queryFailedMessage,
          completedAt: new Date().toISOString(),
          upstreamRequestId: traceMetadata?.requestId || null,
          upstreamTraceId: traceMetadata?.traceId || null,
        }).catch((error) => {
          console.error('[monitor-debug] updateUsageLogByTaskId promise rejected:', error)
        })
        return
      }
      if (!taskId || !finalStatus) return
      updateUsageLogByTaskId(taskId, {
        status: finalStatus,
        videoUrl: finalStatus === 'succeeded' ? extractAggregationVideoUrl(payload) : null,
        errorMessage: finalMessage,
        completedAt: new Date().toISOString(),
        upstreamRequestId: traceMetadata?.requestId || null,
        upstreamTraceId: traceMetadata?.traceId || null,
      }).catch((error) => {
        console.error('[monitor-debug] updateUsageLogByTaskId promise rejected:', error)
      })
    } catch (error) {
      console.error('[monitor-debug] /api/veo/queryResult monitor callback failed:', error)
    }
  })
})

app.post('/api/image/chat/completions', async (req, res) => {
  console.log('[monitor-debug] /api/image/chat/completions hit:', {
    hasSession: Boolean(req.videoSiteSession?.user),
    userKeys: req.videoSiteSession?.user ? Object.keys(req.videoSiteSession.user) : [],
    model: req.body?.model || null,
  })
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
  const mediaSummary = parseUsageMediaSummaryHeader(req)
  await proxyJson(req, res, `${imageApiBaseUrl}/chat/completions`, {
    Authorization: `Bearer ${process.env.IMAGE_API_KEY}`,
  }, ({ payload, traceMetadata, status, url }) => {
    const imageResult = status < 400 ? extractImageResponseResult(payload) : null
    const succeeded = Boolean(imageResult)
    insertUsageLog({
      session: req.videoSiteSession,
      channel: 'image',
      providerId: body.providerId || 'gemini-image',
      model: body.model || null,
      generationMode: 'image',
      prompt: extractImagePromptText(body) || null,
      requestParams: attachUsageMediaSummary({
        model: body.model,
        mediaCounts: extractImageMediaCounts(body),
      }, mediaSummary),
      upstreamRequestId: traceMetadata?.requestId || null,
      upstreamTraceId: traceMetadata?.traceId || null,
      upstreamUrl: url,
      status: succeeded ? 'succeeded' : 'failed',
      errorMessage: succeeded
        ? null
        : (payload?.error?.message || buildImageResponseParseError(payload)),
    }).catch(() => {})
  })
})

app.post('/api/wan/generate', async (req, res) => {
  const missing = getMissingDashScopeConfig()
  if (missing.length > 0) {
    res.status(500).json({
      success: false,
      message: `Missing backend config: ${missing.join(', ')}`,
    })
    return
  }

  try {
    const body = req.body || {}
    const mediaSummary = resolveUsageMediaSummary(body, parseUsageMediaSummaryHeader(req))
    const requestSpec = buildDashScopeWanGenerateRequest(body)
    const upstream = await requestDashScope(requestSpec)
    const traceMetadata = extractUpstreamTraceMetadata(upstream.response, upstream.payload)
    const normalized = normalizeDashScopeWanTask(upstream.payload)

    insertUsageLog({
      session: req.videoSiteSession,
      channel: 'wan',
      providerId: body.providerId || 'wan1',
      model: body.params?.model || requestSpec.body?.model || null,
      generationMode: body.mode || 'fusion',
      prompt: body.prompt || null,
      aspectRatio: body.params?.aspectRatio || null,
      resolution: body.params?.resolution || null,
      duration: body.params?.duration || null,
      requestParams: attachUsageMediaSummary(body, mediaSummary),
      engineTaskId: normalized.taskId || null,
      upstreamRequestId: traceMetadata?.requestId || null,
      upstreamTraceId: traceMetadata?.traceId || null,
      upstreamUrl: `${dashScopeBaseUrl}${requestSpec.path}`,
    }).catch(() => {})

    applyUpstreamTraceHeaders(res, traceMetadata)
    res.json({
      success: true,
      data: normalized,
      ...(traceMetadata.requestId ? { requestId: traceMetadata.requestId } : {}),
      ...(traceMetadata.traceId ? { traceId: traceMetadata.traceId } : {}),
    })
  } catch (error) {
    const statusCode = Number(error.statusCode) || 502
    applyUpstreamTraceHeaders(res, error)
    res.status(statusCode).json({
      success: false,
      message: error.message || 'DashScope Wan generate failed',
      ...(error.requestId ? { requestId: error.requestId } : {}),
      ...(error.traceId ? { traceId: error.traceId } : {}),
    })
  }
})

app.post('/api/wan/query', async (req, res) => {
  const missing = getMissingDashScopeConfig()
  if (missing.length > 0) {
    res.status(500).json({
      success: false,
      message: `Missing backend config: ${missing.join(', ')}`,
    })
    return
  }

  try {
    const requestSpec = buildDashScopeWanQueryRequest(req.body || {})
    const upstream = await requestDashScope(requestSpec)
    const traceMetadata = extractUpstreamTraceMetadata(upstream.response, upstream.payload)
    const normalized = normalizeDashScopeWanTask(upstream.payload)

    if (normalized.status === 'succeeded' || normalized.status === 'failed' || normalized.status === 'cancelled') {
      const taskId = normalized.taskId || req.body?.taskId
      if (taskId) {
        updateUsageLogByTaskId(taskId, {
          status: normalized.status,
          videoUrl: normalized.videoUrl || null,
          errorMessage: normalized.status === 'succeeded' ? null : (normalized.message || null),
          completedAt: new Date().toISOString(),
          upstreamRequestId: traceMetadata?.requestId || null,
          upstreamTraceId: traceMetadata?.traceId || null,
        }).catch(() => {})
      }
    }

    applyUpstreamTraceHeaders(res, traceMetadata)
    res.json({
      success: true,
      data: normalized,
      ...(traceMetadata.requestId ? { requestId: traceMetadata.requestId } : {}),
      ...(traceMetadata.traceId ? { traceId: traceMetadata.traceId } : {}),
    })
  } catch (error) {
    const statusCode = Number(error.statusCode) || 502
    applyUpstreamTraceHeaders(res, error)
    res.status(statusCode).json({
      success: false,
      message: error.message || 'DashScope Wan query failed',
      ...(error.requestId ? { requestId: error.requestId } : {}),
      ...(error.traceId ? { traceId: error.traceId } : {}),
    })
  }
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

function buildImageResponseParseError(data) {
  const summary = summarizeImageResponseShape(data)
  if (!summary) {
    return 'Image generation completed but no image data was found in the response.'
  }

  return `Image generation completed but no image data was found in the response (fields: ${summary})`
}

function summarizeImageResponseShape(data) {
  if (!data || typeof data !== 'object') {
    return null
  }

  const fields = []
  const topLevelKeys = Object.keys(data).slice(0, 8)
  if (topLevelKeys.length) {
    fields.push(topLevelKeys.join(', '))
  }

  if (Array.isArray(data?.choices)) {
    const choice = data.choices[0]
    if (choice?.message?.content !== undefined) {
      fields.push(`choices[0].message.content:${Array.isArray(choice.message.content) ? 'array' : typeof choice.message.content}`)
    }
    if (Array.isArray(choice?.message?.parts)) {
      fields.push(`choices[0].message.parts:${choice.message.parts.length}`)
    }
  }

  if (Array.isArray(data?.candidates)) {
    fields.push(`candidates:${data.candidates.length}`)
    const parts = data.candidates[0]?.content?.parts
    if (Array.isArray(parts)) {
      fields.push(`candidates[0].content.parts:${parts.length}`)
    }
  }

  if (Array.isArray(data?.data)) {
    fields.push(`data:${data.data.length}`)
  }

  if (Array.isArray(data?.images)) {
    fields.push(`images:${data.images.length}`)
  }

  if (Array.isArray(data?.output)) {
    fields.push(`output:${data.output.length}`)
  }

  return fields.filter(Boolean).join(' | ') || null
}

function extractInlineImagePayload(payload, fallbackPrompt = '') {
  if (!payload || typeof payload !== 'object') {
    return null
  }

  const rawData = typeof payload.data === 'string' ? payload.data : null
  if (!rawData) {
    return null
  }

  const mimeType = payload.mime_type || payload.mimeType || 'image/png'
  return {
    url: `data:${mimeType};base64,${rawData.replace(/\s/g, '')}`,
    revisedPrompt: fallbackPrompt,
  }
}

function extractImageParts(parts, fallbackPrompt = '') {
  if (!Array.isArray(parts)) {
    return null
  }

  for (const part of parts) {
    const inlineImage = extractInlineImagePayload(part?.inline_data || part?.inlineData, fallbackPrompt)
    if (inlineImage) {
      return inlineImage
    }

    if (typeof part?.text === 'string') {
      const textResult = extractImageResponseResult({ choices: [{ message: { content: part.text } }] }, fallbackPrompt)
      if (textResult) {
        return textResult
      }
    }
  }

  return null
}

function extractImageRecord(record, fallbackPrompt = '') {
  if (!record || typeof record !== 'object') {
    return null
  }

  if (typeof record.url === 'string' && record.url) {
    return {
      url: record.url,
      revisedPrompt: typeof record.revised_prompt === 'string' ? record.revised_prompt : fallbackPrompt,
    }
  }

  if (record.image_url?.url) {
    return {
      url: record.image_url.url,
      revisedPrompt: typeof record.revised_prompt === 'string' ? record.revised_prompt : fallbackPrompt,
    }
  }

  if (typeof record.b64_json === 'string' && record.b64_json) {
    const mimeType = typeof record.mime_type === 'string' ? record.mime_type : 'image/png'
    return {
      url: `data:${mimeType};base64,${record.b64_json.replace(/\s/g, '')}`,
      revisedPrompt: typeof record.revised_prompt === 'string' ? record.revised_prompt : fallbackPrompt,
    }
  }

  if (typeof record.image_base64 === 'string' && record.image_base64) {
    const mimeType = typeof record.mime_type === 'string' ? record.mime_type : 'image/png'
    return {
      url: `data:${mimeType};base64,${record.image_base64.replace(/\s/g, '')}`,
      revisedPrompt: typeof record.revised_prompt === 'string' ? record.revised_prompt : fallbackPrompt,
    }
  }

  return null
}

function extractImageResponseResult(data, fallbackPrompt = '') {
  const content = data?.choices?.[0]?.message?.content

  if (typeof content === 'string') {
    const markdownMatch = content.match(/!\[.*?\]\((data:image\/[^;]+;base64,[^)]+)\)/)
    if (markdownMatch) {
      return { url: markdownMatch[1], revisedPrompt: fallbackPrompt }
    }

    if (content.startsWith('data:image/')) {
      return { url: content, revisedPrompt: fallbackPrompt }
    }

    const dataUrlMatch = content.match(/data:(image\/[a-zA-Z+]+);base64,([A-Za-z0-9+/=\s]+)/)
    if (dataUrlMatch) {
      return { url: dataUrlMatch[0].replace(/\s/g, ''), revisedPrompt: fallbackPrompt }
    }

    const rawBase64Match = content.match(/\b([A-Za-z0-9+/]{100,}={0,2})\b/)
    if (rawBase64Match) {
      return { url: `data:image/png;base64,${rawBase64Match[1]}`, revisedPrompt: fallbackPrompt }
    }
  }

  if (Array.isArray(content)) {
    const imageItem = content.find((item) => item?.type === 'image_url' && item?.image_url?.url)
    if (imageItem) {
      return { url: imageItem.image_url.url, revisedPrompt: fallbackPrompt }
    }

    const base64Item = content.find((item) => item?.type === 'image_base64' && typeof item?.image_base64 === 'string')
    if (base64Item) {
      const mimeType = typeof base64Item.mime_type === 'string' ? base64Item.mime_type : 'image/png'
      return {
        url: `data:${mimeType};base64,${base64Item.image_base64.replace(/\s/g, '')}`,
        revisedPrompt: fallbackPrompt,
      }
    }
  }

  const topLevelCollections = [data?.data, data?.images]
  for (const collection of topLevelCollections) {
    if (!Array.isArray(collection)) continue

    for (const record of collection) {
      const parsedRecord = extractImageRecord(record, fallbackPrompt)
      if (parsedRecord) {
        return parsedRecord
      }
    }
  }

  const outputEntries = Array.isArray(data?.output) ? data.output : []
  for (const entry of outputEntries) {
    const directRecord = extractImageRecord(entry, fallbackPrompt)
    if (directRecord) {
      return directRecord
    }

    if (!Array.isArray(entry?.content)) continue

    for (const contentItem of entry.content) {
      const parsedRecord = extractImageRecord(contentItem, fallbackPrompt)
      if (parsedRecord) {
        return parsedRecord
      }
    }
  }

  const parts = data?.choices?.[0]?.message?.parts
  if (parts) {
    const partResult = extractImageParts(parts, fallbackPrompt)
    if (partResult) {
      return partResult
    }
  }

  const candidates = Array.isArray(data?.candidates) ? data.candidates : []
  for (const candidate of candidates) {
    const partResult = extractImageParts(candidate?.content?.parts, fallbackPrompt)
    if (partResult) {
      return partResult
    }
  }

  return null
}

const USAGE_MEDIA_SUMMARY_HEADER = 'x-usage-media-summary'

function normalizeUsageMediaMetric(metric) {
  return {
    count: Math.max(0, Number(metric?.count) || 0),
    bytes: Math.max(0, Number(metric?.bytes) || 0),
  }
}

function normalizeUsageMediaSummary(summary) {
  if (!summary || typeof summary !== 'object') return null

  return {
    images: normalizeUsageMediaMetric(summary.images),
    videos: normalizeUsageMediaMetric(summary.videos),
    audios: normalizeUsageMediaMetric(summary.audios),
  }
}

function parseUsageMediaSummaryHeader(req) {
  const rawValue = req.get(USAGE_MEDIA_SUMMARY_HEADER)
  if (!rawValue) return null

  try {
    const parsed = JSON.parse(decodeURIComponent(rawValue))
    return normalizeUsageMediaSummary(parsed)
  } catch {
    return null
  }
}

function attachUsageMediaSummary(requestParams, mediaSummary) {
  if (!mediaSummary) return requestParams
  return {
    ...(requestParams && typeof requestParams === 'object' ? requestParams : {}),
    mediaSummary,
  }
}

function resolveUsageMediaSummary(requestParams, headerSummary) {
  if (headerSummary) {
    return headerSummary
  }

  const references = requestParams?.references
  if (!references || typeof references !== 'object') {
    return null
  }

  return {
    images: buildUploadedReferenceMetric(references.images),
    videos: buildUploadedReferenceMetric(references.videos),
    audios: buildUploadedReferenceMetric(references.audios),
  }
}

function buildUploadedReferenceMetric(items) {
  const refs = Array.isArray(items) ? items : []
  return {
    count: refs.length,
    bytes: refs.reduce((total, item) => total + resolveUploadedReferenceBytes(item), 0),
  }
}

function registerUploadedReference(reference, bytes, expiresAtMs) {
  const key = normalizeUploadedReferenceKey(reference)
  if (!key) return

  uploadedReferenceMetadata.set(key, {
    bytes: Math.max(0, Number(bytes) || 0),
    expiresAtMs: Math.max(Date.now(), Number(expiresAtMs) || Date.now()),
  })
}

function resolveUploadedReferenceBytes(reference) {
  const key = normalizeUploadedReferenceKey(reference)
  if (!key) return 0

  const metadata = uploadedReferenceMetadata.get(key)
  if (!metadata) return 0

  if (metadata.expiresAtMs <= Date.now()) {
    uploadedReferenceMetadata.delete(key)
    return 0
  }

  return metadata.bytes
}

function normalizeUploadedReferenceKey(reference) {
  return typeof reference === 'string' ? reference.trim() : ''
}

function findFirstPathValue(target, paths) {
  for (const pathExpression of paths) {
    const value = getPathValue(target, pathExpression)
    if (value !== undefined && value !== null && value !== '') {
      return value
    }
  }

  return null
}

function findFirstMatchingPathValue(target, paths, predicate) {
  for (const pathExpression of paths) {
    const value = getPathValue(target, pathExpression)
    if (predicate(value, pathExpression)) {
      return value.trim()
    }
  }

  return null
}

function getPathValue(target, pathExpression) {
  if (!target || typeof target !== 'object') {
    return undefined
  }

  const segments = String(pathExpression || '').split('.').filter(Boolean)
  let current = target

  for (const segment of segments) {
    if (current === null || current === undefined) {
      return undefined
    }

    if (/^\d+$/.test(segment)) {
      current = current[Number(segment)]
      continue
    }

    current = current[segment]
  }

  return current
}

function findFirstMediaUrlDeep(target, depth = 0, keyPath = '') {
  if (!target || depth > 6) {
    return null
  }

  if (typeof target === 'string') {
    return isLikelyRemoteVideoUrl(target, keyPath) ? target.trim() : null
  }

  if (Array.isArray(target)) {
    for (let index = 0; index < target.length; index += 1) {
      const match = findFirstMediaUrlDeep(
        target[index],
        depth + 1,
        keyPath ? `${keyPath}.${index}` : String(index),
      )
      if (match) {
        return match
      }
    }
    return null
  }

  if (typeof target === 'object') {
    for (const [key, value] of Object.entries(target)) {
      const nextKeyPath = keyPath ? `${keyPath}.${key}` : key
      if (typeof value === 'string' && isLikelyRemoteVideoUrl(value, nextKeyPath)) {
        return value.trim()
      }

      const nestedMatch = findFirstMediaUrlDeep(value, depth + 1, nextKeyPath)
      if (nestedMatch) {
        return nestedMatch
      }
    }
  }

  return null
}

function isLikelyRemoteVideoUrl(value, keyPath = '') {
  if (typeof value !== 'string') {
    return false
  }

  const normalized = value.trim()
  if (!/^https?:\/\//i.test(normalized)) {
    return false
  }

  try {
    const parsed = new URL(normalized)
    const searchable = `${parsed.pathname}${parsed.search}`.toLowerCase()
    if (/\.(mp4|mov|webm|m3u8)(\?|$)/i.test(searchable)) {
      return true
    }

    const normalizedKeyPath = keyPath.toLowerCase().replace(/[^a-z]/g, '')
    if (/(videourl|downloadurl|download|fileurl|resulturl|outputurl|playurl|videofile)/.test(normalizedKeyPath)) {
      return true
    }

    if (/\/(video|videos|download|downloads|file|files|play)\b/i.test(parsed.pathname)) {
      return true
    }
  } catch {
    return false
  }

  return false
}

function normalizeTaskIdValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(Math.trunc(value))
  }

  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }

  return null
}

function extractAggregationTaskId(payload) {
  return normalizeTaskIdValue(findFirstPathValue(payload, [
    'taskId',
    'task_id',
    'id',
    'data.taskId',
    'data.task_id',
    'data.id',
    'data.result.taskId',
    'data.result.task_id',
    'data.result.id',
    'result.taskId',
    'result.task_id',
    'result.id',
  ]))
}

function extractAggregationStatus(payload) {
  return findFirstPathValue(payload, [
    'status',
    'state',
    'task_status',
    'data.status',
    'data.state',
    'data.task_status',
    'data.result.status',
    'data.result.state',
    'data.result.task_status',
    'result.status',
    'result.state',
    'result.task_status',
  ])
}

function normalizeAggregationFinalStatus(value) {
  if (value === null || value === undefined) return null

  const normalized = String(value).trim().toLowerCase()
  if (!normalized) return null

  if (
    normalized === '2'
    || normalized === 'succeeded'
    || normalized === 'success'
    || normalized === 'completed'
    || normalized === 'done'
  ) {
    return 'succeeded'
  }

  if (
    normalized === '3'
    || normalized === 'failed'
    || normalized === 'failure'
    || normalized === 'error'
  ) {
    return 'failed'
  }

  if (
    normalized === '4'
    || normalized === 'cancelled'
    || normalized === 'canceled'
  ) {
    return 'cancelled'
  }

  return null
}

function extractAggregationVideoUrl(payload) {
  return (
    findFirstMatchingPathValue(payload, [
      'videoUrl',
      'video_url',
      'resultUrl',
      'url',
      'content',
      'message',
      'data.videoUrl',
      'data.video_url',
      'data.resultUrl',
      'data.url',
      'data.content',
      'data.message',
      'data.result.videoUrl',
      'data.result.video_url',
      'data.result.resultUrl',
      'data.result.url',
      'data.result.content',
      'data.result.message',
      'result.videoUrl',
      'result.video_url',
      'result.resultUrl',
      'result.url',
      'result.content',
      'result.message',
    ], isLikelyRemoteVideoUrl)
    || findFirstMediaUrlDeep(payload)
  )
}

function extractAggregationMessage(payload) {
  const preferredMessage = readFirstString(findFirstPathValue(payload, [
    'error',
    'errorMessage',
    'failureReason',
    'failReason',
    'reason',
    'data.error',
    'data.errorMessage',
    'data.failureReason',
    'data.failReason',
    'data.reason',
    'data.result.error',
    'data.result.errorMessage',
    'data.result.failureReason',
    'data.result.failReason',
    'data.result.reason',
    'data.result.message',
    'data.result.msg',
    'result.error',
    'result.errorMessage',
    'result.failureReason',
    'result.failReason',
    'result.reason',
    'result.message',
    'result.msg',
  ]))

  if (preferredMessage && !isGenericSuccessMessage(preferredMessage)) {
    return preferredMessage
  }

  const fallbackMessage = readFirstString(findFirstPathValue(payload, [
    'message',
    'msg',
    'data.message',
    'data.msg',
  ]))

  if (fallbackMessage && !isGenericSuccessMessage(fallbackMessage)) {
    return fallbackMessage
  }

  return null
}

function normalizeComparableMessageText(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[！!。.\s]+/g, '')
}

function isGenericSuccessMessage(value) {
  const normalized = normalizeComparableMessageText(value)
  if (!normalized) return false

  return ['操作成功', '请求成功', '调用成功', 'success', 'ok'].includes(normalized)
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
  console.log('[monitor-debug] /api/veo-fast/generate hit:', {
    hasSession: Boolean(req.videoSiteSession?.user),
    userKeys: req.videoSiteSession?.user ? Object.keys(req.videoSiteSession.user) : [],
    model: req.body?.model || null,
    mode: req.body?.mode || req.body?.params?.mode || null,
  })
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
  const mediaSummary = parseUsageMediaSummaryHeader(req)
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
      requestParams: attachUsageMediaSummary({
        model: normalizedBody?.model,
        parameters: normalizedBody?.parameters,
        referenceCounts: extractVeoFastReferenceCounts(normalizedBody),
      }, mediaSummary),
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

app.use('/api/admin', requireAdminApiAccess, adminRouter)
app.get('/admin', requireAdminPageAccess, (req, res) => {
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

function parseIdentityAllowlist(value) {
  return new Set(uniqueNormalizedValues([value]))
}

function normalizeIdentityValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value).trim().toLowerCase()
  }

  if (typeof value !== 'string') {
    return ''
  }

  return String(value).trim().toLowerCase()
}

function isAdminUser(user) {
  if (!user || typeof user !== 'object') return false

  if (user.isAdmin === true || user.is_admin === true) {
    return true
  }

  const identities = collectUserIdentities(user)
  if (
    matchesAllowlist(adminUserIdAllowlist, identities.ids)
    || matchesAllowlist(adminUserAccountAllowlist, identities.accounts)
    || matchesAllowlist(adminUserEmailAllowlist, identities.emails)
    || matchesAllowlist(adminUserNameAllowlist, identities.names)
  ) {
    return true
  }

  if (
    identities.roles.some(isBuiltInAdminIdentity)
    || identities.groups.some(isBuiltInAdminIdentity)
  ) {
    return true
  }

  if (hasExplicitAdminAllowlist) {
    return false
  }

  return identities.accounts.some(isBuiltInAdminIdentity)
}

function collectUserIdentities(user) {
  return {
    ids: uniqueNormalizedValues([user.id, user.userId, user.uid]),
    accounts: uniqueNormalizedValues([user.account, user.username, user.userName, user.login]),
    emails: uniqueNormalizedValues([user.email]),
    names: uniqueNormalizedValues([user.name, user.nickname, user.displayName, user.realName]),
    roles: uniqueNormalizedValues([
      user.role,
      user.roles,
      user.permission,
      user.permissions,
    ]),
    groups: uniqueNormalizedValues([
      user.group,
      user.groupName,
      user.groups,
      user.groupNames,
    ]),
  }
}

function uniqueNormalizedValues(values) {
  const normalized = []
  for (const value of values) {
    if (Array.isArray(value)) {
      normalized.push(...uniqueNormalizedValues(value))
      continue
    }

    if (typeof value === 'string' && /[,;|]/.test(value)) {
      normalized.push(...value.split(/[,;|]/).map((item) => normalizeIdentityValue(item)).filter(Boolean))
      continue
    }

    const nextValue = normalizeIdentityValue(value)
    if (nextValue) {
      normalized.push(nextValue)
    }
  }

  return [...new Set(normalized)]
}

function matchesAllowlist(allowlist, candidates) {
  if (!allowlist.size) return false
  return candidates.some((candidate) => allowlist.has(candidate))
}

function isBuiltInAdminIdentity(value) {
  return value === 'admin' || value === 'administrator'
}

function requireAdminApiAccess(req, res, next) {
  if (!requireMainAppSso) {
    next()
    return
  }

  const session = req.videoSiteSession
  if (!session) {
    res.status(401).json({
      success: false,
      message: 'Please launch VEO Studio from the main site first.',
      redirectUrl: buildMainAppVideoEntryUrl(resolveRequestedMainAppUrl(req)),
    })
    return
  }

  if (!isAdminUser(session.user)) {
    res.status(403).json({
      success: false,
      message: 'Admin access only.',
    })
    return
  }

  next()
}

function requireAdminPageAccess(req, res, next) {
  if (!requireMainAppSso) {
    next()
    return
  }

  if (!isAdminUser(req.videoSiteSession?.user)) {
    res
      .status(403)
      .type('html')
      .send(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>无权访问</title>
    <style>
      body { margin: 0; font-family: "PingFang SC", "Microsoft YaHei", sans-serif; background: #0f172a; color: #e2e8f0; display: grid; place-items: center; min-height: 100vh; }
      .card { width: min(92vw, 460px); padding: 32px; border-radius: 20px; background: rgba(15, 23, 42, 0.9); border: 1px solid rgba(148, 163, 184, 0.24); box-shadow: 0 20px 60px rgba(15, 23, 42, 0.35); }
      h1 { margin: 0 0 10px; font-size: 26px; }
      p { margin: 0; line-height: 1.7; color: #cbd5e1; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>无权访问</h1>
      <p>当前账号不是管理员，不能进入后台管理页面。</p>
    </div>
  </body>
</html>`)
    return
  }

  next()
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
  const traceMetadata = extractUpstreamTraceMetadata(response, payload)

  if (!response.ok) {
    const message = typeof payload === 'string'
      ? payload
      : payload?.msg || payload?.message || payload?.error?.message || JSON.stringify(payload)
    throw createHttpError(response.status, message || 'Upstream request failed.', traceMetadata)
  }

  return payload
}

async function requestDashScope(spec) {
  const url = appendQueryParams(`${dashScopeBaseUrl}${spec.path}`, spec.query)
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`,
    ...(spec.headers || {}),
  }

  if (spec.async) {
    headers['X-DashScope-Async'] = 'enable'
  }

  if (spec.resolveOssResource) {
    headers['X-DashScope-OssResourceResolve'] = 'enable'
  }

  if (spec.body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }

  let response
  let lastError = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await fetch(url, {
        method: spec.method || 'POST',
        headers,
        body: spec.body !== undefined ? JSON.stringify(spec.body) : undefined,
      })
      break
    } catch (error) {
      lastError = error
      if (attempt === 2) {
        throw createHttpError(502, error?.message || 'DashScope upstream fetch failed.')
      }
      await sleep(800 * (attempt + 1))
    }
  }

  if (!response) {
    throw createHttpError(502, lastError?.message || 'DashScope upstream fetch failed.')
  }

  const contentType = response.headers.get('content-type') || ''
  const payload = isJsonContentType(contentType)
    ? await response.json()
    : await response.text()
  const traceMetadata = extractUpstreamTraceMetadata(response, payload)

  if (!response.ok) {
    const message = typeof payload === 'string'
      ? payload
      : payload?.message || payload?.msg || payload?.error?.message || JSON.stringify(payload)
    throw createHttpError(response.status, message || 'DashScope upstream request failed.', traceMetadata)
  }

  return { response, payload }
}

function createHttpError(statusCode, message, metadata = {}) {
  const error = new Error(message)
  error.statusCode = statusCode
  if (metadata.requestId) {
    error.requestId = metadata.requestId
  }
  if (metadata.traceId) {
    error.traceId = metadata.traceId
  }
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

const DASHSCOPE_WAN_SIZE_MAP = {
  '720P': {
    '16:9': '1280*720',
    '9:16': '720*1280',
    '1:1': '960*960',
    '4:3': '1088*832',
    '3:4': '832*1088',
  },
}

function getMissingDashScopeConfig() {
  return [
    !process.env.DASHSCOPE_API_KEY && 'DASHSCOPE_API_KEY',
  ].filter(Boolean)
}

async function createDashScopeTemporaryReference({ file, model }) {
  const policy = await getDashScopeUploadPolicy(model)
  const key = buildDashScopeUploadKey(policy.uploadDir, file.originalname)
  await uploadFileToDashScope({ file, policy, key })

  const expiresAtMs = Date.now() + 48 * 60 * 60 * 1000

  return {
    resourceRef: `oss://${key}`,
    expiresAt: new Date(expiresAtMs).toISOString(),
    expiresAtMs,
  }
}

async function getDashScopeUploadPolicy(model) {
  const upstream = await requestDashScope({
    method: 'GET',
    path: '/api/v1/uploads',
    query: {
      action: 'getPolicy',
      model,
    },
    headers: {
      'Content-Type': 'application/json',
    },
  })

  const data = upstream.payload?.data
  if (!data?.upload_dir || !data?.upload_host || !data?.policy || !data?.signature || !data?.oss_access_key_id) {
    throw createHttpError(502, 'DashScope upload policy response is incomplete.', extractUpstreamTraceMetadata(upstream.response, upstream.payload))
  }

  return {
    uploadDir: String(data.upload_dir),
    uploadHost: String(data.upload_host),
    policy: String(data.policy),
    signature: String(data.signature),
    ossAccessKeyId: String(data.oss_access_key_id),
    objectAcl: String(data.x_oss_object_acl || 'private'),
    forbidOverwrite: String(data.x_oss_forbid_overwrite || 'true'),
    maxFileSizeMb: Number(data.max_file_size_mb || 0),
  }
}

async function uploadFileToDashScope({ file, policy, key }) {
  if (policy.maxFileSizeMb > 0 && file.size > policy.maxFileSizeMb * 1024 * 1024) {
    throw createHttpError(400, `Reference file exceeds DashScope upload limit of ${policy.maxFileSizeMb}MB.`)
  }

  const fileBuffer = await fsp.readFile(file.path)
  const formData = new FormData()
  formData.append('OSSAccessKeyId', policy.ossAccessKeyId)
  formData.append('policy', policy.policy)
  formData.append('Signature', policy.signature)
  formData.append('key', key)
  formData.append('x-oss-object-acl', policy.objectAcl)
  formData.append('x-oss-forbid-overwrite', policy.forbidOverwrite)
  formData.append('success_action_status', '200')
  formData.append(
    'file',
    new Blob([fileBuffer], { type: file.mimetype || 'application/octet-stream' }),
    sanitizeDashScopeUploadFileName(file.originalname),
  )

  const response = await fetch(policy.uploadHost, {
    method: 'POST',
    body: formData,
  })

  if (!response.ok) {
    const message = (await response.text()) || 'DashScope temp file upload failed.'
    throw createHttpError(response.status, message)
  }
}

function buildDashScopeUploadKey(uploadDir, originalName) {
  const safeName = sanitizeDashScopeUploadFileName(originalName)
  return `${String(uploadDir || '').replace(/\/+$/, '')}/${randomUUID()}-${safeName}`
}

function sanitizeDashScopeUploadFileName(originalName) {
  const parsed = path.parse(path.basename(String(originalName || '').trim()))
  const baseName = (parsed.name || 'reference').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'reference'
  const extension = (parsed.ext || '').replace(/[^\w.]+/g, '')
  return `${baseName.slice(0, 80)}${extension.slice(0, 16)}`
}

function parseUploadStorageBackend(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) return 'local'
  if (normalized === 'dashscope') return 'dashscope'
  return 'local'
}

function normalizeDashScopeUploadModel(value) {
  const normalized = String(value || '').trim()
  return normalized || ''
}

function buildDashScopeWanGenerateRequest(input) {
  const providerId = String(input.providerId || 'wan1')
  if (providerId !== 'wan1') {
    throw createHttpError(400, `Unsupported DashScope Wan provider: ${providerId || 'unknown'}`)
  }

  const prompt = String(input.prompt || '').trim()
  if (!prompt) {
    throw createHttpError(400, 'Prompt is required.')
  }

  const params = input.params && typeof input.params === 'object' ? input.params : {}
  const references = normalizeDashScopeWanReferences(input.references)

  if (references.images.length > 5) {
    throw createHttpError(400, 'DashScope Wan supports at most 5 reference images.')
  }

  if (references.videos.length > 3) {
    throw createHttpError(400, 'DashScope Wan supports at most 3 reference videos.')
  }

  if (references.images.length + references.videos.length > 5) {
    throw createHttpError(400, 'DashScope Wan requires reference images and videos to total 5 or fewer items.')
  }

  const referenceUrls = collectDashScopeWanReferenceUrls(references)
  if (referenceUrls.length === 0) {
    throw createHttpError(400, 'At least one DashScope Wan reference image or video is required.')
  }

  const negativePrompt = typeof params.negativePrompt === 'string' ? params.negativePrompt.trim() : ''

  return {
    method: 'POST',
    path: '/api/v1/services/aigc/video-generation/video-synthesis',
    async: true,
    resolveOssResource: referenceUrls.some((item) => isDashScopeOssResource(item)),
    body: {
      model: String(params.model || 'wan2.6-r2v-flash'),
      input: {
        prompt,
        ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
        reference_urls: referenceUrls,
      },
      parameters: {
        size: resolveDashScopeWanSize(params),
        duration: resolveDashScopeWanDuration(params),
        shot_type: resolveDashScopeWanShotType(params),
        audio: Boolean(params.generateAudio),
        watermark: Boolean(params.watermark),
      },
    },
  }
}

function buildDashScopeWanQueryRequest(input) {
  const providerId = String(input.providerId || 'wan1')
  if (providerId !== 'wan1') {
    throw createHttpError(400, `Unsupported DashScope Wan provider: ${providerId || 'unknown'}`)
  }

  const taskId = String(input.taskId || '').trim()
  if (!taskId) {
    throw createHttpError(400, 'taskId is required.')
  }

  return {
    method: 'GET',
    path: `/api/v1/tasks/${encodeURIComponent(taskId)}`,
  }
}

function normalizeDashScopeWanReferences(references) {
  return {
    images: Array.isArray(references?.images) ? references.images.filter((item) => typeof item === 'string' && item) : [],
    videos: Array.isArray(references?.videos) ? references.videos.filter((item) => typeof item === 'string' && item) : [],
    orderedVisualRefs: Array.isArray(references?.orderedVisualRefs)
      ? references.orderedVisualRefs.filter((item) => typeof item === 'string' && item)
      : [],
  }
}

function collectDashScopeWanReferenceUrls(references) {
  const ordered = references.orderedVisualRefs.slice(0, 5)
  if (ordered.length > 0) {
    return ordered
  }

  return [...references.images, ...references.videos].slice(0, 5)
}

function isDashScopeOssResource(value) {
  return typeof value === 'string' && value.startsWith('oss://')
}

function resolveDashScopeWanSize(params) {
  const resolution = String(params?.resolution || '720P').trim().toUpperCase()
  const aspectRatio = String(params?.aspectRatio || '16:9').trim()
  const size = DASHSCOPE_WAN_SIZE_MAP[resolution]?.[aspectRatio]

  if (!size) {
    throw createHttpError(400, `Unsupported DashScope Wan size mapping: ${resolution} / ${aspectRatio}`)
  }

  return size
}

function resolveDashScopeWanDuration(params) {
  const duration = Math.trunc(Number(params?.duration || 5))
  if (!Number.isFinite(duration) || duration < 2 || duration > 10) {
    throw createHttpError(400, 'DashScope Wan duration must be an integer between 2 and 10 seconds.')
  }
  return duration
}

function resolveDashScopeWanShotType(params) {
  const shotType = String(params?.shotType || 'single').trim().toLowerCase()
  if (shotType !== 'single' && shotType !== 'multi') {
    throw createHttpError(400, `Unsupported DashScope Wan shot_type: ${shotType}`)
  }
  return shotType
}

function normalizeDashScopeWanTask(payload) {
  return {
    taskId: extractDashScopeTaskId(payload),
    status: normalizeDashScopeTaskStatus(extractDashScopeTaskStatus(payload)),
    message: extractDashScopeTaskMessage(payload),
    videoUrl: extractDashScopeVideoUrl(payload),
  }
}

function extractDashScopeTaskId(payload) {
  return normalizeTaskIdValue(findFirstPathValue(payload, [
    'task_id',
    'taskId',
    'id',
    'output.task_id',
    'output.taskId',
    'output.id',
    'data.task_id',
    'data.taskId',
    'data.id',
  ]))
}

function extractDashScopeTaskStatus(payload) {
  return findFirstPathValue(payload, [
    'task_status',
    'status',
    'state',
    'output.task_status',
    'output.status',
    'output.state',
    'data.task_status',
    'data.status',
    'data.state',
  ])
}

function normalizeDashScopeTaskStatus(value) {
  if (value === null || value === undefined) return null

  const normalized = String(value).trim().toLowerCase()
  if (!normalized) return null

  if (['succeeded', 'success', 'completed', 'done'].includes(normalized)) return 'succeeded'
  if (['failed', 'failure', 'error', 'unknown'].includes(normalized)) return 'failed'
  if (['canceled', 'cancelled'].includes(normalized)) return 'cancelled'
  if (['running', 'processing', 'in_progress'].includes(normalized)) return 'running'
  if (['pending', 'queued', 'submitted'].includes(normalized)) return 'pending'
  return normalized
}

function extractDashScopeTaskMessage(payload) {
  return readFirstString(findFirstPathValue(payload, [
    'message',
    'msg',
    'output.message',
    'output.msg',
    'error.message',
    'error',
    'data.message',
    'data.msg',
  ]))
}

function extractDashScopeVideoUrl(payload) {
  return (
    findFirstMatchingPathValue(payload, [
      'video_url',
      'videoUrl',
      'url',
      'output.video_url',
      'output.videoUrl',
      'output.url',
      'output.result_url',
      'output.resultUrl',
      'data.video_url',
      'data.videoUrl',
      'data.url',
    ], isLikelyRemoteVideoUrl)
    || findFirstMediaUrlDeep(payload)
  )
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
  cleanupUploadedReferenceMetadata()
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

function cleanupUploadedReferenceMetadata() {
  const now = Date.now()
  for (const [key, metadata] of uploadedReferenceMetadata.entries()) {
    if (!metadata || metadata.expiresAtMs <= now) {
      uploadedReferenceMetadata.delete(key)
    }
  }
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
