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
  const sessionReuseIndex = htmlSsoBlock.indexOf('if (session) {')

  assert.ok(ticketIndex >= 0, 'expected HTML SSO flow to read ticket')
  assert.ok(sessionReuseIndex >= 0, 'expected HTML SSO flow to support old session reuse')
  assert.ok(ticketIndex < sessionReuseIndex, 'ticket must be read before reusing an old session')
})
