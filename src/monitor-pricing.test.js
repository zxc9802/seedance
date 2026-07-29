import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateConfirmedMediaBilling } from '../db/monitorPricing.js'

test('external Seedance 2 is monitored at 180 credits per second', () => {
  const billing = calculateConfirmedMediaBilling({
    providerId: 'seedance1',
    model: 'doubao-seedance-2-0-260128',
    duration: 5,
    sampleCount: 1,
    billingAudience: 'external',
  })
  assert.equal(billing.chargedCredits, 900)
  assert.equal(billing.costCredits, 500)
  assert.equal(billing.salePriceCny, 9)
})

test('external Seedance 2 Fast is monitored at 90 credits per second', () => {
  const billing = calculateConfirmedMediaBilling({
    providerId: 'seedance1',
    model: 'doubao-seedance-2-0-fast-260128',
    duration: 10,
    sampleCount: 1,
    billingAudience: 'external',
  })
  assert.equal(billing.chargedCredits, 900)
  assert.equal(billing.costCredits, 500)
  assert.equal(billing.salePriceCny, 9)
})

test('external Nano Banana 2 is monitored at 36 credits per image', () => {
  const billing = calculateConfirmedMediaBilling({
    providerId: 'gemini-image-aggregation',
    model: 'gemini-3.1-flash-image-preview',
    sampleCount: 3,
    billingAudience: 'external',
  })
  assert.equal(billing.chargedCredits, 108)
  assert.equal(billing.costCredits, 60)
  assert.equal(billing.salePriceCny, 1.08)
})
