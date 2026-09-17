export async function pollImageGenerationJob(jobId, {
  fetcher = fetch,
  intervalMs = 2000,
  timeoutMs = 13 * 60 * 1000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (typeof jobId !== 'string' || !jobId) throw new Error('图片生成接口未返回 jobId')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const response = await fetcher(`/api/gpt-image-2.5/jobs/${encodeURIComponent(jobId)}`, {
      cache: 'no-store', signal: AbortSignal.timeout(Math.min(30_000, deadline - Date.now())),
    })
    const job = await response.json()
    if (!response.ok) throw new Error(job.error?.message || job.message || '图片任务查询失败')
    if (job.status === 'completed') return job.result
    if (job.status === 'failed') throw new Error(job.error || '图片生成失败')
    if (!['queued', 'processing'].includes(job.status)) throw new Error('图片任务返回了未知状态')
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())))
  }
  throw new Error(`图片任务等待超时（jobId: ${jobId}），请稍后查询，避免重复提交。`)
}
