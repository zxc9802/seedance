import express from 'express'
import { getPool } from '../db/postgres.js'

const router = express.Router()

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function normalizeText(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''

  const escapedMatch = trimmed.match(/\\"text\\":\\"([^"]*)\\"/)
  if (escapedMatch?.[1]) {
    return escapedMatch[1]
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .trim()
  }

  const directMatch = trimmed.match(/"text":"([^"]*)"/)
  if (directMatch?.[1]) {
    return directMatch[1].trim()
  }

  return trimmed
}

function extractPromptFromContent(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''

  return content
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join('\n')
}

function normalizeMediaCounts(counts) {
  return {
    images: Math.max(0, Number(counts?.images) || 0),
    videos: Math.max(0, Number(counts?.videos) || 0),
    audios: Math.max(0, Number(counts?.audios) || 0),
  }
}

function normalizeMediaSummary(summary) {
  if (!summary || typeof summary !== 'object') {
    return null
  }

  return {
    images: {
      count: Math.max(0, Number(summary?.images?.count) || 0),
      bytes: Math.max(0, Number(summary?.images?.bytes) || 0),
    },
    videos: {
      count: Math.max(0, Number(summary?.videos?.count) || 0),
      bytes: Math.max(0, Number(summary?.videos?.bytes) || 0),
    },
    audios: {
      count: Math.max(0, Number(summary?.audios?.count) || 0),
      bytes: Math.max(0, Number(summary?.audios?.bytes) || 0),
    },
  }
}

function extractMediaCounts(log) {
  const requestParams = log?.request_params || {}
  const mediaSummary = normalizeMediaSummary(requestParams.mediaSummary)
  if (mediaSummary) {
    return {
      images: mediaSummary.images.count,
      videos: mediaSummary.videos.count,
      audios: mediaSummary.audios.count,
    }
  }

  if (requestParams.mediaCounts || requestParams.referenceCounts) {
    return normalizeMediaCounts(requestParams.mediaCounts || requestParams.referenceCounts)
  }

  if (requestParams.payload) {
    return {
      images: asArray(requestParams.payload.resources).length,
      videos: asArray(requestParams.payload.referVideoUrl).length,
      audios: asArray(requestParams.payload.referAudioUrl).length,
    }
  }

  if (requestParams.references) {
    return {
      images: asArray(requestParams.references.images).length,
      videos: asArray(requestParams.references.videos).length,
      audios: asArray(requestParams.references.audios).length,
    }
  }

  const firstInstance = asArray(requestParams.instances)[0]
  if (firstInstance) {
    return {
      images: [
        firstInstance.image,
        firstInstance.lastFrame,
        ...asArray(firstInstance.referenceImages).map((item) => item?.image),
      ].filter(Boolean).length,
      videos: 0,
      audios: 0,
    }
  }

  const content = asArray(requestParams.messages).at(-1)?.content
  if (Array.isArray(content)) {
    return {
      images: content.filter((item) => item?.type === 'image_base64' || item?.type === 'image_url').length,
      videos: 0,
      audios: 0,
    }
  }

  return { images: 0, videos: 0, audios: 0 }
}

function extractMediaSizes(log) {
  const requestParams = log?.request_params || {}
  const mediaSummary = normalizeMediaSummary(requestParams.mediaSummary)
  if (mediaSummary) {
    return {
      images: mediaSummary.images.bytes,
      videos: mediaSummary.videos.bytes,
      audios: mediaSummary.audios.bytes,
    }
  }

  return { images: 0, videos: 0, audios: 0 }
}

function enhanceUsageLog(log) {
  const requestParams = log?.request_params || {}
  const promptText = normalizeText(requestParams.rawPrompt)
    || normalizeText(requestParams.prompt)
    || normalizeText(log?.prompt)
    || extractPromptFromContent(asArray(requestParams.messages).at(-1)?.content)

  const mediaCounts = extractMediaCounts(log)
  const mediaSizes = extractMediaSizes(log)

  return {
    ...log,
    promptText,
    imageCount: mediaCounts.images,
    videoCount: mediaCounts.videos,
    audioCount: mediaCounts.audios,
    imageBytes: mediaSizes.images,
    videoBytes: mediaSizes.videos,
    audioBytes: mediaSizes.audios,
  }
}

router.use((req, res, next) => {
  const adminPassword = process.env.ADMIN_PASSWORD || ''
  if (!adminPassword) {
    res.status(503).json({ error: 'ADMIN_PASSWORD not configured' })
    return
  }

  const auth = req.headers.authorization || ''
  const token = req.query.token || ''
  if (auth === `Bearer ${adminPassword}` || token === adminPassword) {
    next()
    return
  }

  res.status(401).json({ error: 'Unauthorized' })
})

