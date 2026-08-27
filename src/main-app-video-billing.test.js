import assert from 'node:assert/strict'
import test from 'node:test'

import { createMainAppVideoBillingClient } from '../billing/mainAppVideoBilling.js'
import { beginVideoBilling, finalizeVideoBilling } from '../billing/videoBillingOrchestrator.js'
import { extractExternalVideoBillingContext } from '../db/usage.js'

test('video workbench reserves external main-account points through the authenticated billing API', async () => {
  const requests = []
  const client = createMainAppVideoBillingClient({
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      return new Response(JSON.stringify({
        success: true,
        data: {
          action: 'reserve',
          requestId: '11111111-1111-4111-8111-111111111111',
          requiredPoints: 5000,
          pointsBalance: 2000,
          chargeRequired: true,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  const result = await client.reserve({
    session: {
      token: 'main-site-token',
      mainAppUrl: 'https://main.example',
      user: { id: 'user-1', groupName: '外部用户' },
    },
    requestId: '11111111-1111-4111-8111-111111111111',
    model: 'doubao-seedance-2-0-260128',
    resolution: '720p',
    duration: 30,
  })

  assert.equal(result.requiredPoints, 5000)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://main.example/api/video-sso/billing')
  assert.equal(requests[0].options.headers.Authorization, 'Bearer main-site-token')
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    action: 'reserve',
    requestId: '11111111-1111-4111-8111-111111111111',
    model: 'doubao-seedance-2-0-260128',
    resolution: '720p',
    duration: 30,
  })
})

test('video workbench does not call main-account billing for internal sessions', async () => {
  const client = createMainAppVideoBillingClient({
    fetchImpl: async () => {
      throw new Error('billing API must not be called')
    },
  })

  assert.deepEqual(await client.reserve({
    session: {
      token: 'main-site-token',
      mainAppUrl: 'https://main.example',
      user: { id: 'internal-user', billingAudience: 'internal' },
    },
    requestId: '22222222-2222-4222-8222-222222222222',
    model: 'seedance2.5',
    resolution: '1080p',
    duration: 30,
  }), {
    chargeRequired: false,
    requiredPoints: 0,
  })
})

test('video generation reserves before submission and finalizes from terminal status', async () => {
  const actions = []
  const client = {
    async reserve(input) {
      actions.push(['reserve', input.requestId])
      return { chargeRequired: true, requiredPoints: 5000, pointsBalance: 2000 }
    },
    async settle(input) {
      actions.push(['settle', input.requestId])
      return { chargeRequired: true, chargedPoints: 5000, pointsBalance: 2000 }
    },
    async release(input) {
      actions.push(['release', input.requestId])
      return { chargeRequired: true, releasedPoints: 5000, pointsBalance: 7000 }
    },
  }
  const session = {
    token: 'main-site-token',
    mainAppUrl: 'https://main.example',
    user: { id: 'user-1', billingAudience: 'external' },
  }
  const requestId = '11111111-1111-4111-8111-111111111111'
  const billing = await beginVideoBilling({
    client,
    session,
    requestIdFactory: () => requestId,
    model: 'doubao-seedance-2-0-260128',
    resolution: '720p',
    duration: 30,
  })

  assert.deepEqual(billing, {
    requestId,
    chargeRequired: true,
    requiredPoints: 5000,
  })
  assert.equal(await finalizeVideoBilling({ client, session, billing, status: 'submitted' }), null)
  await finalizeVideoBilling({ client, session, billing, status: 'succeeded' })
  await finalizeVideoBilling({ client, session, billing, status: 'failed' })
  assert.deepEqual(actions, [
    ['reserve', requestId],
    ['settle', requestId],
    ['release', requestId],
  ])
})

test('video polling recovers the original main-account reservation from persisted usage params', () => {
  assert.deepEqual(extractExternalVideoBillingContext({
    user_id: 'user-1',
    request_params: {
      externalVideoBilling: {
        requestId: '11111111-1111-4111-8111-111111111111',
        chargeRequired: true,
        requiredPoints: 5000,
      },
    },
  }), {
    userId: 'user-1',
    requestId: '11111111-1111-4111-8111-111111111111',
    chargeRequired: true,
    requiredPoints: 5000,
  })
})
