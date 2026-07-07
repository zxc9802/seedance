import express from 'express'
import multer from 'multer'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { createServer as createHttpServer } from 'node:http'
import { promisify } from 'node:util'
import { createServer as createViteServer, loadEnv } from 'vite'
import { getPool, initDatabase, closePool } from './db/postgres.js'
import { insertUsageLog, updateUsageLogByTaskId } from './db/usage.js'
import { assertSufficientCredits, calculateVideoCreditCharge, shouldChargeCreditsForProvider } from './db/credits.js'
import adminRouter from './admin/api.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const execFileAsync = promisify(execFile)
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
const imageApiBaseUrl = normalizeGeminiImageBaseUrl(process.env.IMAGE_API_BASE_URL || 'https://www.shanbaob.com')
const imageAggregationApiBaseUrl = stripTrailingSlash(process.env.IMAGE_AGGREGATION_API_BASE_URL || process.env.VIDEO_API_BASE_URL || 'http://8.137.157.96:9220')
const gptImage2ApiBaseUrl = stripTrailingSlash(process.env.GPT_IMAGE2_API_BASE_URL || 'https://yunwu.ai')
const bcaiApiUrl = normalizeChatCompletionsUrl(process.env.BCAI_API_URL || process.env.BCAI_API_BASE_URL || 'https://bcai.online/v1/chat/completions')
const shanbaoCopywritingApiUrl = normalizeChatCompletionsUrl(
  process.env.SHANBAO_API_URL
    || process.env.SHANBAO_API_BASE_URL
    || process.env.CLAUDE1_API_URL
    || process.env.CLAUDE1_API_BASE_URL
    || 'https://ai.shanbaob.net/v1/chat/completions',
)
const yunwuApiBaseUrl = stripTrailingSlash(process.env.YUNWU_API_BASE_URL || 'https://yunwu.ai')
const arkApiBaseUrl = stripTrailingSlash(process.env.ARK_API_BASE_URL || 'https://ark.cn-beijing.volces.com')
const dashScopeBaseUrl = stripTrailingSlash(process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com')
const materialThirdChannel = Number(process.env.MATERIAL_THIRD_CHANNEL || 1)
const materialPollIntervalMs = Math.max(1000, Number(process.env.MATERIAL_POLL_INTERVAL_MS || 3000))
const materialPollTimeoutMs = Math.max(materialPollIntervalMs, Number(process.env.MATERIAL_POLL_TIMEOUT_MS || 180000))
const materialResourceTemplate = (process.env.MATERIAL_RESOURCE_TEMPLATE || '{materialId}').trim() || '{materialId}'
const tempAssetSigningSecret = resolveTempAssetSigningSecret()
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
const adminCreditsPath = normalizeAdminCreditsPath(process.env.ADMIN_CREDITS_PATH || '/admin/credit-center')
const hasExplicitAdminAllowlist = [
  adminUserIdAllowlist,
  adminUserAccountAllowlist,
  adminUserEmailAllowlist,
  adminUserNameAllowlist,
].some((set) => set.size > 0)
const UPSTREAM_REQUEST_ID_HEADERS = ['x-oneapi-request-id', 'x-request-id', 'request-id']
const UPSTREAM_TRACE_ID_HEADERS = ['trace-id', 'x-trace-id', 'cf-ray']
const COPYWRITING_RETRY_OPTIONS = Object.freeze({
  maxAttempts: readPositiveIntegerEnv(process.env.BCAI_COPYWRITING_MAX_ATTEMPTS, 3),
  statusCodes: new Set([429, 502, 503, 504, 529]),
  delaysMs: [700, 1400, 2600, 4200],
  retryNetworkErrors: true,
  exhaustedMessage: '文案服务暂时不可用，已自动重试仍未成功。可能已产生计费但未返回内容，请记录 requestId 后稍后重试或到服务商后台核对。',
})
const USAGE_STATUS_NEEDS_REVIEW = 'needs_review'
const USAGE_STATUS_SYNC_INTERVAL_MS = Math.max(60000, Number(process.env.USAGE_STATUS_SYNC_INTERVAL_MS || 180000))
const USAGE_STATUS_SYNC_BATCH_SIZE = Math.max(1, Math.min(100, Number(process.env.USAGE_STATUS_SYNC_BATCH_SIZE || 20)))
const USAGE_STATUS_SYNC_LOOKBACK_HOURS = Math.max(1, Number(process.env.USAGE_STATUS_SYNC_LOOKBACK_HOURS || 168))
const USAGE_STATUS_SYNC_MIN_AGE_MINUTES = Math.max(1, Number(process.env.USAGE_STATUS_SYNC_MIN_AGE_MINUTES || 3))
const UNTRACKED_USAGE_REVIEW_DELAY_MINUTES = Math.max(3, Number(process.env.UNTRACKED_USAGE_REVIEW_DELAY_MINUTES || 10))
const UNTRACKED_USAGE_STATUS_MESSAGE = '上游响应未返回 task_id，无法自动查询状态，请结合供应商后台核对。'
const ARK_ALLOWED_PROVIDER_IDS = new Set(['seedance3'])
const ARK_PROVIDER_MODES = Object.freeze({
  seedance3: ['t2v', 'i2v', 'flf', 'fusion'],
})
const ARK_VIDEO_RATIOS = new Set(['1:1', '3:4', '16:9', '4:3', '9:16', '21:9'])
const ARK_VIDEO_RESOLUTIONS = new Set(['480p', '720p', '1080p'])
const DREAMINA_ALLOWED_PROVIDER_IDS = new Set(['seedance2'])
const DREAMINA_PROVIDER_MODES = Object.freeze({
  seedance2: ['generate', 'fusion', 'multiframe', 't2v', 'i2v', 'flf'],
})
const DREAMINA_VIDEO_FAMILY_MODELS = ['seedance2.0', 'seedance2.0fast', 'seedance2.0_vip', 'seedance2.0fast_vip']
const DREAMINA_TEXT2VIDEO_MODELS = new Set(DREAMINA_VIDEO_FAMILY_MODELS)
const DREAMINA_MULTIMODAL_MODELS = new Set(DREAMINA_VIDEO_FAMILY_MODELS)
const DREAMINA_IMAGE2VIDEO_MODELS = new Set([
  ...DREAMINA_VIDEO_FAMILY_MODELS,
  '3.0',
  '3.0fast',
  '3.0pro',
  '3.0_fast',
  '3.0_pro',
  '3.5pro',
  '3.5_pro',
])
const DREAMINA_FRAMES2VIDEO_MODELS = new Set([
  ...DREAMINA_VIDEO_FAMILY_MODELS,
  '3.0',
  '3.5pro',
])
const DREAMINA_VIDEO_RATIOS = new Set(['1:1', '3:4', '16:9', '4:3', '9:16', '21:9'])
const DREAMINA_VIDEO_RESOLUTIONS = new Set(['720p', '1080p'])
const DREAMINA_TEXT2IMAGE_MODELS = new Set(['3.0', '3.1', '4.0', '4.1', '4.5', '4.6', '5.0', 'lab'])
const DREAMINA_IMAGE2IMAGE_MODELS = new Set(['4.0', '4.1', '4.5', '4.6', '5.0', 'lab'])
const DREAMINA_IMAGE_RATIOS = new Set(['21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'])
const DREAMINA_IMAGE_RESOLUTION_TYPES = new Set(['1k', '2k', '4k', '8k'])
const DREAMINA_CLI_TIMEOUT_MS = Math.max(30000, Number(process.env.DREAMINA_CLI_TIMEOUT_MS || 600000))
const uploadedReferenceMetadata = new Map()
let usageStatusSyncTimer = null
let usageStatusSyncRunning = false

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
    files: 32,
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

app.get('/temp-assets/:filename', async (req, res) => {
  const filename = sanitizeTempAssetName(req.params.filename)
  const expiresAt = Number(req.query.exp || 0)
  const signature = readSingleQueryValue(req.query.sig) || ''

  if (!filename || !Number.isFinite(expiresAt) || expiresAt <= 0 || !signature) {
    res.status(400).send('Missing temp asset signature.')
    return
  }

  if (expiresAt <= Date.now()) {
    res.status(410).send('Temp asset URL has expired.')
    return
  }

  if (!verifyTempAssetSignature(filename, expiresAt, signature)) {
    res.status(403).send('Invalid temp asset signature.')
    return
  }

  const absolutePath = path.join(uploadDir, filename)
  try {
    const stat = await fsp.stat(absolutePath)
    if (!stat.isFile()) {
      res.status(404).send('Temp asset not found.')
      return
    }
  } catch {
    res.status(404).send('Temp asset not found.')
    return
  }

  res.setHeader('Cache-Control', `private, max-age=${Math.max(60, Math.floor((expiresAt - Date.now()) / 1000))}`)
  res.sendFile(filename, { root: uploadDir })
})

app.get('/api/health', (_, res) => {
  res.json({
    success: true,
    mode,
    uploadTtlMinutes,
    publicBaseUrl: publicBaseUrl || null,
    requireMainAppSso,
    adminCreditsPath: adminCreditsPath,
  })
})

app.get('/api/session', async (req, res) => {
  const session = requireMainAppSso
    ? await requireFreshVideoSiteSession(req, res)
    : req.videoSiteSession || resolveLocalDevSession()
  if (!session) {
    res.status(401).json({
      success: false,
      code: 'SESSION_REVOKED',
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

function resolveLocalDevSession() {
  if (requireMainAppSso) return null

  const userId = process.env.DEV_USAGE_USER_ID?.trim()
  if (!userId) return null

  const email = process.env.DEV_USAGE_USER_EMAIL?.trim() || `${userId}@local.dev`
  const nickname = process.env.DEV_USAGE_USER_NICKNAME?.trim() || userId
  const groupName = process.env.DEV_USAGE_USER_GROUP?.trim() || 'local-dev'

  return {
    token: 'local-dev-session',
    mainAppUrl: publicBaseUrl || `http://localhost:${port}`,
    expiresAt: Date.now() + videoSiteSessionTtlMs,
    user: {
      id: userId,
      account: userId,
      email,
      nickname,
      groupName,
    },
  }
}

app.use(async (req, res, next) => {
  if (!requireMainAppSso) {
    next()
    return
  }

  if (shouldBypassSso(req)) {
    next()
    return
  }

  if (req.path.startsWith('/api/')) {
    const session = req.videoSiteSession
    const validSession = await requireFreshVideoSiteSession(req, res)
    if (validSession) {
      next()
      return
    }

    res.status(401).json({
      success: false,
      code: session ? 'SESSION_REVOKED' : 'SESSION_REQUIRED',
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

  if (!ticket) {
    const validSession = await requireFreshVideoSiteSession(req, res)
    if (validSession) {
      next()
      return
    }

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

app.post('/api/upload', upload.array('files', 32), async (req, res) => {
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
      const url = buildTempAssetUrl(baseUrl, file.filename, expiresAtMs)
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
        registerUploadedReference(item.resourceRef, file.size, file.mimetype, uploaded.expiresAtMs)
      } else if (materialType !== null && publiclyReachable && file.mimetype.startsWith('image/')) {
        const material = await createMaterialReferenceTask({
          name: buildMaterialName(file.originalname),
          originalUrl: url,
          type: materialType,
        })
        item.materialId = material.materialId
        item.materialStatus = material.status
        item.materialReviewPending = material.status !== 2
        item.materialError = material.errorMsg || null
        item.resourceRef = material.resourceRef
        registerUploadedReference(item.url, file.size, file.mimetype, expiresAtMs)
        registerUploadedReference(item.resourceRef, file.size, file.mimetype, expiresAtMs)
      } else {
        registerUploadedReference(item.url, file.size, file.mimetype, expiresAtMs)
        registerUploadedReference(item.resourceRef, file.size, file.mimetype, expiresAtMs)
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
    applyUpstreamTraceHeaders(res, error)
    res.status(statusCode).json({
      success: false,
      message: error.message || 'Upload failed',
      ...(error.requestId ? { requestId: error.requestId } : {}),
      ...(error.traceId ? { traceId: error.traceId } : {}),
    })
  }
})

app.post('/api/material/status', async (req, res) => {
  const missing = getMissingMaterialConfig()
  if (missing.length > 0) {
    res.status(500).json({
      success: false,
      message: `Missing backend config: ${missing.join(', ')}`,
    })
    return
  }

  const materialId = String(req.body?.materialId || '').trim()
  if (!materialId) {
    res.status(400).json({ success: false, message: 'materialId is required' })
    return
  }

  try {
    const material = await queryMaterialReferenceStatus(materialId)
    res.json({
      success: true,
      data: {
        materialId: material.materialId,
        status: material.status,
        errorMsg: material.errorMsg || null,
        resourceRef: material.resourceRef,
        materialReviewPending: material.status !== 2 && material.status !== 3,
      },
    })
  } catch (error) {
    const statusCode = Number(error.statusCode) || 502
    applyUpstreamTraceHeaders(res, error)
    res.status(statusCode).json({
      success: false,
      message: error.message || 'Material status query failed',
      ...(error.requestId ? { requestId: error.requestId } : {}),
      ...(error.traceId ? { traceId: error.traceId } : {}),
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
  const mediaSummary = resolveUsageMediaSummary(body, parseUsageMediaSummaryHeader(req))
  const requestedParams = extractRequestedVideoParams(body)
  const usageRequestParams = attachUsageMediaSummary(attachRequestedVideoParams(body, requestedParams), mediaSummary)
  const providerId = body.providerId || 'veo'
  const creditCharge = await prepareVideoCreditCharge(req, res, providerId, requestedParams, usageRequestParams)
  if (shouldChargeCreditsForProvider(providerId) && !creditCharge) return
  await proxyJson(req, res, `${videoApiBaseUrl}/openApi/generate`, {
    projectCode: process.env.VIDEO_PROJECT_CODE,
    'X-Access-Key': process.env.VIDEO_ACCESS_KEY,
    'X-Secret-Key': process.env.VIDEO_SECRET_KEY,
  }, ({ payload, traceMetadata, status, url }) => {
    if (status >= 400) return
    const taskId = extractAggregationTaskId(payload)
    insertChargedUsageLog({
      session: req.videoSiteSession,
      channel: 'aggregation',
      providerId,
      model: requestedParams.model || null,
      generationMode: body.mode || 't2v',
      prompt: body.prompt || null,
      aspectRatio: requestedParams.aspectRatio || null,
      resolution: requestedParams.resolution || null,
      duration: requestedParams.duration ?? null,
      sampleCount: requestedParams.sampleCount || 1,
      requestParams: usageRequestParams,
      engineTaskId: taskId || null,
      upstreamRequestId: traceMetadata?.requestId || null,
      upstreamTraceId: traceMetadata?.traceId || null,
      upstreamUrl: url,
      status: taskId ? 'submitted' : USAGE_STATUS_NEEDS_REVIEW,
      errorMessage: taskId ? null : UNTRACKED_USAGE_STATUS_MESSAGE,
    }, creditCharge).catch(() => {})
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
    const syncUpdate = buildAggregationUsageLogSyncUpdate({
      payload,
      requestedTaskId: req.body?.taskId,
      traceMetadata,
    })
    if (syncUpdate?.taskId && syncUpdate.updates) {
      updateUsageLogByTaskId(syncUpdate.taskId, syncUpdate.updates).catch(() => {})
      return
    }

    const taskId = extractAggregationTaskId(payload) || normalizeTaskIdValue(req.body?.taskId)
    const queryFailedMessage = payload?.success === false
      ? (extractAggregationTerminalMessage(payload) || '查询任务状态失败')
      : null

    if (taskId && queryFailedMessage) {
      updateUsageLogByTaskId(taskId, {
        status: 'failed',
        videoUrl: null,
        errorMessage: queryFailedMessage,
        completedAt: new Date().toISOString(),
        upstreamRequestId: traceMetadata?.requestId || null,
        upstreamTraceId: traceMetadata?.traceId || null,
      }).catch(() => {})
      return
    }

    const finalStatus = normalizeAggregationFinalStatus(extractAggregationStatus(payload))
    const finalMessage = finalStatus && finalStatus !== 'succeeded'
      ? extractAggregationTerminalMessage(payload)
      : null
    if (!taskId || !finalStatus) return
    updateUsageLogByTaskId(taskId, {
      status: finalStatus,
      videoUrl: finalStatus === 'succeeded' ? extractAggregationVideoUrl(payload) : null,
      errorMessage: finalMessage,
      completedAt: new Date().toISOString(),
      upstreamRequestId: traceMetadata?.requestId || null,
      upstreamTraceId: traceMetadata?.traceId || null,
    }).catch(() => {})
  })
})

app.get('/api/veo/media/:taskId', async (req, res) => {
  const missing = getMissingVideoConfig()
  if (missing.length > 0) {
    res.status(500).json({
      success: false,
      message: `Missing backend config: ${missing.join(', ')}`,
    })
    return
  }

  try {
    const taskId = normalizeTaskIdValue(req.params.taskId)
    if (!taskId) {
      throw createHttpError(400, 'taskId is required.')
    }

    const payload = await requestJson(
      videoApiBaseUrl,
      '/openApi/queryResult',
      {
        projectCode: process.env.VIDEO_PROJECT_CODE,
        'X-Access-Key': process.env.VIDEO_ACCESS_KEY,
        'X-Secret-Key': process.env.VIDEO_SECRET_KEY,
      },
      {
        taskId,
        abilityType: 'VIDEO',
      },
    )

    const traceMetadata = extractTraceMetadataFromPayload(payload)
    if (payload?.success === false) {
      throw createHttpError(502, extractAggregationTerminalMessage(payload) || '查询任务状态失败', traceMetadata)
    }

    const finalStatus = normalizeAggregationFinalStatus(extractAggregationStatus(payload))
    if (finalStatus !== 'succeeded') {
      const message = extractAggregationTerminalMessage(payload)
      if (finalStatus === 'failed' || finalStatus === 'cancelled') {
        throw createHttpError(409, message || '视频生成失败', traceMetadata)
      }

      throw createHttpError(409, message || 'Veo task is not ready for preview yet.', traceMetadata)
    }

    const mediaUrl = extractAggregationVideoUrl(payload)
    if (!mediaUrl) {
      throw createHttpError(404, 'Veo task succeeded, but no media URL was returned.', traceMetadata)
    }

    const mediaResponse = await fetch(mediaUrl, {
      headers: buildMediaProxyHeaders(req),
      redirect: 'follow',
    })

    if (!mediaResponse.ok) {
      const message = await readDreaminaUpstreamError(mediaResponse)
      throw createHttpError(mediaResponse.status, message || 'Veo media fetch failed.')
    }

    res.status(mediaResponse.status)
    copyUpstreamResponseHeaders(res, mediaResponse.headers)
    applyUpstreamTraceHeaders(res, traceMetadata)
    res.setHeader('Cache-Control', 'private, max-age=300')

    if (req.method === 'HEAD' || !mediaResponse.body) {
      res.end()
      return
    }

    Readable.fromWeb(mediaResponse.body).pipe(res)
  } catch (error) {
    const statusCode = Number(error.statusCode) || 502
    applyUpstreamTraceHeaders(res, error)
    res.status(statusCode).json({
      success: false,
      message: error.message || 'Veo media proxy failed',
      ...(error.requestId ? { requestId: error.requestId } : {}),
      ...(error.traceId ? { traceId: error.traceId } : {}),
    })
  }
})

app.post('/api/image/chat/completions', handleGeminiImageGenerateRequest)
app.post('/api/image/generate-content', handleGeminiImageGenerateRequest)
app.post('/api/gpt-image2/generations', handleGptImage2GenerateRequest)
app.post('/api/copywriting/chat/completions', handleCopywritingChatRequest)

async function handleCopywritingChatRequest(req, res) {
  const body = req.body || {}
  const upstream = resolveCopywritingProviderConfig(body.providerId)
  const apiKey = upstream.apiKey
  if (!apiKey) {
    res.status(500).json({
      error: {
        message: `Missing backend config: ${upstream.missingKeyName}`,
        type: 'config_error',
      },
    })
    return
  }

  const upstreamBody = normalizeCopywritingChatBody(body)
  if (!upstreamBody.model) {
    res.status(400).json({
      error: {
        message: 'Missing required field: model',
        type: 'request_error',
      },
    })
    return
  }

  if (!upstreamBody.messages.length) {
    res.status(400).json({
      error: {
        message: 'Missing required field: messages',
        type: 'request_error',
      },
    })
    return
  }

  const mediaSummary = parseUsageMediaSummaryHeader(req)
  await proxyJsonWithBody(
    req,
    res,
    upstream.apiUrl,
    upstreamBody,
    {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    ({ payload, traceMetadata, status, url }) => {
      const textResult = status < 400 ? extractCopywritingResponseText(payload) : null
      const errorMessage = status >= 400
        ? (payload?.error?.message || payload?.message || null)
        : (textResult ? null : 'Copywriting response did not contain text content')

      insertUsageLog({
        session: req.videoSiteSession,
        channel: 'copywriting',
        providerId: body.providerId || upstream.providerId,
        model: upstreamBody.model || null,
        generationMode: 'copywriting',
        prompt: extractCopywritingPromptText(upstreamBody.messages) || null,
        requestParams: attachUsageMediaSummary({
          model: upstreamBody.model || null,
          temperature: upstreamBody.temperature ?? null,
          max_tokens: upstreamBody.max_tokens ?? null,
        }, mediaSummary),
        upstreamRequestId: traceMetadata?.requestId || null,
        upstreamTraceId: traceMetadata?.traceId || null,
        upstreamUrl: url,
        status: textResult ? 'succeeded' : 'failed',
        errorMessage,
      }).catch(() => {})
    },
    {
      retry: COPYWRITING_RETRY_OPTIONS,
    },
  )
}

async function handleGptImage2GenerateRequest(req, res) {
  const apiKey = process.env.GPT_IMAGE2_API_KEY?.trim()
  if (!apiKey) {
    res.status(500).json({
      error: {
        message: 'Missing backend config: GPT_IMAGE2_API_KEY',
        type: 'config_error',
      },
    })
    return
  }

  const body = req.body || {}
  const upstreamBody = normalizeGptImage2GenerateBody(body)
  if (!upstreamBody.model) {
    res.status(400).json({
      error: {
        message: 'Missing required field: model',
        type: 'request_error',
      },
    })
    return
  }

  if (!upstreamBody.prompt) {
    res.status(400).json({
      error: {
        message: 'Missing required field: prompt',
        type: 'request_error',
      },
    })
    return
  }

  const mediaSummary = parseUsageMediaSummaryHeader(req)
  const upstreamUrl = `${gptImage2ApiBaseUrl}/v1/images/generations`
  if (upstreamBody.n > 1) {
    await handleGptImage2FanoutGenerateRequest(req, res, {
      body,
      upstreamBody,
      upstreamUrl,
      apiKey,
      mediaSummary,
    })
    return
  }

  await proxyJsonWithBody(
    req,
    res,
    upstreamUrl,
    upstreamBody,
    {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    ({ payload, traceMetadata, status, url }) => {
      const imageResult = status < 400 ? extractImageResponseResult(payload, upstreamBody.prompt) : null
      const errorMessage = status >= 400
        ? (payload?.error?.message || payload?.message || null)
        : (imageResult ? null : buildImageResponseParseError(payload))

      insertUsageLog({
        session: req.videoSiteSession,
        channel: 'image',
        providerId: body.providerId || 'gpt-image2',
        model: upstreamBody.model || null,
        generationMode: upstreamBody.image?.length ? 'image-to-image' : 'text-to-image',
        prompt: upstreamBody.prompt || null,
        resolution: upstreamBody.size || null,
        sampleCount: upstreamBody.n || null,
        requestParams: attachUsageMediaSummary({
          model: upstreamBody.model || null,
          size: upstreamBody.size || null,
          n: upstreamBody.n || null,
          quality: upstreamBody.quality || null,
          format: upstreamBody.format || null,
          mediaCounts: { images: upstreamBody.image?.length || 0, videos: 0, audios: 0 },
        }, mediaSummary),
        upstreamRequestId: traceMetadata?.requestId || null,
        upstreamTraceId: traceMetadata?.traceId || null,
        upstreamUrl: url,
        status: imageResult ? 'succeeded' : 'failed',
        errorMessage,
      }).catch(() => {})
    },
  )
}

async function handleGptImage2FanoutGenerateRequest(req, res, {
  body,
  upstreamBody,
  upstreamUrl,
  apiKey,
  mediaSummary,
}) {
  const upstreamHeaders = {
    Accept: 'application/json',
    Authorization: `Bearer ${apiKey}`,
  }
  const fanoutBodies = Array.from({ length: upstreamBody.n }, () => ({
    ...upstreamBody,
    n: 1,
  }))
  const fanoutResults = await Promise.allSettled(
    fanoutBodies.map(async (fanoutBody, index) => {
      try {
        return await fetchGptImage2FanoutResult(req, upstreamUrl, fanoutBody, upstreamHeaders, index)
      } catch (error) {
        error.fanoutIndex = index
        throw error
      }
    }),
  )

  const successfulPayloads = fanoutResults
    .filter((result) => result.status === 'fulfilled' && result.value.succeeded)
    .map((result) => result.value)
  const failedResults = fanoutResults
    .filter((result) => result.status === 'rejected' || !result.value.succeeded)

  const aggregatePayload = aggregateGptImage2FanoutPayload(successfulPayloads, failedResults, upstreamBody)
  const traceMetadata = resolveGptImage2FanoutTraceMetadata(successfulPayloads, failedResults)
  const errorMessage = failedResults.length > 0
    ? aggregatePayload.partial_error?.message || 'Some image generation requests failed.'
    : null

  insertUsageLog({
    session: req.videoSiteSession,
    channel: 'image',
    providerId: body.providerId || 'gpt-image2',
    model: upstreamBody.model || null,
    generationMode: upstreamBody.image?.length ? 'image-to-image' : 'text-to-image',
    prompt: upstreamBody.prompt || null,
    resolution: upstreamBody.size || null,
    sampleCount: upstreamBody.n || null,
    requestParams: attachUsageMediaSummary({
      model: upstreamBody.model || null,
      size: upstreamBody.size || null,
      n: upstreamBody.n || null,
      quality: upstreamBody.quality || null,
      format: upstreamBody.format || null,
      mediaCounts: { images: upstreamBody.image?.length || 0, videos: 0, audios: 0 },
      fanout: {
        requestedCount: upstreamBody.n,
        succeededCount: successfulPayloads.length,
        failedCount: failedResults.length,
      },
    }, mediaSummary),
    upstreamRequestId: traceMetadata?.requestId || null,
    upstreamTraceId: traceMetadata?.traceId || null,
    upstreamUrl,
    status: successfulPayloads.length > 0 ? 'succeeded' : 'failed',
    errorMessage,
  }).catch(() => {})

  applyUpstreamTraceHeaders(res, traceMetadata)
  if (successfulPayloads.length > 0) {
    res.status(200).json(aggregatePayload)
    return
  }

  res.status(resolveGptImage2FanoutFailureStatus(failedResults)).json({
    error: {
      message: resolveGptImage2FanoutFailureMessage(failedResults),
      type: 'image_generation_error',
    },
    ...aggregatePayload,
  })
}

async function fetchGptImage2FanoutResult(req, upstreamUrl, upstreamBody, headers, index) {
  const result = await fetchProxyJsonResult(req, upstreamUrl, upstreamBody, headers)
  const { response, parsedPayload, traceMetadata } = result
  const imageResult = response.status < 400
    ? extractImageResponseResult(parsedPayload, upstreamBody.prompt)
    : null
  const errorMessage = response.status >= 400
    ? readGptImage2ErrorMessage(parsedPayload, response.status)
    : (imageResult ? null : buildImageResponseParseError(parsedPayload))

  return {
    index,
    status: response.status,
    payload: injectUpstreamTraceMetadata(parsedPayload, traceMetadata),
    traceMetadata,
    imageResult,
    errorMessage,
    succeeded: response.status < 400 && Boolean(imageResult),
  }
}

function aggregateGptImage2FanoutPayload(successfulPayloads, failedResults, upstreamBody) {
  const requestedCount = upstreamBody.n
  const data = successfulPayloads.map((result) => ({
    url: result.imageResult.url,
    revised_prompt: result.imageResult.revisedPrompt || upstreamBody.prompt || '',
    fanout_index: result.index + 1,
  }))
  const payload = {
    object: 'list',
    created: Math.floor(Date.now() / 1000),
    data,
    fanout: {
      requestedCount: upstreamBody.n,
      succeededCount: successfulPayloads.length,
      failedCount: failedResults.length,
    },
  }

  if (failedResults.length > 0) {
    payload.partial_error = {
      type: 'partial_error',
      message: `Generated ${successfulPayloads.length} of ${requestedCount} requested images. ${failedResults.length} request(s) failed.`,
      failures: failedResults.map(summarizeGptImage2FanoutFailure),
    }
  }

  return payload
}

function summarizeGptImage2FanoutFailure(result) {
  if (result.status === 'rejected') {
    return {
      index: Number.isInteger(result.reason?.fanoutIndex) ? result.reason.fanoutIndex + 1 : null,
      type: 'network_error',
      message: result.reason?.message || 'Upstream request failed.',
      ...(result.reason?.requestId ? { requestId: result.reason.requestId } : {}),
      ...(result.reason?.traceId ? { traceId: result.reason.traceId } : {}),
    }
  }

  return {
    index: result.value.index + 1,
    type: result.value.status >= 400 ? 'upstream_error' : 'parse_error',
    status: result.value.status,
    message: result.value.errorMessage || 'Image generation finished without a parseable image.',
    ...(result.value.traceMetadata?.requestId ? { requestId: result.value.traceMetadata.requestId } : {}),
    ...(result.value.traceMetadata?.traceId ? { traceId: result.value.traceMetadata.traceId } : {}),
  }
}

function resolveGptImage2FanoutTraceMetadata(successfulPayloads, failedResults) {
  const successfulTrace = successfulPayloads.find((result) => result.traceMetadata?.requestId || result.traceMetadata?.traceId)?.traceMetadata
  if (successfulTrace) return successfulTrace

  for (const result of failedResults) {
    if (result.status === 'fulfilled' && (result.value.traceMetadata?.requestId || result.value.traceMetadata?.traceId)) {
      return result.value.traceMetadata
    }
    if (result.status === 'rejected' && (result.reason?.requestId || result.reason?.traceId)) {
      return result.reason
    }
  }

  return {}
}

function resolveGptImage2FanoutFailureStatus(failedResults) {
  const statuses = failedResults
    .filter((result) => result.status === 'fulfilled')
    .map((result) => Number(result.value.status))
    .filter((status) => Number.isInteger(status) && status >= 400)

  if (statuses.includes(401)) return 401
  if (statuses.includes(403)) return 403
  if (statuses.includes(429)) return 429
  if (statuses.includes(400)) return 400
  return statuses[0] || 502
}

function resolveGptImage2FanoutFailureMessage(failedResults) {
  const firstFailure = failedResults[0]
  if (!firstFailure) return 'Image generation failed.'
  if (firstFailure.status === 'rejected') {
    return firstFailure.reason?.message || 'Upstream request failed.'
  }

  return firstFailure.value.errorMessage || 'Image generation failed.'
}

function readGptImage2ErrorMessage(payload, status) {
  return readFirstString(
    payload?.error?.message,
    payload?.message,
    payload?.msg,
  ) || `Upstream image generation request failed with status ${status}.`
}

async function handleGeminiImageGenerateRequest(req, res) {
  if (!process.env.IMAGE_API_KEY) {
    res.status(500).json({
      error: {
        message: 'Missing backend config: IMAGE_API_KEY',
        type: 'config_error',
      },
    })
    return
  }

  const body = normalizeGeminiImageRequestBody(req.body || {})
  const model = typeof body?.model === 'string' ? body.model.trim() : ''
  if (!model) {
    res.status(400).json({
      error: {
        message: 'Missing required field: model',
        type: 'request_error',
      },
    })
    return
  }

  const contents = Array.isArray(body?.contents) ? body.contents : []
  if (contents.length === 0) {
    res.status(400).json({
      error: {
        message: 'Missing required field: contents',
        type: 'request_error',
      },
    })
    return
  }

  const mediaSummary = parseUsageMediaSummaryHeader(req)
  const upstreamBody = {
    contents,
    ...(body.generationConfig ? { generationConfig: body.generationConfig } : {}),
    ...(body.systemInstruction ? { systemInstruction: body.systemInstruction } : {}),
    ...(body.tools ? { tools: body.tools } : {}),
  }
  const upstreamUrl = buildGeminiGenerateContentUrl(imageApiBaseUrl, model)

  try {
    const response = await fetch(upstreamUrl, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.IMAGE_API_KEY,
        Authorization: `Bearer ${process.env.IMAGE_API_KEY}`,
      },
      body: JSON.stringify(upstreamBody),
    })

    const buffer = Buffer.from(await response.arrayBuffer())
    const contentType = response.headers.get('content-type') || ''
    const parsedPayload = tryParseJsonBuffer(buffer, contentType)
    const traceMetadata = extractUpstreamTraceMetadata(response, parsedPayload)
    const imagePrompt = extractImagePromptText(body) || ''
    const imageResult = response.status < 400 ? extractImageResponseResult(parsedPayload, imagePrompt) : null
    const normalizedPayload = response.status < 400
      ? await inlineImageResultIntoPayload(parsedPayload, imageResult)
      : parsedPayload
    const tracedPayload = injectUpstreamTraceMetadata(normalizedPayload, traceMetadata)
    const succeeded = response.status < 400 && Boolean(imageResult)
    const imageErrorMessage = response.status >= 400
      ? (parsedPayload?.error?.message || null)
      : (succeeded ? null : buildImageResponseParseError(parsedPayload))

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
      upstreamUrl,
      status: succeeded ? 'succeeded' : 'failed',
      errorMessage: imageErrorMessage,
    }).catch(() => {})

    if (response.status < 400 && !imageResult) {
      applyUpstreamTraceHeaders(res, traceMetadata)
      res.status(422).json({
        error: {
          message: imageErrorMessage || 'Image generation completed but no image data was found in the response.',
          type: 'image_generation_error',
        },
        ...(traceMetadata.requestId ? { requestId: traceMetadata.requestId } : {}),
        ...(traceMetadata.traceId ? { traceId: traceMetadata.traceId } : {}),
      })
      return
    }

    res.status(response.status)
    copyUpstreamResponseHeaders(res, response.headers)
    applyUpstreamTraceHeaders(res, traceMetadata)

    if (tracedPayload !== null) {
      if (!res.getHeader('Content-Type')) {
        res.setHeader('Content-Type', contentType || 'application/json; charset=utf-8')
      }
      res.send(JSON.stringify(tracedPayload))
      return
    }

    res.end(buffer)
  } catch (error) {
    applyUpstreamTraceHeaders(res, error)
    res.status(502).json({
      success: false,
      message: error.message || 'Upstream request failed',
      ...(error.requestId ? { requestId: error.requestId } : {}),
      ...(error.traceId ? { traceId: error.traceId } : {}),
    })
  }
}

app.post('/api/image/aggregation/generate', async (req, res) => {
  const missing = getMissingImageAggregationConfig()
  if (missing.length > 0) {
    res.status(500).json({
      success: false,
      message: `Missing backend config: ${missing.join(', ')}`,
    })
    return
  }

  const body = req.body || {}
  const mediaSummary = parseUsageMediaSummaryHeader(req)
  const upstreamBody = normalizeAggregationImageGenerateBody(body)

  await proxyJsonWithBody(req, res, `${imageAggregationApiBaseUrl}/openApi/generate`, upstreamBody, buildImageAggregationHeaders(), ({ payload, traceMetadata, status, url }) => {
    if (status >= 400) return
    const taskId = extractAggregationTaskId(payload)
    insertUsageLog({
      session: req.videoSiteSession,
      channel: 'image',
      providerId: body.providerId || 'gemini-image-aggregation',
      model: upstreamBody.modelId || body.modelId || body.model || null,
      generationMode: 'image',
      prompt: upstreamBody.prompt || null,
      aspectRatio: upstreamBody.payload?.params?.scale || null,
      resolution: upstreamBody.payload?.params?.resolution || null,
      sampleCount: 1,
      requestParams: attachUsageMediaSummary({
        modelId: upstreamBody.modelId || null,
        abilityType: 'IMAGE',
        payload: upstreamBody.payload || null,
      }, mediaSummary),
      engineTaskId: taskId || null,
      upstreamRequestId: traceMetadata?.requestId || null,
      upstreamTraceId: traceMetadata?.traceId || null,
      upstreamUrl: url,
      status: taskId ? 'submitted' : USAGE_STATUS_NEEDS_REVIEW,
      errorMessage: taskId ? null : UNTRACKED_USAGE_STATUS_MESSAGE,
    }).catch(() => {})
  })
})

app.post('/api/image/aggregation/queryResult', async (req, res) => {
  const missing = getMissingImageAggregationConfig()
  if (missing.length > 0) {
    res.status(500).json({
      success: false,
      message: `Missing backend config: ${missing.join(', ')}`,
    })
    return
  }

  const upstreamBody = normalizeAggregationImageQueryBody(req.body || {})

  await proxyJsonWithBody(req, res, `${imageAggregationApiBaseUrl}/openApi/queryResult`, upstreamBody, buildImageAggregationHeaders(), ({ payload, traceMetadata }) => {
    const syncUpdate = buildAggregationUsageLogSyncUpdate({
      payload,
      requestedTaskId: upstreamBody.taskId,
      traceMetadata,
      mediaUrlResolver: extractAggregationImageUrl,
    })
    if (syncUpdate?.taskId && syncUpdate.updates) {
      updateUsageLogByTaskId(syncUpdate.taskId, syncUpdate.updates).catch(() => {})
    }
  })
})

app.post('/api/yunwu/generate', async (req, res) => {
  const missing = getMissingYunwuConfig()
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
    const requestedParams = extractRequestedVideoParams(body)
    const usageRequestParams = attachUsageMediaSummary(attachRequestedVideoParams(body, requestedParams), mediaSummary)
    const requestSpec = buildYunwuGenerateRequest(body)
    const upstream = await requestYunwu(requestSpec)
    const traceMetadata = extractUpstreamTraceMetadata(upstream.response, upstream.payload)
    const normalized = normalizeYunwuGenerateResponse(upstream.payload, requestSpec, traceMetadata)

    insertUsageLog({
      session: req.videoSiteSession,
      channel: 'yunwu',
      providerId: body.providerId || null,
      model: requestedParams.model || requestSpec.body?.model || requestSpec.body?.model_name || null,
      generationMode: body.mode || 't2v',
      prompt: body.prompt || null,
      aspectRatio: requestedParams.aspectRatio || null,
      resolution: requestedParams.resolution || null,
      duration: requestedParams.duration ?? null,
      requestParams: usageRequestParams,
      engineTaskId: normalized.taskId || null,
      upstreamRequestId: traceMetadata?.requestId || null,
      upstreamTraceId: traceMetadata?.traceId || null,
      upstreamUrl: `${yunwuApiBaseUrl}${requestSpec.path}`,
      status: normalized.taskId ? 'submitted' : USAGE_STATUS_NEEDS_REVIEW,
      errorMessage: normalized.taskId ? null : UNTRACKED_USAGE_STATUS_MESSAGE,
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
      message: error.message || 'Yunwu generate failed',
      ...(error.requestId ? { requestId: error.requestId } : {}),
      ...(error.traceId ? { traceId: error.traceId } : {}),
    })
  }
})

app.post('/api/yunwu/query', async (req, res) => {
  const missing = getMissingYunwuConfig()
  if (missing.length > 0) {
    res.status(500).json({
      success: false,
      message: `Missing backend config: ${missing.join(', ')}`,
    })
    return
  }

  try {
    const requestSpec = buildYunwuQueryRequest(req.body || {})
    const upstream = await requestYunwu(requestSpec)
    const traceMetadata = extractUpstreamTraceMetadata(upstream.response, upstream.payload)
    const normalized = normalizeYunwuQueryResponse(upstream.payload, requestSpec, traceMetadata)

    if (normalized.status === 'succeeded' || normalized.status === 'failed') {
      const taskId = normalized.taskId || req.body?.taskId
      if (taskId) {
        updateUsageLogByTaskId(taskId, {
          status: normalized.status,
          videoUrl: normalized.videoUrl || null,
          errorMessage: normalized.status === 'failed' ? (normalized.message || null) : null,
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
      message: error.message || 'Yunwu query failed',
      ...(error.requestId ? { requestId: error.requestId } : {}),
      ...(error.traceId ? { traceId: error.traceId } : {}),
    })
  }
})

app.post('/api/ark/generate', async (req, res) => {
  const missing = getMissingArkConfig()
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
    const requestedParams = extractRequestedVideoParams(body)
    const usageRequestParams = attachUsageMediaSummary(attachRequestedVideoParams(body, requestedParams), mediaSummary)
    const requestSpec = buildArkGenerateRequest(body)
    const upstream = await requestArk(requestSpec)
    const traceMetadata = extractUpstreamTraceMetadata(upstream.response, upstream.payload)
    const normalized = normalizeYunwuGenerateResponse(upstream.payload, requestSpec, traceMetadata)

    insertUsageLog({
      session: req.videoSiteSession,
      channel: 'ark',
      providerId: body.providerId || null,
      model: requestedParams.model || requestSpec.body?.model || null,
      generationMode: body.mode || 't2v',
      prompt: body.prompt || null,
      aspectRatio: requestedParams.aspectRatio || null,
      resolution: requestedParams.resolution || null,
      duration: requestedParams.duration ?? null,
      requestParams: usageRequestParams,
      engineTaskId: normalized.taskId || null,
      upstreamRequestId: traceMetadata?.requestId || null,
      upstreamTraceId: traceMetadata?.traceId || null,
      upstreamUrl: `${arkApiBaseUrl}${requestSpec.path}`,
      status: normalized.taskId ? 'submitted' : USAGE_STATUS_NEEDS_REVIEW,
      errorMessage: normalized.taskId ? null : UNTRACKED_USAGE_STATUS_MESSAGE,
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
      message: error.message || 'Ark generate failed',
      ...(error.requestId ? { requestId: error.requestId } : {}),
      ...(error.traceId ? { traceId: error.traceId } : {}),
    })
  }
})

app.post('/api/ark/query', async (req, res) => {
  const missing = getMissingArkConfig()
  if (missing.length > 0) {
    res.status(500).json({
      success: false,
      message: `Missing backend config: ${missing.join(', ')}`,
    })
    return
  }

  try {
    const requestSpec = buildArkQueryRequest(req.body || {})
    const upstream = await requestArk(requestSpec)
    const traceMetadata = extractUpstreamTraceMetadata(upstream.response, upstream.payload)
    const normalized = normalizeYunwuQueryResponse(upstream.payload, requestSpec, traceMetadata)

    if (normalized.status === 'succeeded' || normalized.status === 'failed') {
      const taskId = normalized.taskId || req.body?.taskId
      if (taskId) {
        updateUsageLogByTaskId(taskId, {
          status: normalized.status,
          videoUrl: normalized.status === 'succeeded' ? (normalized.videoUrl || null) : null,
          errorMessage: normalized.status === 'failed' ? (normalized.message || null) : null,
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
      message: error.message || 'Ark query failed',
      ...(error.requestId ? { requestId: error.requestId } : {}),
      ...(error.traceId ? { traceId: error.traceId } : {}),
    })
  }
})

app.get('/api/ark/media/:taskId', async (req, res) => {
  try {
    const requestSpec = buildArkQueryRequest({
      providerId: 'seedance3',
      taskId: req.params.taskId,
    })
    const upstream = await requestArk(requestSpec)
    const traceMetadata = extractUpstreamTraceMetadata(upstream.response, upstream.payload)
    const normalized = normalizeYunwuQueryResponse(upstream.payload, requestSpec, traceMetadata)
    const mediaUrl = normalized.videoUrl || null

    if (normalized.status !== 'succeeded' && normalized.status !== 'completed') {
      throw createHttpError(409, 'Ark task is not ready for preview yet.')
    }

    if (!mediaUrl) {
      throw createHttpError(404, 'Ark task succeeded, but no media URL was returned.')
    }

    const mediaResponse = await fetch(mediaUrl, {
      headers: buildMediaProxyHeaders(req),
      redirect: 'follow',
    })

    if (!mediaResponse.ok) {
      const message = await readDreaminaUpstreamError(mediaResponse)
      throw createHttpError(mediaResponse.status, message || 'Ark media fetch failed.')
    }

    res.status(mediaResponse.status)
    copyUpstreamResponseHeaders(res, mediaResponse.headers)
    res.setHeader('Cache-Control', 'private, max-age=300')

    if (req.method === 'HEAD' || !mediaResponse.body) {
      res.end()
      return
    }

    Readable.fromWeb(mediaResponse.body).pipe(res)
  } catch (error) {
    const statusCode = Number(error.statusCode) || 502
    res.status(statusCode).json({
      success: false,
      message: error.message || 'Ark media proxy failed',
    })
  }
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
    const requestedParams = extractRequestedVideoParams(body)
    const usageRequestParams = attachUsageMediaSummary(attachRequestedVideoParams(body, requestedParams), mediaSummary)
    const requestSpec = buildDashScopeWanGenerateRequest(body)
    const upstream = await requestDashScope(requestSpec)
    const traceMetadata = extractUpstreamTraceMetadata(upstream.response, upstream.payload)
    const normalized = normalizeYunwuGenerateResponse(upstream.payload, requestSpec, traceMetadata)

    insertUsageLog({
      session: req.videoSiteSession,
      channel: 'wan',
      providerId: body.providerId || 'wan1',
      model: requestedParams.model || requestSpec.body?.model || null,
      generationMode: body.mode || 'fusion',
      prompt: body.prompt || null,
      aspectRatio: requestedParams.aspectRatio || null,
      resolution: requestedParams.resolution || null,
      duration: requestedParams.duration ?? null,
      requestParams: usageRequestParams,
      engineTaskId: normalized.taskId || null,
      upstreamRequestId: traceMetadata?.requestId || null,
      upstreamTraceId: traceMetadata?.traceId || null,
      upstreamUrl: `${dashScopeBaseUrl}${requestSpec.path}`,
      status: normalized.taskId ? 'submitted' : USAGE_STATUS_NEEDS_REVIEW,
      errorMessage: normalized.taskId ? null : UNTRACKED_USAGE_STATUS_MESSAGE,
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
    const normalized = normalizeYunwuQueryResponse(upstream.payload, requestSpec, traceMetadata)

    if (normalized.status === 'succeeded' || normalized.status === 'failed') {
      const taskId = normalized.taskId || req.body?.taskId
      if (taskId) {
        updateUsageLogByTaskId(taskId, {
          status: normalized.status,
          videoUrl: normalized.videoUrl || null,
          errorMessage: normalized.status === 'failed' ? (normalized.message || null) : null,
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

app.post('/api/dreamina/generate', async (req, res) => {
  try {
    const body = req.body || {}
    const mediaSummary = resolveUsageMediaSummary(body, parseUsageMediaSummaryHeader(req))
    const requestedParams = extractRequestedVideoParams(body)
    const requestSpec = await buildDreaminaGenerateRequest(body)
    const finalRequestedParams = {
      ...requestedParams,
      resolution: requestSpec.resolution || requestedParams.resolution,
      duration: requestSpec.duration ?? requestedParams.duration,
      sampleCount: requestedParams.sampleCount || 1,
    }
    const usageRequestParams = attachUsageMediaSummary(attachRequestedVideoParams(body, finalRequestedParams), mediaSummary)
    const cliResult = await executeDreaminaCli(requestSpec.args)
    const normalized = normalizeDreaminaGenerateResponse(cliResult.payload, requestSpec)
    const terminalStatus = normalizeDreaminaTerminalUsageStatus(normalized.status)

    insertUsageLog({
      session: req.videoSiteSession,
      channel: 'dreamina',
      providerId: requestSpec.providerId,
      model: requestSpec.model,
      generationMode: requestSpec.mode,
      prompt: body.prompt || null,
      aspectRatio: requestSpec.aspectRatio || requestedParams.aspectRatio || null,
      resolution: requestSpec.resolution || requestedParams.resolution || null,
      duration: requestSpec.duration ?? requestedParams.duration ?? null,
      sampleCount: requestedParams.sampleCount || 1,
      requestParams: usageRequestParams,
      engineTaskId: normalized.taskId || null,
      upstreamUrl: `dreamina-cli://${requestSpec.command}`,
      status: terminalStatus || (normalized.taskId ? 'submitted' : USAGE_STATUS_NEEDS_REVIEW),
      errorMessage: terminalStatus === 'failed' || terminalStatus === 'cancelled'
        ? (normalized.message || null)
        : normalized.taskId
        ? null
        : UNTRACKED_USAGE_STATUS_MESSAGE,
      videoUrl: terminalStatus === 'succeeded' ? (normalized.videoUrl || normalized.imageUrl || null) : null,
      completedAt: terminalStatus ? new Date().toISOString() : null,
    }).catch(() => {})

    res.json({
      success: true,
      data: normalized,
    })
  } catch (error) {
    const statusCode = Number(error.statusCode) || 502
    res.status(statusCode).json({
      success: false,
      message: error.message || 'Dreamina generate failed',
    })
  }
})

app.post('/api/dreamina/query', async (req, res) => {
  try {
    const requestSpec = buildDreaminaQueryRequest(req.body || {})
    const cliResult = await executeDreaminaCli(requestSpec.args)
    const normalized = normalizeDreaminaQueryResponse(cliResult.payload, requestSpec)
    const terminalStatus = normalizeDreaminaTerminalUsageStatus(normalized.status)

    if (terminalStatus) {
      updateUsageLogByTaskId(requestSpec.taskId, {
        status: terminalStatus,
        videoUrl: terminalStatus === 'succeeded' ? (normalized.videoUrl || normalized.imageUrl || null) : null,
        errorMessage: terminalStatus === 'failed' || terminalStatus === 'cancelled'
          ? (normalized.message || null)
          : null,
        completedAt: new Date().toISOString(),
      }).catch(() => {})
    }

    res.json({
      success: true,
      data: normalized,
    })
  } catch (error) {
    const statusCode = Number(error.statusCode) || 502
    res.status(statusCode).json({
      success: false,
      message: error.message || 'Dreamina query failed',
    })
  }
})

app.get('/api/dreamina/media/:taskId', async (req, res) => {
  try {
    const requestSpec = buildDreaminaQueryRequest({
      providerId: 'seedance2',
      taskId: req.params.taskId,
    })
    const cliResult = await executeDreaminaCli(requestSpec.args)
    const normalized = normalizeDreaminaQueryResponse(cliResult.payload, requestSpec)
    const mediaUrl = normalized.videoUrl || normalized.imageUrl || null

    if (normalized.status !== 'succeeded' && normalized.status !== 'completed') {
      throw createHttpError(409, 'Dreamina task is not ready for preview yet.')
    }

    if (!mediaUrl) {
      throw createHttpError(404, 'Dreamina task succeeded, but no media URL was returned.')
    }

    const upstream = await fetch(mediaUrl, {
      headers: buildMediaProxyHeaders(req),
      redirect: 'follow',
    })

    if (!upstream.ok) {
      const message = await readDreaminaUpstreamError(upstream)
      throw createHttpError(upstream.status, message || 'Dreamina media fetch failed.')
    }

    res.status(upstream.status)
    copyUpstreamResponseHeaders(res, upstream.headers)
    res.setHeader('Cache-Control', 'private, max-age=300')

    if (req.method === 'HEAD' || !upstream.body) {
      res.end()
      return
    }

    Readable.fromWeb(upstream.body).pipe(res)
  } catch (error) {
    const statusCode = Number(error.statusCode) || 502
    res.status(statusCode).json({
      success: false,
      message: error.message || 'Dreamina media proxy failed',
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

function normalizeGeminiImageRequestBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return body
  }

  const normalized = JSON.parse(JSON.stringify(body))
  if (Array.isArray(normalized.contents)) {
    normalized.contents = normalized.contents.map(normalizeGeminiContentItem)
  } else if (Array.isArray(normalized.messages)) {
    normalized.contents = convertOpenAiMessagesToGeminiContents(normalized.messages)
  }

  if (normalized.generationConfig?.imageConfig && typeof normalized.generationConfig.imageConfig === 'object') {
    const nextImageConfig = {}
    if (typeof normalized.generationConfig.imageConfig.aspectRatio === 'string' && normalized.generationConfig.imageConfig.aspectRatio.trim()) {
      nextImageConfig.aspectRatio = normalized.generationConfig.imageConfig.aspectRatio.trim()
    }
    if (typeof normalized.generationConfig.imageConfig.imageSize === 'string' && normalized.generationConfig.imageConfig.imageSize.trim()) {
      nextImageConfig.imageSize = normalized.generationConfig.imageConfig.imageSize.trim()
    }
    normalized.generationConfig.imageConfig = nextImageConfig
  }

  delete normalized.messages

  return normalized
}

function normalizeGeminiContentItem(item) {
  if (!item || typeof item !== 'object') {
    return item
  }

  if (!Array.isArray(item.parts)) {
    return item
  }

  return {
    ...item,
    parts: item.parts.map(normalizeGeminiPartItem),
  }
}

function convertOpenAiMessagesToGeminiContents(messages) {
  return messages
    .filter((message) => message && typeof message === 'object')
    .map((message) => {
      const content = Array.isArray(message.content)
        ? message.content.map(normalizeOpenAiImageContentItem)
        : [{ type: 'text', text: typeof message.content === 'string' ? message.content : '' }]
      const parts = content
        .map(convertOpenAiContentItemToGeminiPart)
        .filter(Boolean)

      return parts.length > 0 ? { parts } : null
    })
    .filter(Boolean)
}

function normalizeOpenAiImageContentItem(item) {
  if (!item || typeof item !== 'object') {
    return item
  }

  if (item.type === 'image_base64' && typeof item.image_base64 === 'string' && item.image_base64.trim()) {
    return {
      ...item,
      type: 'image_url',
      image_url: {
        url: buildDataUrlFromImageItem(item),
      },
    }
  }

  if (item.type === 'image_url' && typeof item.image_url === 'string' && item.image_url.trim()) {
    return {
      ...item,
      image_url: {
        url: item.image_url.trim(),
      },
    }
  }

  return item
}

function normalizeGeminiPartItem(part) {
  if (!part || typeof part !== 'object') {
    return part
  }

  if (part.inline_data && typeof part.inline_data === 'object') {
    return {
      ...part,
      inline_data: normalizeGeminiInlineData(part.inline_data),
    }
  }

  if (part.inlineData && typeof part.inlineData === 'object') {
    return {
      ...part,
      inline_data: normalizeGeminiInlineData(part.inlineData),
    }
  }

  return part
}

function normalizeGeminiInlineData(inlineData) {
  const mimeType = typeof inlineData?.mime_type === 'string'
    ? inlineData.mime_type
    : (typeof inlineData?.mimeType === 'string' ? inlineData.mimeType : 'image/png')
  const data = typeof inlineData?.data === 'string' ? inlineData.data.replace(/\s/g, '') : ''

  return {
    mime_type: mimeType,
    data,
  }
}

function convertOpenAiContentItemToGeminiPart(item) {
  if (!item || typeof item !== 'object') {
    return null
  }

  if (item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
    return { text: item.text.trim() }
  }

  if (item.type === 'image_base64' && typeof item.image_base64 === 'string' && item.image_base64.trim()) {
    const dataUrl = buildDataUrlFromImageItem(item)
    const inlineData = parseGeminiInlineDataFromDataUrl(dataUrl)
    return inlineData ? { inline_data: inlineData } : null
  }

  if (item.type === 'image_url') {
    const rawUrl = typeof item.image_url === 'string'
      ? item.image_url
      : item.image_url?.url
    const inlineData = parseGeminiInlineDataFromDataUrl(rawUrl)
    return inlineData ? { inline_data: inlineData } : null
  }

  return null
}

function parseGeminiInlineDataFromDataUrl(value) {
  if (typeof value !== 'string') {
    return null
  }

  const match = value.trim().match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i)
  if (!match) {
    return null
  }

  return {
    mime_type: match[1],
    data: match[2].replace(/\s/g, ''),
  }
}

function buildDataUrlFromImageItem(item) {
  const rawValue = typeof item?.image_base64 === 'string' ? item.image_base64.trim() : ''
  if (!rawValue) {
    return ''
  }

  if (/^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+$/i.test(rawValue)) {
    return rawValue.replace(/\s/g, '')
  }

  const mimeType = typeof item?.mime_type === 'string'
    ? item.mime_type
    : (typeof item?.mimeType === 'string' ? item.mimeType : 'image/png')

  return `data:${mimeType};base64,${rawValue.replace(/\s/g, '')}`
}

function extractImagePromptText(body) {
  const parts = readGeminiRequestParts(body)
  if (parts.length > 0) {
    return parts
      .filter((item) => typeof item?.text === 'string')
      .map((item) => item.text.trim())
      .filter(Boolean)
      .join('\n')
  }

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
  const parts = readGeminiRequestParts(body)
  if (parts.length > 0) {
    const imageCount = parts.filter((item) => (
      item?.inline_data?.data || item?.inlineData?.data
    )).length
    return { images: imageCount, videos: 0, audios: 0 }
  }

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

function readGeminiRequestParts(body) {
  const contents = Array.isArray(body?.contents) ? body.contents : []
  const lastContent = contents[contents.length - 1]
  return Array.isArray(lastContent?.parts) ? lastContent.parts : []
}

function buildImageResponseParseError(data) {
  const textFailureMessage = extractImageTextFailureMessage(data)
  if (textFailureMessage) {
    return textFailureMessage
  }

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

function extractImageTextFailureMessage(data) {
  const candidates = []
  const content = data?.choices?.[0]?.message?.content
  if (typeof content === 'string') {
    candidates.push(content)
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item?.text === 'string') {
        candidates.push(item.text)
      }
    }
  }

  const messageParts = data?.choices?.[0]?.message?.parts
  if (Array.isArray(messageParts)) {
    for (const part of messageParts) {
      if (typeof part?.text === 'string') {
        candidates.push(part.text)
      }
    }
  }

  const geminiCandidates = Array.isArray(data?.candidates) ? data.candidates : []
  for (const candidate of geminiCandidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []
    for (const part of parts) {
      if (typeof part?.text === 'string') {
        candidates.push(part.text)
      }
    }
  }

  for (const candidate of candidates) {
    const normalizedMessage = normalizeImageTextFailureMessage(candidate)
    if (normalizedMessage) {
      return normalizedMessage
    }
  }

  return null
}

function normalizeImageTextFailureMessage(content) {
  if (typeof content !== 'string') {
    return null
  }

  const trimmed = content.trim()
  if (!trimmed || isLikelyInlineImageText(trimmed)) {
    return null
  }

  const collapsed = trimmed.replace(/\s+/g, ' ').trim()
  if (!collapsed) {
    return null
  }

  if (looksLikeHtmlErrorText(collapsed)) {
    return 'Image upstream returned an HTML error page instead of image data. Check IMAGE_API_BASE_URL, upstream routing, or host status.'
  }

  return collapsed.slice(0, 300)
}

function isLikelyInlineImageText(content) {
  if (typeof content !== 'string') {
    return false
  }

  const trimmed = content.trim()
  if (!trimmed) {
    return false
  }

  if (trimmed.startsWith('data:image/')) {
    return true
  }

  const markdownMatch = trimmed.match(/!\[[^\]]*]\(([^)]+)\)/s)
  if (markdownMatch?.[1]) {
    return isLikelyImageTextUrl(markdownMatch[1])
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return isLikelyImageTextUrl(trimmed)
  }

  return false
}

function isLikelyImageTextUrl(url) {
  if (typeof url !== 'string') {
    return false
  }

  const trimmed = url.trim()
  if (!trimmed) {
    return false
  }

  if (trimmed.startsWith('data:image/')) {
    return true
  }

  return isLikelyRemoteImageUrl(trimmed)
}

function looksLikeHtmlErrorText(content) {
  return (
    /<(?:!doctype|html|head|body|div|span|title)\b/i.test(content)
    || /(?:class=|cf-error-|host error|cloudflare|working<\/span>)/i.test(content)
  )
}

function normalizeExtractedImageUrl(url) {
  if (typeof url !== 'string') {
    return null
  }

  const trimmed = url.trim()
  if (!trimmed) {
    return null
  }

  return trimmed.startsWith('data:image/')
    ? trimmed.replace(/\s/g, '')
    : trimmed
}

async function inlineImageResultIntoPayload(payload, imageResult) {
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') {
    return payload
  }

  const normalizedUrl = normalizeExtractedImageUrl(imageResult?.url)
  if (!normalizedUrl || !/^https?:\/\//i.test(normalizedUrl)) {
    return payload
  }

  try {
    const dataUrl = await fetchRemoteImageAsDataUrl(normalizedUrl)
    return injectCanonicalImageResult(payload, {
      ...imageResult,
      url: dataUrl,
    })
  } catch {
    return payload
  }
}

async function fetchRemoteImageAsDataUrl(url) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch generated image: ${response.status}`)
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  const mimeType = resolveFetchedImageMimeType(response.headers.get('content-type'), url)
  if (!mimeType) {
    throw new Error('Generated asset URL did not return an image')
  }
  return `data:${mimeType};base64,${buffer.toString('base64')}`
}

function resolveFetchedImageMimeType(contentType, url) {
  const normalizedType = typeof contentType === 'string'
    ? contentType.split(';')[0].trim().toLowerCase()
    : ''
  if (normalizedType) {
    return normalizedType.startsWith('image/') ? normalizedType : null
  }

  try {
    const pathname = new URL(url).pathname.toLowerCase()
    if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) {
      return 'image/jpeg'
    }
    if (pathname.endsWith('.webp')) {
      return 'image/webp'
    }
    if (pathname.endsWith('.gif')) {
      return 'image/gif'
    }
    if (pathname.endsWith('.png')) {
      return 'image/png'
    }
  } catch {
    return null
  }

  return null
}

function injectCanonicalImageResult(payload, imageResult) {
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') {
    return payload
  }

  const canonicalContent = [{
    type: 'image_url',
    image_url: {
      url: imageResult.url,
    },
  }]

  if (Array.isArray(payload.choices) && payload.choices.length > 0) {
    const nextChoices = [...payload.choices]
    const firstChoice = nextChoices[0]
    if (firstChoice && typeof firstChoice === 'object') {
      nextChoices[0] = {
        ...firstChoice,
        message: {
          ...(firstChoice.message && typeof firstChoice.message === 'object' ? firstChoice.message : {}),
          content: canonicalContent,
        },
      }

      return {
        ...payload,
        choices: nextChoices,
      }
    }
  }

  return {
    ...payload,
    data: [{
      image_url: imageResult.url,
      ...(typeof imageResult.revisedPrompt === 'string' && imageResult.revisedPrompt
        ? { revised_prompt: imageResult.revisedPrompt }
        : {}),
    }],
  }
}

function tryParseStructuredImageString(content, fallbackPrompt = '') {
  if (typeof content !== 'string') {
    return null
  }

  const candidates = [content]
  const fencedMatch = content.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fencedMatch?.[1]) {
    candidates.unshift(fencedMatch[1])
  }

  for (const candidate of candidates) {
    const trimmed = candidate.trim()
    if (!trimmed || !/^[\[{"]/.test(trimmed)) {
      continue
    }

    try {
      const parsed = JSON.parse(trimmed)
      const parsedResponse = extractImageResponseResult(parsed, fallbackPrompt)
      if (parsedResponse) {
        return parsedResponse
      }

      const directRecord = extractImageRecord(parsed, fallbackPrompt)
      if (directRecord) {
        return directRecord
      }
    } catch {
      // Ignore malformed JSON-like strings and continue with other strategies.
    }
  }

  return null
}

function extractImageUrlFromString(content, fallbackPrompt = '') {
  if (typeof content !== 'string') {
    return null
  }

  const trimmed = content.trim()
  if (!trimmed) {
    return null
  }

  const markdownMatch = trimmed.match(/!\[[^\]]*]\(([^)]+)\)/s)
  if (markdownMatch?.[1]) {
    const nestedMatch = extractImageUrlFromString(markdownMatch[1], fallbackPrompt)
    if (nestedMatch) {
      return nestedMatch
    }
  }

  if (trimmed.startsWith('data:image/')) {
    return { url: normalizeExtractedImageUrl(trimmed), revisedPrompt: fallbackPrompt }
  }

  const dataUrlMatch = trimmed.match(/data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)/)
  if (dataUrlMatch) {
    return { url: dataUrlMatch[0].replace(/\s/g, ''), revisedPrompt: fallbackPrompt }
  }

  const structuredResult = tryParseStructuredImageString(trimmed, fallbackPrompt)
  if (structuredResult) {
    return structuredResult
  }

  const urlMatch = trimmed.match(/https?:\/\/[^\s"'`<>)]+/i)
  if (urlMatch && isLikelyImageTextUrl(urlMatch[0])) {
    return {
      url: normalizeExtractedImageUrl(urlMatch[0]),
      revisedPrompt: fallbackPrompt,
    }
  }

  const rawBase64Match = trimmed.match(/\b([A-Za-z0-9+/]{100,}={0,2})\b/)
  if (rawBase64Match) {
    return {
      url: `data:image/png;base64,${rawBase64Match[1]}`,
      revisedPrompt: fallbackPrompt,
    }
  }

  return null
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
  if (typeof record === 'string') {
    return extractImageUrlFromString(record, fallbackPrompt)
  }

  if (!record || typeof record !== 'object') {
    return null
  }

  if (typeof record.url === 'string' && record.url) {
    const parsedUrl = extractImageUrlFromString(record.url, fallbackPrompt)
    const normalizedUrl = parsedUrl?.url || (
      isLikelyImageTextUrl(record.url)
        ? normalizeExtractedImageUrl(record.url)
        : null
    )
    if (!normalizedUrl) {
      return null
    }
    return {
      url: normalizedUrl,
      revisedPrompt: typeof record.revised_prompt === 'string' ? record.revised_prompt : fallbackPrompt,
    }
  }

  const imageUrlValue = typeof record.image_url === 'string'
    ? record.image_url
    : record.image_url?.url
  if (imageUrlValue) {
    const parsedUrl = extractImageUrlFromString(imageUrlValue, fallbackPrompt)
    return {
      url: parsedUrl?.url || normalizeExtractedImageUrl(imageUrlValue),
      revisedPrompt: typeof record.revised_prompt === 'string' ? record.revised_prompt : fallbackPrompt,
    }
  }

  const imageValue = typeof record.image === 'string'
    ? record.image
    : record.image?.url
  if (imageValue) {
    const parsedUrl = extractImageUrlFromString(imageValue, fallbackPrompt)
    return {
      url: parsedUrl?.url || normalizeExtractedImageUrl(imageValue),
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
    const stringResult = extractImageUrlFromString(content, fallbackPrompt)
    if (stringResult) {
      return stringResult
    }
  }

  if (Array.isArray(content)) {
    const imageItem = content.find((item) => item?.type === 'image_url' && (
      item?.image_url?.url || typeof item?.image_url === 'string'
    ))
    if (imageItem) {
      const imageUrlValue = typeof imageItem.image_url === 'string'
        ? imageItem.image_url
        : imageItem.image_url.url
      return {
        url: normalizeExtractedImageUrl(imageUrlValue),
        revisedPrompt: fallbackPrompt,
      }
    }

    const base64Item = content.find((item) => item?.type === 'image_base64' && typeof item?.image_base64 === 'string')
    if (base64Item) {
      const mimeType = typeof base64Item.mime_type === 'string' ? base64Item.mime_type : 'image/png'
      return {
        url: `data:${mimeType};base64,${base64Item.image_base64.replace(/\s/g, '')}`,
        revisedPrompt: fallbackPrompt,
      }
    }

    for (const contentItem of content) {
      const parsedRecord = extractImageRecord(contentItem, fallbackPrompt)
      if (parsedRecord) {
        return parsedRecord
      }
    }
  }

  const topLevelRecord = extractImageRecord(data, fallbackPrompt)
  if (topLevelRecord) {
    return topLevelRecord
  }

  const topLevelCollections = [data?.data, data?.images, data?.results, data?.artifacts]
  for (const collection of topLevelCollections) {
    if (!Array.isArray(collection)) continue

    for (const record of collection) {
      const parsedRecord = extractImageRecord(record, fallbackPrompt)
      if (parsedRecord) {
        return parsedRecord
      }
    }
  }

  const directContainers = [data?.result, data?.image]
  for (const entry of directContainers) {
    const directRecord = extractImageRecord(entry, fallbackPrompt)
    if (directRecord) {
      return directRecord
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

function attachRequestedVideoParams(requestParams, requestedParams) {
  if (!requestedParams || typeof requestedParams !== 'object') {
    return requestParams
  }

  const filteredEntries = Object.entries(requestedParams).filter(([, value]) => (
    value !== null
    && value !== undefined
    && value !== ''
  ))
  if (filteredEntries.length === 0) {
    return requestParams
  }

  return {
    ...(requestParams && typeof requestParams === 'object' ? requestParams : {}),
    requestedParams: Object.fromEntries(filteredEntries),
  }
}

function extractRequestedVideoParams(requestBody) {
  const body = requestBody && typeof requestBody === 'object' ? requestBody : {}
  const params = body.params && typeof body.params === 'object' ? body.params : {}
  const payloadParams = body.payload?.params && typeof body.payload.params === 'object'
    ? body.payload.params
    : {}

  return {
    model: readFirstString(params.model, body.modelId, body.model),
    aspectRatio: readFirstString(params.aspectRatio, payloadParams.scale, body.aspectRatio, body.scale),
    resolution: readFirstString(params.resolution, payloadParams.resolution, body.resolution),
    duration: readFirstFiniteNumber(params.duration, payloadParams.duration, body.duration),
    sampleCount: readFirstFiniteNumber(params.sampleCount, body.sampleCount),
  }
}

async function prepareVideoCreditCharge(req, res, providerId, requestedParams, requestParams) {
  if (!shouldChargeCreditsForProvider(providerId)) return null

  const charge = calculateVideoCreditCharge({
    resolution: requestedParams.resolution,
    duration: requestedParams.duration,
    sampleCount: requestedParams.sampleCount || 1,
    requestParams,
  })

  if (charge.amount <= 0) return charge

  try {
    const creditStatus = await assertSufficientCredits(req.videoSiteSession, charge)
    if (!creditStatus.ok) {
      res.status(402).json({
        success: false,
        code: 'INSUFFICIENT_CREDITS',
        message: `积分不足，本次需要 ${charge.amount} 积分，当前余额 ${creditStatus.balance || 0} 积分。`,
        requiredCredits: charge.amount,
        balance: creditStatus.balance || 0,
      })
      return null
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || '积分校验失败',
    })
    return null
  }

  return charge
}

function insertChargedUsageLog(options, charge) {
  return insertUsageLog({
    ...options,
    unitPrice: charge?.rate ?? null,
    estimatedCost: charge?.amount ?? null,
  })
}

function resolveUsageMediaSummary(requestParams, headerSummary) {
  if (headerSummary) {
    return headerSummary
  }

  const references = requestParams?.references
  if (!references || typeof references !== 'object') {
    return null
  }

  return buildUploadedReferenceMediaSummary(references)
}

function buildUploadedReferenceMediaSummary(references) {
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

function registerUploadedReference(reference, bytes, mimeType, expiresAtMs) {
  const key = normalizeUploadedReferenceKey(reference)
  if (!key) return

  uploadedReferenceMetadata.set(key, {
    bytes: Math.max(0, Number(bytes) || 0),
    mimeType: typeof mimeType === 'string' ? mimeType : '',
    expiresAtMs: Math.max(Date.now(), Number(expiresAtMs) || Date.now()),
  })
}

function normalizeUploadedReferenceKey(reference) {
  if (typeof reference !== 'string') return ''
  return reference.trim()
}

function cleanupUploadedReferenceMetadata() {
  const now = Date.now()
  for (const [key, metadata] of uploadedReferenceMetadata.entries()) {
    if (!metadata || metadata.expiresAtMs <= now) {
      uploadedReferenceMetadata.delete(key)
    }
  }
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

function extractAggregationImageUrl(payload) {
  const parsed = extractImageResponseResult(payload)
  if (parsed?.url) {
    return parsed.url
  }

  return (
    findFirstMatchingPathValue(payload, [
      'imageUrl',
      'image_url',
      'resultUrl',
      'url',
      'content',
      'message',
      'data.imageUrl',
      'data.image_url',
      'data.resultUrl',
      'data.url',
      'data.content',
      'data.message',
      'data.result.imageUrl',
      'data.result.image_url',
      'data.result.resultUrl',
      'data.result.url',
      'data.result.content',
      'data.result.message',
      'result.imageUrl',
      'result.image_url',
      'result.resultUrl',
      'result.url',
      'result.content',
      'result.message',
    ], isLikelyRemoteImageUrl)
    || findFirstMediaUrlDeep(payload, 0, '', isLikelyRemoteImageUrl)
  )
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

  return [
    '操作成功',
    '请求成功',
    '调用成功',
    'success',
    'ok',
  ].includes(normalized)
}

function extractAggregationTerminalMessage(payload) {
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

function extractVeoFastReferenceCounts(normalizedBody) {
  const firstInstance = Array.isArray(normalizedBody?.instances) ? normalizedBody.instances[0] : null
  if (!firstInstance) {
    return { images: 0, videos: 0, audios: 0 }
  }

  const imageCount = [
    firstInstance.image,
    firstInstance.lastFrame,
    ...(Array.isArray(firstInstance.referenceImages) ? firstInstance.referenceImages.map((item) => item?.image) : []),
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
  const mediaSummary = parseUsageMediaSummaryHeader(req)
  const requestedParams = extractRequestedVideoParams(body)
  const usageRequestParams = attachUsageMediaSummary({
    model: normalizedBody?.model,
    parameters: normalizedBody?.parameters,
    referenceCounts: extractVeoFastReferenceCounts(normalizedBody),
    requestedParams,
  }, mediaSummary)
  await proxyJsonWithBody(req, res, `${veoFastGenerateUrl}/v1/video/generations`, normalizedBody, {
    Authorization: `Bearer ${apiKey}`,
  }, ({ payload, traceMetadata, status, url }) => {
    if (status >= 400) return
    const taskId = payload?.name || payload?.task_id || payload?.id
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
      requestParams: usageRequestParams,
      engineTaskId: taskId || null,
      upstreamRequestId: traceMetadata?.requestId || null,
      upstreamTraceId: traceMetadata?.traceId || null,
      upstreamUrl: url,
      status: taskId ? 'submitted' : USAGE_STATUS_NEEDS_REVIEW,
      errorMessage: taskId ? null : UNTRACKED_USAGE_STATUS_MESSAGE,
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

    // Track status update
    try {
      const contentType = response.headers.get('content-type') || ''
      if (contentType.includes('application/json')) {
        const parsed = JSON.parse(buffer.toString('utf8'))
        const state = parsed?.state || parsed?.status
        if (state === 'succeeded' || state === 'failed' || state === 'SUCCEEDED' || state === 'FAILED') {
          updateUsageLogByTaskId(req.params.taskId, {
            status: state.toLowerCase() === 'succeeded' ? 'succeeded' : 'failed',
            videoUrl: parsed?.video_url || parsed?.videoUrl || null,
            errorMessage: state.toLowerCase() === 'failed' ? (parsed?.error?.message || parsed?.message || null) : null,
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

// Admin dashboard
app.use('/api/admin', requireAdminApiAccess, adminRouter)
app.get('/admin', requireAdminPageAccess, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'))
})
app.get(adminCreditsPath, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'credits.html'))
})

const httpServer = createHttpServer(app)

if (!isProduction) {
  const vite = await createViteServer({
    root: __dirname,
    server: {
      allowedHosts: true,
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
  startUsageStatusMaintenanceLoop()
})

async function proxyJson(req, res, url, extraHeaders = {}, onResponse = null) {
  return proxyJsonWithBody(req, res, url, req.body, extraHeaders, onResponse)
}

async function proxyJsonWithBody(req, res, url, body, extraHeaders = {}, onResponse = null, options = {}) {
  const retryOptions = normalizeProxyRetryOptions(options.retry)
  let lastResult = null
  let lastError = null

  for (let attempt = 1; attempt <= retryOptions.maxAttempts; attempt += 1) {
    try {
      const result = await fetchProxyJsonResult(req, url, body, extraHeaders)
      lastResult = result

      if (shouldRetryProxyResponse(result.response.status, retryOptions, attempt)) {
        await sleep(resolveProxyRetryDelayMs(retryOptions, attempt))
        continue
      }

      const exhausted = didExhaustProxyRetries(result.response.status, retryOptions, attempt)
      sendProxyJsonResult(res, url, result, onResponse, {
        attempts: attempt,
        retryOptions,
        exhausted,
      })
      return
    } catch (error) {
      lastError = error
      if (shouldRetryProxyError(error, retryOptions, attempt)) {
        await sleep(resolveProxyRetryDelayMs(retryOptions, attempt))
        continue
      }

      sendProxyError(res, error)
      return
    }
  }

  if (lastResult) {
    sendProxyJsonResult(res, url, lastResult, onResponse, {
      attempts: retryOptions.maxAttempts,
      retryOptions,
      exhausted: true,
    })
    return
  }

  sendProxyError(res, lastError || new Error('Upstream request failed'))
}

async function fetchProxyJsonResult(req, url, body, extraHeaders) {
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

  return {
    response,
    buffer,
    contentType,
    parsedPayload,
    traceMetadata,
  }
}

function sendProxyJsonResult(res, url, result, onResponse, retryContext) {
  const { response, buffer, contentType, parsedPayload, traceMetadata } = result
  const payload = retryContext?.exhausted
    ? decorateRetryExhaustedPayload(parsedPayload, traceMetadata, retryContext)
    : injectUpstreamTraceMetadata(parsedPayload, traceMetadata)

  if (onResponse) {
    try { onResponse({ payload: parsedPayload, traceMetadata, status: response.status, url }) } catch (_) {}
  }

  res.status(response.status)
  copyUpstreamResponseHeaders(res, response.headers)
  applyUpstreamTraceHeaders(res, traceMetadata)
  if (retryContext?.attempts > 1) {
    res.setHeader('X-Proxy-Retry-Attempts', String(retryContext.attempts))
  }
  if (retryContext?.exhausted) {
    res.setHeader('X-Proxy-Retry-Exhausted', 'true')
  }

  if (payload !== null) {
    if (!res.getHeader('Content-Type')) {
      res.setHeader('Content-Type', contentType || 'application/json; charset=utf-8')
    }
    res.send(JSON.stringify(payload))
    return
  }

  res.end(buffer)
}

function sendProxyError(res, error) {
  applyUpstreamTraceHeaders(res, error)
  res.status(502).json({
    success: false,
    message: error.message || 'Upstream request failed',
    ...(error.requestId ? { requestId: error.requestId } : {}),
    ...(error.traceId ? { traceId: error.traceId } : {}),
  })
}

function normalizeProxyRetryOptions(retry) {
  if (!retry) {
    return {
      maxAttempts: 1,
      statusCodes: new Set(),
      delaysMs: [],
      retryNetworkErrors: false,
      exhaustedMessage: '',
    }
  }

  const maxAttempts = Math.max(1, Number(retry.maxAttempts) || 1)
  return {
    maxAttempts,
    statusCodes: retry.statusCodes instanceof Set ? retry.statusCodes : new Set(retry.statusCodes || []),
    delaysMs: Array.isArray(retry.delaysMs) ? retry.delaysMs : [],
    retryNetworkErrors: Boolean(retry.retryNetworkErrors),
    exhaustedMessage: typeof retry.exhaustedMessage === 'string' ? retry.exhaustedMessage : '',
  }
}

function shouldRetryProxyResponse(status, retryOptions, attempt) {
  return attempt < retryOptions.maxAttempts && retryOptions.statusCodes.has(status)
}

function didExhaustProxyRetries(status, retryOptions, attempt) {
  return attempt >= retryOptions.maxAttempts && retryOptions.statusCodes.has(status)
}

function shouldRetryProxyError(_error, retryOptions, attempt) {
  return attempt < retryOptions.maxAttempts && retryOptions.retryNetworkErrors
}

function resolveProxyRetryDelayMs(retryOptions, attempt) {
  const delay = retryOptions.delaysMs[attempt - 1] ?? retryOptions.delaysMs.at(-1) ?? 0
  return Math.max(0, Number(delay) || 0)
}

function decorateRetryExhaustedPayload(parsedPayload, traceMetadata, retryContext) {
  const tracedPayload = injectUpstreamTraceMetadata(parsedPayload, traceMetadata)
  if (!retryContext?.exhaustedMessage || !tracedPayload || Array.isArray(tracedPayload) || typeof tracedPayload !== 'object') {
    return tracedPayload
  }

  const originalMessage = readFirstString(
    tracedPayload?.error?.message,
    tracedPayload?.message,
  )
  const decoratedPayload = { ...tracedPayload }

  if (decoratedPayload.error && typeof decoratedPayload.error === 'object' && !Array.isArray(decoratedPayload.error)) {
    decoratedPayload.error = {
      ...decoratedPayload.error,
      message: retryContext.exhaustedMessage,
    }
  } else {
    decoratedPayload.message = retryContext.exhaustedMessage
  }

  decoratedPayload.retryAttempts = retryContext.attempts
  if (originalMessage) {
    decoratedPayload.upstreamMessage = originalMessage
  }

  return decoratedPayload
}

function readPositiveIntegerEnv(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

const YUNWU_VIDEO_PROVIDERS = {
  'yunwu-veo': { family: 'veo' },
  'yunwu-kling': { family: 'kling' },
  'yunwu-sora': { family: 'sora' },
  'yunwu-hailuo': { family: 'hailuo' },
  'yunwu-luma': { family: 'luma' },
  'yunwu-runway': { family: 'runway' },
  'yunwu-grok': { family: 'grok' },
  'yunwu-wanxiang': { family: 'wanxiang' },
  'happyhorse': { family: 'happyhorse' },
  'yunwu-tencent': { family: 'tencent' },
}

function getMissingYunwuConfig() {
  return [
    !process.env.YUNWU_API_KEY && 'YUNWU_API_KEY',
  ].filter(Boolean)
}

function getMissingArkConfig() {
  return [
    !process.env.ARK_API_KEY && 'ARK_API_KEY',
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
  '1080P': {
    '16:9': '1920*1080',
    '9:16': '1080*1920',
    '1:1': '1440*1440',
    '4:3': '1632*1248',
    '3:4': '1248*1632',
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
  await uploadFileToDashScope({
    file,
    policy,
    key,
  })

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
  const seed = normalizeDashScopeWanSeed(params.seed)

  return {
    method: 'POST',
    path: '/api/v1/services/aigc/video-generation/video-synthesis',
    async: true,
    resolveOssResource: referenceUrls.some((item) => isDashScopeOssResource(item)),
    body: {
      model: String(params.model || 'wan2.6-r2v'),
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
        ...(seed !== null ? { seed } : {}),
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
  const explicitSize = normalizeDashScopeWanSize(params?.size)
  if (explicitSize) {
    return explicitSize
  }

  const resolution = String(params?.resolution || '720P').trim().toUpperCase()
  const aspectRatio = String(params?.aspectRatio || '16:9').trim()
  const size = DASHSCOPE_WAN_SIZE_MAP[resolution]?.[aspectRatio]

  if (!size) {
    throw createHttpError(400, `Unsupported DashScope Wan size mapping: ${resolution} / ${aspectRatio}`)
  }

  return size
}

function normalizeDashScopeWanSize(value) {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim()
  if (!normalized) {
    return null
  }

  for (const sizes of Object.values(DASHSCOPE_WAN_SIZE_MAP)) {
    if (Object.values(sizes).includes(normalized)) {
      return normalized
    }
  }

  throw createHttpError(400, `Unsupported DashScope Wan size: ${normalized}`)
}

function resolveDashScopeWanDuration(params) {
  const duration = Math.trunc(coercePositiveNumber(params?.duration, 5))
  if (duration < 2 || duration > 10) {
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

function normalizeDashScopeWanSeed(value) {
  if (value === null || value === undefined || value === '') {
    return null
  }

  const seed = Math.trunc(Number(value))
  if (!Number.isFinite(seed) || seed < 0 || seed > 2147483647) {
    throw createHttpError(400, 'DashScope Wan seed must be an integer between 0 and 2147483647.')
  }

  return seed
}

function buildArkGenerateRequest(input) {
  const providerId = normalizeArkProviderId(input.providerId)
  const prompt = String(input.prompt || '').trim()
  if (!prompt) {
    throw createHttpError(400, 'Prompt is required.')
  }

  const mode = normalizeArkMode(input.mode, providerId)
  const params = input.params && typeof input.params === 'object' ? input.params : {}
  const references = normalizeYunwuReferences(input.references)
  return buildArkSeedanceRequest(providerId, mode, prompt, params, references)
}

function buildArkQueryRequest(input) {
  const providerId = normalizeArkProviderId(input.providerId)
  const taskId = normalizeTaskIdValue(input.taskId)
  if (!taskId) {
    throw createHttpError(400, 'taskId is required.')
  }

  return {
    providerId,
    taskId,
    method: 'GET',
    path: `/api/v3/contents/generations/tasks/${encodeURIComponent(taskId)}`,
  }
}

function normalizeArkProviderId(value) {
  const providerId = String(value || 'seedance3').trim()
  if (!ARK_ALLOWED_PROVIDER_IDS.has(providerId)) {
    throw createHttpError(400, `Unsupported Ark provider: ${providerId || 'unknown'}`)
  }
  return providerId
}

function normalizeArkMode(value, providerId = 'seedance3') {
  const mode = String(value || 't2v').trim().toLowerCase()
  const allowedModes = ARK_PROVIDER_MODES[providerId] || ARK_PROVIDER_MODES.seedance3
  if (!allowedModes.includes(mode)) {
    throw createHttpError(400, `Unsupported Ark mode: ${mode || 'unknown'}`)
  }
  return mode
}

function normalizeArkModel(value, fallbackModel = 'doubao-seedance-2-0-fast-260128') {
  const model = String(value || fallbackModel).trim()
  if (!model) {
    throw createHttpError(400, 'Ark model is required.')
  }
  return model
}

function normalizeArkDuration(value, fallbackValue = 5) {
  const duration = Math.trunc(coercePositiveNumber(value, fallbackValue))
  if (!Number.isFinite(duration) || duration < 4 || duration > 15) {
    throw createHttpError(400, 'Ark Seedance duration must be an integer between 4 and 15 seconds.')
  }
  return duration
}

function normalizeArkVideoRatio(value, fallbackValue = '16:9') {
  const ratio = String(value || fallbackValue).trim()
  if (!ARK_VIDEO_RATIOS.has(ratio)) {
    throw createHttpError(400, `Unsupported Ark ratio: ${ratio || 'unknown'}`)
  }
  return ratio
}

function normalizeArkVideoResolution(value, fallbackValue = '720p') {
  const resolution = String(value || fallbackValue).trim().toLowerCase()
  if (!ARK_VIDEO_RESOLUTIONS.has(resolution)) {
    throw createHttpError(400, `Unsupported Ark resolution: ${resolution || 'unknown'}`)
  }
  return resolution
}

function buildArkSeedanceRequest(providerId, mode, prompt, params, references) {
  switch (mode) {
    case 't2v':
      if (references.images.length > 0 || references.videos.length > 0 || references.audios.length > 0) {
        throw createHttpError(400, 'Ark 文生视频模式不支持参考图片、视频或音频。')
      }
      break
    case 'i2v':
      if (references.images.length !== 1) {
        throw createHttpError(400, 'Ark 图生视频模式需要且仅支持 1 张参考图片。')
      }
      if (references.videos.length > 0 || references.audios.length > 0) {
        throw createHttpError(400, 'Ark 图生视频模式不支持额外的参考视频或音频。')
      }
      break
    case 'flf':
      if (references.images.length !== 2) {
        throw createHttpError(400, 'Ark 首尾帧模式需要按顺序上传 2 张参考图片。')
      }
      if (references.videos.length > 0 || references.audios.length > 0) {
        throw createHttpError(400, 'Ark 首尾帧模式不支持额外的参考视频或音频。')
      }
      break
    case 'fusion':
      if (references.images.length > 9) {
        throw createHttpError(400, 'Ark 融合参考模式最多支持 9 张参考图片。')
      }
      if (references.videos.length > 3) {
        throw createHttpError(400, 'Ark 融合参考模式最多支持 3 段参考视频。')
      }
      if (references.audios.length > 3) {
        throw createHttpError(400, 'Ark 融合参考模式最多支持 3 段参考音频。')
      }
      if (references.images.length + references.videos.length + references.audios.length === 0) {
        throw createHttpError(400, 'Ark 融合参考模式至少需要 1 个参考素材。')
      }
      if (references.images.length + references.videos.length === 0) {
        throw createHttpError(400, 'Ark 融合参考模式下音频不能单独使用，至少还需要 1 张图片或 1 段视频。')
      }
      break
    default:
      throw createHttpError(400, `Unsupported Ark mode: ${mode || 'unknown'}`)
  }

  return {
    providerId,
    mode,
    method: 'POST',
    path: '/api/v3/contents/generations/tasks',
    body: {
      model: normalizeArkModel(params.model),
      content: buildArkSeedanceContent(prompt, mode, references),
      ratio: normalizeArkVideoRatio(params.aspectRatio),
      resolution: normalizeArkVideoResolution(params.resolution),
      duration: normalizeArkDuration(params.duration),
      generate_audio: Boolean(params.generateAudio),
      watermark: Boolean(params.watermark),
    },
  }
}

function buildArkSeedanceContent(prompt, mode, references) {
  const content = [{
    type: 'text',
    text: prompt,
  }]

  if (mode === 'i2v' && references.images[0]) {
    content.push({
      type: 'image_url',
      image_url: { url: references.images[0] },
      role: 'first_frame',
    })
  }

  if (mode === 'flf') {
    if (references.images[0]) {
      content.push({
        type: 'image_url',
        image_url: { url: references.images[0] },
        role: 'first_frame',
      })
    }
    if (references.images[1]) {
      content.push({
        type: 'image_url',
        image_url: { url: references.images[1] },
        role: 'last_frame',
      })
    }
  }

  if (mode === 'fusion') {
    for (const imageUrl of references.images) {
      content.push({
        type: 'image_url',
        image_url: { url: imageUrl },
        role: 'reference_image',
      })
    }
    for (const videoUrl of references.videos) {
      content.push({
        type: 'video_url',
        video_url: { url: videoUrl },
        role: 'reference_video',
      })
    }
    for (const audioUrl of references.audios) {
      content.push({
        type: 'audio_url',
        audio_url: { url: audioUrl },
        role: 'reference_audio',
      })
    }
  }

  return content
}

async function buildDreaminaGenerateRequest(input) {
  const providerId = normalizeDreaminaProviderId(input.providerId)
  const prompt = String(input.prompt || '').trim()
  const mode = normalizeDreaminaMode(input.mode, providerId)
  const params = input.params && typeof input.params === 'object' ? input.params : {}
  const references = await resolveDreaminaLocalReferences(input.references)
  return buildDreaminaSeedanceRequest(providerId, mode, prompt, params, references)
}

function buildDreaminaQueryRequest(input) {
  const providerId = normalizeDreaminaProviderId(input.providerId)
  const taskId = normalizeTaskIdValue(input.taskId)
  if (!taskId) {
    throw createHttpError(400, 'taskId is required.')
  }

  return {
    providerId,
    taskId,
    args: [
      'query_result',
      '--submit_id', taskId,
    ],
  }
}

function normalizeDreaminaProviderId(value) {
  const providerId = String(value || 'seedance2').trim()
  if (!DREAMINA_ALLOWED_PROVIDER_IDS.has(providerId)) {
    throw createHttpError(400, `Unsupported Dreamina provider: ${providerId || 'unknown'}`)
  }
  return providerId
}

function normalizeDreaminaMode(value, providerId = 'seedance2') {
  const mode = String(value || 'generate').trim().toLowerCase()
  const allowedModes = DREAMINA_PROVIDER_MODES[providerId] || DREAMINA_PROVIDER_MODES.seedance2
  if (!allowedModes.includes(mode)) {
    throw createHttpError(400, `Unsupported Dreamina mode: ${mode || 'unknown'}`)
  }
  return mode
}

function resolveDreaminaSeedanceMode(mode, references) {
  if (mode !== 'generate') {
    return mode
  }

  const imageCount = Array.isArray(references?.images) ? references.images.length : 0
  if (imageCount >= 2) return 'flf'
  if (imageCount === 1) return 'i2v'
  return 't2v'
}

function normalizeDreaminaModelVersion(value, allowedModels, fallbackModel) {
  const model = String(value || fallbackModel || '').trim()
  if (!allowedModels.has(model)) {
    throw createHttpError(400, `Unsupported Dreamina model_version: ${model || 'unknown'}`)
  }
  return model
}

function normalizeDreaminaIntegerDuration(value, minimum, maximum, fallbackValue, label = 'Dreamina duration') {
  const duration = Math.trunc(coercePositiveNumber(value, fallbackValue))
  if (!Number.isFinite(duration) || duration < minimum || duration > maximum) {
    throw createHttpError(400, `${label} must be an integer between ${minimum} and ${maximum}.`)
  }
  return duration
}

function normalizeDreaminaFloatDuration(value, minimum, maximum, fallbackValue, label) {
  const duration = Number.parseFloat(String(value ?? fallbackValue).trim())
  if (!Number.isFinite(duration) || duration < minimum || duration > maximum) {
    throw createHttpError(400, `${label} must be between ${minimum} and ${maximum} seconds.`)
  }
  return duration
}

function normalizeDreaminaVideoResolution(value, allowedResolutions, fallbackResolution = '720p') {
  const resolution = String(value || fallbackResolution).trim().toLowerCase()
  if (!allowedResolutions.has(resolution) || !DREAMINA_VIDEO_RESOLUTIONS.has(resolution)) {
    throw createHttpError(400, `Unsupported Dreamina video_resolution: ${resolution || 'unknown'}`)
  }
  return resolution
}

function normalizeDreaminaVideoRatio(value) {
  const ratio = String(value || '9:16').trim()
  if (!DREAMINA_VIDEO_RATIOS.has(ratio)) {
    throw createHttpError(400, `Unsupported Dreamina ratio: ${ratio || 'unknown'}`)
  }
  return ratio
}

function normalizeDreaminaImageRatio(value) {
  const ratio = String(value || '1:1').trim()
  if (!DREAMINA_IMAGE_RATIOS.has(ratio)) {
    throw createHttpError(400, `Unsupported Dreamina ratio: ${ratio || 'unknown'}`)
  }
  return ratio
}

function normalizeDreaminaResolutionType(value, allowedResolutionTypes, fallbackResolutionType) {
  const resolutionType = String(value || fallbackResolutionType).trim().toLowerCase()
  if (!allowedResolutionTypes.has(resolutionType) || !DREAMINA_IMAGE_RESOLUTION_TYPES.has(resolutionType)) {
    throw createHttpError(400, `Unsupported Dreamina resolution_type: ${resolutionType || 'unknown'}`)
  }
  return resolutionType
}

function buildDreaminaSeedanceRequest(providerId, mode, prompt, params, references) {
  const operationalMode = resolveDreaminaSeedanceMode(mode, references)

  if (mode === 'generate') {
    ensureDreaminaReferenceCount(references.images.length <= 2, '视频生成模式最多支持 2 张参考图片。')
    ensureDreaminaReferenceCount(
      references.videos.length === 0 && references.audios.length === 0,
      '视频生成模式仅支持 0-2 张图片，不支持参考视频或音频。',
    )
  }

  if (operationalMode === 'multiframe') {
    return buildDreaminaStoryRequest(providerId, operationalMode, prompt, params, references)
  }

  const args = []
  let command = ''
  let model = null
  let duration = null
  let resolution = null
  let aspectRatio = null

  switch (operationalMode) {
    case 't2v':
      ensureDreaminaPrompt(prompt, '文生视频')
      ensureDreaminaReferenceCount(references.images.length === 0 && references.videos.length === 0 && references.audios.length === 0, '文生视频不支持参考素材，请先清空已上传的图片、视频和音频。')
      command = 'text2video'
      model = normalizeDreaminaModelVersion(params.model, DREAMINA_TEXT2VIDEO_MODELS, 'seedance2.0fast')
      duration = normalizeDreaminaIntegerDuration(params.duration, 4, 15, 5, 'Dreamina text2video duration')
      resolution = normalizeDreaminaVideoResolution(params.resolution, new Set(['720p']), '720p')
      aspectRatio = normalizeDreaminaVideoRatio(params.aspectRatio)
      args.push(
        command,
        '--prompt', prompt,
        '--duration', String(duration),
        '--ratio', aspectRatio,
        '--video_resolution', resolution,
        '--model_version', model,
        '--poll', '0',
      )
      break
    case 'i2v':
      ensureDreaminaPrompt(prompt, '图生视频')
      ensureDreaminaReferenceCount(references.images.length === 1, '图生视频需要且仅支持 1 张参考图片。')
      ensureDreaminaReferenceCount(references.videos.length === 0 && references.audios.length === 0, '图生视频不支持额外的参考视频或音频。')
      command = 'image2video'
      model = normalizeDreaminaModelVersion(params.model, DREAMINA_IMAGE2VIDEO_MODELS, 'seedance2.0fast')
      duration = normalizeDreaminaImage2VideoDuration(params.duration, model)
      resolution = normalizeDreaminaImage2VideoResolution(params.resolution, model)
      args.push(
        command,
        '--image', references.images[0],
        '--prompt', prompt,
        '--duration', String(duration),
        '--video_resolution', resolution,
        '--model_version', model,
        '--poll', '0',
      )
      break
    case 'flf':
      ensureDreaminaPrompt(prompt, '首尾帧')
      ensureDreaminaReferenceCount(references.images.length === 2, '首尾帧模式需要按顺序上传 2 张参考图片。')
      ensureDreaminaReferenceCount(references.videos.length === 0 && references.audios.length === 0, '首尾帧模式不支持额外的参考视频或音频。')
      command = 'frames2video'
      model = normalizeDreaminaModelVersion(params.model, DREAMINA_FRAMES2VIDEO_MODELS, 'seedance2.0fast')
      duration = normalizeDreaminaFramesDuration(params.duration, model)
      resolution = normalizeDreaminaFramesResolution(params.resolution, model)
      args.push(
        command,
        '--first', references.images[0],
        '--last', references.images[1],
        '--prompt', prompt,
        '--duration', String(duration),
        '--video_resolution', resolution,
        '--model_version', model,
        '--poll', '0',
      )
      break
    case 'fusion':
      ensureDreaminaReferenceCount(references.images.length <= 9, '融合参考模式最多支持 9 张参考图片。')
      ensureDreaminaReferenceCount(references.videos.length <= 3, '融合参考模式最多支持 3 段参考视频。')
      ensureDreaminaReferenceCount(references.audios.length <= 3, '融合参考模式最多支持 3 段参考音频。')
      ensureDreaminaReferenceCount(references.images.length + references.videos.length > 0, '融合参考模式至少需要 1 张参考图片或 1 段参考视频。')
      command = 'multimodal2video'
      model = normalizeDreaminaModelVersion(params.model, DREAMINA_MULTIMODAL_MODELS, 'seedance2.0fast')
      duration = normalizeDreaminaIntegerDuration(params.duration, 4, 15, 5, 'Dreamina multimodal2video duration')
      resolution = normalizeDreaminaVideoResolution(params.resolution, new Set(['720p']), '720p')
      aspectRatio = normalizeDreaminaVideoRatio(params.aspectRatio)
      args.push(
        command,
        '--prompt', prompt,
        '--duration', String(duration),
        '--ratio', aspectRatio,
        '--video_resolution', resolution,
        '--model_version', model,
        '--poll', '0',
      )
      for (const imagePath of references.images) {
        args.push('--image', imagePath)
      }
      for (const videoPath of references.videos) {
        args.push('--video', videoPath)
      }
      for (const audioPath of references.audios) {
        args.push('--audio', audioPath)
      }
      break
    default:
      throw createHttpError(400, `Unsupported Dreamina mode: ${operationalMode}`)
  }

  return {
    providerId,
    mode,
    command,
    args,
    model,
    duration,
    resolution,
    aspectRatio,
  }
}

function buildDreaminaStoryRequest(providerId, mode, prompt, params, references) {
  ensureDreaminaReferenceCount(mode === 'multiframe', `Unsupported Dreamina multiframe mode: ${mode}`)
  ensureDreaminaReferenceCount(references.images.length >= 2, '动作模仿模式至少需要 2 张参考图片。')
  ensureDreaminaReferenceCount(references.images.length <= 20, '动作模仿模式最多支持 20 张参考图片。')
  ensureDreaminaReferenceCount(references.videos.length === 0 && references.audios.length === 0, '动作模仿模式仅支持上传图片。')

  const args = [
    'multiframe2video',
    '--images', references.images.join(','),
    '--poll', '0',
  ]
  const transitionCount = references.images.length - 1

  if (references.images.length === 2) {
    ensureDreaminaPrompt(prompt, '动作模仿（两张图）')
    const duration = normalizeDreaminaFloatDuration(
      params.singleTransitionDuration,
      2,
      8,
      3,
      'Dreamina multiframe2video duration',
    )
    args.push('--prompt', prompt, '--duration', formatDreaminaFloat(duration))

    return {
      providerId,
      mode,
      command: 'multiframe2video',
      args,
      duration,
      aspectRatio: null,
      resolution: null,
      model: null,
    }
  }

  const transitionPrompts = normalizeDreaminaPromptList(params.transitionPrompts, transitionCount, '动作模仿过渡提示词')
  const transitionDurations = normalizeDreaminaTransitionDurationList(params.transitionDurations, transitionCount)
  const totalDuration = transitionDurations.reduce((sum, item) => sum + item, 0)
  if (totalDuration < 2) {
    throw createHttpError(400, '动作模仿总时长至少需要 2 秒。')
  }

  for (let index = 0; index < transitionCount; index += 1) {
    args.push('--transition-prompt', transitionPrompts[index])
    args.push('--transition-duration', formatDreaminaFloat(transitionDurations[index]))
  }

  return {
    providerId,
    mode,
    command: 'multiframe2video',
    args,
    duration: totalDuration,
    aspectRatio: null,
    resolution: null,
    model: null,
  }
}

function buildDreaminaImageRequest(providerId, mode, prompt, params, references) {
  ensureDreaminaPrompt(prompt, mode === 't2v' ? '文生图' : '图生图')

  const aspectRatio = normalizeDreaminaImageRatio(params.aspectRatio)
  let command = ''
  let model = null
  let resolution = null
  const args = []

  switch (mode) {
    case 't2v':
      ensureDreaminaReferenceCount(references.images.length === 0 && references.videos.length === 0 && references.audios.length === 0, 'Dreamina 文生图不支持参考素材。')
      command = 'text2image'
      model = normalizeDreaminaModelVersion(params.model, DREAMINA_TEXT2IMAGE_MODELS, '5.0')
      resolution = normalizeDreaminaText2ImageResolution(params.resolution, model)
      args.push(
        command,
        '--prompt', prompt,
        '--ratio', aspectRatio,
        '--resolution_type', resolution,
        '--model_version', model,
        '--poll', '0',
      )
      break
    case 'i2v':
      ensureDreaminaReferenceCount(references.images.length > 0, 'Dreamina 图生图至少需要 1 张参考图片。')
      ensureDreaminaReferenceCount(references.videos.length === 0 && references.audios.length === 0, 'Dreamina 图生图仅支持上传图片。')
      command = 'image2image'
      model = normalizeDreaminaModelVersion(params.model, DREAMINA_IMAGE2IMAGE_MODELS, '5.0')
      resolution = normalizeDreaminaImage2ImageResolution(params.resolution, model)
      args.push(
        command,
        '--images', references.images.join(','),
        '--prompt', prompt,
        '--ratio', aspectRatio,
        '--resolution_type', resolution,
        '--model_version', model,
        '--poll', '0',
      )
      break
    default:
      throw createHttpError(400, `Unsupported Dreamina image mode: ${mode}`)
  }

  return {
    providerId,
    mode,
    command,
    args,
    model,
    resolution,
    aspectRatio,
    duration: null,
  }
}

function buildDreaminaUpscaleRequest(providerId, mode, params, references) {
  ensureDreaminaReferenceCount(mode === 'upscale', `Unsupported Dreamina upscale mode: ${mode}`)
  ensureDreaminaReferenceCount(references.images.length === 1, 'Dreamina 超清放大需要且仅支持 1 张参考图片。')
  ensureDreaminaReferenceCount(references.videos.length === 0 && references.audios.length === 0, 'Dreamina 超清放大仅支持上传图片。')

  const resolution = normalizeDreaminaResolutionType(params.resolution, new Set(['2k', '4k', '8k']), '2k')
  return {
    providerId,
    mode,
    command: 'image_upscale',
    args: [
      'image_upscale',
      '--image', references.images[0],
      '--resolution_type', resolution,
      '--poll', '0',
    ],
    model: null,
    resolution,
    aspectRatio: null,
    duration: null,
  }
}

function ensureDreaminaPrompt(prompt, label) {
  if (!prompt) {
    throw createHttpError(400, `${label}提示词不能为空。`)
  }
}

function normalizeDreaminaImage2VideoDuration(value, model) {
  if (isDreaminaModelInSet(model, ['3.0', '3.0fast', '3.0pro', '3.0_fast', '3.0_pro'])) {
    return normalizeDreaminaIntegerDuration(value, 3, 10, 5, 'Dreamina image2video duration')
  }

  if (isDreaminaModelInSet(model, ['3.5pro', '3.5_pro'])) {
    return normalizeDreaminaIntegerDuration(value, 4, 12, 5, 'Dreamina image2video duration')
  }

  return normalizeDreaminaIntegerDuration(value, 4, 15, 5, 'Dreamina image2video duration')
}

function normalizeDreaminaImage2VideoResolution(value, model) {
  if (isDreaminaModelInSet(model, ['3.0pro', '3.0_pro'])) {
    return normalizeDreaminaVideoResolution(value, new Set(['1080p']), '1080p')
  }

  if (isDreaminaModelInSet(model, ['3.0', '3.0fast', '3.5pro', '3.0_fast', '3.5_pro'])) {
    return normalizeDreaminaVideoResolution(value, new Set(['720p', '1080p']), '720p')
  }

  return normalizeDreaminaVideoResolution(value, new Set(['720p']), '720p')
}

function normalizeDreaminaFramesDuration(value, model) {
  if (model === '3.0') {
    return normalizeDreaminaIntegerDuration(value, 3, 10, 5, 'Dreamina frames2video duration')
  }

  if (model === '3.5pro') {
    return normalizeDreaminaIntegerDuration(value, 4, 12, 5, 'Dreamina frames2video duration')
  }

  return normalizeDreaminaIntegerDuration(value, 4, 15, 5, 'Dreamina frames2video duration')
}

function normalizeDreaminaFramesResolution(value, model) {
  if (model === '3.0' || model === '3.5pro') {
    return normalizeDreaminaVideoResolution(value, new Set(['720p', '1080p']), '720p')
  }

  return normalizeDreaminaVideoResolution(value, new Set(['720p']), '720p')
}

function normalizeDreaminaText2ImageResolution(value, model) {
  if (model === '3.0' || model === '3.1') {
    return normalizeDreaminaResolutionType(value, new Set(['1k', '2k']), '2k')
  }

  return normalizeDreaminaResolutionType(value, new Set(['2k', '4k']), '2k')
}

function normalizeDreaminaImage2ImageResolution(value, model) {
  if (model === '3.0' || model === '3.1') {
    throw createHttpError(400, `Unsupported Dreamina model_version: ${model}`)
  }

  return normalizeDreaminaResolutionType(value, new Set(['2k', '4k']), '2k')
}

function normalizeDreaminaPromptList(value, expectedCount, label) {
  const promptList = Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean)
    : []

  if (promptList.length !== expectedCount) {
    throw createHttpError(400, `${label}数量必须与过渡段数一致。`)
  }

  return promptList
}

function normalizeDreaminaTransitionDurationList(value, expectedCount) {
  if (!Array.isArray(value) || value.length !== expectedCount) {
    throw createHttpError(400, 'Dreamina 多帧叙事每一段都需要填写时长。')
  }

  return value.map((item) => normalizeDreaminaFloatDuration(
    item,
    0.5,
    8,
    3,
    'Dreamina multiframe2video transition duration',
  ))
}

function formatDreaminaFloat(value) {
  return Number.isInteger(value) ? String(value) : String(value)
}

function isDreaminaModelInSet(model, candidates) {
  return candidates.includes(model)
}

function ensureDreaminaReferenceCount(condition, message) {
  if (!condition) {
    throw createHttpError(400, message)
  }
}

async function resolveDreaminaLocalReferences(references) {
  const normalized = normalizeYunwuReferences(references)

  return {
    images: await Promise.all(
      normalized.images.map((reference, index) => resolveDreaminaLocalReference(reference, `参考图片 ${index + 1}`)),
    ),
    videos: await Promise.all(
      normalized.videos.map((reference, index) => resolveDreaminaLocalReference(reference, `参考视频 ${index + 1}`)),
    ),
    audios: await Promise.all(
      normalized.audios.map((reference, index) => resolveDreaminaLocalReference(reference, `参考音频 ${index + 1}`)),
    ),
  }
}

async function resolveDreaminaLocalReference(reference, label) {
  const absolutePath = resolveDreaminaTempAssetPath(reference)

  let stat = null
  try {
    stat = await fsp.stat(absolutePath)
  } catch {
    stat = null
  }

  if (!stat?.isFile()) {
    throw createHttpError(400, `${label} 已失效或不存在，请重新上传后再试。`)
  }

  return absolutePath
}

function resolveDreaminaTempAssetPath(reference) {
  const rawReference = String(reference || '').trim()
  if (!rawReference) {
    throw createHttpError(400, 'Dreamina reference is required.')
  }

  if (path.isAbsolute(rawReference)) {
    return rawReference
  }

  let parsedUrl
  try {
    parsedUrl = new URL(rawReference)
  } catch {
    try {
      parsedUrl = new URL(rawReference, 'http://localhost')
    } catch {
      throw createHttpError(400, 'Dreamina reference must be a temp asset URL or local absolute path.')
    }
  }

  const pathname = decodeURIComponent(parsedUrl.pathname || '')
  if (!pathname.startsWith('/temp-assets/')) {
    throw createHttpError(400, 'Dreamina only accepts files uploaded through the current project.')
  }

  const filename = sanitizeTempAssetName(pathname.slice('/temp-assets/'.length))
  if (!filename) {
    throw createHttpError(400, 'Dreamina reference filename is invalid.')
  }

  const expiresAt = Number(parsedUrl.searchParams.get('exp') || 0)
  const signature = parsedUrl.searchParams.get('sig') || ''
  if (expiresAt > 0 && signature) {
    if (expiresAt <= Date.now()) {
      throw createHttpError(400, 'Dreamina reference has expired. Please upload it again.')
    }
    if (!verifyTempAssetSignature(filename, expiresAt, signature)) {
      throw createHttpError(400, 'Dreamina reference signature is invalid. Please upload it again.')
    }
  }

  return path.join(uploadDir, filename)
}

function resolveDreaminaCliBin() {
  const explicitPath = process.env.DREAMINA_CLI_BIN?.trim()
  if (explicitPath) {
    return path.isAbsolute(explicitPath) ? explicitPath : path.resolve(__dirname, explicitPath)
  }

  const homeDir = process.env.HOME?.trim()
  if (homeDir) {
    return path.join(homeDir, '.local', 'bin', 'dreamina')
  }

  return 'dreamina'
}

function resolveDreaminaCliHome() {
  const configured = process.env.DREAMINA_CLI_HOME?.trim()
  if (!configured) {
    return null
  }

  return path.isAbsolute(configured) ? configured : path.resolve(__dirname, configured)
}

function buildDreaminaCliEnv(cliBin) {
  const nextEnv = { ...process.env }
  const cliHome = resolveDreaminaCliHome()
  if (cliHome) {
    nextEnv.HOME = cliHome
    nextEnv.USERPROFILE = cliHome
    nextEnv.DREAMINA_CLI_HOME = cliHome
  }

  const binDir = path.dirname(cliBin)
  const currentPath = nextEnv.PATH || ''
  const pathEntries = currentPath ? currentPath.split(path.delimiter) : []
  if (binDir && !pathEntries.includes(binDir)) {
    nextEnv.PATH = currentPath ? `${binDir}${path.delimiter}${currentPath}` : binDir
  }

  return nextEnv
}

async function executeDreaminaCli(args) {
  const cliBin = resolveDreaminaCliBin()
  const cliEnv = buildDreaminaCliEnv(cliBin)
  const cliHome = resolveDreaminaCliHome()

  if (cliHome) {
    await fsp.mkdir(cliHome, { recursive: true })
  }

  try {
    const result = await execFileAsync(cliBin, args, {
      cwd: __dirname,
      env: cliEnv,
      maxBuffer: 16 * 1024 * 1024,
      timeout: DREAMINA_CLI_TIMEOUT_MS,
      windowsHide: true,
    })

    return {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      payload: parseDreaminaCliPayload(result.stdout, result.stderr),
    }
  } catch (error) {
    throw normalizeDreaminaCliError(error)
  }
}

function normalizeDreaminaCliError(error) {
  const stdout = typeof error?.stdout === 'string'
    ? error.stdout
    : Buffer.isBuffer(error?.stdout)
    ? error.stdout.toString('utf8')
    : ''
  const stderr = typeof error?.stderr === 'string'
    ? error.stderr
    : Buffer.isBuffer(error?.stderr)
    ? error.stderr.toString('utf8')
    : ''
  const payload = parseDreaminaCliPayload(stdout, stderr)
  const combinedText = [stderr, stdout, error?.message]
    .filter((value) => typeof value === 'string' && value.trim())
    .join('\n')

  if (combinedText.includes('未检测到有效登录态')) {
    throw createHttpError(
      401,
      'Dreamina CLI 未登录，请先执行 dreamina login。若本地调试同时提示 .dreamina_cli 无写权限，请设置 DREAMINA_CLI_HOME 到可写目录后，在同一目录重新登录。',
    )
  }

  if (/AigcComplianceConfirmationRequired/i.test(combinedText)) {
    throw createHttpError(409, 'Dreamina 账号需要先在即梦网页端完成内容安全授权确认，然后再重试生成。')
  }

  if (/\.dreamina_cli[\\/].*operation not permitted/i.test(combinedText)) {
    throw createHttpError(500, 'Dreamina CLI 无法写入本地运行目录。请设置 DREAMINA_CLI_HOME 到一个可写目录，并在该目录下重新执行 dreamina login。')
  }

  if (error?.code === 'ENOENT') {
    throw createHttpError(500, `Dreamina CLI not found: ${resolveDreaminaCliBin()}`)
  }

  const message = extractDreaminaMessage(payload?.data, payload?.rawText)
    || readLastNonEmptyLine(stderr)
    || readLastNonEmptyLine(stdout)
    || error?.message
    || 'Dreamina CLI request failed.'

  throw createHttpError(502, message)
}

function parseDreaminaCliPayload(...chunks) {
  const cleanedChunks = chunks
    .filter((chunk) => typeof chunk === 'string' && chunk.trim())
    .map((chunk) => chunk.trim())

  const rawText = cleanedChunks[0] || ''
  for (const chunk of cleanedChunks) {
    const parsed = tryParseDreaminaJsonChunk(chunk)
    if (parsed !== null) {
      return {
        rawText,
        data: expandDreaminaJsonValue(parsed),
      }
    }
  }

  return {
    rawText,
    data: null,
  }
}

function tryParseDreaminaJsonChunk(text) {
  if (typeof text !== 'string') {
    return null
  }

  const direct = tryParseDreaminaJson(text)
  if (direct !== null) {
    return direct
  }

  const objectStart = text.indexOf('{')
  const objectEnd = text.lastIndexOf('}')
  if (objectStart >= 0 && objectEnd > objectStart) {
    const sliced = tryParseDreaminaJson(text.slice(objectStart, objectEnd + 1))
    if (sliced !== null) {
      return sliced
    }
  }

  const arrayStart = text.indexOf('[')
  const arrayEnd = text.lastIndexOf(']')
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    return tryParseDreaminaJson(text.slice(arrayStart, arrayEnd + 1))
  }

  return null
}

function tryParseDreaminaJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function expandDreaminaJsonValue(value, depth = 0) {
  if (depth > 4) {
    return value
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}'))
      || (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      const parsed = tryParseDreaminaJson(trimmed)
      if (parsed !== null) {
        return expandDreaminaJsonValue(parsed, depth + 1)
      }
    }
    return value
  }

  if (Array.isArray(value)) {
    return value.map((item) => expandDreaminaJsonValue(item, depth + 1))
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, expandDreaminaJsonValue(nestedValue, depth + 1)]),
    )
  }

  return value
}

function normalizeDreaminaGenerateResponse(payload, requestSpec) {
  return {
    taskId: extractDreaminaTaskId(payload?.data, payload?.rawText),
    status: normalizeDreaminaStatus(
      extractDreaminaStatus(payload?.data, payload?.rawText) || 'submitted',
      'submitted',
    ),
    message: extractDreaminaMessage(payload?.data, payload?.rawText),
    videoUrl: extractDreaminaVideoUrl(payload?.data, payload?.rawText),
    imageUrl: extractDreaminaImageUrl(payload?.data, payload?.rawText),
  }
}

function normalizeDreaminaQueryResponse(payload, requestSpec) {
  return {
    taskId: extractDreaminaTaskId(payload?.data, payload?.rawText) || requestSpec.taskId,
    status: normalizeDreaminaStatus(
      extractDreaminaStatus(payload?.data, payload?.rawText) || 'processing',
      'processing',
    ),
    message: extractDreaminaMessage(payload?.data, payload?.rawText),
    videoUrl: extractDreaminaVideoUrl(payload?.data, payload?.rawText),
    imageUrl: extractDreaminaImageUrl(payload?.data, payload?.rawText),
  }
}

function normalizeDreaminaTerminalUsageStatus(status) {
  if (status === 'succeeded' || status === 'failed' || status === 'cancelled') {
    return status
  }
  return null
}

function buildMediaProxyHeaders(req) {
  const headers = {}
  const range = req.get('range')
  if (range) {
    headers.Range = range
  }
  return headers
}

async function readDreaminaUpstreamError(response) {
  const contentType = (response.headers.get('content-type') || '').toLowerCase()

  if (contentType.includes('application/json')) {
    const payload = await response.json().catch(() => null)
    return payload?.message || payload?.error?.message || JSON.stringify(payload || {})
  }

  const text = await response.text().catch(() => '')
  return text.trim() || null
}

function extractDreaminaTaskId(payload, rawText = '') {
  const taskId = normalizeTaskIdValue(findFirstPathValue(payload, [
    'submit_id',
    'submitId',
    'taskId',
    'task_id',
    'data.submit_id',
    'data.submitId',
    'data.taskId',
    'data.task_id',
    'result.submit_id',
    'result.submitId',
    'result.taskId',
    'result.task_id',
  ]))
  if (taskId) {
    return taskId
  }

  const matched = rawText.match(/submit_id["'\s:=]+([A-Za-z0-9_-]+)/i)
  return matched?.[1] || null
}

function extractDreaminaStatus(payload, rawText = '') {
  const status = readFirstString(findFirstPathValue(payload, [
    'gen_status',
    'status',
    'state',
    'data.gen_status',
    'data.status',
    'data.state',
    'result.gen_status',
    'result.status',
    'result.state',
  ]))
  if (status) {
    return status
  }

  const matched = rawText.match(/gen_status["'\s:=]+([A-Za-z0-9_-]+)/i)
  return matched?.[1] || null
}

function extractDreaminaMessage(payload, rawText = '') {
  const message = findFirstPathValue(payload, [
    'fail_reason',
    'error_msg',
    'error_message',
    'message',
    'msg',
    'error.message',
    'error',
    'data.fail_reason',
    'data.error_msg',
    'data.error_message',
    'data.message',
    'data.msg',
    'result.fail_reason',
    'result.error_msg',
    'result.error_message',
    'result.message',
    'result.msg',
  ])

  if (typeof message === 'string' && message.trim()) {
    return message.trim()
  }

  const lines = rawText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('{') && !line.startsWith('['))

  if (lines.length === 0) {
    return null
  }

  const lastLine = lines[lines.length - 1]
  return lastLine || null
}

function extractDreaminaVideoUrl(payload, rawText = '') {
  const payloadUrl = extractAggregationVideoUrl(payload)
  if (payloadUrl) {
    return payloadUrl
  }

  const matched = rawText.match(/https?:\/\/\S+/i)
  if (matched && isLikelyRemoteVideoUrl(matched[0])) {
    return matched[0]
  }

  return null
}

function extractDreaminaImageUrl(payload, rawText = '') {
  const payloadUrl = extractAggregationImageUrl(payload)
  if (payloadUrl) {
    return payloadUrl
  }

  const matched = rawText.match(/https?:\/\/\S+/i)
  if (matched && isLikelyRemoteImageUrl(matched[0])) {
    return matched[0]
  }

  return null
}

function normalizeDreaminaStatus(value, fallbackStatus = 'processing') {
  if (typeof value !== 'string') {
    return fallbackStatus
  }

  const normalized = value.trim().toLowerCase()
  if (!normalized) {
    return fallbackStatus
  }

  if (['success', 'succeeded', 'completed', 'complete', 'finished', 'done'].includes(normalized)) {
    return 'succeeded'
  }

  if (['failed', 'failure', 'error', 'rejected'].includes(normalized)) {
    return 'failed'
  }

  if (['cancelled', 'canceled'].includes(normalized)) {
    return 'cancelled'
  }

  if (['submitted', 'submit', 'created'].includes(normalized)) {
    return 'submitted'
  }

  if (['pending', 'queued', 'queueing', 'processing', 'running', 'inprogress', 'in_progress'].includes(normalized)) {
    return 'processing'
  }

  return normalized
}

function readLastNonEmptyLine(text) {
  if (typeof text !== 'string') {
    return null
  }

  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  return lines.length > 0 ? lines[lines.length - 1] : null
}

function getYunwuProviderConfig(providerId) {
  return YUNWU_VIDEO_PROVIDERS[providerId] || null
}

function buildYunwuGenerateRequest(input) {
  const providerId = String(input.providerId || '')
  const providerConfig = getYunwuProviderConfig(providerId)
  if (!providerConfig) {
    throw createHttpError(400, `Unsupported Yunwu provider: ${providerId || 'unknown'}`)
  }

  const prompt = String(input.prompt || '').trim()
  if (!prompt) {
    throw createHttpError(400, 'Prompt is required.')
  }

  const mode = String(input.mode || 't2v')
  const params = input.params && typeof input.params === 'object' ? input.params : {}
  const references = normalizeYunwuReferences(input.references)

  switch (providerConfig.family) {
    case 'veo':
      return {
        method: 'POST',
        path: '/v1/video/create',
        body: {
          model: params.model,
          prompt,
          aspect_ratio: params.aspectRatio,
          ...(typeof params.enhancePrompt === 'boolean' ? { enhance_prompt: params.enhancePrompt } : {}),
          ...(typeof params.enableUpsample === 'boolean' ? { enable_upsample: params.enableUpsample } : {}),
          ...(references.images.length > 0 ? { images: references.images } : {}),
          ...(params.resolution ? { size: params.resolution } : {}),
        },
      }
    case 'sora':
      return {
        method: 'POST',
        path: '/v1/video/create',
        body: {
          model: params.model,
          prompt,
          duration: coercePositiveNumber(params.duration, 10),
          orientation: mapOrientationFromAspectRatio(params.aspectRatio),
          size: params.resolution || '720p',
          private: params.privateOutput !== false,
          watermark: Boolean(params.watermark),
          ...(references.images.length > 0 ? { images: references.images.slice(0, 1) } : {}),
        },
      }
    case 'grok':
      return {
        method: 'POST',
        path: '/v1/video/create',
        body: {
          model: params.model,
          prompt,
          aspect_ratio: params.aspectRatio,
          size: params.resolution || '720p',
          ...(references.images.length > 0 ? { images: references.images.slice(0, 1) } : {}),
        },
      }
    case 'hailuo':
      return {
        method: 'POST',
        path: '/minimax/v1/video_generation',
        body: {
          model: params.model,
          prompt,
          duration: coercePositiveNumber(params.duration, 6),
          ...(mode !== 't2v' && references.images[0] ? { first_frame_image: references.images[0] } : {}),
          ...(mode === 'flf' && references.images[1] ? { last_frame_image: references.images[1] } : {}),
          ...(mode !== 't2v'
            ? {
                resolution: params.resolution || '768P',
                prompt_optimizer: params.promptOptimizer !== false,
              }
            : {}),
        },
      }
    case 'luma':
      return {
        method: 'POST',
        path: '/luma/generations',
        body: {
          user_prompt: prompt,
          model_name: params.model,
          duration: coercePositiveNumber(params.duration, 5),
          resolution: params.resolution || '720p',
        },
      }
    case 'runway':
      return {
        method: 'POST',
        path: '/runwayml/v1/image_to_video',
        body: {
          model: params.model,
          promptText: prompt,
          promptImage: references.images[0],
          duration: String(coercePositiveNumber(params.duration, 5)),
          ratio: params.aspectRatio || '16:9',
          watermark: Boolean(params.watermark),
        },
      }
    case 'seedance':
      return {
        method: 'POST',
        path: '/volc/v1/contents/generations/tasks',
        body: {
          model: params.model,
          content: buildYunwuSeedanceContent(prompt, mode, params, references),
        },
      }
    case 'kling': {
      const createKind = resolveYunwuKlingCreateKind(mode)
      return {
        method: 'POST',
        path: mapYunwuKlingCreatePath(createKind),
        body: buildYunwuKlingBody(createKind, prompt, params, references, mode),
        queryContext: { createKind },
      }
    }
    case 'wanxiang':
      return {
        method: 'POST',
        path: '/alibailian/api/v1/services/aigc/video-generation/video-synthesis',
        body: {
          model: params.model,
          input: {
            prompt,
            img_url: references.images[0],
          },
          parameters: {
            resolution: params.resolution || '720p',
            prompt_extend: params.promptExtend !== false,
            audio: Boolean(params.generateAudio),
          },
        },
      }
    case 'happyhorse':
      return {
        method: 'POST',
        path: '/alibailian/api/v1/services/aigc/video-generation/video-synthesis',
        body: {
          model: params.model,
          input: {
            prompt,
            media: references.images.map((url) => ({
              type: 'reference_image',
              url,
            })),
          },
          parameters: {
            resolution: params.resolution || '720P',
            ratio: params.aspectRatio || '16:9',
            duration: coercePositiveNumber(params.duration, 5),
          },
        },
      }
    case 'tencent':
      return {
        method: 'POST',
        path: '/tencent-vod/v1/aigc-video',
        body: {
          model_name: 'Kling',
          model_version: params.model,
          prompt,
          output_config: {
            storage_mode: 'url',
            media_name: `veo-studio-${Date.now()}`,
            duration: coercePositiveNumber(params.duration, 5),
            resolution: params.resolution || '720p',
            aspect_ratio: params.aspectRatio || '16:9',
            audio_generation: Boolean(params.generateAudio),
            person_generation: 'real',
            input_compliance_check: false,
            output_compliance_check: false,
            enhance_switch: true,
          },
        },
      }
    default:
      throw createHttpError(400, `Unsupported Yunwu family: ${providerConfig.family}`)
  }
}

function buildYunwuQueryRequest(input) {
  const providerId = String(input.providerId || '')
  const providerConfig = getYunwuProviderConfig(providerId)
  if (!providerConfig) {
    throw createHttpError(400, `Unsupported Yunwu provider: ${providerId || 'unknown'}`)
  }

  const taskId = String(input.taskId || '').trim()
  if (!taskId) {
    throw createHttpError(400, 'taskId is required.')
  }

  const queryContext = input.queryContext && typeof input.queryContext === 'object' ? input.queryContext : {}

  switch (providerConfig.family) {
    case 'veo':
    case 'sora':
    case 'grok':
      return {
        method: 'GET',
        path: '/v1/video/query',
        query: { id: taskId },
      }
    case 'hailuo':
      return {
        method: 'GET',
        path: '/minimax/v1/query/video_generation',
        query: { task_id: taskId },
      }
    case 'luma':
      return {
        method: 'GET',
        path: `/luma/generations/${encodeURIComponent(taskId)}`,
      }
    case 'runway':
      return {
        method: 'GET',
        path: `/runwayml/v1/tasks/${encodeURIComponent(taskId)}`,
      }
    case 'seedance':
      return {
        method: 'GET',
        path: `/volc/v1/contents/generations/tasks/${encodeURIComponent(taskId)}`,
      }
    case 'kling':
      return {
        method: 'GET',
        path: mapYunwuKlingQueryPath(queryContext.createKind, taskId),
      }
    case 'wanxiang':
    case 'happyhorse':
      return {
        method: 'GET',
        path: `/alibailian/api/v1/tasks/${encodeURIComponent(taskId)}`,
      }
    case 'tencent':
      return {
        method: 'GET',
        path: `/tencent-vod/v1/query/${encodeURIComponent(taskId)}`,
      }
    default:
      throw createHttpError(400, `Unsupported Yunwu family: ${providerConfig.family}`)
  }
}

async function requestYunwu(spec) {
  const url = appendQueryParams(`${yunwuApiBaseUrl}${spec.path}`, spec.query)
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${process.env.YUNWU_API_KEY}`,
  }

  if (spec.body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }

  const options = {
    method: spec.method || 'POST',
    headers,
    body: spec.body !== undefined ? JSON.stringify(spec.body) : undefined,
  }

  let response
  let lastError = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await fetch(url, options)
      break
    } catch (error) {
      lastError = error
      if (attempt === 2) {
        throw createHttpError(502, error?.message || 'Yunwu upstream fetch failed.')
      }
      await sleep(800 * (attempt + 1))
    }
  }

  if (!response) {
    throw createHttpError(502, lastError?.message || 'Yunwu upstream fetch failed.')
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
    throw createHttpError(response.status, message || 'Yunwu upstream request failed.', traceMetadata)
  }

  return { response, payload }
}

async function requestArk(spec) {
  const url = appendQueryParams(`${arkApiBaseUrl}${spec.path}`, spec.query)
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${process.env.ARK_API_KEY}`,
    ...(spec.headers || {}),
  }

  if (spec.body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }

  const options = {
    method: spec.method || 'POST',
    headers,
    body: spec.body !== undefined ? JSON.stringify(spec.body) : undefined,
  }

  let response
  let lastError = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await fetch(url, options)
      break
    } catch (error) {
      lastError = error
      if (attempt === 2) {
        throw createHttpError(502, error?.message || 'Ark upstream fetch failed.')
      }
      await sleep(800 * (attempt + 1))
    }
  }

  if (!response) {
    throw createHttpError(502, lastError?.message || 'Ark upstream fetch failed.')
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
    throw createHttpError(response.status, message || 'Ark upstream request failed.', traceMetadata)
  }

  return { response, payload }
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

  const options = {
    method: spec.method || 'POST',
    headers,
    body: spec.body !== undefined ? JSON.stringify(spec.body) : undefined,
  }

  let response
  let lastError = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await fetch(url, options)
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

function normalizeYunwuGenerateResponse(payload, requestSpec, traceMetadata) {
  return {
    taskId: extractYunwuTaskId(payload),
    status: normalizeYunwuStatus(extractYunwuStatus(payload) || 'submitted'),
    message: extractYunwuMessage(payload),
    videoUrl: extractYunwuVideoUrl(payload),
    queryContext: requestSpec.queryContext || null,
    ...(traceMetadata.requestId ? { requestId: traceMetadata.requestId } : {}),
    ...(traceMetadata.traceId ? { traceId: traceMetadata.traceId } : {}),
  }
}

function normalizeYunwuQueryResponse(payload, requestSpec, traceMetadata) {
  return {
    taskId: extractYunwuTaskId(payload) || readFirstString(requestSpec.taskId, requestSpec.query?.id, requestSpec.query?.task_id),
    status: normalizeYunwuStatus(extractYunwuStatus(payload)),
    message: extractYunwuMessage(payload),
    videoUrl: extractYunwuVideoUrl(payload),
    ...(traceMetadata.requestId ? { requestId: traceMetadata.requestId } : {}),
    ...(traceMetadata.traceId ? { traceId: traceMetadata.traceId } : {}),
  }
}

function normalizeYunwuReferences(references) {
  return {
    images: Array.isArray(references?.images) ? references.images.filter((item) => typeof item === 'string' && item) : [],
    videos: Array.isArray(references?.videos) ? references.videos.filter((item) => typeof item === 'string' && item) : [],
    audios: Array.isArray(references?.audios) ? references.audios.filter((item) => typeof item === 'string' && item) : [],
  }
}

function buildYunwuSeedanceContent(prompt, mode, params, references) {
  const flags = [
    `--resolution ${params.resolution || '480p'}`,
    `--ratio ${params.aspectRatio || '16:9'}`,
    `--duration ${coercePositiveNumber(params.duration, 5)}`,
    `--wm ${Boolean(params.watermark)}`,
  ]

  const content = [{
    type: 'text',
    text: `${prompt} ${flags.join(' ')}`.trim(),
  }]

  if (mode === 'i2v' && references.images[0]) {
    content.push({ type: 'image_url', image_url: references.images[0] })
  }

  if (mode === 'flf') {
    if (references.images[0]) {
      content.push({ type: 'image_url', image_url: references.images[0], role: 'first_frame' })
    }
    if (references.images[1]) {
      content.push({ type: 'image_url', image_url: references.images[1], role: 'last_frame' })
    }
  }

  if (mode === 'ref') {
    for (const imageUrl of references.images) {
      content.push({ type: 'image_url', image_url: imageUrl, role: 'reference_image' })
    }
  }

  return content
}

function resolveYunwuKlingCreateKind(mode) {
  switch (mode) {
    case 't2v':
      return 'text2video'
    case 'ref':
      return 'multi-image2video'
    case 'omni':
      return 'omni-video'
    case 'flf':
    case 'i2v':
    default:
      return 'image2video'
  }
}

function mapYunwuKlingCreatePath(createKind) {
  switch (createKind) {
    case 'text2video':
      return '/kling/v1/videos/text2video'
    case 'multi-image2video':
      return '/kling/v1/videos/multi-image2video'
    case 'omni-video':
      return '/kling/v1/videos/omni-video'
    case 'image2video':
    default:
      return '/kling/v1/videos/image2video'
  }
}

function mapYunwuKlingQueryPath(createKind, taskId) {
  switch (createKind) {
    case 'text2video':
      return `/kling/v1/videos/text2video/${encodeURIComponent(taskId)}`
    case 'multi-image2video':
      return `/kling/v1/videos/multi-image2video/${encodeURIComponent(taskId)}`
    case 'omni-video':
      return `/kling/v1/videos/omni-video/${encodeURIComponent(taskId)}`
    case 'image2video':
    default:
      return `/kling/v1/videos/image2video/${encodeURIComponent(taskId)}`
  }
}

function resolveYunwuKlingDurationOptions(modelName, mode) {
  if (modelName === 'kling-v2-6') {
    return [5, 10]
  }

  if (modelName === 'kling-video-o1' && (mode === 't2v' || mode === 'i2v')) {
    return [5, 10]
  }

  return [3, 5, 10]
}

function resolveYunwuKlingDuration(params, mode) {
  const duration = Math.trunc(coercePositiveNumber(params?.duration, 5))
  const modelName = String(params?.model || '').trim()
  const allowedDurations = resolveYunwuKlingDurationOptions(modelName, mode)

  if (!allowedDurations.includes(duration)) {
    throw createHttpError(
      400,
      `Yunwu Kling model ${modelName || 'default'} in ${mode} mode only supports ${allowedDurations.join(', ')} second durations.`,
    )
  }

  return duration
}

function buildYunwuKlingBody(createKind, prompt, params, references, mode) {
  const duration = String(resolveYunwuKlingDuration(params, mode))

  if (createKind === 'text2video') {
    return {
      model_name: params.model,
      prompt,
      aspect_ratio: params.aspectRatio || '16:9',
      duration,
      sound: Boolean(params.generateAudio),
    }
  }

  if (createKind === 'multi-image2video') {
    return {
      model_name: params.model,
      prompt,
      image_list: references.images.map((image) => ({ image })),
      aspect_ratio: params.aspectRatio || '16:9',
      duration,
      mode: 'std',
    }
  }

  if (createKind === 'omni-video') {
    return {
      model_name: params.model,
      prompt,
      ...(references.images[0]
        ? {
            image_list: [
              {
                image_url: references.images[0],
                type: 'first_frame',
              },
            ],
          }
        : {}),
      ...(references.videos[0]
        ? {
            video_list: [
              {
                video_url: references.videos[0],
                refer_type: 'base',
                keep_original_sound: 'yes',
              },
            ],
          }
        : {}),
      mode: 'std',
      sound: params.generateAudio ? 'on' : 'off',
      aspect_ratio: params.aspectRatio || '16:9',
      duration,
    }
  }

  return {
    model_name: params.model,
    prompt,
    image: references.images[0],
    ...(references.images[1] ? { image_tail: references.images[1] } : {}),
    aspect_ratio: params.aspectRatio || '16:9',
    duration,
    sound: Boolean(params.generateAudio),
  }
}

function extractYunwuTaskId(payload) {
  const taskValue = findFirstPathValue(payload, [
    'taskId',
    'task_id',
    'id',
    'output.taskId',
    'output.task_id',
    'data.taskId',
    'data.task_id',
    'data.id',
    'result.taskId',
    'result.task_id',
    'result.id',
    'Response.TaskId',
    'Response.TaskID',
  ])

  if (typeof taskValue === 'number') {
    return String(taskValue)
  }

  return typeof taskValue === 'string' && taskValue.trim() ? taskValue.trim() : null
}

function extractYunwuStatus(payload) {
  return readFirstString(
    findFirstPathValue(payload, [
      'status',
      'state',
      'task_status',
      'output.status',
      'output.state',
      'output.task_status',
      'detail.status',
      'detail.state',
      'detail.task_status',
      'data.status',
      'data.state',
      'data.task_status',
      'result.status',
      'result.state',
      'Response.Status',
      'base_resp.status_msg',
    ]),
  )
}

function extractYunwuMessage(payload) {
  const message = findFirstPathValue(payload, [
    'message',
    'msg',
    'output.message',
    'output.msg',
    'error.message',
    'error',
    'detail.error_message',
    'detail.errorMessage',
    'detail.error.message',
    'detail.message',
    'detail.msg',
    'detail.error',
    'detail.images.0.error_message',
    'detail.images.1.error_message',
    'detail.images.2.error_message',
    'detail.images.3.error_message',
    'detail.images.4.error_message',
    'data.message',
    'data.msg',
    'data.error.message',
    'data.error',
    'result.message',
    'result.msg',
    'result.error.message',
    'result.error',
    'failure_reason',
    'base_resp.status_msg',
    'Response.ErrorMessage',
  ])

  if (typeof message === 'string' && message.trim()) {
    return message.trim()
  }

  return null
}

function extractYunwuVideoUrl(payload) {
  return (
    findFirstMatchingPathValue(payload, [
      'videoUrl',
      'video_url',
      'url',
      'content',
      'content.video_url',
      'content.videoUrl',
      'content.url',
      'data.videoUrl',
      'data.video_url',
      'data.url',
      'data.content',
      'data.output.video_url',
      'data.output.url',
      'data.result.video_url',
      'data.result.videoUrl',
      'data.result.url',
      'data.file.download_url',
      'data.data.file.download_url',
      'output.video_url',
      'output.url',
      'result.video_url',
      'result.videoUrl',
      'result.url',
      'assets.video',
      'assets.video.url',
      'data.assets.video',
      'data.assets.video.url',
      'video.url',
      'Response.AigcVideoResult.Output.FileInfos.0.FileUrl',
      'Response.AigcVideoTask.Output.FileInfos.0.FileUrl',
    ], isLikelyRemoteVideoUrl)
    || findFirstMediaUrlDeep(payload)
  )
}

function normalizeYunwuStatus(value) {
  if (typeof value !== 'string') {
    return 'processing'
  }

  const normalized = value.trim().toLowerCase()
  if (!normalized) {
    return 'processing'
  }

  if (['success', 'succeeded', 'completed', 'complete', 'finished', 'done'].includes(normalized)) {
    return 'succeeded'
  }

  if (['failed', 'failure', 'error', 'rejected', 'canceled', 'cancelled', 'unknown'].includes(normalized)) {
    return 'failed'
  }

  if (['pending', 'queued', 'submitted', 'processing', 'running', 'in_progress'].includes(normalized)) {
    return 'processing'
  }

  return normalized
}

function findFirstPathValue(target, paths) {
  for (const path of paths) {
    const value = getPathValue(target, path)
    if (value !== undefined && value !== null && value !== '') {
      return value
    }
  }

  return null
}

function getPathValue(target, pathExpression) {
  if (!target || typeof target !== 'object') {
    return undefined
  }

  const segments = pathExpression.split('.')
  let current = target

  for (const rawSegment of segments) {
    if (current === null || current === undefined) {
      return undefined
    }

    if (/^\d+$/.test(rawSegment)) {
      current = current[Number(rawSegment)]
      continue
    }

    current = current[rawSegment]
  }

  return current
}

function findFirstMediaUrlDeep(target, depth = 0, keyPath = '', predicate = isLikelyRemoteVideoUrl) {
  if (!target || depth > 6) {
    return null
  }

  if (typeof target === 'string') {
    return predicate(target, keyPath) ? target.trim() : null
  }

  if (Array.isArray(target)) {
    for (let index = 0; index < target.length; index += 1) {
      const match = findFirstMediaUrlDeep(
        target[index],
        depth + 1,
        keyPath ? `${keyPath}.${index}` : String(index),
        predicate,
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
      if (typeof value === 'string' && predicate(value, nextKeyPath)) {
        return value.trim()
      }

      const nestedMatch = findFirstMediaUrlDeep(value, depth + 1, nextKeyPath, predicate)
      if (nestedMatch) {
        return nestedMatch
      }
    }
  }

  return null
}

function findFirstMatchingPathValue(target, paths, predicate) {
  for (const path of paths) {
    const value = getPathValue(target, path)
    if (predicate(value, path)) {
      return value.trim()
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

function isLikelyRemoteImageUrl(value, keyPath = '') {
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
    if (/\.(png|jpe?g|webp|gif|bmp|svg)(\?|$)/i.test(searchable)) {
      return true
    }

    const normalizedKeyPath = keyPath.toLowerCase().replace(/[^a-z]/g, '')
    if (/(imageurl|thumbnail|cover|poster|resulturl|outputurl|fileurl)/.test(normalizedKeyPath)) {
      return true
    }

    if (/\/(image|images|img|thumbnail|cover|poster|file|files)\b/i.test(parsed.pathname)) {
      return true
    }
  } catch {
    return false
  }

  return false
}

function appendQueryParams(url, query) {
  if (!query || typeof query !== 'object') {
    return url
  }

  const nextUrl = new URL(url)
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') {
      continue
    }
    nextUrl.searchParams.set(key, String(value))
  }
  return nextUrl.toString()
}

function coercePositiveNumber(value, fallbackValue) {
  const numericValue = Number(value)
  if (Number.isFinite(numericValue) && numericValue > 0) {
    return numericValue
  }
  return fallbackValue
}

function mapOrientationFromAspectRatio(aspectRatio) {
  if (aspectRatio === '9:16' || aspectRatio === '3:4') {
    return 'portrait'
  }

  if (aspectRatio === '1:1') {
    return 'square'
  }

  return 'landscape'
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

function normalizeStringArray(value) {
  const list = Array.isArray(value) ? value : [value]
  return list
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
}

function normalizeInteger(value, fallback, min, max) {
  const numericValue = Number(value)
  if (!Number.isFinite(numericValue)) {
    return fallback
  }

  return Math.max(min, Math.min(max, Math.trunc(numericValue)))
}

function normalizeGptImage2GenerateBody(body) {
  const normalized = {
    model: readFirstString(body.model) || 'gpt-image-2',
    prompt: readFirstString(body.prompt) || '',
    size: readFirstString(body.size, body.resolution) || '1024x1024',
    n: normalizeInteger(body.n ?? body.sampleCount, 1, 1, 4),
    quality: readFirstString(body.quality) || 'low',
    format: readFirstString(body.format) || 'png',
    image: normalizeStringArray(body.image),
  }

  if (normalized.image.length === 0) {
    delete normalized.image
  }

  return normalized
}

function resolveBcaiApiKey() {
  return process.env.BCAI_API_KEY?.trim() || process.env.COPYWRITING_API_KEY?.trim() || ''
}

function resolveShanbaoCopywritingApiKey() {
  return (
    process.env.SHANBAO_API_KEY?.trim()
    || process.env.CLAUDE1_API_KEY?.trim()
    || process.env.IMAGE_API_KEY?.trim()
    || ''
  )
}

function resolveCopywritingProviderConfig(rawProviderId) {
  const providerId = readFirstString(rawProviderId) || 'bcai-copywriting'

  if (providerId === 'claude1-copywriting') {
    return {
      providerId,
      apiUrl: shanbaoCopywritingApiUrl,
      apiKey: resolveShanbaoCopywritingApiKey(),
      missingKeyName: 'SHANBAO_API_KEY or IMAGE_API_KEY',
    }
  }

  return {
    providerId: 'bcai-copywriting',
    apiUrl: bcaiApiUrl,
    apiKey: resolveBcaiApiKey(),
    missingKeyName: 'BCAI_API_KEY',
  }
}

function normalizeCopywritingChatBody(body) {
  const messages = normalizeCopywritingMessages(body.messages)
  const prompt = readFirstString(body.prompt)
  if (messages.length === 0 && prompt) {
    messages.push({ role: 'user', content: prompt })
  }

  return {
    model: readFirstString(body.model) || 'claude-sonnet-4-6',
    messages,
    temperature: normalizeTemperature(body.temperature),
    max_tokens: normalizeInteger(body.max_tokens ?? body.maxTokens, 2000, 1, 8192),
  }
}

function normalizeCopywritingMessages(value) {
  if (!Array.isArray(value)) return []

  return value
    .map((item) => {
      const role = readFirstString(item?.role) || 'user'
      const content = normalizeCopywritingContentParts(item?.content)
      if (!content) return null

      return {
        role: ['system', 'assistant', 'user'].includes(role) ? role : 'user',
        content,
      }
    })
    .filter(Boolean)
}

function normalizeCopywritingContentParts(content) {
  if (typeof content === 'string') {
    return content.trim()
  }

  if (!Array.isArray(content)) {
    return ''
  }

  const parts = content
    .map((part) => normalizeCopywritingContentPart(part))
    .filter(Boolean)

  return parts.length > 0 ? parts : ''
}

function normalizeCopywritingContentPart(part) {
  if (typeof part === 'string') {
    const text = part.trim()
    return text ? { type: 'text', text } : null
  }

  if (!part || typeof part !== 'object') {
    return null
  }

  if (part?.type === 'text') {
    const text = readFirstString(part.text, part.content)
    return text ? { type: 'text', text } : null
  }

  if (part?.type === 'image_url') {
    const url = readFirstString(part.image_url?.url, part.image_url, part.url)
    return url ? { type: 'image_url', image_url: { url } } : null
  }

  if (part?.type === 'file') {
    const filename = readFirstString(part.file?.filename, part.filename) || 'attachment'
    const fileData = readFirstString(part.file?.file_data, part.file_data, part.data)
    return fileData
      ? {
          type: 'file',
          file: {
            filename,
            file_data: fileData,
          },
        }
      : null
  }

  return null
}

function normalizeCopywritingMessageContent(content) {
  if (typeof content === 'string') {
    return content.trim()
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (typeof part?.text === 'string') return part.text
        if (typeof part?.content === 'string') return part.content
        return ''
      })
      .join('')
      .trim()
  }

  return ''
}

function normalizeTemperature(value) {
  const numericValue = Number(value)
  if (!Number.isFinite(numericValue)) {
    return 0.7
  }

  return Math.max(0, Math.min(2, numericValue))
}

function extractCopywritingPromptText(messages) {
  if (!Array.isArray(messages)) return ''
  const userMessage = messages.find((message) => message?.role === 'user') || messages[0]
  return normalizeCopywritingMessageContent(userMessage?.content)
}

function extractCopywritingResponseText(payload) {
  const content = payload?.choices?.[0]?.message?.content
  return normalizeCopywritingMessageContent(content)
    || normalizeCopywritingMessageContent(payload?.output_text)
    || normalizeCopywritingMessageContent(payload?.text)
    || normalizeCopywritingMessageContent(payload?.content)
    || normalizeCopywritingMessageContent(payload?.message)
}

function readFirstFiniteNumber(...values) {
  for (const value of values) {
    const numericValue = Number(value)
    if (Number.isFinite(numericValue)) {
      return numericValue
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

async function createMaterialReferenceTask({ name, originalUrl, type }) {
  const createPayload = await requestJson(materialApiBaseUrl, '/openApi/material/create', buildMaterialHeaders(), {
    name,
    originalUrl,
    type,
    fileType: 1,
    thirdChannel: materialThirdChannel,
  })

  if (!createPayload?.success) {
    throw createHttpError(
      400,
      createPayload?.msg || createPayload?.message || 'Material creation failed.',
      extractTraceMetadataFromPayload(createPayload),
    )
  }

  const materialId = createPayload?.data?.materialId
  if (!materialId) {
    throw createHttpError(502, 'Material creation succeeded but no materialId was returned.')
  }

  return {
    materialId,
    status: Number(createPayload?.data?.status || 1),
    errorMsg: createPayload?.data?.errorMsg || '',
    resourceRef: formatMaterialResource(materialId),
  }
}

async function queryMaterialReferenceStatus(materialId) {
  const listPayload = await requestJson(materialApiBaseUrl, '/openApi/material/pageList', buildMaterialHeaders(), {
    materialId,
    pageNo: 1,
    pageSize: 10,
  })

  if (!listPayload?.success) {
    throw createHttpError(
      502,
      listPayload?.msg || listPayload?.message || 'Material status query failed.',
      extractTraceMetadataFromPayload(listPayload),
    )
  }

  const records = Array.isArray(listPayload?.data?.records) ? listPayload.data.records : []
  const record = records.find((item) => item?.materialId === materialId) || records[0]

  return {
    materialId,
    status: Number(record?.status || 1),
    errorMsg: record?.errorMsg || '',
    resourceRef: formatMaterialResource(materialId),
  }
}

async function createMaterialReference({ name, originalUrl, type }) {
  const created = await createMaterialReferenceTask({ name, originalUrl, type })
  let currentStatus = created.status
  let lastError = created.errorMsg || ''
  const materialId = created.materialId
  const deadline = Date.now() + materialPollTimeoutMs

  while (currentStatus === 1 && Date.now() < deadline) {
    await sleep(materialPollIntervalMs)
    const material = await queryMaterialReferenceStatus(materialId)
    currentStatus = material.status || currentStatus
    lastError = material.errorMsg || lastError
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

  return injectUpstreamTraceMetadata(payload, traceMetadata)
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

function getMissingImageAggregationConfig() {
  return [
    !(process.env.IMAGE_AGGREGATION_PROJECT_CODE || process.env.VIDEO_PROJECT_CODE) && 'IMAGE_AGGREGATION_PROJECT_CODE|VIDEO_PROJECT_CODE',
    !(process.env.IMAGE_AGGREGATION_ACCESS_KEY || process.env.VIDEO_ACCESS_KEY) && 'IMAGE_AGGREGATION_ACCESS_KEY|VIDEO_ACCESS_KEY',
    !(process.env.IMAGE_AGGREGATION_SECRET_KEY || process.env.VIDEO_SECRET_KEY) && 'IMAGE_AGGREGATION_SECRET_KEY|VIDEO_SECRET_KEY',
  ].filter(Boolean)
}

function buildImageAggregationHeaders() {
  return {
    projectCode: process.env.IMAGE_AGGREGATION_PROJECT_CODE || process.env.VIDEO_PROJECT_CODE,
    'X-Access-Key': process.env.IMAGE_AGGREGATION_ACCESS_KEY || process.env.VIDEO_ACCESS_KEY,
    'X-Secret-Key': process.env.IMAGE_AGGREGATION_SECRET_KEY || process.env.VIDEO_SECRET_KEY,
  }
}

function normalizeAggregationImageGenerateBody(body) {
  const normalized = JSON.parse(JSON.stringify(body || {}))
  delete normalized.providerId
  delete normalized.model
  normalized.abilityType = 'IMAGE'

  if (typeof normalized.modelId !== 'string' || !normalized.modelId.trim()) {
    normalized.modelId = 'gemini-3.1-flash-image-preview'
  } else {
    normalized.modelId = normalized.modelId.trim()
  }

  if (!normalized.payload || typeof normalized.payload !== 'object' || Array.isArray(normalized.payload)) {
    normalized.payload = {}
  }

  if (!normalized.payload.params || typeof normalized.payload.params !== 'object' || Array.isArray(normalized.payload.params)) {
    normalized.payload.params = {}
  }

  const resolution = readFirstString(normalized.payload.params.resolution)
  const scale = readFirstString(normalized.payload.params.scale)
  if (resolution) {
    normalized.payload.params.resolution = resolution
  } else {
    delete normalized.payload.params.resolution
  }
  if (scale) {
    normalized.payload.params.scale = scale
  } else {
    delete normalized.payload.params.scale
  }

  if (Array.isArray(normalized.payload.resources)) {
    normalized.payload.resources = normalized.payload.resources
      .filter((value) => typeof value === 'string' && value.trim())
      .map((value) => value.trim())
  } else {
    delete normalized.payload.resources
  }

  return normalized
}

function normalizeAggregationImageQueryBody(body) {
  return {
    taskId: normalizeTaskIdValue(body?.taskId),
    abilityType: 'IMAGE',
  }
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

function buildTempAssetUrl(baseUrl, filename, expiresAt) {
  const normalizedFilename = sanitizeTempAssetName(filename)
  const signature = signTempAssetPayload(normalizedFilename, expiresAt)
  const url = new URL(`${stripTrailingSlash(baseUrl)}/temp-assets/${encodeURIComponent(normalizedFilename)}`)
  url.searchParams.set('exp', String(expiresAt))
  url.searchParams.set('sig', signature)
  return url.toString()
}

function sanitizeTempAssetName(value) {
  const normalized = path.basename(String(value || '').trim())
  if (!normalized || normalized === '.' || normalized === '..') return ''
  return normalized
}

function signTempAssetPayload(filename, expiresAt) {
  return createHmac('sha256', tempAssetSigningSecret)
    .update(`${filename}:${expiresAt}`)
    .digest('base64url')
}

function verifyTempAssetSignature(filename, expiresAt, signature) {
  const expected = signTempAssetPayload(filename, expiresAt)
  const providedBuffer = Buffer.from(signature, 'utf8')
  const expectedBuffer = Buffer.from(expected, 'utf8')
  if (providedBuffer.length !== expectedBuffer.length) return false
  return timingSafeEqual(providedBuffer, expectedBuffer)
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

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, '')
}

function normalizeGeminiImageBaseUrl(value) {
  const normalized = stripTrailingSlash(String(value || '').trim())

  try {
    const url = new URL(normalized)
    const pathname = stripTrailingSlash(url.pathname || '')
    if (pathname === '' || pathname === '/') {
      url.pathname = ''
      return stripTrailingSlash(url.toString())
    }

    if (pathname.endsWith('/chat/completions')) {
      url.pathname = pathname.slice(0, -'/chat/completions'.length) || ''
      return stripTrailingSlash(url.toString())
    }

    if (pathname.endsWith('/v1') || pathname.endsWith('/v1beta')) {
      url.pathname = pathname.replace(/\/v1(beta)?$/, '')
      return stripTrailingSlash(url.toString())
    }
  } catch {
    return normalized
  }

  return normalized
}

function normalizeChatCompletionsUrl(value) {
  const normalized = stripTrailingSlash(String(value || '').trim())

  try {
    const url = new URL(normalized)
    const pathname = stripTrailingSlash(url.pathname || '')
    if (pathname.endsWith('/chat/completions')) {
      return stripTrailingSlash(url.toString())
    }

    if (pathname.endsWith('/v1')) {
      url.pathname = `${pathname}/chat/completions`
      return url.toString()
    }

    url.pathname = `${pathname}/v1/chat/completions`
    return url.toString()
  } catch {
    return normalized
  }
}

function buildGeminiGenerateContentUrl(baseUrl, model) {
  const url = new URL(stripTrailingSlash(baseUrl))
  url.pathname = `${stripTrailingSlash(url.pathname || '')}/v1beta/models/${encodeURIComponent(model)}:generateContent`
  return url.toString()
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

function resolveTempAssetSigningSecret() {
  const candidates = [
    process.env.TEMP_ASSET_SIGNING_SECRET,
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
    return 'veo-studio-dev-temp-asset-secret'
  }

  throw new Error('TEMP_ASSET_SIGNING_SECRET is required in production when temp asset URLs are enabled.')
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
  const requestPath = resolveRequestPath(req)
  if (!requireMainAppSso) return true
  if (requestPath === '/api/health') return true
  if (requestPath === adminCreditsPath) return true
  if (requestPath === '/admin/credit-center') return true
  if (requestPath.startsWith('/api/admin/credits/')) return true
  if (requestPath.startsWith('/temp-assets/')) return true
  if (!isProduction && (
    requestPath.startsWith('/@vite')
    || requestPath.startsWith('/@react-refresh')
    || requestPath.startsWith('/src/')
    || requestPath.startsWith('/node_modules/')
  )) {
    return true
  }
  return false
}

function isHtmlDocumentRequest(req) {
  const requestPath = resolveRequestPath(req)
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  if (requestPath.startsWith('/api/')) return false
  if (requestPath.startsWith('/temp-assets/')) return false
  if (path.extname(requestPath)) return false
  if (!isProduction && (
    requestPath.startsWith('/@vite')
    || requestPath.startsWith('/@react-refresh')
    || requestPath.startsWith('/src/')
    || requestPath.startsWith('/node_modules/')
  )) {
    return false
  }

  const accept = req.get('accept') || ''
  return !accept || accept.includes('text/html') || accept.includes('*/*')
}

function resolveRequestPath(req) {
  if (typeof req?.path === 'string' && req.path) return req.path
  const rawUrl = typeof req?.originalUrl === 'string' && req.originalUrl
    ? req.originalUrl
    : req?.url
  try {
    return new URL(rawUrl || '/', 'http://localhost').pathname
  } catch {
    return '/'
  }
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

async function requireFreshVideoSiteSession(req, res) {
  const session = req.videoSiteSession
  if (!session) return null

  const valid = await validateVideoSiteSession(session)
  if (valid) return session

  clearVideoSiteSession(res)
  req.videoSiteSession = null
  return null
}

async function validateVideoSiteSession(session) {
  if (!session?.token) return false

  const sessionMainAppUrl = sanitizeMainAppUrl(session.mainAppUrl) || mainAppUrl
  try {
    const response = await fetch(`${stripTrailingSlash(sessionMainAppUrl)}/api/sso/session`, {
      headers: {
        Authorization: `Bearer ${session.token}`,
      },
    })

    return response.ok
  } catch (error) {
    console.error('[video-sso] Main-site session validation failed:', error)
    return false
  }
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

function parseIdentityAllowlist(value) {
  if (typeof value !== 'string') return new Set()
  return new Set(
    value
      .split(/[,\n;\r]+/)
      .map((item) => normalizeIdentityValue(item))
      .filter(Boolean),
  )
}

function normalizeAdminCreditsPath(value) {
  const normalized = String(value || '').trim()
  if (!normalized || normalized === '/') return '/admin/credit-center'
  return normalized.startsWith('/') ? normalized : `/${normalized}`
}

function normalizeIdentityValue(value) {
  if (value == null) return ''
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
    identities.roles.some(isAdminRoleValue)
    || identities.groups.some(isAdminRoleValue)
  ) {
    return true
  }

  if (hasExplicitAdminAllowlist) {
    return false
  }

  return (
    identities.ids.some(isBuiltInAdminIdentity)
    || identities.accounts.some(isBuiltInAdminIdentity)
    || identities.emails.some(isBuiltInAdminIdentity)
    || identities.names.some(isBuiltInAdminIdentity)
  )
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

function isAdminRoleValue(value) {
  return (
    value === 'admin'
    || value === 'administrator'
    || value === 'superadmin'
    || value === 'super-admin'
    || value === 'root'
    || value.includes('管理员')
    || value.includes('administrator')
    || value.includes('superadmin')
  )
}

function requireAdminApiAccess(req, res, next) {
  if (req.path.startsWith('/credits/')) {
    next()
    return
  }

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
    <title>无权限访问</title>
    <style>
      body { margin: 0; font-family: "PingFang SC", "Microsoft YaHei", sans-serif; background: #0f172a; color: #e2e8f0; display: grid; place-items: center; min-height: 100vh; }
      .card { width: min(92vw, 460px); padding: 32px; border-radius: 20px; background: rgba(15, 23, 42, 0.9); border: 1px solid rgba(148, 163, 184, 0.24); box-shadow: 0 20px 60px rgba(15, 23, 42, 0.35); }
      h1 { margin: 0 0 10px; font-size: 26px; }
      p { margin: 0; line-height: 1.7; color: #cbd5e1; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>当前账号无后台权限</h1>
      <p>只有管理员账号可以进入监控后台。请返回视频工作台并使用管理员账号登录。</p>
    </div>
  </body>
</html>`)
    return
  }

  next()
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
function buildAggregationUsageLogSyncUpdate({
  payload,
  requestedTaskId,
  traceMetadata,
  mediaUrlResolver = extractAggregationVideoUrl,
}) {
  const taskId = extractAggregationTaskId(payload) || normalizeTaskIdValue(requestedTaskId)
  if (!taskId) {
    return null
  }

  const aggregationStatus = extractAggregationStatus(payload)
  const finalStatus = normalizeAggregationFinalStatus(aggregationStatus)
  if (finalStatus) {
    return {
      taskId,
      outcome: 'terminal',
      updates: {
        status: finalStatus,
        videoUrl: finalStatus === 'succeeded' ? mediaUrlResolver(payload) : null,
        errorMessage: finalStatus === 'succeeded' ? null : extractAggregationTerminalMessage(payload),
        completedAt: new Date().toISOString(),
        upstreamRequestId: traceMetadata?.requestId || null,
        upstreamTraceId: traceMetadata?.traceId || null,
      },
    }
  }

  const queryFailedMessage = payload?.success === false
    ? (extractAggregationTerminalMessage(payload) || '查询任务状态失败')
    : null
  if (queryFailedMessage) {
    return {
      taskId,
      outcome: 'needs_review',
      updates: {
        status: USAGE_STATUS_NEEDS_REVIEW,
        videoUrl: null,
        errorMessage: formatUsageStatusQueryFailureMessage(queryFailedMessage),
        completedAt: null,
        upstreamRequestId: traceMetadata?.requestId || null,
        upstreamTraceId: traceMetadata?.traceId || null,
      },
    }
  }

  if (isAggregationPendingStatus(aggregationStatus)) {
    return {
      taskId,
      outcome: 'pending',
      updates: {
        status: 'submitted',
        errorMessage: null,
        completedAt: null,
        upstreamRequestId: traceMetadata?.requestId || null,
        upstreamTraceId: traceMetadata?.traceId || null,
      },
    }
  }

  return null
}

function isAggregationPendingStatus(value) {
  if (value === null || value === undefined) return false

  const normalized = String(value).trim().toLowerCase()
  return [
    '0',
    '1',
    'submitted',
    'pending',
    'queued',
    'processing',
    'running',
    'inprogress',
    'in_progress',
  ].includes(normalized)
}

function formatUsageStatusQueryFailureMessage(message) {
  const normalized = readFirstString(message) || '查询任务状态失败'
  if (normalized.startsWith('状态查询失败')) {
    return normalized
  }
  return `状态查询失败：${normalized}`
}

async function markUntrackedUsageLogsForReview() {
  const db = getPool()
  if (!db) return 0

  const result = await db.query(
    `
      UPDATE video_usage_logs
      SET status = $1,
          error_message = CASE
            WHEN error_message IS NULL OR BTRIM(error_message) = '' THEN $2
            ELSE error_message
          END,
          completed_at = NULL,
          updated_at = NOW()
      WHERE status = 'submitted'
        AND engine_task_id IS NULL
        AND channel = ANY($3::text[])
        AND created_at <= NOW() - ($4::int * INTERVAL '1 minute')
      RETURNING id
    `,
    [
      USAGE_STATUS_NEEDS_REVIEW,
      UNTRACKED_USAGE_STATUS_MESSAGE,
      ['aggregation', 'veo_fast', 'yunwu', 'ark', 'wan'],
      UNTRACKED_USAGE_REVIEW_DELAY_MINUTES,
    ],
  )

  return result.rowCount
}

async function reclassifyAggregationQueryFailuresForReview() {
  const db = getPool()
  if (!db) return 0

  const result = await db.query(
    `
      UPDATE video_usage_logs
      SET status = $1,
          completed_at = NULL,
          error_message = CASE
            WHEN error_message IS NULL OR BTRIM(error_message) = '' THEN $2
            WHEN error_message LIKE '状态查询失败：%' THEN error_message
            ELSE '状态查询失败：' || error_message
          END,
          updated_at = NOW()
      WHERE channel = 'aggregation'
        AND status = 'failed'
        AND engine_task_id IS NOT NULL
        AND (
          error_message LIKE 'AK/SK校验失败%'
          OR error_message LIKE '查询任务状态失败%'
          OR error_message LIKE '状态查询失败：%'
        )
      RETURNING id
    `,
    [
      USAGE_STATUS_NEEDS_REVIEW,
      '状态查询失败：查询接口返回了非终态错误，请重新核对上游账号凭证。',
    ],
  )

  return result.rowCount
}

async function fetchAggregationLogsForStatusSync() {
  const db = getPool()
  if (!db) return []

  const retryDelaySeconds = Math.max(30, Math.floor(USAGE_STATUS_SYNC_INTERVAL_MS / 1000))
  const result = await db.query(
    `
      SELECT id, channel, provider_id, engine_task_id, status, created_at, updated_at
      FROM video_usage_logs
      WHERE (channel = 'aggregation' OR provider_id = 'gemini-image-aggregation')
        AND status = ANY($1::text[])
        AND engine_task_id IS NOT NULL
        AND created_at >= NOW() - ($2::int * INTERVAL '1 hour')
        AND created_at <= NOW() - ($3::int * INTERVAL '1 minute')
        AND updated_at <= NOW() - ($4::int * INTERVAL '1 second')
      ORDER BY updated_at ASC, created_at ASC
      LIMIT $5
    `,
    [
      ['submitted', USAGE_STATUS_NEEDS_REVIEW],
      USAGE_STATUS_SYNC_LOOKBACK_HOURS,
      USAGE_STATUS_SYNC_MIN_AGE_MINUTES,
      retryDelaySeconds,
      USAGE_STATUS_SYNC_BATCH_SIZE,
    ],
  )

  return result.rows
}

async function queryAggregationTaskStatusForSync(row) {
  const taskId = normalizeTaskIdValue(row?.engine_task_id)
  const isImageAggregationTask = row?.provider_id === 'gemini-image-aggregation'

  try {
    const payload = await requestJson(
      isImageAggregationTask ? imageAggregationApiBaseUrl : videoApiBaseUrl,
      '/openApi/queryResult',
      isImageAggregationTask ? buildImageAggregationHeaders() : {
        projectCode: process.env.VIDEO_PROJECT_CODE,
        'X-Access-Key': process.env.VIDEO_ACCESS_KEY,
        'X-Secret-Key': process.env.VIDEO_SECRET_KEY,
      },
      {
      taskId,
      abilityType: isImageAggregationTask ? 'IMAGE' : 'VIDEO',
    },
    )

    return buildAggregationUsageLogSyncUpdate({
      payload,
      requestedTaskId: taskId,
      traceMetadata: extractTraceMetadataFromPayload(payload),
      mediaUrlResolver: isImageAggregationTask ? extractAggregationImageUrl : extractAggregationVideoUrl,
    })
  } catch (error) {
    return {
      taskId: normalizeTaskIdValue(taskId),
      outcome: 'needs_review',
      updates: {
        status: USAGE_STATUS_NEEDS_REVIEW,
        videoUrl: null,
        errorMessage: formatUsageStatusQueryFailureMessage(error?.message || '查询任务状态失败'),
        completedAt: null,
        upstreamRequestId: error?.requestId || null,
        upstreamTraceId: error?.traceId || null,
      },
    }
  }
}

async function syncAggregationUsageStatuses() {
  const rows = await fetchAggregationLogsForStatusSync()
  const summary = {
    scanned: rows.length,
    updated: 0,
    terminal: 0,
    needsReview: 0,
    pending: 0,
  }

  for (const row of rows) {
    const syncUpdate = await queryAggregationTaskStatusForSync(row)
    if (!syncUpdate?.taskId || !syncUpdate.updates) {
      continue
    }

    await updateUsageLogByTaskId(syncUpdate.taskId, syncUpdate.updates)
    summary.updated += 1

    if (syncUpdate.outcome === 'terminal') {
      summary.terminal += 1
    } else if (syncUpdate.outcome === 'needs_review') {
      summary.needsReview += 1
    } else if (syncUpdate.outcome === 'pending') {
      summary.pending += 1
    }
  }

  return summary
}

async function runUsageStatusMaintenance(trigger = 'interval') {
  if (usageStatusSyncRunning) {
    return
  }

  usageStatusSyncRunning = true
  try {
    const reclassifiedCount = await reclassifyAggregationQueryFailuresForReview()
    const untrackedCount = await markUntrackedUsageLogsForReview()
    const syncSummary = await syncAggregationUsageStatuses()

    if (reclassifiedCount > 0 || untrackedCount > 0 || syncSummary.updated > 0) {
      console.info('[usage-status-sync]', {
        trigger,
        reclassifiedCount,
        untrackedCount,
        ...syncSummary,
      })
    }
  } catch (error) {
    console.error('[usage-status-sync] failed:', error)
  } finally {
    usageStatusSyncRunning = false
  }
}

function startUsageStatusMaintenanceLoop() {
  if (usageStatusSyncTimer) {
    return
  }

  runUsageStatusMaintenance('startup').catch((error) => {
    console.error('[usage-status-sync] startup failed:', error)
  })

  usageStatusSyncTimer = setInterval(() => {
    runUsageStatusMaintenance('interval').catch((error) => {
      console.error('[usage-status-sync] interval failed:', error)
    })
  }, USAGE_STATUS_SYNC_INTERVAL_MS)

  usageStatusSyncTimer.unref()
}
