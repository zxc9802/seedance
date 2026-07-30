import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('workbench generation keeps the credit gate before either upstream protocol', async () => {
  const source = await readFile(new URL('../server.js', import.meta.url), 'utf8')
  const routeStart = source.indexOf("app.post('/api/veo/generate'")
  const routeEnd = source.indexOf("app.post('/api/veo/queryResult'", routeStart)
  const route = source.slice(routeStart, routeEnd)

  const creditGate = route.indexOf('prepareVideoCreditCharge(')
  const relaySubmit = route.indexOf('submitSeedanceRelayUpstream(')
  const aggregationSubmit = route.indexOf("`${videoApiBaseUrl}/openApi/generate`")

  assert.ok(creditGate >= 0, 'expected the existing credit gate')
  assert.ok(relaySubmit > creditGate, 'relay submission must happen after the credit gate')
  assert.ok(aggregationSubmit > creditGate, 'aggregation submission must happen after the credit gate')
})

test('workbench query and status maintenance support relay without removing aggregation', async () => {
  const source = await readFile(new URL('../server.js', import.meta.url), 'utf8')
  const queryStart = source.indexOf("app.post('/api/veo/queryResult'")
  const queryEnd = source.indexOf("app.get('/api/veo/media/:taskId'", queryStart)
  const queryRoute = source.slice(queryStart, queryEnd)

  assert.match(queryRoute, /querySeedanceRelayUpstream\(/)
  assert.match(queryRoute, /\/openApi\/queryResult/)
  assert.match(source, /queryAggregationTaskStatusForSync[\s\S]*usesVideoRelayProtocol\(\)/)
})

test('relay protocol exposes uploaded Seedance references as public URLs instead of material IDs', async () => {
  const source = await readFile(new URL('../server.js', import.meta.url), 'utf8')
  const uploadStart = source.indexOf("app.post('/api/upload'")
  const uploadEnd = source.indexOf("app.post('/api/material/status'", uploadStart)
  const uploadRoute = source.slice(uploadStart, uploadEnd)

  assert.match(uploadRoute, /usesVideoRelayProtocol\(\)/)
  assert.match(uploadRoute, /item\.materialStatus = 2/)
  assert.match(uploadRoute, /item\.resourceRef = url/)
  assert.match(uploadRoute, /createMaterialReferenceTask\(/)
})

test('example environment documents an explicit upstream protocol switch', async () => {
  const source = await readFile(new URL('../.env.example', import.meta.url), 'utf8')

  assert.match(source, /VIDEO_UPSTREAM_PROTOCOL=aggregation/)
  assert.match(source, /VIDEO_RELAY_API_BASE_URL=/)
  assert.match(source, /VIDEO_RELAY_API_KEY=/)
})
