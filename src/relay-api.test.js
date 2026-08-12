import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import express from 'express'
import {
  createApiKeyAuthenticator,
  createStoredRelayApiKey,
  findStoredRelayApiKey,
} from '../relay/apiKeys.js'
import {
  buildAggregationRequest,
  createSeedanceRelayRouter,
  normalizeGenerationRequest,
} from '../relay/api.js'

function createMemoryRepository() {
  const tasks = new Map()
  const idempotency = new Map()
  let nextId = 1

  return {
    async createOrGetTask(input) {
      const key = `${input.apiKeyId}:${input.idempotencyKey}`
      const existingId = idempotency.get(key)
      if (existingId) {
        const existing = tasks.get(existingId)
        if (existing.request_hash !== input.requestHash) {
          const error = new Error('Idempotency-Key was already used with a different request')
          error.code = 'IDEMPOTENCY_CONFLICT'
          throw error
        }
        return { created: false, task: existing }
      }

      const task = {
        id: `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`,
        app_id: input.apiKeyId,
        request_id: input.idempotencyKey,
        request_hash: input.requestHash,
        provider_id: 'seedance-relay',
        model: input.request.model,
        generation_mode: input.request.mode,
        prompt: input.request.prompt,
        aspect_ratio: input.request.aspectRatio,
        resolution: input.request.resolution,
        duration: input.request.duration,
        sample_count: 1,
        status: 'submitting',
        engine_task_id: null,
        video_url: null,
        error_message: null,
        billing_unit: input.billing.billingUnit,
        billable_units: input.billing.billableUnits,
        upstream_cost_cny: input.billing.upstreamCostCny,
        sale_multiplier: input.billing.saleMultiplier,
        sale_price_cny: input.billing.salePriceCny,
        cost_credits: input.billing.costCredits,
        charged_credits: input.billing.chargedCredits,
        price_version: input.billing.priceVersion,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completed_at: null,
      }
      tasks.set(task.id, task)
      idempotency.set(key, task.id)
      return { created: true, task }
    },

    async applyProviderState(taskId, apiKeyId, updates) {
      const task = tasks.get(taskId)
      if (!task || task.app_id !== apiKeyId) return null
      Object.assign(task, updates, { updated_at: new Date().toISOString() })
      if (['succeeded', 'failed', 'cancelled'].includes(task.status)) {
        task.completed_at = task.completed_at || new Date().toISOString()
      }
      return task
    },

    async findTask(taskId, apiKeyId) {
      const task = tasks.get(taskId)
      return task?.app_id === apiKeyId ? task : null
    },

    async listUsage(apiKeyId) {
      const items = [...tasks.values()].filter((task) => task.app_id === apiKeyId)
      const succeeded = items.filter((task) => task.status === 'succeeded')
      return {
        summary: {
          requests: items.length,
          succeeded: succeeded.length,
          failed: items.filter((task) => task.status === 'failed').length,
          upstreamCostCny: succeeded.reduce((sum, task) => sum + task.upstream_cost_cny, 0),
          salePriceCny: succeeded.reduce((sum, task) => sum + task.sale_price_cny, 0),
        },
        items,
      }
    },
  }
}

async function startRelay({ provider } = {}) {
  const repository = createMemoryRepository()
  const authenticate = createApiKeyAuthenticator({
    SEEDANCE_RELAY_API_KEYS_JSON: JSON.stringify([
      { appId: 'client-a', name: 'Client A', apiKey: 'sk-seedance-a' },
      { appId: 'client-b', name: 'Client B', apiKey: 'sk-seedance-b' },
    ]),
  })
  const activeProvider = provider || {
    submitCalls: 0,
    async submit() {
      this.submitCalls += 1
      return { taskId: 'upstream-1', status: 'submitted' }
    },
    async query() {
      return {
        taskId: 'upstream-1',
        status: 'succeeded',
        videoUrl: 'https://media.example/video.mp4',
      }
    },
  }

  const app = express()
  app.use(express.json())
  app.use('/v1', createSeedanceRelayRouter({
    authenticate,
    repository,
    provider: activeProvider,
  }))

  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  const address = server.address()
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    provider: activeProvider,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function relayHeaders(apiKey = 'sk-seedance-a', idempotencyKey = null) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
  }
}

const VALID_REQUEST = {
  model: 'doubao-seedance-2-0-260128',
  prompt: 'A product rotates slowly on a clean studio background',
  mode: 't2v',
  resolution: '720p',
  aspect_ratio: '9:16',
  duration: 5,
}

