import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { postImageAndWait } from './testHelpers/imageJobs.js'
import { generateFalNanoBanana21, normalizeNanoBanana21Input } from '../integrations/falNanoBanana21.js'

const reference = 'data:image/png;base64,aGVsbG8='

test('Nano Banana 2.1 is selectable as Qiya Linghui and builds text/edit requests', async () => {
  const source = await readFile('src/modelConfig.js', 'utf8')
  const providersUrl = pathToFileURL(path.resolve('src/yunwuProviders.js')).href
  const { PROVIDERS, MODEL_TYPES } = await import(`data:text/javascript,${encodeURIComponent(source.replace("'./yunwuProviders'", `'${providersUrl}'`))}`)
  const config = PROVIDERS['nano-banana-2.1']
  assert.ok(config)
  assert.equal(config.selectorLabel, '起芽·灵绘（全能）')
  assert.ok(MODEL_TYPES.image.providers.includes(config.id))
  assert.equal(config.defaults.resolution, '1K')
  assert.deepEqual(config.resolutions.default, ['1K', '2K', '4K'])
  assert.equal(config.maxReferenceImages, 14)
  const app = await readFile('src/App.jsx', 'utf8')
  const start = app.indexOf('function buildNanoBanana21Request(')
  assert.notEqual(start, -1)
  const build = new Function(`${app.slice(start, app.indexOf('\nfunction ', start + 1))}\nreturn buildNanoBanana21Request`)()
  for (const mode of ['t2v', 'i2v']) {
    const request = build({ ...config.defaults, aspectRatio: '3:4' }, 'Poster', mode, [reference])
    assert.equal(request.url, '/api/nano-banana-2.1/generations')
    assert.deepEqual(request.body, {
      prompt: 'Poster', resolution: '1K', aspect_ratio: '3:4', ...(mode === 'i2v' ? { image: [reference] } : {}),
    })
    assert.equal(request.headers.Authorization, undefined)
  }
})