router.get('/overview', async (req, res) => {
  const db = getPool()
  if (!db) return res.json({})

  try {
    const [totals, today, users] = await Promise.all([
      db.query(`
        SELECT
          COUNT(*)::int AS total_requests,
          COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
          COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
          COALESCE(SUM(estimated_cost), 0)::float AS total_cost
        FROM video_usage_logs
      `),
      db.query(`
        SELECT COUNT(*)::int AS today_requests
        FROM video_usage_logs
        WHERE created_at >= CURRENT_DATE
      `),
      db.query(`
        SELECT COUNT(DISTINCT user_id)::int AS active_users
        FROM video_usage_logs
      `),
    ])

    const t = totals.rows[0]
    res.json({
      totalRequests: t.total_requests,
      succeeded: t.succeeded,
      failed: t.failed,
      successRate: t.total_requests > 0 ? ((t.succeeded / t.total_requests) * 100).toFixed(1) : '0',
      totalCost: t.total_cost,
      todayRequests: today.rows[0].today_requests,
      activeUsers: users.rows[0].active_users,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/trend', async (req, res) => {
  const db = getPool()
  if (!db) return res.json([])

  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30))

  try {
    const result = await db.query(`
      SELECT
        DATE(created_at) AS date,
        COUNT(*)::int AS requests,
        COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
        COALESCE(SUM(estimated_cost), 0)::float AS estimated_cost
      FROM video_usage_logs
      WHERE created_at >= CURRENT_DATE - $1::int
      GROUP BY DATE(created_at)
      ORDER BY date
    `, [days])

    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/by-model', async (req, res) => {
  const db = getPool()
  if (!db) return res.json([])

  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30))

  try {
    const result = await db.query(`
      SELECT
        COALESCE(model, 'unknown') AS model,
        channel,
        COUNT(*)::int AS requests,
        COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
        COALESCE(SUM(estimated_cost), 0)::float AS estimated_cost
      FROM video_usage_logs
      WHERE created_at >= CURRENT_DATE - $1::int
      GROUP BY model, channel
      ORDER BY requests DESC
    `, [days])

    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/by-user', async (req, res) => {
  const db = getPool()
  if (!db) return res.json([])

  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30))
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50))

  try {
    const result = await db.query(`
      SELECT
        user_id,
        COALESCE(user_nickname, user_email, user_id) AS user_name,
        user_email,
        user_group,
        COUNT(*)::int AS requests,
        COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
        COALESCE(SUM(estimated_cost), 0)::float AS estimated_cost
      FROM video_usage_logs
      WHERE created_at >= CURRENT_DATE - $1::int
      GROUP BY user_id, user_nickname, user_email, user_group
      ORDER BY requests DESC
      LIMIT $2
    `, [days, limit])

    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/by-channel', async (req, res) => {
  const db = getPool()
  if (!db) return res.json([])

  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30))

  try {
    const result = await db.query(`
      SELECT
        channel,
        COUNT(*)::int AS requests,
        COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
        COALESCE(SUM(estimated_cost), 0)::float AS estimated_cost
      FROM video_usage_logs
      WHERE created_at >= CURRENT_DATE - $1::int
      GROUP BY channel
      ORDER BY requests DESC
    `, [days])

    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/tasks', async (req, res) => {
  const db = getPool()
  if (!db) return res.json({ items: [], total: 0 })

  const page = Math.max(1, Number(req.query.page) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 50))
  const offset = (page - 1) * pageSize

  const conditions = ['1=1']
  const params = []
  let paramIdx = 1

  if (req.query.userId) {
    conditions.push(`user_id = $${paramIdx++}`)
    params.push(req.query.userId)
  }
  if (req.query.channel === 'zhouzong') {
    conditions.push(`channel = ANY($${paramIdx++})`)
    params.push(['veo_fast', 'image'])
  } else if (req.query.channel) {
    conditions.push(`channel = $${paramIdx++}`)
    params.push(req.query.channel)
  }
  if (req.query.model) {
    conditions.push(`model ILIKE $${paramIdx++}`)
    params.push(`%${req.query.model}%`)
  }
  if (req.query.status) {
    conditions.push(`status = $${paramIdx++}`)
    params.push(req.query.status)
  }
  if (req.query.dateFrom) {
    conditions.push(`created_at >= $${paramIdx++}`)
    params.push(req.query.dateFrom)
  }
  if (req.query.dateTo) {
    conditions.push(`created_at <= $${paramIdx++}`)
    params.push(req.query.dateTo)
  }

  const where = conditions.join(' AND ')

  try {
    const [countResult, dataResult] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS total FROM video_usage_logs WHERE ${where}`, params),
      db.query(
        `SELECT * FROM video_usage_logs WHERE ${where} ORDER BY created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
        [...params, pageSize, offset]
      ),
    ])

    res.json({
      items: dataResult.rows.map(enhanceUsageLog),
      total: countResult.rows[0].total,
      page,
      pageSize,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/pricing', async (req, res) => {
  const db = getPool()
  if (!db) return res.json([])

  try {
    const result = await db.query('SELECT * FROM model_pricing ORDER BY channel, model')
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/pricing', async (req, res) => {
  const db = getPool()
  if (!db) return res.status(503).json({ error: 'Database not available' })

  const { channel, model, priceType, unitPrice, currency, note } = req.body || {}
  if (!channel || !model) {
    return res.status(400).json({ error: 'channel and model are required' })
  }

  try {
    await db.query(`
      INSERT INTO model_pricing (channel, model, price_type, unit_price, currency, note, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (channel, model)
      DO UPDATE SET price_type = $3, unit_price = $4, currency = $5, note = $6, updated_at = NOW()
    `, [channel, model, priceType || 'per_call', unitPrice || 0, currency || 'CNY', note || null])

    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/user-detail', async (req, res) => {
  const db = getPool()
  if (!db) return res.json([])

  const userId = req.query.userId
  if (!userId) return res.status(400).json({ error: 'userId is required' })

  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30))

  try {
    const result = await db.query(`
      SELECT
        id, channel, provider_id, model, generation_mode, prompt,
        aspect_ratio, resolution, duration, request_params, engine_task_id,
        upstream_request_id, upstream_trace_id, upstream_url, status, error_message,
        video_url, estimated_cost, created_at, completed_at
      FROM video_usage_logs
      WHERE user_id = $1 AND created_at >= CURRENT_DATE - $2::int
      ORDER BY created_at DESC
      LIMIT 200
    `, [userId, days])

    res.json(result.rows.map(enhanceUsageLog))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
