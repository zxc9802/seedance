import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import express from 'express'

async function startSsoTestServer(t, upstreamFetch) {
  const source = await fs.readFile(path.resolve('server.js'), 'utf8')
  const app = express()
  const bindings = {
    app,
    fetch: upstreamFetch,
    Buffer,
    URL,
    AbortSignal,
    path,
    createHmac,
    timingSafeEqual,
    console: { error() {} },
    isProduction: true,
    requireMainAppSso: true,
    mainAppUrl: 'https://main.example',
    mainAppVideoEntryPath: '/bot/video-workbench-seedance',
    adminCreditCenterPath: '/admin/credit-center',
    videoSiteSessionCookieName: 'veo_studio_session',
    videoSiteSessionSecret: 'test-only-secret',
    videoSiteSessionTtlMs: 720 * 60 * 1000,
    stripTrailingSlash: (value) => value.replace(/\/+$/, ''),
    isAdminUser: () => false,
  }
  const helpers = source.slice(source.indexOf('function shouldBypassSso(req)'), source.indexOf('function parseIdentityAllowlist(value)'))
  const cookieHelpers = source.slice(source.indexOf('function appendSetCookie(res, cookie)'), source.indexOf('function buildAggregationUsageLogSyncUpdate('))
  let sessionHelpers
  app.use((req, res, next) => {
    req.videoSiteSession = sessionHelpers.readVideoSiteSession(req)
    next()
  })
  const sessionRouteStart = source.indexOf("app.get('/api/session',")
  const sessionRoute = source.slice(sessionRouteStart, source.indexOf('\n})', sessionRouteStart) + 3)
  const middleware = source.slice(source.indexOf('app.use(async (req, res, next) => {'), source.indexOf("app.post('/api/upload',"))
  const setup = new Function(...Object.keys(bindings), `${helpers}\n${cookieHelpers}\n${sessionRoute}\n${middleware}\nreturn { readVideoSiteSession, writeVideoSiteSession }`)
  sessionHelpers = setup(...Object.values(bindings))
  app.get('/', (_, res) => res.send('Studio'))
  app.get('/api/probe', (_, res) => res.json({ success: true }))

  let cookie
  sessionHelpers.writeVideoSiteSession({
    getHeader: () => undefined,
    setHeader: (_, value) => { cookie = value.split(';')[0] },
  }, { token: 'test-token', user: { id: 'test-user' }, mainAppUrl: 'https://main.example' })

  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve) => {
    server.close(resolve)
    server.closeAllConnections()
  }))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  return (url, headers = {}) => fetch(`${baseUrl}${url}`, {
    headers: { Cookie: cookie, ...headers },
    redirect: 'manual',
  })
}

test('temporary main-site failures preserve the login cookie and do not redirect to SSO', async (t) => {
  for (const [failure, upstreamFetch] of [
    ['429', async () => new Response(null, { status: 429 })],
    ['502', async () => new Response(null, { status: 502 })],
    ['503', async () => new Response(null, { status: 503 })],
    ['redirect', async (_, options) => options.redirect === 'manual'
      ? new Response(null, { status: 302, headers: { Location: '/login' } })
      : new Response('<html>Login</html>')],
    ['network', async () => { throw new TypeError('fetch failed') }],
  ]) {
    await t.test(failure, async (t) => {
      const request = await startSsoTestServer(t, upstreamFetch)
      for (const url of ['/', '/api/session', '/api/probe']) {
        const response = await request(url)
        assert.equal(response.headers.get('set-cookie'), null, `${url} must preserve the signed session cookie`)
        assert.equal(response.status, 503, `${url} must report a temporary authentication outage`)
        assert.equal(response.headers.get('location'), null, `${url} must not redirect to SSO`)
        const payload = await response.json()
        assert.equal(payload.code, 'SSO_UNAVAILABLE')
        assert.equal(payload.redirectUrl, undefined)
      }
    })
  }
})

test('a stalled main-site validation times out without clearing the login cookie', { timeout: 8000 }, async (t) => {
  const request = await startSsoTestServer(t, async (_, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  const response = await request('/api/session')
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('set-cookie'), null)
  assert.equal((await response.json()).code, 'SSO_UNAVAILABLE')
})

test('the same session works again when main-site validation recovers', async (t) => {
  let available = false
  const request = await startSsoTestServer(t, async (url, options) => {
    assert.equal(url, 'https://main.example/api/sso/session')
    assert.equal(options.headers.Authorization, 'Bearer test-token')
    return new Response(null, { status: available ? 200 : 503 })
  })
  assert.equal((await request('/api/session')).status, 503)
  available = true
  for (const url of ['/', '/api/session', '/api/probe']) {
    const response = await request(url)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('set-cookie'), null)
  }
})

test('an explicitly revoked main-site session still clears the cookie and requires SSO', async (t) => {
  for (const status of [401, 403]) {
    await t.test(String(status), async (t) => {
      const request = await startSsoTestServer(t, async () => new Response(null, { status }))
      const response = await request('/')
      assert.equal(response.status, 302)
      assert.equal(response.headers.get('location'), 'https://main.example/bot/video-workbench-seedance')
      assert.match(response.headers.get('set-cookie'), /Max-Age=0/)

      for (const url of ['/api/session', '/api/probe']) {
        const response = await request(url)
        assert.equal(response.status, 401)
        assert.match(response.headers.get('set-cookie'), /Max-Age=0/)
        const payload = await response.json()
        assert.equal(payload.code, 'SESSION_REVOKED')
        assert.equal(payload.redirectUrl, 'https://main.example/bot/video-workbench-seedance')
      }
    })
  }
})

test('missing or tampered cookies cannot access the site during a main-site outage', async (t) => {
  const request = await startSsoTestServer(t, async () => assert.fail('an invalid cookie must not reach the main site'))
  for (const Cookie of ['', 'veo_studio_session=invalid.signature']) {
    assert.equal((await request('/', { Cookie })).status, 302)
    assert.equal((await request('/api/session', { Cookie })).status, 401)
    assert.equal((await request('/api/probe', { Cookie })).status, 401)
  }
})

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

test('multi-merchant credit hub bypasses SSO while legacy single-site credit API stays removed', async () => {
  const serverSource = await fs.readFile(path.resolve('server.js'), 'utf8')
  const bypassStart = serverSource.indexOf('function shouldBypassSso(req)')
  const bypassEnd = serverSource.indexOf('function isHtmlDocumentRequest(req)', bypassStart)
  const bypassSource = serverSource.slice(bypassStart, bypassEnd)

  assert.match(bypassSource, /resolveRequestPath\(req\)/)
  assert.match(bypassSource, /requestPath === adminCreditCenterPath/)
  assert.match(bypassSource, /requestPath === '\/admin\/credit-hub'/)
  assert.match(bypassSource, /requestPath\.startsWith\('\/api\/admin\/credit-hub\/'\)/)
  assert.match(bypassSource, /requestPath\.startsWith\('\/api\/credit-agent\/'\)/)
  assert.doesNotMatch(bypassSource, /requestPath\.startsWith\('\/api\/admin\/credits\/'\)/)
  assert.doesNotMatch(serverSource, /app\.get\('\/admin\/site-credit-center'/)
})
