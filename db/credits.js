import { getPool } from './postgres.js'

const TEXT_VIDEO_RATES = Object.freeze({
  '480p': 1.5,
  '720p': 3.05,
  '1080p': 7.6,
  '4k': 16,
})

const REFERENCE_VIDEO_RATES = Object.freeze({
  '480p': 2.5,
  '720p': 5,
  '1080p': 12.5,
  '4k': 25.5,
})

const CREDIT_BILLED_PROVIDERS = new Set(['veo', 'seedance1'])

export function shouldChargeCreditsForProvider(providerId) {
  return CREDIT_BILLED_PROVIDERS.has(String(providerId || '').trim().toLowerCase())
}

export function normalizeCreditAmount(value) {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('credit amount must be greater than 0')
  }
  return Number(amount.toFixed(2))
}

export function extractCreditUserInfo(session) {
  if (!session?.user) {
    const userId = process.env.DEV_USAGE_USER_ID?.trim()
    if (!userId) return { userId: null, email: null, nickname: null, group: null }
    return {
      userId,
      email: process.env.DEV_USAGE_USER_EMAIL?.trim() || `${userId}@local.dev`,
      nickname: process.env.DEV_USAGE_USER_NICKNAME?.trim() || userId,
      group: process.env.DEV_USAGE_USER_GROUP?.trim() || 'local-dev',
    }
  }

  const user = session.user
  const userId = user.id || user.userId || user.uid || user.uuid || user.memberId || user.account || user.email || null
  return {
    userId,
    email: user.account || user.email || user.username || user.userName || user.login || null,
    nickname: user.nickname || user.name || user.displayName || user.realName || null,
    group: user.groupName || user.group || (Array.isArray(user.groupNames) ? user.groupNames.join(',') : null),
  }
}

export function normalizeCreditResolution(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized.includes('4k') || normalized === '2160p') return '4k'
  if (normalized.includes('1080')) return '1080p'
  if (normalized.includes('720')) return '720p'
  if (normalized.includes('480')) return '480p'
  return '720p'
}

export function calculateVideoCreditCharge(log) {
  const resolution = normalizeCreditResolution(log?.resolution || log?.requestParams?.requestedParams?.resolution)
  const duration = Math.max(0, Number(log?.duration ?? log?.requestParams?.requestedParams?.duration) || 0)
  const sampleCount = Math.max(1, Math.trunc(Number(log?.sampleCount ?? log?.sample_count) || 1))
  const mediaSummary = log?.requestParams?.mediaSummary || {}
  const fallbackCounts = log?.requestParams?.referenceCounts || log?.requestParams?.mediaCounts || {}
  const imageCount = Math.max(0, Number(mediaSummary?.images?.count ?? fallbackCounts.images) || 0)
  const videoCount = Math.max(0, Number(mediaSummary?.videos?.count ?? fallbackCounts.videos) || 0)
  const referenceVideoSeconds = Math.max(0, Number(mediaSummary?.videos?.durationSeconds) || 0)
  const category = imageCount + videoCount > 0 ? 'reference' : 'text'
  const rates = category === 'reference' ? REFERENCE_VIDEO_RATES : TEXT_VIDEO_RATES
  const rate = rates[resolution] || rates['720p']
  const billableSeconds = (duration * sampleCount) + (category === 'reference' ? referenceVideoSeconds : 0)
  const amount = Number((rate * billableSeconds).toFixed(2))

  return {
    category,
    resolution,
    rate,
    billableSeconds,
    amount,
  }
}

export async function getUserCreditBalance(userId) {
  const db = getPool()
  if (!db || !userId) return null

  const result = await db.query(
    'SELECT balance FROM user_credit_accounts WHERE user_id = $1',
    [userId],
  )
  return Number(result.rows[0]?.balance || 0)
}

export async function rechargeUserCredits({ userId, email, nickname, group, amount, note, actor }) {
  const db = getPool()
  if (!db) throw new Error('Database not available')
  if (!userId) throw new Error('userId is required')
  const normalizedAmount = normalizeCreditAmount(amount)
  const client = await db.connect()

  try {
    await client.query('BEGIN')
    const account = await upsertCreditAccount(client, { userId, email, nickname, group })
    const nextBalance = Number(account.balance) + normalizedAmount
    await client.query(
      `UPDATE user_credit_accounts
       SET balance = $2, user_email = COALESCE($3, user_email), user_nickname = COALESCE($4, user_nickname),
           user_group = COALESCE($5, user_group), updated_at = NOW()
       WHERE user_id = $1`,
      [userId, nextBalance, email || null, nickname || null, group || null],
    )
    await client.query(
      `INSERT INTO user_credit_transactions (
        user_id, user_email, user_nickname, user_group, type, amount, balance_after, note, created_by
      ) VALUES ($1,$2,$3,$4,'recharge',$5,$6,$7,$8)`,
      [userId, email || null, nickname || null, group || null, normalizedAmount, nextBalance, note || null, actor || 'admin'],
    )
    await client.query('COMMIT')
    return { userId, balance: nextBalance, amount: normalizedAmount }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function deductUserCreditsForUsage({ session, charge, usageLogId, note }) {
  const db = getPool()
  const user = extractCreditUserInfo(session)
  if (!db || !user.userId || !charge?.amount) return null
  const client = await db.connect()

  try {
    await client.query('BEGIN')
    const account = await upsertCreditAccount(client, user)
    const currentBalance = Number(account.balance)
    if (currentBalance < charge.amount) {
      throw Object.assign(new Error('Insufficient credits'), { statusCode: 402, balance: currentBalance })
    }
    const nextBalance = Number((currentBalance - charge.amount).toFixed(2))
    await client.query(
      `UPDATE user_credit_accounts
       SET balance = $2, user_email = COALESCE($3, user_email), user_nickname = COALESCE($4, user_nickname),
           user_group = COALESCE($5, user_group), updated_at = NOW()
       WHERE user_id = $1`,
      [user.userId, nextBalance, user.email, user.nickname, user.group],
    )
    await client.query(
      `INSERT INTO user_credit_transactions (
        user_id, user_email, user_nickname, user_group, type, amount, balance_after, usage_log_id, note, created_by
      ) VALUES ($1,$2,$3,$4,'consume',$5,$6,$7,$8,'system')`,
      [user.userId, user.email, user.nickname, user.group, -charge.amount, nextBalance, usageLogId || null, note || null],
    )
    await client.query('COMMIT')
    return { userId: user.userId, balance: nextBalance }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function assertSufficientCredits(session, charge) {
  const user = extractCreditUserInfo(session)
  if (!user.userId || !charge?.amount) return { ok: true, userId: user.userId, balance: null }
  const balance = await getUserCreditBalance(user.userId)
  if (balance === null || balance >= charge.amount) return { ok: true, userId: user.userId, balance }
  return { ok: false, userId: user.userId, balance }
}

async function upsertCreditAccount(client, { userId, email, nickname, group }) {
  const result = await client.query(
    `INSERT INTO user_credit_accounts (user_id, user_email, user_nickname, user_group, balance, updated_at)
     VALUES ($1,$2,$3,$4,0,NOW())
     ON CONFLICT (user_id) DO UPDATE
       SET user_email = COALESCE(EXCLUDED.user_email, user_credit_accounts.user_email),
           user_nickname = COALESCE(EXCLUDED.user_nickname, user_credit_accounts.user_nickname),
           user_group = COALESCE(EXCLUDED.user_group, user_credit_accounts.user_group),
           updated_at = NOW()
     RETURNING balance`,
    [userId, email || null, nickname || null, group || null],
  )
  return result.rows[0]
}
