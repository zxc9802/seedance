import { createHash } from 'node:crypto'
import express from 'express'
import { calculateConfirmedMediaBilling } from '../db/monitorPricing.js'

const ALLOWED_MODELS = new Set([
  'doubao-seedance-2-0-260128',
  'doubao-seedance-2-0-fast-260128',
])
const ALLOWED_MODES = new Set(['t2v', 'i2v', 'flf', 'fusion'])
const ALLOWED_RATIOS = new Set(['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'])
const ALLOWED_DURATIONS = new Set([4, 5, 6, 8, 10, 12, 15])
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled'])

function sendError(res, status, code, message) {
  res.status(status).json({
    error: {
      code,
      message,
    },
  })
}

function normalizeStringArray(value, fieldName) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array`)
  }

  return value.map((item) => {
    const normalized = String(item || '').trim()
    if (!normalized) {
      throw new Error(`${fieldName} cannot contain empty values`)
    }
    return normalized
  })
}

function validateReferenceCounts(mode, references) {
  if (mode === 't2v' && (
    references.images.length > 0
    || references.videos.length > 0
    || references.audios.length > 0
  )) {
    throw new Error('t2v mode does not accept reference media')
  }
  if (mode === 'i2v' && references.images.length !== 1) {
    throw new Error('i2v mode requires exactly one reference image')
  }
  if (mode === 'flf' && references.images.length !== 2) {
    throw new Error('flf mode requires exactly two reference images')
  }
  if (['i2v', 'flf'].includes(mode) && (references.videos.length > 0 || references.audios.length > 0)) {
    throw new Error(`${mode} mode does not accept reference video or audio`)
  }
  if (mode === 'fusion') {
    if (references.images.length > 9 || references.videos.length > 3 || references.audios.length > 3) {
      throw new Error('fusion mode supports up to 9 images, 3 videos and 3 audios')
    }
    if (references.images.length + references.videos.length === 0) {
      throw new Error('fusion mode requires at least one reference image or video')
    }
  }
}

export function normalizeGenerationRequest(body) {
  const model = String(body?.model || '').trim()
  if (!ALLOWED_MODELS.has(model)) {
    throw new Error('Unsupported Seedance 2.0 model')
  }

  const prompt = String(body?.prompt || '').trim()
  if (!prompt) {
    throw new Error('prompt is required')
  }

  const mode = String(body?.mode || 't2v').trim().toLowerCase()
  if (!ALLOWED_MODES.has(mode)) {
    throw new Error('mode must be one of t2v, i2v, flf or fusion')
  }

  const aspectRatio = String(body?.aspect_ratio || body?.aspectRatio || '9:16').trim()
  if (!ALLOWED_RATIOS.has(aspectRatio)) {
    throw new Error('Unsupported aspect_ratio')
  }

  const resolution = String(body?.resolution || '720p').trim().toLowerCase()
  const allowedResolutions = model.includes('-fast-')
    ? new Set(['480p', '720p'])
    : new Set(['480p', '720p', '1080p'])
  if (!allowedResolutions.has(resolution)) {
    throw new Error(`Unsupported resolution for model ${model}`)
  }

  const duration = Number(body?.duration ?? 5)
  if (!Number.isInteger(duration) || !ALLOWED_DURATIONS.has(duration)) {
    throw new Error(`duration must be one of ${[...ALLOWED_DURATIONS].join(', ')}`)
  }

  const references = {
    images: normalizeStringArray(body?.references?.images, 'references.images'),
    videos: normalizeStringArray(body?.references?.videos, 'references.videos'),
    audios: normalizeStringArray(body?.references?.audios, 'references.audios'),
  }
  validateReferenceCounts(mode, references)

  return {
    model,
    prompt,
    mode,
    aspectRatio,
    resolution,
    duration,
    generateAudio: Boolean(body?.generate_audio ?? body?.generateAudio),
    references,
  }
}

function mapVideoMode(mode) {
  if (mode === 'i2v') return 'image_to_video'
  if (mode === 'flf') return 'first_last_frame'
  if (mode === 'fusion') return 'fusion_video'
  return 'text_to_video'
}

export function buildAggregationRequest(request) {
  const payload = {
    params: {
      mode: mapVideoMode(request.mode),
      resolution: request.resolution,
      scale: request.aspectRatio,
      duration: request.duration,
      generateAudio: request.generateAudio,
    },
  }

  if (request.references.images.length > 0) payload.resources = request.references.images
  if (request.references.videos.length > 0) payload.referVideoUrl = request.references.videos
  if (request.references.audios.length > 0) payload.referAudioUrl = request.references.audios

  return {
    modelId: request.model,
    abilityType: 'VIDEO',
    prompt: request.prompt,
    payload,
  }
}

function hashRequest(request) {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex')
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''))
}

function normalizeStoredStatus(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (['succeeded', 'completed', 'complete', 'success', '2'].includes(normalized)) return 'succeeded'
  if (['failed', 'failure', 'error', '3'].includes(normalized)) return 'failed'
  if (['cancelled', 'canceled', '4'].includes(normalized)) return 'cancelled'
  return 'submitted'
}

function publicStatus(status) {
  if (status === 'succeeded') return 'completed'
  if (status === 'failed' || status === 'cancelled') return 'failed'
  return 'processing'
}

function billingStatus(status) {
  if (status === 'succeeded') return 'settled'
  if (status === 'failed' || status === 'cancelled') return 'void'
  return 'quoted'
}

function asNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function formatTask(task) {
  const status = normalizeStoredStatus(task.status)
  const response = {
    id: task.id,
    object: 'video.generation.task',
    status: publicStatus(status),
    request_id: task.request_id,
    model: task.model,
    mode: task.generation_mode,
    created_at: task.created_at,
    updated_at: task.updated_at,
    billing: {
      status: billingStatus(status),
      unit: task.billing_unit,
      billable_units: asNumber(task.billable_units),
      upstream_cost_cny: asNumber(task.upstream_cost_cny),
      sale_multiplier: asNumber(task.sale_multiplier),
      sale_price_cny: asNumber(task.sale_price_cny),
      price_version: task.price_version,
    },
    poll_url: `/v1/videos/generations/${task.id}`,
  }

  if (status === 'succeeded' && task.video_url) {
    response.output = { video_url: task.video_url }
  }
  if ((status === 'failed' || status === 'cancelled') && task.error_message) {
    response.error = {
      code: status === 'cancelled' ? 'GENERATION_CANCELLED' : 'GENERATION_FAILED',
      message: task.error_message,
    }
  }
  if (task.completed_at) {
    response.completed_at = task.completed_at
  }
  return response
}

function providerStateUpdates(result) {
  const status = normalizeStoredStatus(result?.status)
  return {
    status,
    engine_task_id: result?.taskId || null,
    video_url: status === 'succeeded' ? (result?.videoUrl || null) : null,
    error_message: status === 'failed' || status === 'cancelled'
      ? (result?.message || 'Video generation failed')
      : null,
    upstream_request_id: result?.upstreamRequestId || null,
    upstream_trace_id: result?.upstreamTraceId || null,
    upstream_url: result?.upstreamUrl || null,
    completed_at: TERMINAL_STATUSES.has(status) ? new Date().toISOString() : null,
  }
}

function normalizeUsageSummary(summary) {
  const upstreamCostCny = asNumber(summary?.upstreamCostCny)
  const salePriceCny = asNumber(summary?.salePriceCny)
  return {
    requests: Math.max(0, Number(summary?.requests) || 0),
    succeeded: Math.max(0, Number(summary?.succeeded) || 0),
    failed: Math.max(0, Number(summary?.failed) || 0),
    upstream_cost_cny: upstreamCostCny,
    sale_price_cny: salePriceCny,
    gross_margin_cny: Number((salePriceCny - upstreamCostCny).toFixed(8)),
  }
}

export function getSeedanceRelayPricing() {
  return [...ALLOWED_MODELS].map((model) => {
    const billing = calculateConfirmedMediaBilling({
      providerId: 'seedance1',
      model,
      duration: 1,
      sampleCount: 1,
      billingAudience: 'external',
    })
    return {
      model,
      billing_unit: billing.billingUnit,
      upstream_cost_cny_per_unit: billing.costCnyPerUnit,
      sale_multiplier: billing.saleMultiplier,
      sale_price_cny_per_unit: billing.salePriceCny,
      price_version: billing.priceVersion,
    }
  })
}

export function createSeedanceRelayRouter({
  authenticate,
  repository,
  provider,
}) {
  const router = express.Router()

  router.use(async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    const authResult = await authenticate(req)
    if (!authResult?.ok) {
      sendError(
        res,
        authResult?.status || 401,
        authResult?.code || 'INVALID_API_KEY',
        authResult?.message || 'Invalid API key',
      )
      return
    }
    req.seedanceRelayApiKey = authResult.apiKey
    next()
  })

  router.get('/pricing', (_req, res) => {
    res.json({ models: getSeedanceRelayPricing() })
  })

  router.post('/videos/generations', async (req, res) => {
    const idempotencyKey = String(req.get('idempotency-key') || '').trim()
    if (!idempotencyKey) {
      sendError(res, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required')
      return
    }
    if (idempotencyKey.length > 128) {
      sendError(res, 400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key cannot exceed 128 characters')
      return
    }

    let request
    try {
      request = normalizeGenerationRequest(req.body)
    } catch (error) {
      sendError(res, 400, 'INVALID_REQUEST', error.message)
      return
    }

    const billing = calculateConfirmedMediaBilling({
      providerId: 'seedance1',
      model: request.model,
      duration: request.duration,
      sampleCount: 1,
      billingAudience: 'external',
    })

    let taskResult
    try {
      taskResult = await repository.createOrGetTask({
        apiKeyId: req.seedanceRelayApiKey.id,
        apiKeyName: req.seedanceRelayApiKey.name,
        idempotencyKey,
        requestHash: hashRequest(request),
        request,
        billing,
      })
    } catch (error) {
      if (error.code === 'IDEMPOTENCY_CONFLICT') {
        sendError(res, 409, error.code, error.message)
        return
      }
      sendError(res, 503, 'USAGE_STORE_UNAVAILABLE', error.message || 'Usage store unavailable')
      return
    }

    if (!taskResult.created) {
      res.setHeader('Idempotent-Replayed', 'true')
      res.json(formatTask(taskResult.task))
      return
    }

    try {
      const providerResult = await provider.submit(buildAggregationRequest(request))
      if (!providerResult?.taskId && !providerResult?.videoUrl) {
        throw new Error('Upstream accepted the request but returned no taskId or video URL')
      }
      const task = await repository.applyProviderState(
        taskResult.task.id,
        req.seedanceRelayApiKey.id,
        providerStateUpdates(providerResult),
      )
      res.setHeader('Location', `/v1/videos/generations/${task.id}`)
      res.setHeader('Retry-After', '3')
      res.status(202).json(formatTask(task))
    } catch (error) {
      const failureStatus = Number(error.statusCode) > 0 ? 'failed' : 'needs_review'
      await repository.applyProviderState(taskResult.task.id, req.seedanceRelayApiKey.id, {
        status: failureStatus,
        error_message: error.message || 'Upstream request failed',
        completed_at: failureStatus === 'failed' ? new Date().toISOString() : null,
      }).catch(() => {})
      sendError(res, Number(error.statusCode) || 502, 'UPSTREAM_ERROR', error.message || 'Upstream request failed')
    }
  })

  router.get('/videos/generations/:taskId', async (req, res) => {
    if (!isUuid(req.params.taskId)) {
      sendError(res, 404, 'TASK_NOT_FOUND', 'Task not found')
      return
    }
    let task
    try {
      task = await repository.findTask(req.params.taskId, req.seedanceRelayApiKey.id)
    } catch (error) {
      sendError(res, 503, 'USAGE_STORE_UNAVAILABLE', error.message || 'Usage store unavailable')
      return
    }
    if (!task) {
      sendError(res, 404, 'TASK_NOT_FOUND', 'Task not found')
      return
    }

    const storedStatus = normalizeStoredStatus(task.status)
    if (!TERMINAL_STATUSES.has(storedStatus) && task.engine_task_id) {
      try {
        const providerResult = await provider.query(task.engine_task_id)
        task = await repository.applyProviderState(
          task.id,
          req.seedanceRelayApiKey.id,
          providerStateUpdates(providerResult),
        )
      } catch (error) {
        sendError(res, Number(error.statusCode) || 502, 'UPSTREAM_QUERY_ERROR', error.message || 'Failed to query upstream task')
        return
      }
    }

    res.json(formatTask(task))
  })

  router.get('/usage', async (req, res) => {
    try {
      const usage = await repository.listUsage(req.seedanceRelayApiKey.id, {
        limit: req.query.limit,
        from: req.query.from,
        to: req.query.to,
      })
      res.json({
        summary: normalizeUsageSummary(usage.summary),
        items: usage.items.map(formatTask),
      })
    } catch (error) {
      if (error.code === 'INVALID_USAGE_FILTER') {
        sendError(res, 400, error.code, error.message)
        return
      }
      sendError(res, 503, 'USAGE_STORE_UNAVAILABLE', error.message || 'Usage store unavailable')
    }
  })

  return router
}
