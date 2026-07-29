import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('relay admin uses its own password gate instead of the video workbench SSO', async () => {
  const serverSource = await readFile(new URL('../server.js', import.meta.url), 'utf8')
  const pageSource = await readFile(new URL('../admin/relay.html', import.meta.url), 'utf8')

  assert.match(serverSource, /if \(requestPath === '\/relay-admin'\) return true/)
  assert.match(serverSource, /requestPath\.startsWith\('\/api\/admin\/relay\/'\)/)
  assert.match(serverSource, /if \(req\.path\.startsWith\('\/relay\/'\)\) \{\s*next\(\)/)
  assert.match(serverSource, /app\.get\('\/relay-admin',\s*\(req, res\)/)
  assert.doesNotMatch(serverSource, /app\.get\('\/relay-admin',\s*requireAdminPageAccess/)
  assert.match(serverSource, /admin',\s*'relay\.html'/)
  assert.match(pageSource, /\/api\/admin\/relay\/overview/)
  assert.match(pageSource, /上游成本/)
  assert.match(pageSource, /对外售价/)
  assert.match(pageSource, /毛利润/)
  assert.match(pageSource, /最近请求/)
  assert.match(pageSource, /API 客户端/)
})

test('relay admin overview exposes masked clients, pricing, trends and recent tasks', async () => {
  const adminApiSource = await readFile(new URL('../admin/api.js', import.meta.url), 'utf8')
  const databaseSource = await readFile(new URL('../db/postgres.js', import.meta.url), 'utf8')
  const pageSource = await readFile(new URL('../admin/relay.html', import.meta.url), 'utf8')
  const relayApiSource = await readFile(new URL('../relay/api.js', import.meta.url), 'utf8')

  assert.match(adminApiSource, /parseConfiguredApiKeys/)
  assert.match(adminApiSource, /maskRelayApiKey/)
  assert.match(adminApiSource, /router\.post\('\/relay\/api-keys'/)
  assert.match(adminApiSource, /databaseAvailable/)
  assert.match(adminApiSource, /recent/)
  assert.match(adminApiSource, /trend/)
  assert.match(adminApiSource, /pricing/)
  assert.match(databaseSource, /CREATE TABLE IF NOT EXISTS relay_api_keys/)
  assert.match(pageSource, /生成 API Key/)
  assert.match(pageSource, /generateApiKey/)
  assert.match(relayApiSource, /export function getSeedanceRelayPricing/)
})