test('relay accepts Seedance 2.5 with the Seedance 2.0 contract', () => {
  const request = normalizeGenerationRequest({
    ...VALID_REQUEST,
    model: 'seedance2.5',
  })

  assert.equal(request.model, 'seedance2.5')
  assert.equal(request.resolution, '720p')
  assert.equal(buildAggregationRequest(request).modelId, 'seedance2.5')
})

test('generated relay API keys are stored as hashes and authenticate immediately', async () => {
  const rows = []
  const db = {
    async query(sql, params) {
      if (sql.includes('INSERT INTO relay_api_keys')) {
        const row = {
          app_id: params[0],
          name: params[1],
          key_hash: params[2],
          key_preview: params[3],
          enabled: true,
          created_at: new Date().toISOString(),
        }
        rows.push(row)
        return { rows: [row] }
      }
      if (sql.includes('FROM relay_api_keys') && sql.includes('key_hash = $1')) {
        return {
          rows: rows
            .filter((row) => row.enabled && row.key_hash === params[0])
            .map((row) => ({ app_id: row.app_id, name: row.name })),
        }
      }
      throw new Error(`Unexpected query: ${sql}`)
    },
  }

  const created = await createStoredRelayApiKey(db, { name: 'Client C' })
  assert.match(created.apiKey, /^sk-seedance-[A-Za-z0-9_-]{32,}$/)
  assert.equal(created.client.name, 'Client C')
  assert.equal(rows[0].key_hash.length, 64)
  assert.equal(JSON.stringify(rows).includes(created.apiKey), false)

  const authenticate = createApiKeyAuthenticator({}, {
    findApiKey: (apiKey) => findStoredRelayApiKey(db, apiKey),
  })
  const result = await authenticate({
    get: () => `Bearer ${created.apiKey}`,
  })
  assert.deepEqual(result, {
    ok: true,
    apiKey: {
      id: created.client.appId,
      name: 'Client C',
    },
  })
})

