import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import test from 'node:test'

async function loadModelConfig() {
  const source = await readFile('src/modelConfig.js', 'utf8')
  const providersUrl = pathToFileURL(path.resolve('src/yunwuProviders.js')).href
  return import(`data:text/javascript,${encodeURIComponent(source.replace("'./yunwuProviders'", `'${providersUrl}'`))}`)
}

for (const model of ['gpt-image-2.5', 'gpt-image-2.5-sunburst']) {
  test(`${model} is selectable under Image and builds its own backend request`, async () => {
    const { MODEL_TYPES, PROVIDERS } = await loadModelConfig()
    const provider = PROVIDERS[model]
    assert.ok(provider, `${model} must be registered`)
    assert.ok(MODEL_TYPES.image.providers.includes(provider.id))
    assert.equal(provider.selectorLabel, model)
    assert.equal(provider.name, model)
    assert.equal(provider.defaults.model, model)
    assert.equal(MODEL_TYPES.image.providers[0], 'gpt-image-2.5-sunburst')

    const source = await readFile('src/App.jsx', 'utf8')
    const names = ['isGptImage2Provider', 'isGptImage2VipProvider', 'buildGptImage2Request', 'resolveImageSizeForParams', 'buildGptImage2Prompt']
    const functions = names.map((name) => {
      const start = source.indexOf(`function ${name}(`)
      return source.slice(start, source.indexOf('\nfunction ', start + 1))
    }).join('\n')
    const { accepts, build } = new Function('PROVIDERS', `${functions}\nreturn { accepts: isGptImage2Provider, build: buildGptImage2Request }`)(PROVIDERS)
    assert.equal(accepts(provider.id), true)
    const image = 'data:image/png;base64,aGVsbG8='
    const request = build(provider.id, provider.defaults, 'Draw a circle', 'i2v', [image])
    assert.equal(request.url, `/api/${model}/generations`)
    assert.equal(request.body.model, model)
    assert.equal(request.body.prompt, 'Draw a circle')
    assert.deepEqual(request.body.image, [image])
    assert.equal(request.headers.Authorization, undefined)
  })
}

