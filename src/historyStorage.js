export const HISTORY_LIMIT = 10

const HISTORY_DB_NAME = 'veo-studio-generation-history'
const HISTORY_STORE_NAME = 'records'
const HISTORY_DB_VERSION = 1
const HISTORY_INDEX_KEY = 'veo-studio:generation-history-index'

export function createHistoryRecordId(savedAt = Date.now()) {
  const suffix = Math.random().toString(36).slice(2, 8)
  return `history-${savedAt}-${suffix}`
}

export function createHistoryIndexEntry(record) {
  const params = record?.params || {}
  return {
    id: record.id,
    savedAt: record.savedAt,
    provider: record.provider,
    generationMode: record.generationMode,
    promptSummary: summarizePrompt(record.prompt),
    paramsSummary: {
      model: params.model || null,
      aspectRatio: params.aspectRatio || null,
      duration: params.duration ?? null,
      resolution: params.resolution || null,
    },
    mediaCounts: normalizeMediaCounts(record.mediaCounts),
  }
}

export function trimHistoryIndex(records) {
  return (Array.isArray(records) ? records : [])
    .filter((record) => record?.id && typeof record.savedAt === 'number')
    .sort((a, b) => b.savedAt - a.savedAt)
    .slice(0, HISTORY_LIMIT)
}

export function getHistoryIndex() {
  try {
    const raw = window.localStorage.getItem(HISTORY_INDEX_KEY)
    if (!raw) return []
    return trimHistoryIndex(JSON.parse(raw))
  } catch {
    return []
  }
}

export async function saveHistoryRecord(record) {
  const db = await openHistoryDatabase()
  await runRequest(
    db
      .transaction(HISTORY_STORE_NAME, 'readwrite')
      .objectStore(HISTORY_STORE_NAME)
      .put(record, record.id)
  )

  const nextIndex = trimHistoryIndex([
    createHistoryIndexEntry(record),
    ...getHistoryIndex().filter((entry) => entry.id !== record.id),
  ])
  window.localStorage.setItem(HISTORY_INDEX_KEY, JSON.stringify(nextIndex))

  await pruneHistoryRecords(db, nextIndex)
  return nextIndex
}

export async function loadHistoryRecord(id) {
  if (!id) return null

  const db = await openHistoryDatabase()
  return runRequest(
    db
      .transaction(HISTORY_STORE_NAME, 'readonly')
      .objectStore(HISTORY_STORE_NAME)
      .get(id)
  )
}

function summarizePrompt(prompt) {
  const normalized = typeof prompt === 'string'
    ? prompt.replace(/\s+/g, ' ').trim()
    : ''
  return normalized || '\u672a\u586b\u5199\u63d0\u793a\u8bcd'
}

function normalizeMediaCounts(counts) {
  return {
    images: Math.max(0, Number(counts?.images) || 0),
    videos: Math.max(0, Number(counts?.videos) || 0),
    audios: Math.max(0, Number(counts?.audios) || 0),
  }
}

async function pruneHistoryRecords(db, index) {
  const keepIds = new Set(index.map((entry) => entry.id))
  const keys = await runRequest(
    db
      .transaction(HISTORY_STORE_NAME, 'readonly')
      .objectStore(HISTORY_STORE_NAME)
      .getAllKeys()
  )

  const staleKeys = keys.filter((key) => !keepIds.has(key))
  if (!staleKeys.length) return

  const transaction = db.transaction(HISTORY_STORE_NAME, 'readwrite')
  const store = transaction.objectStore(HISTORY_STORE_NAME)
  await Promise.all(staleKeys.map((key) => runRequest(store.delete(key))))
}

function openHistoryDatabase() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('\u5f53\u524d\u6d4f\u89c8\u5668\u4e0d\u652f\u6301 IndexedDB\uff0c\u65e0\u6cd5\u4fdd\u5b58\u5386\u53f2\u8bb0\u5f55'))
      return
    }

    const request = window.indexedDB.open(HISTORY_DB_NAME, HISTORY_DB_VERSION)

    request.onerror = () => reject(request.error || new Error('\u6253\u5f00\u6d4f\u89c8\u5668\u5386\u53f2\u5e93\u5931\u8d25'))
    request.onsuccess = () => resolve(request.result)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(HISTORY_STORE_NAME)) {
        database.createObjectStore(HISTORY_STORE_NAME)
      }
    }
  })
}

function runRequest(request) {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error || new Error('\u6d4f\u89c8\u5668\u5386\u53f2\u8bfb\u5199\u5931\u8d25'))
    request.onsuccess = () => resolve(request.result)
  })
}