test('production server mounts the API-key relay before browser SSO middleware', async () => {
  const serverSource = await readFile(new URL('../server.js', import.meta.url), 'utf8')
  const adminSource = await readFile(new URL('../admin/api.js', import.meta.url), 'utf8')
  const databaseSource = await readFile(new URL('../db/postgres.js', import.meta.url), 'utf8')
  const repositorySource = await readFile(new URL('../relay/postgresRepository.js', import.meta.url), 'utf8')
  const mountIndex = serverSource.indexOf("app.use('/v1', seedanceRelayRouter)")
  const ssoIndex = serverSource.indexOf('app.use(async (req, res, next) =>')
  assert.ok(mountIndex > 0)
  assert.ok(ssoIndex > mountIndex)
  assert.match(serverSource, /requestJson\(\s*videoApiBaseUrl,\s*'\/openApi\/generate'/s)
  assert.match(serverSource, /requestJson\(\s*videoApiBaseUrl,\s*'\/openApi\/queryResult'/s)
  assert.match(databaseSource, /ON video_usage_logs\(channel, app_id, request_id\)/)
  assert.match(databaseSource, /sale_price_cny NUMERIC\(18,8\)/)
  assert.match(repositorySource, /ON CONFLICT \(channel, app_id, request_id\) DO NOTHING/)
  assert.match(repositorySource, /AND app_id = \$2[\s\S]*AND usage_source = \$3/)
  assert.match(adminSource, /router\.get\('\/relay\/overview'/)
  assert.match(adminSource, /SUM\(sale_price_cny\) FILTER \(WHERE status = 'succeeded'\)/)
})

test('relay requires a configured Bearer API key', async () => {
  const relay = await startRelay()
  try {
    const response = await fetch(`${relay.baseUrl}/v1/videos/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'req-auth' },
      body: JSON.stringify(VALID_REQUEST),
    })
    assert.equal(response.status, 401)
    assert.equal((await response.json()).error.code, 'INVALID_API_KEY')
  } finally {
    await relay.close()
  }
})

test('relay returns a 1.8 pricing snapshot and replays identical idempotent requests', async () => {
  const relay = await startRelay()
  try {
    const pricing = await fetch(`${relay.baseUrl}/v1/pricing`, {
      headers: relayHeaders('sk-seedance-a'),
    })
    assert.equal(pricing.status, 200)
    const pricingBody = await pricing.json()
    assert.equal(pricingBody.models[0].sale_multiplier, 1.8)
    assert.equal(pricingBody.models[0].sale_price_cny_per_unit, 1.8)

    const first = await fetch(`${relay.baseUrl}/v1/videos/generations`, {
      method: 'POST',
      headers: relayHeaders('sk-seedance-a', 'req-1'),
      body: JSON.stringify(VALID_REQUEST),
    })
    assert.equal(first.status, 202)
    assert.equal(first.headers.get('retry-after'), '3')
    const firstBody = await first.json()
    assert.equal(firstBody.status, 'processing')
    assert.equal(firstBody.billing.upstream_cost_cny, 5)
    assert.equal(firstBody.billing.sale_multiplier, 1.8)
    assert.equal(firstBody.billing.sale_price_cny, 9)
    assert.equal(firstBody.poll_url, `/v1/videos/generations/${firstBody.id}`)

    const replay = await fetch(`${relay.baseUrl}/v1/videos/generations`, {
      method: 'POST',
      headers: relayHeaders('sk-seedance-a', 'req-1'),
      body: JSON.stringify(VALID_REQUEST),
    })
    assert.equal(replay.status, 200)
    assert.equal(replay.headers.get('idempotent-replayed'), 'true')
    assert.equal((await replay.json()).id, firstBody.id)
    assert.equal(relay.provider.submitCalls, 1)

    const conflict = await fetch(`${relay.baseUrl}/v1/videos/generations`, {
      method: 'POST',
      headers: relayHeaders('sk-seedance-a', 'req-1'),
      body: JSON.stringify({ ...VALID_REQUEST, duration: 10 }),
    })
    assert.equal(conflict.status, 409)
    assert.equal((await conflict.json()).error.code, 'IDEMPOTENCY_CONFLICT')
  } finally {
    await relay.close()
  }
})

test('relay scopes tasks and usage to the submitting API key', async () => {
  const relay = await startRelay()
  try {
    const submitted = await fetch(`${relay.baseUrl}/v1/videos/generations`, {
      method: 'POST',
      headers: relayHeaders('sk-seedance-a', 'req-owner'),
      body: JSON.stringify(VALID_REQUEST),
    })
    const task = await submitted.json()

    const hidden = await fetch(`${relay.baseUrl}${task.poll_url}`, {
      headers: relayHeaders('sk-seedance-b'),
    })
    assert.equal(hidden.status, 404)

    const completed = await fetch(`${relay.baseUrl}${task.poll_url}`, {
      headers: relayHeaders('sk-seedance-a'),
    })
    assert.equal(completed.status, 200)
    const completedBody = await completed.json()
    assert.equal(completedBody.status, 'completed')
    assert.equal(completedBody.output.video_url, 'https://media.example/video.mp4')
    assert.equal(completedBody.billing.status, 'settled')

    const usage = await fetch(`${relay.baseUrl}/v1/usage`, {
      headers: relayHeaders('sk-seedance-a'),
    })
    assert.equal(usage.status, 200)
    const usageBody = await usage.json()
    assert.equal(usageBody.summary.requests, 1)
    assert.equal(usageBody.summary.succeeded, 1)
    assert.equal(usageBody.summary.upstream_cost_cny, 5)
    assert.equal(usageBody.summary.sale_price_cny, 9)

    const otherUsage = await fetch(`${relay.baseUrl}/v1/usage`, {
      headers: relayHeaders('sk-seedance-b'),
    })
    assert.equal((await otherUsage.json()).summary.requests, 0)
  } finally {
    await relay.close()
  }
})

test('relay keeps an ambiguous submit failure for review instead of confirming a charge', async () => {
  const provider = {
    submitCalls: 0,
    async submit() {
      this.submitCalls += 1
      throw new Error('socket disconnected before the upstream response')
    },
    async query() {
      throw new Error('query should not run without an upstream task id')
    },
  }
  const relay = await startRelay({ provider })
  try {
    const failedSubmit = await fetch(`${relay.baseUrl}/v1/videos/generations`, {
      method: 'POST',
      headers: relayHeaders('sk-seedance-a', 'req-ambiguous'),
      body: JSON.stringify(VALID_REQUEST),
    })
    assert.equal(failedSubmit.status, 502)

    const replay = await fetch(`${relay.baseUrl}/v1/videos/generations`, {
      method: 'POST',
      headers: relayHeaders('sk-seedance-a', 'req-ambiguous'),
      body: JSON.stringify(VALID_REQUEST),
    })
    const replayBody = await replay.json()
    assert.equal(replay.status, 200)
    assert.equal(replayBody.status, 'processing')
    assert.equal(replayBody.billing.status, 'quoted')
    assert.equal(provider.submitCalls, 1)

    const usage = await fetch(`${relay.baseUrl}/v1/usage`, {
      headers: relayHeaders('sk-seedance-a'),
    })
    const usageBody = await usage.json()
    assert.equal(usageBody.summary.succeeded, 0)
    assert.equal(usageBody.summary.sale_price_cny, 0)
  } finally {
    await relay.close()
  }
})
