const SNAPSHOT_DB_NAME = 'veo-studio-browser-snapshots'
const SNAPSHOT_STORE_NAME = 'snapshots'
const SNAPSHOT_KEY = 'latest'
const SNAPSHOT_META_KEY = 'veo-studio:snapshot-meta'
const SNAPSHOT_DB_VERSION = 1

export async function saveLatestSnapshot(snapshot) {
  const db = await openSnapshotDatabase()
  await runRequest(
    db
      .transaction(SNAPSHOT_STORE_NAME, 'readwrite')
      .objectStore(SNAPSHOT_STORE_NAME)
      .put(snapshot, SNAPSHOT_KEY)
  )

  const meta = { savedAt: snapshot.savedAt }
  window.localStorage.setItem(SNAPSHOT_META_KEY, JSON.stringify(meta))
  return meta
}

export async function loadLatestSnapshot() {
  const db = await openSnapshotDatabase()
  return runRequest(
    db
      .transaction(SNAPSHOT_STORE_NAME, 'readonly')
      .objectStore(SNAPSHOT_STORE_NAME)
      .get(SNAPSHOT_KEY)
  )
}

export function getLatestSnapshotMeta() {
  try {
    const raw = window.localStorage.getItem(SNAPSHOT_META_KEY)
    if (!raw) return null

    const parsed = JSON.parse(raw)
    return typeof parsed?.savedAt === 'number' ? parsed : null
  } catch {
    return null
  }
}

function openSnapshotDatabase() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('\u5f53\u524d\u6d4f\u89c8\u5668\u4e0d\u652f\u6301 IndexedDB\uff0c\u65e0\u6cd5\u4fdd\u5b58\u5feb\u7167'))
      return
    }

    const request = window.indexedDB.open(SNAPSHOT_DB_NAME, SNAPSHOT_DB_VERSION)

    request.onerror = () => reject(request.error || new Error('\u6253\u5f00\u6d4f\u89c8\u5668\u5feb\u7167\u5e93\u5931\u8d25'))
    request.onsuccess = () => resolve(request.result)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(SNAPSHOT_STORE_NAME)) {
        database.createObjectStore(SNAPSHOT_STORE_NAME)
      }
    }
  })
}

function runRequest(request) {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error || new Error('\u6d4f\u89c8\u5668\u5feb\u7167\u8bfb\u5199\u5931\u8d25'))
    request.onsuccess = () => resolve(request.result)
  })
}
