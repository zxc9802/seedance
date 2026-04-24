import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildMockVideoPlan,
  resolveMockGenerationDurationMs,
  selectMockPreviewAsset,
} from './mockVideoGeneration.js'

test('selectMockPreviewAsset prefers a local video reference when available', () => {
  const references = {
    images: [
      { id: 'image-1', file: { name: 'cover.png' }, mimeType: 'image/png' },
    ],
    videos: [
      { id: 'video-1', file: { name: 'clip.mp4' }, mimeType: 'video/mp4' },
    ],
    audios: [],
  }

  assert.deepEqual(selectMockPreviewAsset(references), {
    kind: 'video',
    asset: references.videos[0],
  })
})

test('selectMockPreviewAsset falls back to the first image reference', () => {
  const references = {
    images: [
      { id: 'image-1', file: { name: 'cover.png' }, mimeType: 'image/png' },
    ],
    videos: [],
    audios: [],
  }

  assert.deepEqual(selectMockPreviewAsset(references), {
    kind: 'image',
    asset: references.images[0],
  })
})

test('buildMockVideoPlan returns a local placeholder when no references exist', () => {
  const plan = buildMockVideoPlan({
    providerId: 'veo',
    providerLabel: 'Seedance 1',
    prompt: 'A cat running through neon rain',
    params: { aspectRatio: '9:16' },
    references: { images: [], videos: [], audios: [] },
    randomValue: 0,
  })

  assert.equal(plan.preview.kind, 'image')
  assert.equal(plan.preview.source, 'placeholder')
  assert.match(plan.preview.url, /^data:image\/svg\+xml/)
  assert.match(decodeURIComponent(plan.preview.url), /Seedance 1/)
})

test('resolveMockGenerationDurationMs stays inside the configured mock range', () => {
  assert.equal(resolveMockGenerationDurationMs(0), 9000)
  assert.equal(resolveMockGenerationDurationMs(1), 14000)
  assert.equal(resolveMockGenerationDurationMs(0.5), 11500)
})
