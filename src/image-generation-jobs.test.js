import assert from 'node:assert/strict'
import test from 'node:test'
import { startImageGenerationJob, getImageGenerationJob } from '../integrations/imageGenerationJobs.js'
import { pollImageGenerationJob } from './imageGenerationJobs.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('job IDs return before work, repeated queries never restart work, and owners are isolated', async () => {
  let calls = 0
  let finish
  const pending = new Promise((resolve) => { finish = resolve })
  const submitted = startImageGenerationJob('alice', async (id, signal) => {
    calls += 1
    assert.ok(id)
    assert.equal(signal.aborted, false)
    return pending
  })
  assert.equal(submitted.status, 'queued')
  assert.equal(calls, 0)
  assert.equal(getImageGenerationJob(submitted.jobId, 'bob'), null)
  assert.equal(getImageGenerationJob('missing', 'alice'), null)
  await tick()
  for (let i = 0; i < 10; i++) assert.equal(getImageGenerationJob(submitted.jobId, 'alice').status, 'processing')
  assert.equal(calls, 1)
  finish({ data: [{ url: 'https://example.com/image.png' }] })
  await tick()
  const done = getImageGenerationJob(submitted.jobId, 'alice')
  assert.equal(done.status, 'completed')
  assert.equal(done.ownerId, undefined)
  done.result.data[0].url = 'changed'
  assert.equal(getImageGenerationJob(submitted.jobId, 'alice').result.data[0].url, 'https://example.com/image.png')
})

test('worker failures become terminal job errors with upstream request IDs', async () => {
  const job = startImageGenerationJob('alice', async () => {
    throw Object.assign(new Error('Upstream rejected'), { requestId: 'fal-request', statusCode: 422 })
  })
  await tick()
  const result = getImageGenerationJob(job.jobId, 'alice')
  assert.equal(result.status, 'failed')
  assert.equal(result.error, 'Upstream rejected')
  assert.equal(result.statusCode, 422)
  assert.equal(result.requestId, 'fal-request')
})

test('completed jobs expire after the result retention window', async (t) => {
  const job = startImageGenerationJob('alice', async () => ({ data: [] }))
  await tick()
  const future = Date.now() + 31 * 60 * 1000
  t.mock.method(Date, 'now', () => future)
  assert.equal(getImageGenerationJob(job.jobId, 'alice'), null)
})

test('frontend polls queued and processing states and returns only the terminal image result', async () => {
  const states = ['queued', 'processing', 'completed']
  let calls = 0
  const result = { data: [{ url: 'https://example.com/image.png' }], provider: 'fal' }
  assert.deepEqual(await pollImageGenerationJob('test-job', {
    fetcher: async (url, options) => {
      calls += 1
      assert.equal(url, '/api/gpt-image-2.5/jobs/test-job')
      assert.equal(options.method, undefined)
      assert.equal(options.cache, 'no-store')
      return Response.json({ status: states.shift(), result })
    }, sleep: async () => {},
  }), result)
  assert.equal(calls, 3)
})

for (const [name, payload, status, pattern] of [
  ['provider failure', { status: 'failed', error: 'Provider unavailable' }, 200, /Provider unavailable/],
  ['unknown status', { status: 'something-else' }, 200, /未知状态/],
  ['expired session', { message: 'Please log in' }, 401, /Please log in/],
  ['missing task', { error: { message: 'Job missing' } }, 404, /Job missing/],
]) {
  test(`frontend stops polling on ${name}`, async () => {
    let calls = 0
    await assert.rejects(pollImageGenerationJob('test-job', {
      fetcher: async () => { calls += 1; return Response.json(payload, { status }) },
    }), pattern)
    assert.equal(calls, 1)
  })
}

test('frontend timeout preserves the job ID and never resubmits', async (t) => {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  let calls = 0
  await assert.rejects(pollImageGenerationJob('existing-job', {
    timeoutMs: 100,
    fetcher: async () => { calls += 1; return Response.json({ status: 'processing' }) },
    sleep: async () => { now += 101 },
  }), /existing-job/)
  assert.equal(calls, 1)
})
