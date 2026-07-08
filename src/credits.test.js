import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  calculateImageCreditCharge,
  calculateVideoCreditCharge,
  extractCreditUserInfo,
  normalizeCreditProviderId,
  shouldChargeCreditsForProvider,
  shouldDeductCreditsForUsageUpdate,
  normalizeCreditAmount,
} from '../db/credits.js'

test('seedance2 text-to-video credit charge uses the enterprise stable rates', () => {
  const charge = calculateVideoCreditCharge({
    providerId: 'seedance1',
    model: 'doubao-seedance-2-0-260128',
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
    rate: 10,
    billableSeconds: 16,
    amount: 160,
  })
})

test('seedance2 fast model on seedance1 channel uses its own 480p and 720p rates', () => {
  const standardCharge = calculateVideoCreditCharge({
    providerId: 'seedance1',
    model: 'doubao-seedance-2-0-260128',
    resolution: '720p',
    duration: 5,
    sampleCount: 1,
    requestParams: {
      mediaSummary: {
        images: { count: 0 },
        videos: { count: 0 },
      },
    },
  })
  const fast480TextCharge = calculateVideoCreditCharge({
    providerId: 'seedance1',
    model: 'doubao-seedance-2-0-fast-260128',
    resolution: '480p',
    duration: 5,
    sampleCount: 1,
    requestParams: {
      mediaSummary: {
        images: { count: 0 },
        videos: { count: 0 },
      },
    },
  })
  const fast720TextCharge = calculateVideoCreditCharge({
    providerId: 'seedance1',
    model: 'doubao-seedance-2-0-fast-260128',
    resolution: '720p',
    duration: 5,
    sampleCount: 1,
    requestParams: {
      mediaSummary: {
        images: { count: 0 },
        videos: { count: 0 },
      },
    },
  })
  const fast480ImageReferenceCharge = calculateVideoCreditCharge({
    providerId: 'seedance1',
    model: 'doubao-seedance-2-0-fast-260128',
    resolution: '480p',
    duration: 5,
    sampleCount: 1,
    requestParams: {
      mediaSummary: {
        images: { count: 1 },
        videos: { count: 0 },
      },
    },
  })
  const fast720InputVideoCharge = calculateVideoCreditCharge({
    providerId: 'seedance1',
    model: 'doubao-seedance-2-0-fast-260128',
    resolution: '720p',
    duration: 5,
    sampleCount: 1,
    requestParams: {
      mediaSummary: {
        images: { count: 0 },
        videos: { count: 1, durationSeconds: 3 },
      },
    },
  })

  assert.deepEqual(standardCharge, {
    category: 'text',
    resolution: '720p',
    rate: 4,
    billableSeconds: 5,
    amount: 20,
  })
  assert.deepEqual(fast480TextCharge, {
    category: 'text',
    resolution: '480p',
    rate: 1,
    billableSeconds: 5,
    amount: 5,
  })
  assert.deepEqual(fast720TextCharge, {
    category: 'text',
    resolution: '720p',
    rate: 3,
    billableSeconds: 5,
    amount: 15,
  })
  assert.deepEqual(fast480ImageReferenceCharge, {
    category: 'reference',
    resolution: '480p',
    rate: 2.5,
    billableSeconds: 5,
    amount: 12.5,
  })
  assert.deepEqual(fast720InputVideoCharge, {
    category: 'reference',
    resolution: '720p',
    rate: 5.5,
    billableSeconds: 8,
    amount: 44,
  })
})

test('seedance2 reference modes use enterprise stable rates and include reference video length', () => {
  const charge = calculateVideoCreditCharge({
    providerId: 'seedance1',
    model: 'doubao-seedance-2-0-260128',
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
    rate: 7,
    billableSeconds: 10,
    amount: 70,
  })
})

test('seedance2 reference modes support the configured 1080p rate', () => {
  const referenceCharge = calculateVideoCreditCharge({
    providerId: 'seedance1',
    model: 'doubao-seedance-2-0-260128',
    resolution: '1080p',
    duration: 5,
    sampleCount: 1,
    requestParams: {
      mediaSummary: {
        images: { count: 1 },
        videos: { count: 0 },
      },
    },
  })

  assert.equal(referenceCharge.rate, 17.5)
  assert.equal(referenceCharge.billableSeconds, 5)
  assert.equal(referenceCharge.amount, 87.5)
})

test('nanobanana2 image credit charge bills 1K images at the high rate', () => {
  assert.deepEqual(calculateImageCreditCharge({
    providerId: 'gemini-image-aggregation',
    resolution: '1K',
    sampleCount: 3,
  }), {
    category: 'image',
    resolution: '1k',
    rate: 3.5,
    imageCount: 3,
    amount: 10.5,
  })
})

test('nanobanana2 image credit charge bills 512 images at the low rate', () => {
  assert.deepEqual(calculateImageCreditCharge({
    providerId: 'gemini-image-aggregation',
    resolution: '512',
    sampleCount: 4,
  }), {
    category: 'image',
    resolution: '512',
    rate: 2,
    imageCount: 4,
    amount: 8,
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

test('credit billing only applies to configured providers', () => {
  assert.equal(normalizeCreditProviderId('veo'), 'seedance1')
  assert.equal(shouldChargeCreditsForProvider('veo'), false)
  assert.equal(shouldChargeCreditsForProvider('seedance1'), true)
  assert.equal(shouldChargeCreditsForProvider('gemini-image-aggregation'), true)
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

test('credit center generation detail shows actual deducted credits only', async () => {
  const html = await readFile(new URL('../admin/credits.html', import.meta.url), 'utf8')
  const apiSource = await readFile(new URL('../admin/api.js', import.meta.url), 'utf8')
  const usageRouteStart = apiSource.indexOf("router.get('/credits/usage'")
  const usageRouteEnd = apiSource.indexOf("router.get('/pricing'", usageRouteStart)
  const usageRouteSource = apiSource.slice(usageRouteStart, usageRouteEnd)

  assert.match(html, /fmtCredit\(row\.credit_spent\)/)
  assert.doesNotMatch(html, /fmtCredit\(row\.estimated_cost\)/)
  assert.match(usageRouteSource, /LEFT JOIN \(\$\{CREDIT_USAGE_SUMMARY_SQL\}\) credit_usage/)
  assert.match(usageRouteSource, /COALESCE\(credit_usage\.credit_spent, 0\)::float AS credit_spent/)
})

test('credit cost converts five credits into one yuan', async () => {
  const credits = await import('../db/credits.js')

  assert.equal(credits.convertCreditsToCny(5), 1)
  assert.equal(credits.convertCreditsToCny(25.5), 5.1)
  assert.equal(credits.convertCreditsToCny(null), 0)
})
