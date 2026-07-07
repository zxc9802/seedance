import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  calculateVideoCreditCharge,
  extractCreditUserInfo,
  shouldChargeCreditsForProvider,
  shouldDeductCreditsForUsageUpdate,
  normalizeCreditAmount,
} from '../db/credits.js'

test('text-to-video credit charge uses the base resolution rate per generated second', () => {
  const charge = calculateVideoCreditCharge({
    resolution: '1080P',
    duration: 8,
    sampleCount: 2,
    requestParams: {
      mediaSummary: {
        images: { count: 0 },
        videos: { count: 0 },
      },
    },
  })

  assert.deepEqual(charge, {
    category: 'text',
    resolution: '1080p',
    rate: 7.6,
    billableSeconds: 16,
    amount: 121.6,
  })
})

test('reference credit charge uses reference rates and includes reference video length', () => {
  const charge = calculateVideoCreditCharge({
    resolution: '720p',
    duration: 6,
    sampleCount: 1,
    requestParams: {
      mediaSummary: {
        images: { count: 1 },
        videos: { count: 1, durationSeconds: 4 },
      },
    },
  })

  assert.deepEqual(charge, {
    category: 'reference',
    resolution: '720p',
    rate: 5,
    billableSeconds: 10,
    amount: 50,
  })
})

test('credit user identity can be read from production session or dev fallback', () => {
  assert.deepEqual(extractCreditUserInfo({
    user: {
      id: 'u_1',
      account: 'buyer@example.com',
      nickname: '买家一号',
      groupName: '运营',
    },
  }), {
    userId: 'u_1',
    email: 'buyer@example.com',
    nickname: '买家一号',
    group: '运营',
  })

  const previousUserId = process.env.DEV_USAGE_USER_ID
  const previousEmail = process.env.DEV_USAGE_USER_EMAIL
  process.env.DEV_USAGE_USER_ID = 'local-user'
  process.env.DEV_USAGE_USER_EMAIL = 'local@example.com'
  try {
    assert.equal(extractCreditUserInfo(null).userId, 'local-user')
    assert.equal(extractCreditUserInfo(null).email, 'local@example.com')
  } finally {
    if (previousUserId === undefined) delete process.env.DEV_USAGE_USER_ID
    else process.env.DEV_USAGE_USER_ID = previousUserId
    if (previousEmail === undefined) delete process.env.DEV_USAGE_USER_EMAIL
    else process.env.DEV_USAGE_USER_EMAIL = previousEmail
  }
})

test('admin recharge amount keeps one decimal or two decimal precision without negatives', () => {
  assert.equal(normalizeCreditAmount('12.345'), 12.35)
  assert.throws(() => normalizeCreditAmount('-1'), /must be greater than 0/)
  assert.throws(() => normalizeCreditAmount('abc'), /must be greater than 0/)
})

test('credit billing only applies to the seedance1 provider', () => {
  assert.equal(shouldChargeCreditsForProvider('veo'), true)
  assert.equal(shouldChargeCreditsForProvider('seedance1'), true)
  assert.equal(shouldChargeCreditsForProvider('ark'), false)
  assert.equal(shouldChargeCreditsForProvider('wan1'), false)
  assert.equal(shouldChargeCreditsForProvider('veo31fast'), false)
  assert.equal(shouldChargeCreditsForProvider('seedance2'), false)
})

test('credit deduction waits for a successful video url', () => {
  assert.equal(shouldDeductCreditsForUsageUpdate({ status: 'submitted', videoUrl: 'https://cdn.example/a.mp4' }), false)
  assert.equal(shouldDeductCreditsForUsageUpdate({ status: 'succeeded', videoUrl: null }), false)
  assert.equal(shouldDeductCreditsForUsageUpdate({ status: 'succeeded', videoUrl: '' }), false)
  assert.equal(shouldDeductCreditsForUsageUpdate({ status: 'succeeded', videoUrl: 'https://cdn.example/a.mp4' }), true)
})

test('credit balance account is shared across all employees', async () => {
  const credits = await import('../db/credits.js')

  assert.equal(typeof credits.getCreditBalanceAccountId, 'function')
  assert.equal(credits.getCreditBalanceAccountId({ userId: 'employee-a' }), credits.SITE_CREDIT_ACCOUNT_ID)
  assert.equal(credits.getCreditBalanceAccountId({ userId: 'employee-b' }), credits.SITE_CREDIT_ACCOUNT_ID)
})

test('credit center recharge form targets site balance instead of an employee account', async () => {
  const html = await readFile(new URL('../admin/credits.html', import.meta.url), 'utf8')

  assert.match(html, /站点余额/)
  assert.doesNotMatch(html, /用户 ID/)
  assert.doesNotMatch(html, /id="r-user-id"/)
  assert.doesNotMatch(html, /id="r-email"/)
  assert.doesNotMatch(html, /id="r-nickname"/)
})
