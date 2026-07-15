import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('credit agent API is mounted with token auth and SSO bypass', async () => {
  const serverSource = await readFile(new URL('../server.js', import.meta.url), 'utf8')
  const agentSource = await readFile(new URL('../credit/agentApi.js', import.meta.url), 'utf8')

  assert.match(serverSource, /app\.use\('\/api\/credit-agent',\s*creditAgentRouter\)/)
  assert.match(serverSource, /requestPath\.startsWith\('\/api\/credit-agent\/'\)/)
  assert.match(agentSource, /CREDIT_AGENT_TOKEN/)
  assert.match(agentSource, /router\.get\('\/summary'/)
  assert.match(agentSource, /router\.get\('\/transactions'/)
  assert.match(agentSource, /router\.post\('\/recharge'/)
  assert.match(agentSource, /requestId/)
})

test('credit hub admin page and APIs are password-only hidden surfaces', async () => {
  const serverSource = await readFile(new URL('../server.js', import.meta.url), 'utf8')
  const adminApiSource = await readFile(new URL('../admin/api.js', import.meta.url), 'utf8')
  const hubPage = await readFile(new URL('../admin/credit-hub.html', import.meta.url), 'utf8')

  assert.match(serverSource, /app\.get\('\/admin\/credit-hub'/)
  assert.match(serverSource, /requestPath === '\/admin\/credit-hub'/)
  assert.match(serverSource, /requestPath\.startsWith\('\/api\/admin\/credit-hub\/'\)/)
  assert.match(adminApiSource, /router\.use\('\/credit-hub',\s*creditHubRouter\)/)
  assert.match(hubPage, /\/api\/admin\/credit-hub\/instances/)
  assert.match(hubPage, /新增项目/)
  assert.match(hubPage, /同步状态/)
  assert.doesNotMatch(hubPage, /token_ciphertext/)
})

test('credit hub tables and idempotent recharge request ids are initialized', async () => {
  const postgresSource = await readFile(new URL('../db/postgres.js', import.meta.url), 'utf8')

  assert.match(postgresSource, /ALTER TABLE user_credit_transactions ADD COLUMN IF NOT EXISTS request_id TEXT/)
  assert.match(postgresSource, /idx_credit_transactions_unique_recharge_request/)
  assert.match(postgresSource, /CREATE TABLE IF NOT EXISTS credit_hub_instances/)
  assert.match(postgresSource, /CREATE TABLE IF NOT EXISTS credit_hub_snapshots/)
  assert.match(postgresSource, /CREATE TABLE IF NOT EXISTS credit_hub_actions/)
})

test('credit hub stores remote tokens encrypted and does not return them in instance rows', async () => {
  const hubSource = await readFile(new URL('../admin/creditHub.js', import.meta.url), 'utf8')

  assert.match(hubSource, /encryptHubToken/)
  assert.match(hubSource, /decryptHubToken/)
  assert.match(hubSource, /token_hint/)
  assert.doesNotMatch(hubSource, /res\.json\([^)]*token_ciphertext/)
})
