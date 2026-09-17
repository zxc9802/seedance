import { postImageAndWait } from './testHelpers/imageJobs.js'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { generateFalGptImage25 } from '../integrations/falGptImage25.js'

async function fixture(t, overrides = {}) {
  const requests = []
  const tasks = new Map()
  const upstream = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
    requests.push({ url: req.url, headers: req.headers, body })
    const reply = (payload, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (req.url === '/v1/images/generations') {
      reply({ data: [{ url: 'https://example.com/backup.png' }] })
      return
    }
    if (req.method === 'POST') {
      if (body.prompt === 'fal unavailable') {
        reply({ detail: 'temporarily unavailable' }, 503)
        return
      }
      const id = String(tasks.size + 1)
      tasks.set(id, { prompt: body.prompt, polls: 0 })
      reply({
        request_id: id,
        status_url: body.prompt === 'untrusted URL' ? 'https://example.com/steal-key' : `${baseUrl}/returned/${id}/status`,
        response_url: `${baseUrl}/returned/${id}/result`,
      })
      return
    }
    const task = tasks.get(req.url.split('/')[2])
    if (req.url.endsWith('/status')) {
      task.polls += 1
      reply({ status: task.prompt === 'wait forever' ? 'IN_PROGRESS' : task.polls === 1 ? 'IN_QUEUE' : 'COMPLETED' })
    } else if (task.prompt === 'empty image') {
      reply({ images: [] })
    } else if (task.prompt === 'failed completion') {
      reply({ detail: 'provider rejected fal-secret-key' }, 422)
    } else {
      reply({ images: [{ url: 'https://example.com/fal.png' }] })
    }
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  t.after(() => upstream.close())
  const baseUrl = `http://127.0.0.1:${upstream.address().port}`
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  const child = spawn(process.execPath, ['server.js', '--production'], {
    env: {
      ...process.env, PORT: String(port), REQUIRE_MAIN_APP_SSO: 'false', DATABASE_URL: '',
      TEMP_ASSET_SIGNING_SECRET: 'fal-test-assets', VIDEO_SITE_SESSION_SECRET: 'fal-test-session',
      FAL_KEY: 'fal-secret-key', FAL_GPT_IMAGE2_API_KEY: 'legacy-fal-key',
      FAL_GPT_IMAGE2_API_BASE_URL: baseUrl,
      MIXTOKEN_API_KEY: 'backup-key', MIXTOKEN_API_BASE_URL: baseUrl,
      ...overrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  child.stdout.on('data', (chunk) => { logs += chunk })
  child.stderr.on('data', (chunk) => { logs += chunk })
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill()
      await once(child, 'exit')
    }
  })
  const url = `http://127.0.0.1:${port}`
  let ready = false
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) assert.fail(logs)
    try { await fetch(`${url}/api/session`); ready = true; break } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(ready, logs)
  return {
    baseUrl, requests,
    post: (body, provider = 'gpt-image-2.5') => postImageAndWait(`${url}/api/${provider}/generations`, body),
    submit: (body) => fetch(`${url}/api/gpt-image-2.5/generations`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
    poll: (pollUrl) => fetch(new URL(pollUrl, url)),
    completeTasks: () => { for (const task of tasks.values()) task.prompt = 'Poster' },
  }
}

test('production routes prefer fal high and preserve references, sizes and backup behavior', async (t) => {
  const { post, requests, baseUrl } = await fixture(t)
  const reference = 'data:image/png;base64,aGVsbG8='
  for (const provider of ['gpt-image-2.5', 'gpt-image-2.5-sunburst']) {
    for (const image of [[], [reference]]) {
      await t.test(`${provider}: ${image.length ? 'edit' : 'text-to-image'}`, async () => {
        const start = requests.length
        const response = await post({ prompt: 'Poster', size: '1152x1536', image, model: 'wrong-model', quality: 'low' }, provider)
        assert.equal(response.status, 200)
        assert.equal(response.headers.get('x-image-provider'), 'fal')
        const model = `openai/gpt-image-2.5/sunburst/${image.length ? 'edit' : 'text-to-image'}`
        assert.equal(response.headers.get('x-image-model'), model)
        const payload = await response.json()
        assert.deepEqual(payload.data, [{ url: 'https://example.com/fal.png' }])
        assert.ok(payload.requestId)
        const calls = requests.slice(start)
        assert.equal(calls.filter((call) => call.body).length, 1)
        assert.equal(calls[0].url, `/${model}`)
        assert.deepEqual(calls[0].body, {
          prompt: 'Poster', quality: 'high', num_images: 1, output_format: 'png',
          image_size: { width: 1152, height: 1536 }, ...(image.length ? { image_urls: image } : {}),
        })
        assert.ok(calls.every((call) => call.headers.authorization === 'Key fal-secret-key'))
        assert.ok(calls.slice(1).every((call) => call.url.startsWith('/returned/')))
      })
    }
  }
  for (const prompt of ['fal unavailable', 'failed completion', 'empty image', 'untrusted URL']) {
    await t.test(`${prompt} switches to Mixtoken once and retains references`, async () => {
      const start = requests.length
      const response = await post({ prompt, size: '1024x1024', image: [reference] }, 'gpt-image-2.5-sunburst')
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('x-image-provider'), 'mixtoken')
      assert.equal(response.headers.get('x-image-model'), 'gpt-image-2.5-sunburst')
      assert.deepEqual((await response.json()).data, [{ url: 'https://example.com/backup.png' }])
      const calls = requests.slice(start).filter((call) => call.body)
      assert.equal(calls.length, 2)
      assert.equal(calls[1].url, '/v1/images/generations')
      assert.equal(calls[1].headers.authorization, 'Bearer backup-key')
      assert.deepEqual(calls[1].body.image, [reference])
    })
  }
  await t.test('invalid requests do not reach either paid provider', async () => {
    const start = requests.length
    for (const body of [{ prompt: '' }, { prompt: 'Edit', image: ['invalid'] }, { prompt: 'Edit', image: Array(4).fill(reference) }]) {
      assert.equal((await post(body)).status, 400)
    }
    assert.equal(requests.length, start)
  })
  await t.test('queue timeout does not submit a second fal job', async () => {
    const start = requests.length
    await assert.rejects(generateFalGptImage25({ prompt: 'wait forever' }, {
      apiKey: 'fal-secret-key', baseUrl, timeoutMs: 100, pollIntervalMs: 10,
    }), /timed out/)
    assert.equal(requests.slice(start).filter((call) => call.body).length, 1)
  })
})

