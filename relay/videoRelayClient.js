const RELAY_PATH = '/v1/videos/generations'

export function normalizeVideoUpstreamProtocol(value) {
  const protocol = String(value || 'aggregation').trim().toLowerCase()
  if (protocol === 'aggregation' || protocol === 'relay') {
    return protocol
  }
  throw new Error('VIDEO_UPSTREAM_PROTOCOL must be aggregation or relay')
}

function normalizeReferences(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => String(item || '').trim())
    .filter(Boolean)
}

function mapAggregationMode(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'image_to_video') return 'i2v'
  if (normalized === 'first_last_frame') return 'flf'
  if (normalized === 'fusion_video') return 'fusion'
  return 't2v'
}

export function buildRelayGenerationRequest(body) {
  const params = body?.payload?.params || {}
  return {
    model: String(body?.modelId || body?.model || '').trim(),
    prompt: String(body?.prompt || '').trim(),
    mode: mapAggregationMode(params.mode),
    aspect_ratio: String(params.scale || params.aspectRatio || '9:16').trim(),
    resolution: String(params.resolution || '720p').trim().toLowerCase(),
    duration: Number(params.duration ?? 5),
    generate_audio: Boolean(params.generateAudio),
    references: {
      images: normalizeReferences(body?.payload?.resources),
      videos: normalizeReferences(body?.payload?.referVideoUrl),
      audios: normalizeReferences(body?.payload?.referAudioUrl),
    },
  }
}

function stripTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

async function readResponsePayload(response) {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function relayErrorMessage(payload) {
  if (typeof payload === 'string') return payload
  return payload?.error?.message || payload?.message || 'Relay request failed'
}

function relayErrorCode(payload) {
  if (!payload || typeof payload !== 'object') return null
  return payload?.error?.code || payload?.code || null
}

async function requireSuccessfulResponse(response) {
  const payload = await readResponsePayload(response)
  if (response.ok) return payload

  const error = new Error(relayErrorMessage(payload))
  error.statusCode = response.status
  error.code = relayErrorCode(payload)
  throw error
}

export function createVideoRelayClient({
  baseUrl,
  apiKey,
  fetchImpl = globalThis.fetch,
}) {
  const normalizedBaseUrl = stripTrailingSlash(baseUrl)
  const normalizedApiKey = String(apiKey || '').trim()

  return {
    async submit(body, { idempotencyKey } = {}) {
      const response = await fetchImpl(`${normalizedBaseUrl}${RELAY_PATH}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${normalizedApiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': String(idempotencyKey || '').trim(),
        },
        body: JSON.stringify(buildRelayGenerationRequest(body)),
      })
      return requireSuccessfulResponse(response)
    },

    async query(taskId) {
      const response = await fetchImpl(
        `${normalizedBaseUrl}${RELAY_PATH}/${encodeURIComponent(String(taskId || '').trim())}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${normalizedApiKey}`,
            Accept: 'application/json',
          },
        },
      )
      return requireSuccessfulResponse(response)
    },
  }
}

function relayTaskState(task) {
  const status = String(task?.status || '').trim().toLowerCase()
  if (['completed', 'succeeded', 'success'].includes(status)) return 'succeeded'
  if (['failed', 'failure', 'error', 'cancelled', 'canceled'].includes(status)) return 'failed'
  return 'submitted'
}

export function normalizeRelayTask(task) {
  const status = relayTaskState(task)
  return {
    taskId: String(task?.id || '').trim() || null,
    status,
    videoUrl: status === 'succeeded'
      ? (String(task?.output?.video_url || task?.output?.videoUrl || '').trim() || null)
      : null,
    message: status === 'failed'
      ? (String(task?.error?.message || task?.message || 'Video generation failed').trim())
      : null,
    upstreamRequestId: String(task?.request_id || '').trim() || null,
  }
}

export function formatRelayTaskAsAggregationPayload(task) {
  const normalized = normalizeRelayTask(task)
  const status = normalized.status === 'succeeded'
    ? 2
    : normalized.status === 'failed'
      ? 3
      : 1

  return {
    success: true,
    data: {
      taskId: normalized.taskId,
      status,
      message: normalized.videoUrl || normalized.message,
    },
  }
}
