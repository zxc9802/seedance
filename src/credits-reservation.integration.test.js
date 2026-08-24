import assert from 'node:assert/strict'
import test from 'node:test'
import pg from 'pg'

const databaseUrl = process.env.CREDIT_TEST_DATABASE_URL

async function resetCreditTables(adminPool, balance = 100) {
  await adminPool.query(`
    DROP TABLE IF EXISTS credit_reservations, user_credit_transactions, video_usage_logs, user_credit_accounts CASCADE;

    CREATE TABLE user_credit_accounts (
      user_id TEXT PRIMARY KEY,
      user_email TEXT,
      user_nickname TEXT,
      user_group TEXT,
      balance NUMERIC(12,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE video_usage_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL,
      user_email TEXT,
      user_nickname TEXT,
      user_group TEXT,
      provider_id TEXT,
      resolution TEXT,
      duration INT,
      sample_count INT DEFAULT 1,
      request_params JSONB,
      engine_task_id TEXT,
      upstream_request_id TEXT,
      upstream_trace_id TEXT,
      estimated_cost NUMERIC(10,4),
      unit_price NUMERIC(10,4),
      status TEXT NOT NULL DEFAULT 'submitted',
      error_message TEXT,
      video_url TEXT,
      credit_reservation_id UUID,
      completed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE user_credit_transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL,
      user_email TEXT,
      user_nickname TEXT,
      user_group TEXT,
      type TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      balance_after NUMERIC(12,2) NOT NULL,
      usage_log_id UUID,
      note TEXT,
      created_by TEXT,
      request_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX idx_credit_transactions_unique_consume_usage
      ON user_credit_transactions(usage_log_id)
      WHERE type = 'consume' AND usage_log_id IS NOT NULL;

    CREATE TABLE credit_reservations (
      id UUID PRIMARY KEY,
      user_id TEXT,
      user_email TEXT,
      user_nickname TEXT,
      user_group TEXT,
      amount NUMERIC(12,2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'reserved',
      usage_log_id UUID UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      settled_at TIMESTAMPTZ,
      released_at TIMESTAMPTZ
    );
  `)
  await adminPool.query(
    `INSERT INTO user_credit_accounts (user_id, balance)
     VALUES ('__site_shared_credits__', $1)`,
    [balance],
  )
}

test('concurrent generation requests cannot reserve more than the shared balance', {
  skip: !databaseUrl && 'CREDIT_TEST_DATABASE_URL is required',
}, async (t) => {
  process.env.DATABASE_URL = databaseUrl

  const adminPool = new pg.Pool({ connectionString: databaseUrl })
  const credits = await import('../db/credits.js')
  const database = await import('../db/postgres.js')

  t.after(async () => {
    await database.closePool()
    await adminPool.end()
  })

  await resetCreditTables(adminPool)

  const session = { user: { id: 'employee-a', nickname: 'Employee A' } }
  const charge = { category: 'text', resolution: '720p', billableSeconds: 20, amount: 80 }
  const reservations = await Promise.all([
    credits.assertSufficientCredits(session, charge, {
      reservationId: '00000000-0000-4000-8000-000000000001',
    }),
    credits.assertSufficientCredits(session, charge, {
      reservationId: '00000000-0000-4000-8000-000000000002',
    }),
  ])

  assert.equal(reservations.filter((reservation) => reservation.ok).length, 1)
  assert.equal(reservations.filter((reservation) => !reservation.ok).length, 1)

  const balance = await adminPool.query(
    `SELECT balance::float FROM user_credit_accounts WHERE user_id = '__site_shared_credits__'`,
  )
  assert.equal(balance.rows[0].balance, 20)
})

test('successful usage settles a reservation once without deducting the balance again', {
  skip: !databaseUrl && 'CREDIT_TEST_DATABASE_URL is required',
}, async (t) => {
  process.env.DATABASE_URL = databaseUrl

  const adminPool = new pg.Pool({ connectionString: databaseUrl })
  const credits = await import('../db/credits.js')
  const database = await import('../db/postgres.js')

  t.after(async () => {
    await database.closePool()
    await adminPool.end()
  })

  await resetCreditTables(adminPool)

  const reservationId = '00000000-0000-4000-8000-000000000003'
  const reserved = await credits.assertSufficientCredits(
    { user: { id: 'employee-a', nickname: 'Employee A' } },
    { category: 'text', resolution: '720p', billableSeconds: 20, amount: 80 },
    { reservationId },
  )
  assert.equal(reserved.ok, true)

  const usage = await adminPool.query(
    `INSERT INTO video_usage_logs (
      user_id, user_nickname, provider_id, resolution, duration, sample_count,
      estimated_cost, status, video_url, credit_reservation_id
    ) VALUES ('employee-a','Employee A','seedance1','720p',20,1,80,'succeeded',
      'https://media.example/video.mp4',$1::uuid)
    RETURNING id`,
    [reservationId],
  )
  const usageLogId = usage.rows[0].id

  await credits.reconcileCreditsForUsageLog(usageLogId)
  await credits.reconcileCreditsForUsageLog(usageLogId)

  const balance = await adminPool.query(
    `SELECT balance::float FROM user_credit_accounts WHERE user_id = '__site_shared_credits__'`,
  )
  const reservation = await adminPool.query(
    `SELECT status, usage_log_id FROM credit_reservations WHERE id = $1::uuid`,
    [reservationId],
  )
  const transactions = await adminPool.query(
    `SELECT type, amount::float, usage_log_id FROM user_credit_transactions ORDER BY created_at`,
  )

  assert.equal(balance.rows[0].balance, 20)
  assert.equal(reservation.rows[0].status, 'settled')
  assert.equal(reservation.rows[0].usage_log_id, usageLogId)
  assert.deepEqual(transactions.rows, [{
    type: 'consume',
    amount: -80,
    usage_log_id: usageLogId,
  }])
})

