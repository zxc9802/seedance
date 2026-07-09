import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

test('main-site SSO ticket refreshes the video session before reusing an old HTML session', async () => {
  const serverSource = await fs.readFile(path.resolve('server.js'), 'utf8')
  const htmlGateIndex = serverSource.indexOf('if (!isHtmlDocumentRequest(req))')
  const exchangeIndex = serverSource.indexOf('const exchangeResult = await exchangeVideoSsoTicket', htmlGateIndex)
  const htmlSsoBlock = serverSource.slice(htmlGateIndex, exchangeIndex)

  assert.ok(htmlGateIndex >= 0, 'expected SSO middleware to check HTML document requests')
  assert.ok(exchangeIndex > htmlGateIndex, 'expected SSO middleware to exchange tickets for HTML requests')

  const ticketIndex = htmlSsoBlock.indexOf('const ticket = readSingleQueryValue(req.query.ticket)')
  const sessionReuseIndex = htmlSsoBlock.indexOf('if (validSession) {')

  assert.ok(ticketIndex >= 0, 'expected HTML SSO flow to read ticket')
  assert.ok(sessionReuseIndex >= 0, 'expected HTML SSO flow to support validated session reuse')
  assert.ok(ticketIndex < sessionReuseIndex, 'ticket must be read before reusing a validated session')
})

test('cached video sessions are validated against the main-site SSO session endpoint', async () => {
  const serverSource = await fs.readFile(path.resolve('server.js'), 'utf8')

  assert.match(serverSource, /async function validateVideoSiteSession\(session\)/)
  assert.match(serverSource, /\/api\/sso\/session/)
  assert.match(serverSource, /Authorization: `Bearer \$\{session\.token\}`/)
  assert.match(serverSource, /const validSession = await requireFreshVideoSiteSession\(req, res\)/)
  assert.match(serverSource, /clearVideoSiteSession\(res\)/)
  assert.match(serverSource, /code: 'SESSION_REVOKED'/)
})

test('/api/session rejects stale child-site cookies before returning a user', async () => {
  const serverSource = await fs.readFile(path.resolve('server.js'), 'utf8')
  const routeStart = serverSource.indexOf("app.get('/api/session',")
  const routeEnd = serverSource.indexOf('function resolveLocalDevSession()', routeStart)
  const routeSource = serverSource.slice(routeStart, routeEnd)

  assert.match(routeSource, /async \(req, res\)/)
  assert.match(routeSource, /await requireFreshVideoSiteSession\(req, res\)/)
  assert.doesNotMatch(routeSource, /const session = req\.videoSiteSession \|\| resolveLocalDevSession\(\)/)
})

test('legacy single-site credit center no longer bypasses SSO', async () => {
  const serverSource = await fs.readFile(path.resolve('server.js'), 'utf8')
  const bypassStart = serverSource.indexOf('function shouldBypassSso(req)')
  const bypassEnd = serverSource.indexOf('function isHtmlDocumentRequest(req)', bypassStart)
  const bypassSource = serverSource.slice(bypassStart, bypassEnd)

  assert.match(bypassSource, /resolveRequestPath\(req\)/)
  assert.doesNotMatch(bypassSource, /adminCreditsPath/)
  assert.doesNotMatch(bypassSource, /requestPath === '\/admin\/credit-center'/)
  assert.doesNotMatch(bypassSource, /requestPath\.startsWith\('\/api\/admin\/credits\/'\)/)
  assert.doesNotMatch(serverSource, /app\.get\(adminCreditsPath/)
})
