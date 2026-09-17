import assert from 'node:assert/strict'

// Retain the existing provider assertions while exercising the real job API.
export async function postImageAndWait(url, body) {
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!response.ok || url.includes('/gpt-image2-vip/')) return response
  assert.equal(response.status, 202)
  const submitted = await response.json()
  assert.equal(submitted.status, 'queued')
  assert.ok(submitted.jobId)
  assert.equal(submitted.pollUrl, `/api/gpt-image-2.5/jobs/${submitted.jobId}`)
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const pollResponse = await fetch(new URL(submitted.pollUrl, url))
    assert.equal(pollResponse.status, 200)
    assert.equal(pollResponse.headers.get('cache-control'), 'no-store')
    const job = await pollResponse.json()
    assert.equal(job.jobId, submitted.jobId)
    if (job.status === 'completed') return Response.json(job.result, { headers: pollResponse.headers })
    if (job.status === 'failed') return Response.json({ error: { message: job.error } }, { status: job.statusCode })
    assert.ok(['queued', 'processing'].includes(job.status))
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Test image job did not complete')
}