test('failed usage releases reserved credits once', {
  skip: !databaseUrl && 'CREDIT_TEST_DATABASE_URL is required',
}, async (t) => {
  process.env.DATABASE_URL = databaseUrl

  const adminPool = new pg.Pool({ connectionString: databaseUrl })
  const credits = await import('../db/credits.js')
  const database = await import('../db/postgres.js')

  t.after(async () => {
    await database.closePool()
    await adminPool.end()
  })

  await resetCreditTables(adminPool)

  const reservationId = '00000000-0000-4000-8000-000000000004'
  const reserved = await credits.assertSufficientCredits(
    { user: { id: 'employee-a', nickname: 'Employee A' } },
    { category: 'text', resolution: '720p', billableSeconds: 20, amount: 80 },
    { reservationId },
  )
  assert.equal(reserved.ok, true)

  const usage = await adminPool.query(
    `INSERT INTO video_usage_logs (
      user_id, user_nickname, provider_id, resolution, duration, sample_count,
      estimated_cost, status, video_url, credit_reservation_id
    ) VALUES ('employee-a','Employee A','seedance1','720p',20,1,80,'failed',NULL,$1::uuid)
    RETURNING id`,
    [reservationId],
  )
  const usageLogId = usage.rows[0].id

  await credits.reconcileCreditsForUsageLog(usageLogId)
  await credits.reconcileCreditsForUsageLog(usageLogId)

  const balance = await adminPool.query(
    `SELECT balance::float FROM user_credit_accounts WHERE user_id = '__site_shared_credits__'`,
  )
  const reservation = await adminPool.query(
    `SELECT status, usage_log_id FROM credit_reservations WHERE id = $1::uuid`,
    [reservationId],
  )
  const transactions = await adminPool.query(
    `SELECT type, amount::float, usage_log_id FROM user_credit_transactions ORDER BY created_at`,
  )

  assert.equal(balance.rows[0].balance, 100)
  assert.equal(reservation.rows[0].status, 'released')
  assert.equal(reservation.rows[0].usage_log_id, usageLogId)
  assert.deepEqual(transactions.rows, [
    { type: 'reserve', amount: -80, usage_log_id: null },
    { type: 'release', amount: 80, usage_log_id: usageLogId },
  ])
})

test('usage status updates release a failed generation reservation before returning', {
  skip: !databaseUrl && 'CREDIT_TEST_DATABASE_URL is required',
}, async (t) => {
  process.env.DATABASE_URL = databaseUrl

  const adminPool = new pg.Pool({ connectionString: databaseUrl })
  const credits = await import('../db/credits.js')
  const usage = await import('../db/usage.js')
  const database = await import('../db/postgres.js')

  t.after(async () => {
    await database.closePool()
    await adminPool.end()
  })

  await resetCreditTables(adminPool)

  const reservationId = '00000000-0000-4000-8000-000000000005'
  await credits.assertSufficientCredits(
    { user: { id: 'employee-a', nickname: 'Employee A' } },
    { category: 'text', resolution: '720p', billableSeconds: 20, amount: 80 },
    { reservationId },
  )
  await adminPool.query(
    `INSERT INTO video_usage_logs (
      user_id, user_nickname, provider_id, resolution, duration, sample_count,
      estimated_cost, status, engine_task_id, credit_reservation_id
    ) VALUES ('employee-a','Employee A','seedance1','720p',20,1,80,'submitted','task-5',$1::uuid)`,
    [reservationId],
  )

  await usage.updateUsageLogByTaskId('task-5', {
    status: 'failed',
    videoUrl: null,
    errorMessage: 'upstream failed',
    completedAt: new Date().toISOString(),
  })

  const balance = await adminPool.query(
    `SELECT balance::float FROM user_credit_accounts WHERE user_id = '__site_shared_credits__'`,
  )
  const reservation = await adminPool.query(
    `SELECT status FROM credit_reservations WHERE id = $1::uuid`,
    [reservationId],
  )
  assert.equal(balance.rows[0].balance, 100)
  assert.equal(reservation.rows[0].status, 'released')
})

test('a legacy unreserved completion cannot push the shared balance below zero', {
  skip: !databaseUrl && 'CREDIT_TEST_DATABASE_URL is required',
}, async (t) => {
  process.env.DATABASE_URL = databaseUrl

  const adminPool = new pg.Pool({ connectionString: databaseUrl })
  const credits = await import('../db/credits.js')
  const database = await import('../db/postgres.js')

  t.after(async () => {
    await database.closePool()
    await adminPool.end()
  })

  await resetCreditTables(adminPool, 20)
  const usage = await adminPool.query(
    `INSERT INTO video_usage_logs (
      user_id, user_nickname, provider_id, resolution, duration, sample_count,
      estimated_cost, status, video_url
    ) VALUES ('employee-a','Employee A','seedance1','720p',20,1,80,'succeeded',
      'https://media.example/legacy.mp4')
    RETURNING id`,
  )

  const result = await credits.reconcileCreditsForUsageLog(usage.rows[0].id)
  const balance = await adminPool.query(
    `SELECT balance::float FROM user_credit_accounts WHERE user_id = '__site_shared_credits__'`,
  )
  const consumed = await adminPool.query(
    `SELECT COUNT(*)::int AS count FROM user_credit_transactions WHERE type = 'consume'`,
  )

  assert.equal(result.reason, 'insufficient_unreserved_balance')
  assert.equal(balance.rows[0].balance, 20)
  assert.equal(consumed.rows[0].count, 0)
})
