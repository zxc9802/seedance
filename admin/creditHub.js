import crypto from 'node:crypto'
import express from 'express'
import { getPool } from '../db/postgres.js'
import { normalizeCreditAmount } from '../db/credits.js'

const router = express.Router()
const DEFAULT_SYNC_INTERVAL_MS = 60_000
const DEFAULT_FETCH_TIMEOUT_MS = 15_000
let syncTimer = null
let syncRunning = false

function createHttpError(statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function getHubSecret() {
  const secret = process.env.CREDIT_HUB_SECRET?.trim() || process.env.ADMIN_PASSWORD?.trim()
  if (!secret) throw createHttpError(503, 'CREDIT_HUB_SECRET or ADMIN_PASSWORD is required')
  return secret
}

function getEncryptionKey() {
  return crypto.createHash('sha256').update(getHubSecret()).digest()
}

export function encryptHubToken(token) {
  const normalized = String(token || '').trim()
  if (!normalized) throw createHttpError(400, 'token is required')
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return [
    'v1',
    iv.toString('base64url'),
    authTag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':')
}

export function decryptHubToken(encrypted) {
  const [version, ivValue, tagValue, ciphertextValue] = String(encrypted || '').split(':')
  if (version !== 'v1' || !ivValue || !tagValue || !ciphertextValue) {
    throw createHttpError(500, 'Invalid encrypted token')
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), Buffer.from(ivValue, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}

function tokenHint(token) {
  const normalized = String(token || '').trim()
  if (!normalized) return ''
  return `****${normalized.slice(-4)}`
}

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) throw createHttpError(400, 'baseUrl is required')
  let url
  try {
    url = new URL(raw)
  } catch {
    throw createHttpError(400, 'baseUrl is invalid')
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw createHttpError(400, 'baseUrl must start with http or https')
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function normalizeInstanceName(value) {
  const name = String(value || '').trim()
  if (!name) throw createHttpError(400, 'name is required')
  return name
}

function normalizeLimit(value, fallback = 100, max = 500) {
  return Math.min(max, Math.max(1, Number(value) || fallback))
}

function getAdminActor(req) {
  const user = req.videoSiteSession?.user || {}
  return user.id || user.userId || user.account || user.email || user.nickname || user.name || 'admin'
}

function parseEnabled(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback
  return value === true || value === 'true' || value === 1 || value === '1'
}

function mapInstanceRow(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    tokenHint: row.token_hint || '',
    enabled: row.enabled !== false,
    note: row.note || '',
    lastSyncStatus: row.last_sync_status || row.snapshot_status || null,
    lastSyncError: row.last_sync_error || row.snapshot_error_message || null,
    lastSyncedAt: row.last_synced_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    snapshot: row.snapshot_id ? {
      id: row.snapshot_id,
      balance: Number(row.snapshot_balance || 0),
      totalConsumed: Number(row.snapshot_total_consumed || 0),
      todayConsumed: Number(row.snapshot_today_consumed || 0),
      totalGenerations: Number(row.snapshot_total_generations || 0),
      lastTransactionAt: row.snapshot_last_transaction_at || null,
      serverTime: row.snapshot_server_time || null,
      status: row.snapshot_status || null,
      errorMessage: row.snapshot_error_message || null,
      createdAt: row.snapshot_created_at || null,
    } : null,
  }
}

async function readInstanceSafe(db, id) {
  const result = await db.query(
    `SELECT
       instances.id, instances.name, instances.base_url, instances.token_hint, instances.enabled,
       instances.note, instances.last_sync_status, instances.last_sync_error, instances.last_synced_at,
       instances.created_at, instances.updated_at,
       snapshots.id AS snapshot_id,
       snapshots.balance AS snapshot_balance,
       snapshots.total_consumed AS snapshot_total_consumed,
       snapshots.today_consumed AS snapshot_today_consumed,
       snapshots.total_generations AS snapshot_total_generations,
       snapshots.last_transaction_at AS snapshot_last_transaction_at,
       snapshots.server_time AS snapshot_server_time,
       snapshots.status AS snapshot_status,
       snapshots.error_message AS snapshot_error_message,
       snapshots.created_at AS snapshot_created_at
     FROM credit_hub_instances instances
     LEFT JOIN LATERAL (
       SELECT *
       FROM credit_hub_snapshots
       WHERE instance_id = instances.id
       ORDER BY created_at DESC
       LIMIT 1
     ) snapshots ON TRUE
     WHERE instances.id = $1::uuid`,
    [id],
  )
  return mapInstanceRow(result.rows[0])
}

async function readInstanceForRemote(db, id) {
  const result = await db.query(
    `SELECT id, name, base_url, token_ciphertext, token_hint, enabled
     FROM credit_hub_instances
     WHERE id = $1::uuid`,
    [id],
  )
  return result.rows[0] || null
}

async function fetchAgentJson(instance, path, options = {}) {
  const token = decryptHubToken(instance.token_ciphertext)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Number(process.env.CREDIT_HUB_FETCH_TIMEOUT_MS) || DEFAULT_FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(`${instance.base_url}/api/credit-agent${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    })
    const payload = await response.json().catch(async () => ({ error: await response.text().catch(() => '') }))
    if (!response.ok) {
      throw createHttpError(response.status, payload?.error || `Agent request failed with HTTP ${response.status}`)
    }
    return payload
  } finally {
    clearTimeout(timeout)
  }
}

async function insertSnapshot(db, instanceId, status, payload = {}, errorMessage = null) {
  const result = await db.query(
    `INSERT INTO credit_hub_snapshots (
       instance_id, balance, total_consumed, today_consumed, total_generations,
       last_transaction_at, server_time, status, error_message
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [
      instanceId,
      Number(payload.balance || 0),
      Number(payload.totalConsumed || 0),
      Number(payload.todayConsumed || 0),
      Number(payload.totalGenerations || 0),
      payload.lastTransactionAt || null,
      payload.serverTime || null,
      status,
      errorMessage,
    ],
  )
  await db.query(
    `UPDATE credit_hub_instances
     SET last_sync_status = $2, last_sync_error = $3, last_synced_at = NOW(), updated_at = NOW()
     WHERE id = $1::uuid`,
    [instanceId, status, errorMessage],
  )
  return result.rows[0]?.id || null
}

export async function syncCreditHubInstance(instanceId) {
  const db = getPool()
  if (!db) throw createHttpError(503, 'Database not available')
  const instance = await readInstanceForRemote(db, instanceId)
  if (!instance) throw createHttpError(404, 'Instance not found')
  if (instance.enabled === false) throw createHttpError(400, 'Instance is disabled')

  try {
    const summary = await fetchAgentJson(instance, '/summary')
    await insertSnapshot(db, instance.id, 'online', summary, null)
    return {
      instance: await readInstanceSafe(db, instance.id),
      summary,
    }
  } catch (error) {
    const message = error.message || 'Sync failed'
    await insertSnapshot(db, instance.id, 'offline', {}, message).catch(() => {})
    return {
      instance: await readInstanceSafe(db, instance.id),
      error: message,
    }
  }
}

export async function syncAllCreditHubInstances() {
  if (syncRunning) return
  const db = getPool()
  if (!db) return
  syncRunning = true
  try {
    const result = await db.query(`SELECT id FROM credit_hub_instances WHERE enabled = TRUE ORDER BY name`)
    for (const row of result.rows) {
      await syncCreditHubInstance(row.id).catch((error) => {
        console.error('[credit-hub] sync failed:', error.message)
      })
    }
  } finally {
    syncRunning = false
  }
}

export function startCreditHubSyncLoop() {
  if (syncTimer) return
  const intervalMs = Math.max(10_000, Number(process.env.CREDIT_HUB_SYNC_INTERVAL_MS) || DEFAULT_SYNC_INTERVAL_MS)
  syncAllCreditHubInstances().catch((error) => {
    console.error('[credit-hub] startup sync failed:', error.message)
  })
  syncTimer = setInterval(() => {
    syncAllCreditHubInstances().catch((error) => {
      console.error('[credit-hub] interval sync failed:', error.message)
    })
  }, intervalMs)
  syncTimer.unref()
}

router.get('/instances', async (_req, res) => {
  const db = getPool()
  if (!db) return res.status(503).json({ error: 'Database not available' })

  try {
    const result = await db.query(
      `SELECT
         instances.id, instances.name, instances.base_url, instances.token_hint, instances.enabled,
         instances.note, instances.last_sync_status, instances.last_sync_error, instances.last_synced_at,
         instances.created_at, instances.updated_at,
         snapshots.id AS snapshot_id,
         snapshots.balance AS snapshot_balance,
         snapshots.total_consumed AS snapshot_total_consumed,
         snapshots.today_consumed AS snapshot_today_consumed,
         snapshots.total_generations AS snapshot_total_generations,
         snapshots.last_transaction_at AS snapshot_last_transaction_at,
         snapshots.server_time AS snapshot_server_time,
         snapshots.status AS snapshot_status,
         snapshots.error_message AS snapshot_error_message,
         snapshots.created_at AS snapshot_created_at
       FROM credit_hub_instances instances
       LEFT JOIN LATERAL (
         SELECT *
         FROM credit_hub_snapshots
         WHERE instance_id = instances.id
         ORDER BY created_at DESC
         LIMIT 1
       ) snapshots ON TRUE
       ORDER BY instances.enabled DESC, instances.name`,
    )
    res.json({ items: result.rows.map(mapInstanceRow) })
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to load instances' })
  }
})

router.post('/instances', async (req, res) => {
  const db = getPool()
  if (!db) return res.status(503).json({ error: 'Database not available' })

  try {
    const name = normalizeInstanceName(req.body?.name)
    const baseUrl = normalizeBaseUrl(req.body?.baseUrl)
    const token = String(req.body?.token || '').trim()
    const result = await db.query(
      `INSERT INTO credit_hub_instances (name, base_url, token_ciphertext, token_hint, enabled, note, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       RETURNING id`,
      [
        name,
        baseUrl,
        encryptHubToken(token),
        tokenHint(token),
        parseEnabled(req.body?.enabled, true),
        req.body?.note ? String(req.body.note).trim() : null,
      ],
    )
    res.status(201).json({ success: true, instance: await readInstanceSafe(db, result.rows[0].id) })
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message || 'Failed to create instance' })
  }
})