test('Mixtoken route isolates credentials and supports generations, edits, validation and upstream errors', async (t) => {
  const requests = []
  let upstreamStatus = 200
  let outcomes = []
  const upstream = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    requests.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) })
    const outcome = outcomes.shift() ?? upstreamStatus
    if (outcome === 'disconnect') { req.socket.destroy(); return }
    const status = outcome === 'empty' ? 200 : outcome
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(outcome === 'empty' ? { data: [] } : status === 200
      ? { data: [{ b64_json: 'aW1hZ2U=' }] }
      : { error: { message: 'Upstream unavailable' } }))
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  t.after(() => upstream.close())
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  const child = spawn(process.execPath, ['server.js', '--production'], {
    cwd: process.cwd(),
    env: {
      ...process.env, PORT: String(port), REQUIRE_MAIN_APP_SSO: 'false', DATABASE_URL: '',
      TEMP_ASSET_SIGNING_SECRET: 'mixtoken-test-assets', VIDEO_SITE_SESSION_SECRET: 'mixtoken-test-session',
      MIXTOKEN_API_BASE_URL: `${upstreamUrl}/v1/`, MIXTOKEN_API_KEY: 'mixtoken-test-key',
      FAL_KEY: '', FAL_GPT_IMAGE2_API_KEY: '',
      GPT_IMAGE2_VIP_API_BASE_URL: upstreamUrl, GPT_IMAGE2_VIP_API_KEY: 'vip-test-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
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
  const post = (body, route = '/api/gpt-image-2.5/generations') => fetch(`${url}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const response = await post({ prompt: 'Draw a circle', model: 'wrong-model', providerId: 'gpt-image2-vip', size: '1024x1024' })
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).data, [{ b64_json: 'aW1hZ2U=' }])
  assert.equal(requests[0].url, '/v1/images/generations')
  assert.equal(requests[0].headers.authorization, 'Bearer mixtoken-test-key')
  assert.deepEqual(JSON.parse(requests[0].body), { model: 'gpt-image-2.5', prompt: 'Draw a circle', size: '1024x1024' })

  const reference = 'data:image/png;base64,aGVsbG8='
  assert.equal((await post({ prompt: 'Make it blue', image: [reference] })).status, 200)
  assert.equal(requests[1].url, '/v1/images/generations')
  const editBody = JSON.parse(requests[1].body)
  assert.equal(editBody.model, 'gpt-image-2.5')
  assert.equal(editBody.prompt, 'Make it blue')
  assert.deepEqual(editBody.image, [reference])

  const beforeInvalid = requests.length
  assert.equal((await post({ prompt: '' })).status, 400)
  assert.equal((await post({ prompt: 'Edit', image: Array(4).fill(reference) })).status, 400)
  assert.equal((await post({ prompt: 'Edit', image: ['invalid'] })).status, 400)
  assert.equal(requests.length, beforeInvalid)

  assert.equal((await post({ prompt: 'Trailing slash' }, '/api/gpt-image-2.5/generations/')).status, 200)
  assert.equal(requests.at(-1).headers.authorization, 'Bearer mixtoken-test-key')
  assert.equal(JSON.parse(requests.at(-1).body).model, 'gpt-image-2.5')

  assert.equal((await post({ prompt: 'Legacy VIP' }, '/api/gpt-image2-vip/generations')).status, 200)
  assert.equal(requests.at(-1).headers.authorization, 'Bearer vip-test-key')
  assert.equal(JSON.parse(requests.at(-1).body).model, 'gpt-image-2-vip')
  upstreamStatus = 503
  const failed = await post({ prompt: 'Failure' })
  assert.equal(failed.status, 503)
  assert.equal((await failed.json()).error.message, 'Upstream unavailable')

  const sunburstRoute = '/api/gpt-image-2.5-sunburst/generations'
  const primary = 'gpt-image-2.5-sunburst'
  const fallback = 'gpt-image-2.5'
  upstreamStatus = 200
  const requestModel = async (request) => request.headers['content-type'].includes('multipart/form-data')
    ? (await new Response(request.body, { headers: request.headers }).formData()).get('model')
    : JSON.parse(request.body).model

  for (const { name, sequence, expectedModels, expectedStatus, edit } of [
    { name: 'primary succeeds without retries', sequence: [200], expectedModels: [primary], expectedStatus: 200 },
    { name: 'retry succeeds without fallback', sequence: [503, 200], expectedModels: [primary, primary], expectedStatus: 200 },
    { name: 'third retry succeeds without fallback', sequence: [503, 503, 503, 200], expectedModels: Array(4).fill(primary), expectedStatus: 200 },
    { name: 'three retries precede fallback', sequence: [503, 503, 503, 503, 200], expectedModels: [...Array(4).fill(primary), fallback], expectedStatus: 200 },
    { name: 'network and empty-response failures also retry', sequence: ['disconnect', 'empty', 503, 400, 200], expectedModels: [...Array(4).fill(primary), fallback], expectedStatus: 200 },
    { name: 'all models failing returns the final error', sequence: [503, 503, 503, 503, 429], expectedModels: [...Array(4).fill(primary), fallback], expectedStatus: 429 },
    { name: 'fallback connection failure stops the retry chain', sequence: [503, 503, 503, 503, 'disconnect'], expectedModels: [...Array(4).fill(primary), fallback], expectedStatus: 502 },
    { name: 'empty fallback response is reported as a failure', sequence: ['empty', 'empty', 'empty', 'empty', 'empty'], expectedModels: [...Array(4).fill(primary), fallback], expectedStatus: 502 },
    { name: 'reference edits retain the input through fallback', sequence: [503, 503, 503, 503, 200], expectedModels: [...Array(4).fill(primary), fallback], expectedStatus: 200, edit: true },
  ]) {
    await t.test(name, async () => {
      outcomes = [...sequence]
      const start = requests.length
      const result = await post({ prompt: 'Draw a circle', size: '1024x1024', model: 'wrong-model', ...(edit ? { image: [reference] } : {}) }, sunburstRoute)
      assert.equal(result.status, expectedStatus)
      const attempts = requests.slice(start)
      assert.deepEqual(await Promise.all(attempts.map(requestModel)), expectedModels)
      if (expectedStatus === 200) assert.equal(result.headers.get('x-image-model'), expectedModels.at(-1))
      for (const request of attempts) {
        assert.equal(request.headers.authorization, 'Bearer mixtoken-test-key')
        assert.equal(request.url, '/v1/images/generations')
        if (edit) {
          const editBody = JSON.parse(request.body)
          assert.deepEqual(editBody.image, [reference])
          assert.equal(editBody.prompt, 'Draw a circle')
          assert.equal(editBody.size, '1024x1024')
        } else {
          assert.equal(JSON.parse(request.body).prompt, 'Draw a circle')
        }
      }
    })
  }
  await t.test('invalid references fail before any paid retry', async () => {
    const start = requests.length
    assert.equal((await post({ prompt: 'Edit', image: ['invalid'] }, sunburstRoute)).status, 400)
    assert.equal(requests.length, start)
  })
})
