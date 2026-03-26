import { getPool } from './postgres.js'

function extractUserInfo(session) {
  if (!session?.user) {
    return { userId: null, email: null, nickname: null, group: null }
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
}) {
  const db = getPool()
  if (!db) return null

  const { userId, email, nickname, group } = extractUserInfo(session)
  if (!userId) {
    console.warn('[usage-db] No usable user identity in session, skipping usage log.', {
      userKeys: session?.user ? Object.keys(session.user) : [],
    })
    return null
  }

  try {
    const result = await db.query(
      `INSERT INTO video_usage_logs (
        user_id, user_email, user_nickname, user_group,
        channel, provider_id, model, generation_mode,
        prompt, aspect_ratio, resolution, duration, sample_count, request_params,
        engine_task_id, upstream_request_id, upstream_trace_id, upstream_url,
        status, video_url, error_message
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      RETURNING id`,
      [
        userId, email, nickname, group,
        channel, providerId || null, model || null, generationMode || null,
        prompt || null, aspectRatio || null, resolution || null, duration || null,
        sampleCount || 1, requestParams ? JSON.stringify(requestParams) : null,
        engineTaskId || null, upstreamRequestId || null, upstreamTraceId || null, upstreamUrl || null,
        status, videoUrl, errorMessage,
      ]
    )
    const insertedId = result.rows[0]?.id || null
    console.log('[usage-db] insertUsageLog success:', {
      id: insertedId,
      userId,
      channel,
      model: model || null,
      engineTaskId: engineTaskId || null,
      status,
    })
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

  if (setClauses.length === 0) return

  setClauses.push(`updated_at = NOW()`)
  values.push(engineTaskId)

  try {
    await db.query(
      `UPDATE video_usage_logs SET ${setClauses.join(', ')} WHERE engine_task_id = $${paramIndex}`,
      values
    )
  } catch (err) {
    console.error('[usage-db] updateUsageLogByTaskId failed:', err.message)
  }
}