router.put('/instances/:id', async (req, res) => {
  const db = getPool()
  if (!db) return res.status(503).json({ error: 'Database not available' })

  try {
    const name = normalizeInstanceName(req.body?.name)
    const baseUrl = normalizeBaseUrl(req.body?.baseUrl)
    const token = String(req.body?.token || '').trim()
    const values = [
      req.params.id,
      name,
      baseUrl,
      parseEnabled(req.body?.enabled, true),
      req.body?.note ? String(req.body.note).trim() : null,
    ]
    let tokenSet = ''
    if (token) {
      values.push(encryptHubToken(token), tokenHint(token))
      tokenSet = `, token_ciphertext = $${values.length - 1}, token_hint = $${values.length}`
    }
    const result = await db.query(
      `UPDATE credit_hub_instances
       SET name = $2, base_url = $3, enabled = $4, note = $5, updated_at = NOW()${tokenSet}
       WHERE id = $1::uuid
       RETURNING id`,
      values,
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Instance not found' })
    res.json({ success: true, instance: await readInstanceSafe(db, result.rows[0].id) })
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message || 'Failed to update instance' })
  }
})

router.post('/instances/:id/sync', async (req, res) => {
  try {
    const result = await syncCreditHubInstance(req.params.id)
    res.json({ success: !result.error, ...result })
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message || 'Sync failed' })
  }
})

