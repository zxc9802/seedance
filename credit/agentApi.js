import { timingSafeEqual } from 'node:crypto'
import express from 'express'
import { getPool } from '../db/postgres.js'
import { getCreditBalanceAccountId, normalizeCreditAmount, rechargeSiteCredits } from '../db/credits.js'

const router = express.Router()
const CREDIT_USAGE_WHERE_SQL = `(provider_id = 'veo' OR provider_id = 'seedance1')`

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

function requireCreditAgentToken(req, res, next) {
  const expectedToken = process.env.CREDIT_AGENT_TOKEN?.trim()
  if (!expectedToken) {
    res.status(503).json({ error: 'CREDIT_AGENT_TOKEN not configured' })
    return
  }

  if (!isSameToken(readBearerToken(req), expectedToken)) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  next()
}

function getAgentInstanceId() {
  return (
    process.env.CREDIT_AGENT_INSTANCE_ID?.trim()
    || process.env.PUBLIC_BASE_URL?.trim()
    || process.env.ZEABUR_SERVICE_ID?.trim()
    || 'seedance'
  )
}

router.use(requireCreditAgentToken)

router.get('/summary', async (_req, res) => {
  const db = getPool()
  if (!db) return res.status(503).json({ error: 'Database not available' })

  try {
    const [accountResult, consumedResult, generationResult, transactionResult] = await Promise.all([
      db.query(
        `SELECT COALESCE(balance, 0)::float AS balance
         FROM user_credit_accounts
         WHERE user_id = $1`,
        [getCreditBalanceAccountId()],
      ),
      db.query(`
        SELECT
          COALESCE(SUM(-amount), 0)::float AS total_consumed,
          COALESCE(SUM(-amount) FILTER (WHERE created_at >= CURRENT_DATE), 0)::float AS today_consumed
        FROM user_credit_transactions
        WHERE type = 'consume'
      `),
      db.query(`
        SELECT COALESCE(SUM(GREATEST(COALESCE(sample_count, 1), 1)), 0)::int AS total_generations
        FROM video_usage_logs
        WHERE ${CREDIT_USAGE_WHERE_SQL} AND status = 'succeeded'
      `),
      db.query(`
        SELECT MAX(created_at) AS last_transaction_at
        FROM user_credit_transactions
      `),
    ])

    res.json({
      instanceId: getAgentInstanceId(),
      balance: Number(accountResult.rows[0]?.balance || 0),
      totalConsumed: Number(consumedResult.rows[0]?.total_consumed || 0),
      todayConsumed: Number(consumedResult.rows[0]?.today_consumed || 0),
      totalGenerations: Number(generationResult.rows[0]?.total_generations || 0),
      lastTransactionAt: transactionResult.rows[0]?.last_transaction_at || null,
      serverTime: new Date().toISOString(),
    })
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to load credit summary' })
  }
})

router.get('/transactions', async (req, res) => {
  const db = getPool()
  if (!db) return res.status(503).json({ error: 'Database not available' })
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100))

  try {
    const result = await db.query(
      `SELECT id, user_id, user_email, user_nickname, user_group, type, amount, balance_after,
              usage_log_id, note, created_by, request_id, created_at
       FROM user_credit_transactions
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit],
    )
    res.json({ items: result.rows })
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to load transactions' })
  }
})

router.post('/recharge', async (req, res) => {
  const requestId = String(req.body?.requestId || '').trim()
  const note = req.body?.note ? String(req.body.note).trim() : null
  if (!requestId) {
    res.status(400).json({ error: 'requestId is required' })
    return
  }

  let amount
  try {
    amount = normalizeCreditAmount(req.body?.amount)
  } catch (error) {
    res.status(400).json({ error: error.message || 'amount is invalid' })
    return
  }

  try {
    const result = await rechargeSiteCredits({
      amount,
      note,
      actor: 'credit-hub',
      requestId,
    })
    res.json({
      success: true,
      balance: result.balance,
      amount: result.amount,
      transactionId: result.transactionId,
      duplicate: result.duplicate === true,
    })
  } catch (error) {
    res.status(500).json({ error: error.message || 'Recharge failed' })
  }
})

export default router