test('fal works without Mixtoken and errors retain task IDs while redacting credentials', async (t) => {
  const { post } = await fixture(t, { MIXTOKEN_API_KEY: '' })
  assert.equal((await post({ prompt: 'Poster' })).status, 200)
  const response = await post({ prompt: 'failed completion' })
  assert.equal(response.status, 502)
  const payload = await response.json()
  assert.match(payload.error.message, /fal request/)
  assert.match(payload.error.message, /\[redacted\]/)
  assert.doesNotMatch(JSON.stringify(payload), /fal-secret-key/)
})

test('existing FAL_GPT_IMAGE2_API_KEY is supported when FAL_KEY is empty', async (t) => {
  const { post, requests } = await fixture(t, { FAL_KEY: '' })
  assert.equal((await post({ prompt: 'Poster' })).status, 200)
  assert.ok(requests.every((call) => call.headers.authorization === 'Key legacy-fal-key'))
})


test('HTTP submission returns a job ID while fal is still running; GET polls never create another generation', async (t) => {
  const { submit, poll, completeTasks, requests } = await fixture(t)
  const response = await submit({ prompt: 'wait forever' })
  assert.equal(response.status, 202)
  const submitted = await response.json()
  assert.equal(submitted.status, 'queued')
  assert.ok(submitted.jobId)
  for (let i = 0; i < 3; i++) {
    const job = await (await poll(submitted.pollUrl)).json()
    assert.equal(job.status, 'processing')
    assert.equal(job.result, undefined)
    assert.equal(job.ownerId, undefined)
  }
  completeTasks()
  let final
  for (let i = 0; i < 60; i++) {
    final = await (await poll(submitted.pollUrl)).json()
    if (final.status === 'completed') break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(final.status, 'completed')
  assert.equal(final.result.provider, 'fal')
  assert.equal(final.result.model, 'openai/gpt-image-2.5/sunburst/text-to-image')
  assert.equal(requests.filter((req) => req.body).length, 1)
  assert.equal((await poll('/api/gpt-image-2.5/jobs/nonexistent')).status, 404)
})
