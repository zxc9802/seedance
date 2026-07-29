import { timingSafeEqual } from 'node:crypto'

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

export function createApiKeyAuthenticator(env = process.env) {
  let entries = []
  let configError = null
  try {
    entries = parseConfiguredApiKeys(env)
  } catch (error) {
    configError = error
  }

  return function authenticate(req) {
    if (configError) {
      return {
        ok: false,
        status: 503,
        code: 'RELAY_API_KEY_CONFIG_INVALID',
        message: configError.message,
      }
    }
    if (entries.length === 0) {
      return {
        ok: false,
        status: 503,
        code: 'RELAY_API_KEY_NOT_CONFIGURED',
        message: 'Seedance relay API keys are not configured',
      }
    }

    const token = readBearerToken(req)
    const matched = entries.find((entry) => isSameToken(token, entry.apiKey))
    if (!matched) {
      return {
        ok: false,
        status: 401,
        code: 'INVALID_API_KEY',
        message: 'Invalid API key',
      }
    }

    return {
      ok: true,
      apiKey: {
        id: matched.id,
        name: matched.name,
      },
    }
  }
}
