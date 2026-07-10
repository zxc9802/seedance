import { getPool } from './postgres.js'

export const SITE_CREDIT_ACCOUNT_ID = '__site_shared_credits__'

const SITE_CREDIT_ACCOUNT = Object.freeze({
  userId: SITE_CREDIT_ACCOUNT_ID,
  email: null,
  nickname: '全站共享积分',
  group: 'site',
})

export function getCreditBalanceAccountId() {
  return SITE_CREDIT_ACCOUNT_ID
}

export function normalizeCreditAmount(value) {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('credit amount must be greater than 0')
  }
  return Number(amount.toFixed(2))
}

export async function rechargeSiteCredits({ amount, note, actor, requestId }) {
  return rechargeUserCredits({
    ...SITE_CREDIT_ACCOUNT,
    amount,
    note,
    actor,
    requestId,
  })
}

async function rechargeUserCredits({ userId, email, nickname, group, amount, note, actor, requestId }) {
  const db = getPool()
  if (!db) throw new Error('Database not available')
  if (!userId) throw new Error('userId is required')

  const normalizedAmount = normalizeCreditAmount(amount)
  const normalizedRequestId = String(requestId || '').trim() || null
  const client = await db.connect()

  try {
    await client.query('BEGIN')
    if (normalizedRequestId) {
      const existing = await client.query(
        `SELECT id, amount, balance_after
         FROM user_credit_transactions
         WHERE type = 'recharge' AND request_id = $1
         LIMIT 1`,
        [normalizedRequestId],
      )
      const transaction = existing.rows[0]
      if (transaction) {
        await client.query('COMMIT')
        return {
          userId,
          balance: Number(transaction.balance_after || 0),
          amount: Math.abs(Number(transaction.amount || 0)),
          transactionId: transaction.id,
          duplicate: true,
        }
      }
    }

    const account = await upsertCreditAccount(client, { userId, email, nickname, group })
    const nextBalance = Number(account.balance) + normalizedAmount
    await client.query(
      `UPDATE user_credit_accounts
       SET balance = $2, user_email = COALESCE($3, user_email), user_nickname = COALESCE($4, user_nickname),
           user_group = COALESCE($5, user_group), updated_at = NOW()
       WHERE user_id = $1`,
      [userId, nextBalance, email || null, nickname || null, group || null],
    )
    const transactionResult = await client.query(
      `INSERT INTO user_credit_transactions (
        user_id, user_email, user_nickname, user_group, type, amount, balance_after, note, created_by, request_id
      ) VALUES ($1,$2,$3,$4,'recharge',$5,$6,$7,$8,$9)
      RETURNING id`,
      [userId, email || null, nickname || null, group || null, normalizedAmount, nextBalance, note || null, actor || 'admin', normalizedRequestId],
    )
    await client.query('COMMIT')
    return {
      userId,
      balance: nextBalance,
      amount: normalizedAmount,
      transactionId: transactionResult.rows[0]?.id || null,
      duplicate: false,
    }
  } catch (error) {
    await client.query('ROLLBACK')
    if (normalizedRequestId && error?.code === '23505') {
      const existing = await db.query(
        `SELECT id, amount, balance_after
         FROM user_credit_transactions
         WHERE type = 'recharge' AND request_id = $1
         LIMIT 1`,
        [normalizedRequestId],
      )
      const transaction = existing.rows[0]
      if (transaction) {
        return {
          userId,
          balance: Number(transaction.balance_after || 0),
          amount: Math.abs(Number(transaction.amount || 0)),
          transactionId: transaction.id,
          duplicate: true,
        }
      }
    }
    throw error
  } finally {
    client.release()
  }
}

async function upsertCreditAccount(client, { userId, email, nickname, group }) {
  const result = await client.query(
    `INSERT INTO user_credit_accounts (user_id, user_email, user_nickname, user_group, balance)
     VALUES ($1,$2,$3,$4,0)
     ON CONFLICT (user_id)
     DO UPDATE SET
       user_email = COALESCE(EXCLUDED.user_email, user_credit_accounts.user_email),
       user_nickname = COALESCE(EXCLUDED.user_nickname, user_credit_accounts.user_nickname),
       user_group = COALESCE(EXCLUDED.user_group, user_credit_accounts.user_group),
       updated_at = NOW()
     RETURNING balance`,
    [userId, email || null, nickname || null, group || null],
  )
  return result.rows[0] || { balance: 0 }
}
