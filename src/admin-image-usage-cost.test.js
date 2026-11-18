import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import express from 'express'
import pg from 'pg'
import adminRouter from '../admin/api.js'

test('admin task details show a reference cost for an existing successful image with no billed amount', async (t) => {
  const oldEnv = { DATABASE_URL: process.env.DATABASE_URL, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD }
  process.env.DATABASE_URL = 'postgres://fixture@127.0.0.1/fixture'
  process.env.ADMIN_PASSWORD = 'fixture-password'
  t.after(() => {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  const task = {
    channel: 'image',
    provider_id: 'gpt-image-2.5-sunburst',
    model: 'openai/gpt-image-2.5/sunburst/edit',
    status: 'succeeded',
    resolution: '864x1536',
    sample_count: 1,
    request_params: { mediaCounts: { images: 3 } },
    estimated_cost: null,
  }
  const rows = [
    task,
    { ...task, estimated_cost: '0.00' },
    { ...task, status: 'failed' },
    { ...task, status: 'submitted' },
    { ...task, model: 'gpt-image-2.5-sunburst', request_params: { imageProvider: 'mixtoken' } },
    { ...task, provider_id: 'gemini-image-aggregation', model: 'gemini-3.1-flash-image-preview', sample_count: 3 },
    { ...task, provider_id: 'nano-banana-2.1', model: 'google/nano-banana-2.1/edit', resolution: '2K', request_params: { mediaCounts: { images: 2 } } },
    { ...task, model: 'openai/gpt-image-2.5/sunburst/text-to-image', resolution: '1024x1024', request_params: {} },
    { channel: 'aggregation', provider_id: 'seedance1', model: 'doubao-seedance-2-0-260128', status: 'succeeded', estimated_cost: null },
  ]
  t.mock.method(pg.Pool.prototype, 'query', async (sql) => ({
    rows: sql.includes('COUNT(*)::int AS total') ? [{ total: rows.length }] : rows,
  }))

  const app = express()
  app.use('/api/admin', adminRouter)
  const server = createServer(app).listen(0, '127.0.0.1')
  t.after(() => new Promise((resolve) => server.close(resolve)))
  await once(server, 'listening')

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/tasks`, {
    headers: { Authorization: 'Bearer fixture-password' },
  })
  assert.equal(response.status, 200)
  const { items } = await response.json()
  assert.equal(items[0].estimated_cost, null)
  assert.equal(items[1].estimated_cost, '0.00')
  assert.deepEqual(items.map((item) => item.referenceCostCny), [0.52, null, null, null, null, 0.60, 0.42, 0.35, null])
})