async function fixture(t, overrides = {}) {
  const requests = []
  const tasks = new Map()
  const upstream = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null
    requests.push({ url: req.url, authorization: req.headers.authorization, body })
    const reply = (payload, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (req.method === 'POST') {
      const id = String(tasks.size + 1)
      tasks.set(id, { prompt: body.prompt, polls: 0 })
      reply({
        request_id: id,
        status_url: body.prompt === 'untrusted URL' ? 'https://example.com/steal-key' : `${baseUrl}/tasks/${id}/status`,
        response_url: `${baseUrl}/tasks/${id}/result`,
      })
      return
    }
    const task = tasks.get(req.url.split('/')[2])
    if (req.url.endsWith('/status')) {
      task.polls += 1
      reply({ status: task.prompt === 'wait forever' ? 'IN_PROGRESS' : 'COMPLETED' })
    } else if (task.prompt === 'downstream failure') {
      reply({ detail: [{ msg: 'Downstream service error nano-test-key', type: 'downstream_service_error' }] }, 500)
    } else {
      reply({ images: task.prompt === 'empty result' ? [] : [{ url: 'https://example.com/nano.png' }] })
    }
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const baseUrl = `http://127.0.0.1:${upstream.address().port}`
  t.after(() => upstream.close())
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  const child = spawn(process.execPath, ['server.js', '--production'], {
    env: {
      ...process.env, PORT: String(port), REQUIRE_MAIN_APP_SSO: 'false', DATABASE_URL: '',
      TEMP_ASSET_SIGNING_SECRET: 'nano-test-assets', VIDEO_SITE_SESSION_SECRET: 'nano-test-session',
      FAL_KEY: 'nano-test-key', FAL_GPT_IMAGE2_API_KEY: 'legacy-nano-key', FAL_GPT_IMAGE2_API_BASE_URL: baseUrl,
      ...overrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let logs = ''
  child.stdout.on('data', chunk => { logs += chunk })
  child.stderr.on('data', chunk => { logs += chunk })
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit') }
  })
  const url = `http://127.0.0.1:${port}`
  let ready = false
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) assert.fail(logs)
    try { await fetch(`${url}/api/health`); ready = true; break } catch {}
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.ok(ready, logs)
  return {
    baseUrl, requests,
    submit: body => fetch(`${url}/api/nano-banana-2.1/generations`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
    post: body => postImageAndWait(`${url}/api/nano-banana-2.1/generations`, body),
    poll: pollUrl => fetch(new URL(pollUrl, url)),
    complete: () => { for (const task of tasks.values()) task.prompt = 'Poster' },
  }
}

test('Nano Banana routes keep credentials server-side and enforce supported input before billing', async t => {
  const { post, requests } = await fixture(t)
  for (const [resolution, image] of [['1K', []], ['2K', [reference]], ['4K', Array(14).fill(reference)]]) {
    const start = requests.length
    const response = await post({ prompt: 'Poster', resolution, aspect_ratio: '9:16', image, model: 'wrong-model', num_images: 4 })
    assert.equal(response.status, 200)
    const model = `google/nano-banana-2.1${image.length ? '/edit' : ''}`
    assert.equal(response.headers.get('x-image-model'), model)
    assert.equal(response.headers.get('x-image-provider'), 'fal')
    assert.deepEqual((await response.json()).data, [{ url: 'https://example.com/nano.png' }])
    const calls = requests.slice(start)
    assert.equal(calls.filter(call => call.body).length, 1)
    assert.equal(calls[0].url, `/${model}`)
    assert.deepEqual(calls[0].body, {
      prompt: 'Poster', resolution, aspect_ratio: '9:16', num_images: 1,
      limit_generations: true, output_format: 'png', thinking_level: 'medium',
      ...(image.length ? { image_urls: image } : {}),
    })
    assert.ok(calls.every(call => call.authorization === 'Key nano-test-key'))
  }
  const before = requests.length
  for (const body of [
    { prompt: '' }, { prompt: 'Poster', resolution: '8K' }, { prompt: 'Poster', aspect_ratio: '7:9' },
    { prompt: 'Edit', image: ['invalid'] }, { prompt: 'Edit', image: [null] },
    { prompt: 'Edit', image: Array(15).fill(reference) }, { prompt: 'Edit', image: reference },
  ]) assert.equal((await post(body)).status, 400)
  assert.equal(requests.length, before)
  for (const [prompt, expected] of [['downstream failure', 500], ['empty result', 502]]) {
    const start = requests.length
    const response = await post({ prompt })
    assert.equal(response.status, expected)
    const error = await response.json()
    assert.match(error.error.message, /fal request/)
    assert.doesNotMatch(JSON.stringify(error), /nano-test-key/)
    assert.equal(requests.slice(start).filter(call => call.body).length, 1)
  }
})

test('Nano Banana jobs return immediately and polling does not submit more paid requests', async t => {
  const { submit, poll, requests, complete } = await fixture(t)
  const response = await submit({ prompt: 'wait forever' })
  assert.equal(response.status, 202)
  const job = await response.json()
  for (let i = 0; i < 3; i++) {
    const snapshot = await (await poll(job.pollUrl)).json()
    assert.equal(snapshot.status, 'processing')
    assert.equal(snapshot.ownerId, undefined)
  }
  complete()
  let result
  for (let i = 0; i < 80; i++) {
    result = await (await poll(job.pollUrl)).json()
    if (result.status === 'completed') break
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(result.status, 'completed')
  assert.equal(requests.filter(call => call.body).length, 1)
})

test('Nano Banana accepts the existing legacy fal key and reports missing config', async t => {
  const { post, requests } = await fixture(t, { FAL_KEY: '' })
  assert.equal((await post({ prompt: 'Poster' })).status, 200)
  assert.ok(requests.every(call => call.authorization === 'Key legacy-nano-key'))
  const missing = await fixture(t, { FAL_KEY: '', FAL_GPT_IMAGE2_API_KEY: '' })
  assert.equal((await missing.post({ prompt: 'Poster' })).status, 500)
  assert.equal(missing.requests.length, 0)
})

test('Nano Banana queue rejects foreign task URLs and stops on timeout without resubmitting', async t => {
  const { baseUrl, requests } = await fixture(t)
  for (const [prompt, expected] of [['untrusted URL', /invalid task URL/], ['wait forever', /超时/]]) {
    const start = requests.length
    await assert.rejects(generateFalNanoBanana21(normalizeNanoBanana21Input({ prompt }), {
      apiKey: 'nano-test-key', baseUrl, timeoutMs: 100, pollIntervalMs: 10,
    }), expected)
    const calls = requests.slice(start)
    assert.equal(calls.filter(call => call.body).length, 1)
    assert.ok(calls.every(call => call.url.startsWith('/google/') || call.url.startsWith('/tasks/')))
  }
})
