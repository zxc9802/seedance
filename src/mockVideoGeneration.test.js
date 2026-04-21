import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildMockVideoPlan,
  resolveMockGenerationDurationMs,
} from './mockVideoGeneration.js'

test('buildMockVideoPlan always returns the same failed-fetch message', () => {
  const plan = buildMockVideoPlan({
    providerId: 'veo',
    references: {
      images: [{ id: 'image-1' }],
      videos: [{ id: 'video-1' }],
      audios: [{ id: 'audio-1' }],
    },
    randomValue: 0,
  })

  assert.equal(plan.status, 'failed')
  assert.equal(plan.errorMessage, 'Failed to fetch')
})

test('resolveMockGenerationDurationMs stays inside the configured mock range', () => {
  assert.equal(resolveMockGenerationDurationMs(0), 9000)
  assert.equal(resolveMockGenerationDurationMs(1), 14000)
  assert.equal(resolveMockGenerationDurationMs(0.5), 11500)
})