router.get('/instances/:id/transactions', async (req, res) => {
  const db = getPool()
  if (!db) return res.status(503).json({ error: 'Database not available' })

  try {
    const instance = await readInstanceForRemote(db, req.params.id)
    if (!instance) return res.status(404).json({ error: 'Instance not found' })
    const limit = normalizeLimit(req.query.limit)
    const payload = await fetchAgentJson(instance, `/transactions?limit=${limit}`)
    res.json({ items: Array.isArray(payload.items) ? payload.items : [] })
  } catch (error) {
    res.status(error.statusCode || 502).json({ error: error.message || 'Failed to load remote transactions' })
  }
})

router.get('/instances/:id/actions', async (req, res) => {
  const db = getPool()
  if (!db) return res.status(503).json({ error: 'Database not available' })

  try {
    const limit = normalizeLimit(req.query.limit, 50, 200)
    const result = await db.query(
      `SELECT id, type, amount, request_id, note, status, error_message, created_by, created_at, updated_at
       FROM credit_hub_actions
       WHERE instance_id = $1::uuid
       ORDER BY created_at DESC
       LIMIT $2`,
      [req.params.id, limit],
    )
    res.json({ items: result.rows })
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to load actions' })
  }
})

router.post('/instances/:id/recharge', async (req, res) => {
  const db = getPool()
  if (!db) return res.status(503).json({ error: 'Database not available' })

  const requestId = crypto.randomUUID()
  let amount
  try {
    amount = normalizeCreditAmount(req.body?.amount)
  } catch (error) {
    return res.status(400).json({ error: error.message || 'amount is invalid' })
  }

  const note = req.body?.note ? String(req.body.note).trim() : null
  const actor = getAdminActor(req)
  let actionId = null

  try {
    const instance = await readInstanceForRemote(db, req.params.id)
    if (!instance) return res.status(404).json({ error: 'Instance not found' })
    const actionResult = await db.query(
      `INSERT INTO credit_hub_actions (instance_id, type, amount, request_id, note, status, created_by)
       VALUES ($1,'recharge',$2,$3,$4,'pending',$5)
       RETURNING id`,
      [instance.id, amount, requestId, note, actor],
    )
    actionId = actionResult.rows[0]?.id || null

    const payload = await fetchAgentJson(instance, '/recharge', {
      method: 'POST',
      body: JSON.stringify({ amount, note, requestId }),
    })

    await db.query(
      `UPDATE credit_hub_actions
       SET status = 'success', response = $2::jsonb, updated_at = NOW()
       WHERE id = $1::uuid`,
      [actionId, JSON.stringify(payload)],
    )
    const syncResult = await syncCreditHubInstance(instance.id)
    res.json({
      success: true,
      actionId,
      requestId,
      recharge: payload,
      instance: syncResult.instance,
    })
  } catch (error) {
    if (actionId) {
      await db.query(
        `UPDATE credit_hub_actions
         SET status = 'failed', error_message = $2, updated_at = NOW()
         WHERE id = $1::uuid`,
        [actionId, error.message || 'Recharge failed'],
      ).catch(() => {})
    }
    res.status(error.statusCode || 502).json({ error: error.message || 'Recharge failed', actionId, requestId })
  }
})

export default router
