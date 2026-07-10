import test from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'

async function fileExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

test('multi-merchant credit hub stays available while generation credit billing is removed', async () => {
  const serverSource = await readFile(new URL('../server.js', import.meta.url), 'utf8')
  const adminApiSource = await readFile(new URL('../admin/api.js', import.meta.url), 'utf8')

  assert.equal(await fileExists(new URL('../admin/credit-hub.html', import.meta.url)), true)
  assert.equal(await fileExists(new URL('../admin/creditHub.js', import.meta.url)), true)
  assert.equal(await fileExists(new URL('../credit/agentApi.js', import.meta.url)), true)

  assert.match(serverSource, /app\.use\('\/api\/credit-agent',\s*creditAgentRouter\)/)
  assert.match(serverSource, /app\.get\(adminCreditCenterPath/)
  assert.match(serverSource, /app\.get\('\/admin\/credit-hub'/)
  assert.match(serverSource, /requestPath\.startsWith\('\/api\/credit-agent\/'\)/)
  assert.match(serverSource, /requestPath\.startsWith\('\/api\/admin\/credit-hub\/'\)/)
  assert.match(adminApiSource, /router\.use\('\/credit-hub',\s*creditHubRouter\)/)

  assert.doesNotMatch(serverSource, /assertSufficientCredits/)
  assert.doesNotMatch(serverSource, /prepareVideoCreditCharge/)
  assert.doesNotMatch(serverSource, /insertChargedUsageLog/)
  assert.doesNotMatch(serverSource, /shouldChargeCreditsForProvider/)
})
