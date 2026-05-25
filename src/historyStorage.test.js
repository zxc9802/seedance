import test from 'node:test'
import assert from 'node:assert/strict'

import {
  HISTORY_LIMIT,
  createHistoryIndexEntry,
  trimHistoryIndex,
} from './historyStorage.js'

test('trimHistoryIndex keeps only the newest 10 records', () => {
  const records = Array.from({ length: 12 }, (_, index) => ({
    id: `record-${index}`,
    savedAt: index,
  }))

  assert.deepEqual(
    trimHistoryIndex(records).map((record) => record.id),
    [
      'record-11',
      'record-10',
      'record-9',
      'record-8',
      'record-7',
      'record-6',
      'record-5',
      'record-4',
      'record-3',
      'record-2',
    ],
  )
  assert.equal(trimHistoryIndex(records).length, HISTORY_LIMIT)
})

test('createHistoryIndexEntry summarizes prompt, params, and media counts', () => {
  const entry = createHistoryIndexEntry({
    id: 'history-1',
    savedAt: 1710000000000,
    provider: 'seedance2',
    generationMode: 'generate',
    prompt: 'A long prompt that should be summarized for the history menu.',
    params: { model: 'seedance2', aspectRatio: '9:16', duration: 5 },
    mediaCounts: { images: 2, videos: 1, audios: 0 },
  })

  assert.deepEqual(entry, {
    id: 'history-1',
    savedAt: 1710000000000,
    provider: 'seedance2',
    generationMode: 'generate',
    promptSummary: 'A long prompt that should be summarized for the history menu.',
    paramsSummary: {
      model: 'seedance2',
      aspectRatio: '9:16',
      duration: 5,
      resolution: null,
    },
    mediaCounts: { images: 2, videos: 1, audios: 0 },
  })
})
