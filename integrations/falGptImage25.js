import { setTimeout as sleep } from 'node:timers/promises'

export async function generateFalGptImage25({ prompt, size, image = [] }, {
  apiKey,
  baseUrl = 'https://queue.fal.run',
  timeoutMs = 360_000,
  pollIntervalMs = 1500,
}) {
  const model = `openai/gpt-image-2.5/sunburst/${image.length ? 'edit' : 'text-to-image'}`
  const endpoint = `${baseUrl}/${model}`
  const deadline = Date.now() + timeoutMs
  let requestId = ''

  async function request(url, init = {}) {
    const target = new URL(url)
    if (target.origin !== new URL(baseUrl).origin || target.username || target.password) {
      throw new Error('fal.ai returned an invalid task URL')
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('fal.ai image generation timed out')
    const response = await fetch(target, {
      ...init,
      headers: { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(Math.min(30_000, remaining)),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok || payload.error) {
      const detail = Array.isArray(payload.detail)
        ? payload.detail.map((item) => item.msg || item.message).filter(Boolean).join('; ')
        : payload.detail
      throw new Error(`fal.ai HTTP ${response.status}: ${payload.error?.message || payload.error || detail || response.statusText}`)
    }
    return payload
  }

  try {
    const dimensions = size?.match(/^(\d+)x(\d+)$/)
    const queued = await request(endpoint, {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        quality: 'high',
        num_images: 1,
        output_format: 'png',
        image_size: dimensions ? { width: Number(dimensions[1]), height: Number(dimensions[2]) } : 'auto',
        ...(image.length ? { image_urls: image } : {}),
      }),
    })
    requestId = queued.request_id || ''
    if (!requestId || !queued.status_url || !queued.response_url) {
      throw new Error('fal.ai did not return a valid generation task')
    }
    while (true) {
      const status = await request(queued.status_url)
      if (status.status === 'COMPLETED') break
      if (!['IN_QUEUE', 'IN_PROGRESS'].includes(status.status)) {
        throw new Error(`fal.ai task failed: ${status.status || 'unknown status'}`)
      }
      await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())))
    }
    const result = await request(queued.response_url)
    const url = result.images?.find((item) => typeof item.url === 'string' && item.url.startsWith('https://'))?.url
    if (!url) throw new Error('fal.ai task completed without a result image')
    return { data: [{ url }], model, requestId, endpoint }
  } catch (error) {
    const message = error.name === 'TimeoutError' ? 'fal.ai image generation timed out' : String(error.message || error)
    const safeError = new Error(`${message.split(apiKey).join('[redacted]')}${requestId ? ` (fal request ${requestId})` : ''}`)
    safeError.requestId = requestId || undefined
    throw safeError
  }
}
