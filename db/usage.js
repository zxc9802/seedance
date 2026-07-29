import { getPool } from './postgres.js'
import { scheduleUsageLogBackupSyncById, syncUsageLogBackupByIds } from '../integrations/larkBaseUsageBackup.js'
import { calculateConfirmedMediaBilling } from './monitorPricing.js'

function extractDevUserInfo() {
  const userId = process.env.DEV_USAGE_USER_ID?.trim()
  if (!userId) return { userId: null, email: null, nickname: null, group: null, billingAudience: 'internal' }

  return {
    userId,
    email: process.env.DEV_USAGE_USER_EMAIL?.trim() || `${userId}@local.dev`,
    nickname: process.env.DEV_USAGE_USER_NICKNAME?.trim() || userId,
    group: process.env.DEV_USAGE_USER_GROUP?.trim() || 'local-dev',
    billingAudience: 'internal',
  }
}

function extractUserInfo(session) {
  if (!session?.user) {
    return extractDevUserInfo()
  }

  const user = session.user
  const userId = (
    user.id
    || user.userId
    || user.uid
    || user.uuid
    || user.memberId
    || user.account
    || user.email
    || null
  )

  return {
    userId,
    email: user.account || user.email || user.username || user.userName || user.login || null,
    nickname: user.nickname || user.name || user.displayName || user.realName || null,
    group: user.groupName || user.group || (Array.isArray(user.groupNames) ? user.groupNames.join(',') : null),
    billingAudience: user.billingAudience === 'internal' ? 'internal' : 'external',
  }
}

export async function insertUsageLog({
  session,
  channel,
  providerId,
  model,
  generationMode,
  prompt,
  aspectRatio,
  resolution,
  duration,
  sampleCount,
  requestParams,
  engineTaskId,
  upstreamRequestId,
  upstreamTraceId,
  upstreamUrl,
  status = 'submitted',
  videoUrl = null,
  errorMessage = null,
  unitPrice = null,
  estimatedCost = null,
}) {
  const db = getPool()
  if (!db) return null

  const { userId, email, nickname, group, billingAudience } = extractUserInfo(session)
  if (!userId) {
    console.warn('[usage-db] No usable user identity in session, skipping usage log.', {
      userKeys: session?.user ? Object.keys(session.user) : [],
    })
    return null
  }

  try {
    const monitorBilling = calculateConfirmedMediaBilling({
      providerId,
      model,
      duration,
      sampleCount,
      billingAudience,
    })
    const result = await db.query(
      `INSERT INTO video_usage_logs (
        user_id, user_email, user_nickname, user_group,
        channel, app_id, provider_id, model, generation_mode,
        prompt, aspect_ratio, resolution, duration, sample_count, request_params,
        engine_task_id, upstream_request_id, upstream_trace_id, upstream_url,
        request_id, usage_source, status, video_url, error_message, unit_price, estimated_cost,
        billing_audience, upstream_cost_cny, sale_multiplier, sale_price_cny, cost_credits,
        charged_credits, billing_unit, billable_units, price_version
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'web',$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34)
      RETURNING id`,
      [
        userId, email, nickname, group,
        channel, 'seedance', providerId || null, model || null, generationMode || null,
        prompt || null, aspectRatio || null, resolution || null, duration || null,
        sampleCount || 1, requestParams ? JSON.stringify(requestParams) : null,
        engineTaskId || null, upstreamRequestId || null, upstreamTraceId || null, upstreamUrl || null,
        engineTaskId || upstreamRequestId || null,
        status, videoUrl, errorMessage, unitPrice, estimatedCost,
        billingAudience,
        monitorBilling?.upstreamCostCny ?? null,
        monitorBilling?.saleMultiplier ?? null,
        monitorBilling?.salePriceCny ?? null,
        monitorBilling?.costCredits ?? null,
        monitorBilling?.chargedCredits ?? null,
        monitorBilling?.billingUnit ?? null,
        monitorBilling?.billableUnits ?? null,
        monitorBilling?.priceVersion ?? null,
      ]
    )
    const insertedId = result.rows[0]?.id || null
    if (insertedId) {
      scheduleUsageLogBackupSyncById(insertedId).catch(() => {})
    }
    return insertedId
  } catch (err) {
    console.error('[usage-db] insertUsageLog failed:', err.message)
    return null
  }
}

export async function updateUsageLogByTaskId(engineTaskId, updates) {
  const db = getPool()
  if (!db || !engineTaskId) return

  const setClauses = []
  const values = []
  let paramIndex = 1

  if (updates.status !== undefined) {
    setClauses.push(`status = $${paramIndex++}`)
    values.push(updates.status)
  }
  if (updates.videoUrl !== undefined) {
    setClauses.push(`video_url = $${paramIndex++}`)
    values.push(updates.videoUrl)
  }
  if (updates.errorMessage !== undefined) {
    setClauses.push(`error_message = $${paramIndex++}`)
    values.push(updates.errorMessage)
  }
  if (updates.completedAt !== undefined) {
    setClauses.push(`completed_at = $${paramIndex++}`)
    values.push(updates.completedAt)
  }
  if (updates.upstreamRequestId !== undefined) {
    setClauses.push(`upstream_request_id = $${paramIndex++}`)
    values.push(updates.upstreamRequestId)
  }
  if (updates.upstreamTraceId !== undefined) {
    setClauses.push(`upstream_trace_id = $${paramIndex++}`)
    values.push(updates.upstreamTraceId)
  }
  if (updates.estimatedCost !== undefined) {
    setClauses.push(`estimated_cost = $${paramIndex++}`)
    values.push(updates.estimatedCost)
  }
  if (updates.unitPrice !== undefined) {
    setClauses.push(`unit_price = $${paramIndex++}`)
    values.push(updates.unitPrice)
  }

  if (setClauses.length === 0) return

  setClauses.push(`updated_at = NOW()`)
  values.push(engineTaskId)

  try {
    const result = await db.query(
      `UPDATE video_usage_logs SET ${setClauses.join(', ')} WHERE engine_task_id = $${paramIndex} RETURNING id`,
      values
    )
    if (result.rows.length > 0) {
      const updatedIds = result.rows.map((row) => row.id)
      syncUsageLogBackupByIds(updatedIds).catch(() => {})
    }
  } catch (err) {
    console.error('[usage-db] updateUsageLogByTaskId failed:', err.message)
  }
}

export async function updateUsageLogById(logId, updates) {
  const db = getPool()
  if (!db || !logId) return

  const setClauses = []
  const values = []
  let paramIndex = 1

  for (const [key, value] of Object.entries(updates)) {
    const columnMap = {
      status: 'status',
      videoUrl: 'video_url',
      errorMessage: 'error_message',
      completedAt: 'completed_at',
      engineTaskId: 'engine_task_id',
      upstreamRequestId: 'upstream_request_id',
      upstreamTraceId: 'upstream_trace_id',
      estimatedCost: 'estimated_cost',
      unitPrice: 'unit_price',
    }
    const col = columnMap[key]
    if (col) {
      setClauses.push(`${col} = $${paramIndex++}`)
      values.push(value)
    }
  }

  if (setClauses.length === 0) return

  setClauses.push(`updated_at = NOW()`)
  values.push(logId)

  try {
    const result = await db.query(
      `UPDATE video_usage_logs SET ${setClauses.join(', ')} WHERE id = $${paramIndex}::uuid RETURNING id`,
      values
    )
    if (result.rows[0]?.id) {
      scheduleUsageLogBackupSyncById(result.rows[0].id).catch(() => {})
    }
  } catch (err) {
    console.error('[usage-db] updateUsageLogById failed:', err.message)
  }
}
