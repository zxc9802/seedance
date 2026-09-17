import { randomUUID } from 'node:crypto'

const jobs = new Map()
const RESULT_TTL_MS = 30 * 60 * 1000
const JOB_TIMEOUT_MS = 12 * 60 * 1000

function cleanup() {
  for (const [id, job] of jobs) {
    if (['completed', 'failed'].includes(job.status) && Date.now() - job.updatedAt > RESULT_TTL_MS) jobs.delete(id)
  }
}

export function startImageGenerationJob(ownerId, generate) {
  cleanup()
  const job = { jobId: randomUUID(), ownerId, status: 'queued', createdAt: Date.now(), updatedAt: Date.now() }
  jobs.set(job.jobId, job)
  // Return to the HTTP handler before calling any upstream provider.
  setImmediate(async () => {
    job.status = 'processing'
    job.updatedAt = Date.now()
    try {
      job.result = await generate(job.jobId, AbortSignal.timeout(JOB_TIMEOUT_MS))
      job.status = 'completed'
    } catch (error) {
      job.status = 'failed'
      job.error = error.name === 'TimeoutError' ? '图片生成任务超时，请重新生成。' : error.message || '图片生成失败'
      job.statusCode = Number(error.statusCode) || 502
      if (error.requestId) job.requestId = error.requestId
    }
    job.updatedAt = Date.now()
  })
  return { jobId: job.jobId, status: job.status }
}

export function getImageGenerationJob(jobId, ownerId) {
  cleanup()
  const job = jobs.get(jobId)
  if (!job || job.ownerId !== ownerId) return null
  const { ownerId: _, ...snapshot } = job
  return structuredClone(snapshot)
}
