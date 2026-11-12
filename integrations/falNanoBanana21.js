import { setTimeout as sleep } from 'node:timers/promises'

const ASPECT_RATIOS = new Set(['auto', '21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16', '4:1', '1:4', '8:1', '1:8'])

export function normalizeNanoBanana21Input(body) {
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  const resolution = body.resolution || '1K'
  const aspectRatio = body.aspect_ratio || '9:16'
  const images = body.image ?? []
  const invalid = (message) => { throw Object.assign(new Error(message), { statusCode: 400 }) }
  if (!prompt) invalid('请输入提示词')
  if (!['1K', '2K', '4K'].includes(resolution)) invalid('分辨率仅支持 1K、2K、4K')
  if (!ASPECT_RATIOS.has(aspectRatio)) invalid('不支持的图片宽高比')
  if (!Array.isArray(images) || images.length > 14) invalid('最多支持 14 张参考图片')
  for (const image of images) {
    const match = typeof image === 'string' && image.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i)
    if (!match || !Buffer.from(match[1].replace(/\s/g, ''), 'base64').length) invalid('参考图片必须是有效的 Base64 图片')
  }
  return {
    prompt, resolution, aspect_ratio: aspectRatio, num_images: 1,
    limit_generations: true, output_format: 'png', thinking_level: 'medium',
    ...(images.length ? { image_urls: images } : {}),
  }
}

export async function generateFalNanoBanana21(input, {
  apiKey,
  baseUrl = 'https://queue.fal.run',
  timeoutMs = 360_000,
  pollIntervalMs = 1500,
  signal,
}) {
  const model = `google/nano-banana-2.1${input.image_urls?.length ? '/edit' : ''}`
  const endpoint = `${baseUrl}/${model}`
  const deadline = Date.now() + timeoutMs
  let requestId = ''

  async function request(url, init = {}) {
    const target = new URL(url)
    if (target.origin !== new URL(baseUrl).origin || target.username || target.password) {
      throw new Error('fal.ai returned an invalid task URL')
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('图片生成超时')
    const timeout = AbortSignal.timeout(Math.min(30_000, remaining))
    const response = await fetch(target, {
      ...init,
      headers: { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' },
      redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok || payload.error) {
      const detail = Array.isArray(payload.detail)
        ? payload.detail.map(item => item.msg || item.message).filter(Boolean).join('; ')
        : payload.detail
      throw Object.assign(new Error(`fal.ai HTTP ${response.status}: ${payload.error?.message || payload.error || detail || response.statusText}`), {
        statusCode: response.ok ? 502 : response.status,
      })
    }
    return payload
  }

  try {
    const queued = await request(endpoint, { method: 'POST', body: JSON.stringify(input) })
    requestId = queued.request_id || ''
    if (!requestId || !queued.status_url || !queued.response_url) throw new Error('fal.ai did not return a valid generation task')
    while (true) {
      const status = await request(queued.status_url)
      if (status.status === 'COMPLETED') break
      if (!['IN_QUEUE', 'IN_PROGRESS'].includes(status.status)) throw new Error(`fal.ai task failed: ${status.status || 'unknown status'}`)
      await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())), undefined, { signal })
    }
    const result = await request(queued.response_url)
    const url = result.images?.find(item => typeof item.url === 'string' && item.url.startsWith('https://'))?.url
    if (!url) throw new Error('fal.ai task completed without a result image')
    return { data: [{ url }], model, requestId, endpoint }
  } catch (error) {
    const message = error.name === 'TimeoutError' ? '图片生成超时' : String(error.message || error)
    const safeError = new Error(`${message}${requestId ? ` (fal request ${requestId})` : ''}`.split(apiKey).join('[redacted]'))
    safeError.statusCode = Number(error.statusCode) || 502
    safeError.requestId = requestId || undefined
    throw safeError
  }
}
