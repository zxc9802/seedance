import { getPool } from '../db/postgres.js'

const RELAY_USAGE_SOURCE = 'seedance_relay'
const RELAY_CHANNEL = 'aggregation'

function requireDatabase(getPoolFn) {
  const db = getPoolFn()
  if (!db) {
    const error = new Error('DATABASE_URL is required for relay usage monitoring')
    error.code = 'DATABASE_NOT_AVAILABLE'
    throw error
  }
  return db
}

function requestHashFromRow(row) {
  const params = row?.request_params
  if (!params) return ''
  if (typeof params === 'string') {
    try {
      return JSON.parse(params)?.relayRequestHash || ''
    } catch {
      return ''
    }
  }
  return params.relayRequestHash || ''
}

function normalizeLimit(value) {
  return Math.min(100, Math.max(1, Math.trunc(Number(value) || 25)))
}

function appendDateFilter(value, operator, conditions, values) {
  if (!value) return
  const timestamp = new Date(String(value))
  if (Number.isNaN(timestamp.getTime())) {
    const error = new Error(`${operator === '>=' ? 'from' : 'to'} must be a valid date`)
    error.code = 'INVALID_USAGE_FILTER'
    throw error
  }
  values.push(timestamp.toISOString())
  conditions.push(`created_at ${operator} $${values.length}::timestamptz`)
}

export function createPostgresRelayRepository({
  getPoolFn = getPool,
} = {}) {
  return {
    async createOrGetTask({
      apiKeyId,
      apiKeyName,
      idempotencyKey,
      requestHash,
      request,
      billing,
    }) {
      const db = requireDatabase(getPoolFn)
      const requestParams = {
        relayRequestHash: requestHash,
        relayRequest: request,
      }
      const result = await db.query(
        `INSERT INTO video_usage_logs (
          user_id, user_nickname, user_group,
          channel, app_id, provider_id, model, generation_mode,
          prompt, aspect_ratio, resolution, duration, sample_count,
          request_params, request_id, status, usage_source, billing_audience,
          upstream_cost_cny, sale_multiplier, sale_price_cny,
          cost_credits, charged_credits, billing_unit, billable_units, price_version
        ) VALUES (
          $1,$2,'relay',
          $3,$4,'seedance-relay',$5,$6,
          $7,$8,$9,$10,1,
          $11,$12,'submitting',$13,'external',
          $14,$15,$16,
          $17,$18,$19,$20,$21
        )
        ON CONFLICT (channel, app_id, request_id) DO NOTHING
        RETURNING *`,
        [
          `relay:${apiKeyId}`,
          apiKeyName || apiKeyId,
          RELAY_CHANNEL,
          apiKeyId,
          request.model,
          request.mode,
          request.prompt,
          request.aspectRatio,
          request.resolution,
          request.duration,
          JSON.stringify(requestParams),
          idempotencyKey,
          RELAY_USAGE_SOURCE,
          billing.upstreamCostCny,
          billing.saleMultiplier,
          billing.salePriceCny,
          billing.costCredits,
          billing.chargedCredits,
          billing.billingUnit,
          billing.billableUnits,
          billing.priceVersion,
        ],
      )

      if (result.rows[0]) {
        return { created: true, task: result.rows[0] }
      }

      const existingResult = await db.query(
        `SELECT *
         FROM video_usage_logs
         WHERE channel = $1
           AND app_id = $2
           AND request_id = $3
           AND usage_source = $4
         LIMIT 1`,
        [RELAY_CHANNEL, apiKeyId, idempotencyKey, RELAY_USAGE_SOURCE],
      )
      const existing = existingResult.rows[0]
      if (!existing) {
        throw new Error('Idempotency record could not be loaded')
      }
      if (requestHashFromRow(existing) !== requestHash) {
        const error = new Error('Idempotency-Key was already used with a different request')
        error.code = 'IDEMPOTENCY_CONFLICT'
        throw error
      }
      return { created: false, task: existing }
    },

    async applyProviderState(taskId, apiKeyId, updates) {
      const db = requireDatabase(getPoolFn)
      const result = await db.query(
        `UPDATE video_usage_logs
         SET status = $3,
             engine_task_id = COALESCE($4, engine_task_id),
             video_url = $5,
             error_message = $6,
             upstream_request_id = COALESCE($7, upstream_request_id),
             upstream_trace_id = COALESCE($8, upstream_trace_id),
             upstream_url = COALESCE($9, upstream_url),
             completed_at = $10,
             updated_at = NOW()
         WHERE id = $1::uuid
           AND app_id = $2
           AND usage_source = $11
         RETURNING *`,
        [
          taskId,
          apiKeyId,
          updates.status,
          updates.engine_task_id || null,
          updates.video_url ?? null,
          updates.error_message ?? null,
          updates.upstream_request_id || null,
          updates.upstream_trace_id || null,
          updates.upstream_url || null,
          updates.completed_at || null,
          RELAY_USAGE_SOURCE,
        ],
      )
      return result.rows[0] || null
    },

    async findTask(taskId, apiKeyId) {
      const db = requireDatabase(getPoolFn)
      const result = await db.query(
        `SELECT *
         FROM video_usage_logs
         WHERE id = $1::uuid
           AND app_id = $2
           AND usage_source = $3
         LIMIT 1`,
        [taskId, apiKeyId, RELAY_USAGE_SOURCE],
      )
      return result.rows[0] || null
    },

    async listUsage(apiKeyId, filters = {}) {
      const db = requireDatabase(getPoolFn)
      const conditions = ['app_id = $1', 'usage_source = $2']
      const values = [apiKeyId, RELAY_USAGE_SOURCE]
      appendDateFilter(filters.from, '>=', conditions, values)
      appendDateFilter(filters.to, '<=', conditions, values)
      const where = conditions.join(' AND ')
      const limit = normalizeLimit(filters.limit)

      const [summaryResult, itemsResult] = await Promise.all([
        db.query(
          `SELECT
             COUNT(*)::int AS requests,
             COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
             COUNT(*) FILTER (WHERE status IN ('failed', 'cancelled'))::int AS failed,
             COALESCE(SUM(upstream_cost_cny) FILTER (WHERE status = 'succeeded'), 0)::float AS upstream_cost_cny,
             COALESCE(SUM(sale_price_cny) FILTER (WHERE status = 'succeeded'), 0)::float AS sale_price_cny
           FROM video_usage_logs
           WHERE ${where}`,
          values,
        ),
        db.query(
          `SELECT *
           FROM video_usage_logs
           WHERE ${where}
           ORDER BY created_at DESC
           LIMIT $${values.length + 1}`,
          [...values, limit],
        ),
      ])
      const summary = summaryResult.rows[0] || {}
      return {
        summary: {
          requests: Number(summary.requests || 0),
          succeeded: Number(summary.succeeded || 0),
          failed: Number(summary.failed || 0),
          upstreamCostCny: Number(summary.upstream_cost_cny || 0),
          salePriceCny: Number(summary.sale_price_cny || 0),
        },
        items: itemsResult.rows,
      }
    },
  }
}
