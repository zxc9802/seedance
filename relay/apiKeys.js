import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

function readBearerToken(req) {
  const value = req.get('authorization') || ''
  const match = value.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : ''
}

function isSameToken(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8')
  const rightBuffer = Buffer.from(String(right || ''), 'utf8')
  if (leftBuffer.length !== rightBuffer.length) return false
  return timingSafeEqual(leftBuffer, rightBuffer)
}

export function hashRelayApiKey(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex')
}

export function maskRelayApiKey(value) {
  const key = String(value || '').trim()
  if (!key) return ''
  if (key.length <= 8) return `${key.slice(0, 2)}••••${key.slice(-2)}`
  return `${key.slice(0, 5)}••••••••${key.slice(-4)}`
}

export async function createStoredRelayApiKey(db, { name } = {}) {
  const normalizedName = String(name || '').trim()
  if (!normalizedName || normalizedName.length > 80) {
    const error = new Error('客户端名称长度应为 1 到 80 个字符')
    error.code = 'INVALID_RELAY_CLIENT_NAME'
    throw error
  }

  const appId = `relay-${randomBytes(6).toString('hex')}`
  const apiKey = `sk-seedance-${randomBytes(32).toString('base64url')}`
  const keyPreview = maskRelayApiKey(apiKey)
  const result = await db.query(
    `INSERT INTO relay_api_keys (app_id, name, key_hash, key_preview)
     VALUES ($1, $2, $3, $4)
     RETURNING app_id, name, key_preview, enabled, created_at`,
    [appId, normalizedName, hashRelayApiKey(apiKey), keyPreview],
  )
  const row = result.rows[0]

  return {
    apiKey,
    client: {
      appId: row.app_id,
      name: row.name,
      keyPreview: row.key_preview,
      enabled: row.enabled,
      createdAt: row.created_at,
    },
  }
}

export async function findStoredRelayApiKey(db, apiKey) {
  const normalizedKey = String(apiKey || '').trim()
  if (!db || !normalizedKey) return null

  const result = await db.query(
    `SELECT app_id, name
     FROM relay_api_keys
     WHERE key_hash = $1 AND enabled = TRUE
     LIMIT 1`,
    [hashRelayApiKey(normalizedKey)],
  )
  const row = result.rows[0]
  if (!row) return null

  return {
    id: row.app_id,
    name: row.name,
  }
}

export async function listStoredRelayApiKeys(db) {
  if (!db) return []

  const result = await db.query(
    `SELECT app_id, name, key_preview, enabled, created_at
     FROM relay_api_keys
     WHERE enabled = TRUE
     ORDER BY created_at DESC`,
  )
  return result.rows.map((row) => ({
    appId: row.app_id,
    name: row.name,
    keyPreview: row.key_preview,
    enabled: row.enabled,
    createdAt: row.created_at,
  }))
}

function normalizeApiKeyEntry(entry) {
  const appId = String(entry?.appId || '').trim()
  const apiKey = String(entry?.apiKey || '').trim()
  if (!appId || !apiKey) {
    throw new Error('Each relay API key requires appId and apiKey')
  }

  return {
    id: appId,
    name: String(entry?.name || appId).trim() || appId,
    apiKey,
  }
}

export function parseConfiguredApiKeys(env = process.env) {
  const entries = []
  const json = env.SEEDANCE_RELAY_API_KEYS_JSON?.trim()
  if (json) {
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed)) {
      throw new Error('SEEDANCE_RELAY_API_KEYS_JSON must be a JSON array')
    }
    entries.push(...parsed.map(normalizeApiKeyEntry))
  }

  const singleKey = env.SEEDANCE_RELAY_API_KEY?.trim()
  if (singleKey) {
    entries.push(normalizeApiKeyEntry({
      appId: env.SEEDANCE_RELAY_APP_ID?.trim() || 'default',
      name: env.SEEDANCE_RELAY_APP_NAME?.trim() || 'Default relay client',
      apiKey: singleKey,
    }))
  }

  const seenAppIds = new Set()
  for (const entry of entries) {
    if (seenAppIds.has(entry.id)) {
      throw new Error(`Duplicate relay appId: ${entry.id}`)
    }
    seenAppIds.add(entry.id)
  }
  return entries
}

export function createApiKeyAuthenticator(env = process.env, { findApiKey = null } = {}) {
  let entries = []
  let configError = null
  try {
    entries = parseConfiguredApiKeys(env)
  } catch (error) {
    configError = error
  }

  return async function authenticate(req) {
    if (configError) {
      return {
        ok: false,
        status: 503,
        code: 'RELAY_API_KEY_CONFIG_INVALID',
        message: configError.message,
      }
    }
    const token = readBearerToken(req)
    const matched = entries.find((entry) => isSameToken(token, entry.apiKey))
    if (matched) {
      return {
        ok: true,
        apiKey: {
          id: matched.id,
          name: matched.name,
        },
      }
    }

    if (findApiKey && token) {
      try {
        const stored = await findApiKey(token)
        if (stored) {
          return {
            ok: true,
            apiKey: stored,
          }
        }
      } catch (error) {
        return {
          ok: false,
          status: 503,
          code: 'RELAY_API_KEY_STORE_UNAVAILABLE',
          message: error.message || 'Relay API key store unavailable',
        }
      }
    }

    if (entries.length === 0 && !findApiKey) {
      return {
        ok: false,
        status: 503,
        code: 'RELAY_API_KEY_NOT_CONFIGURED',
        message: 'Seedance relay API keys are not configured',
      }
    }

    return {
      ok: false,
      status: 401,
      code: 'INVALID_API_KEY',
      message: 'Invalid API key',
    }
  }
}
