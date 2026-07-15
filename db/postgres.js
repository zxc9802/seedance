import pg from 'pg'

const { Pool } = pg

let pool = null

export function getPool() {
  if (pool) return pool

  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    console.warn('[usage-db] DATABASE_URL not set, usage tracking disabled.')
    return null
  }

  pool = new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ssl: connectionString.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
  })

  pool.on('error', (err) => {
    console.error('[usage-db] Unexpected pool error:', err.message)
  })

  return pool
}

export async function initDatabase() {
  const db = getPool()
  if (!db) return

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS video_usage_logs (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id             TEXT NOT NULL,
        user_email          TEXT,
        user_nickname       TEXT,
        user_group          TEXT,
        channel             TEXT NOT NULL,
        provider_id         TEXT,
        model               TEXT,
        generation_mode     TEXT,
        prompt              TEXT,
        aspect_ratio        TEXT,
        resolution          TEXT,
        duration            INT,
        sample_count        INT DEFAULT 1,
        request_params      JSONB,
        engine_task_id      TEXT,
        upstream_request_id TEXT,
        upstream_trace_id   TEXT,
        upstream_url        TEXT,
        status              TEXT NOT NULL DEFAULT 'submitted',
        error_message       TEXT,
        video_url           TEXT,
        unit_price          NUMERIC(10,4),
        estimated_cost      NUMERIC(10,4),
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at        TIMESTAMPTZ
      )
    `)

    await db.query(`ALTER TABLE video_usage_logs ADD COLUMN IF NOT EXISTS lark_backup_record_id TEXT`)
    await db.query(`ALTER TABLE video_usage_logs ADD COLUMN IF NOT EXISTS lark_backup_synced_at TIMESTAMPTZ`)
    await db.query(`ALTER TABLE video_usage_logs ADD COLUMN IF NOT EXISTS lark_backup_error TEXT`)

    await db.query(`CREATE INDEX IF NOT EXISTS idx_usage_logs_user_id ON video_usage_logs(user_id)`)
    await db.query(`CREATE INDEX IF NOT EXISTS idx_usage_logs_channel ON video_usage_logs(channel)`)
    await db.query(`CREATE INDEX IF NOT EXISTS idx_usage_logs_model ON video_usage_logs(model)`)
    await db.query(`CREATE INDEX IF NOT EXISTS idx_usage_logs_status ON video_usage_logs(status)`)
    await db.query(`CREATE INDEX IF NOT EXISTS idx_usage_logs_created_at ON video_usage_logs(created_at)`)
    await db.query(`CREATE INDEX IF NOT EXISTS idx_usage_logs_engine_task_id ON video_usage_logs(engine_task_id)`)
    await db.query(`CREATE INDEX IF NOT EXISTS idx_usage_logs_lark_backup_record_id ON video_usage_logs(lark_backup_record_id)`)

    await db.query(`
      CREATE TABLE IF NOT EXISTS model_pricing (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        channel     TEXT NOT NULL,
        model       TEXT NOT NULL,
        price_type  TEXT NOT NULL DEFAULT 'per_call',
        unit_price  NUMERIC(10,4) NOT NULL DEFAULT 0,
        currency    TEXT NOT NULL DEFAULT 'CNY',
        note        TEXT,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(channel, model)
      )
    `)

    await db.query(`
      CREATE TABLE IF NOT EXISTS user_credit_accounts (
        user_id       TEXT PRIMARY KEY,
        user_email    TEXT,
        user_nickname TEXT,
        user_group    TEXT,
        balance       NUMERIC(12,2) NOT NULL DEFAULT 0,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    await db.query(`
      CREATE TABLE IF NOT EXISTS user_credit_transactions (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id       TEXT NOT NULL,
        user_email    TEXT,
        user_nickname TEXT,
        user_group    TEXT,
        type          TEXT NOT NULL,
        amount        NUMERIC(12,2) NOT NULL,
        balance_after NUMERIC(12,2) NOT NULL,
        usage_log_id  UUID,
        note          TEXT,
        created_by    TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    await db.query(`CREATE INDEX IF NOT EXISTS idx_credit_transactions_user_id ON user_credit_transactions(user_id)`)
    await db.query(`CREATE INDEX IF NOT EXISTS idx_credit_transactions_created_at ON user_credit_transactions(created_at)`)
    await db.query(`CREATE INDEX IF NOT EXISTS idx_credit_transactions_usage_log_id ON user_credit_transactions(usage_log_id)`)
    await db.query(`ALTER TABLE user_credit_transactions ADD COLUMN IF NOT EXISTS request_id TEXT`)
    await db.query(`CREATE INDEX IF NOT EXISTS idx_credit_transactions_request_id ON user_credit_transactions(request_id)`)
    await db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_transactions_unique_consume_usage
      ON user_credit_transactions(usage_log_id)
      WHERE type = 'consume' AND usage_log_id IS NOT NULL
    `)
    await db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_transactions_unique_recharge_request
      ON user_credit_transactions(request_id)
      WHERE type = 'recharge' AND request_id IS NOT NULL
    `)

    await db.query(`
      CREATE TABLE IF NOT EXISTS credit_hub_instances (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name             TEXT NOT NULL,
        base_url         TEXT NOT NULL,
        token_ciphertext TEXT NOT NULL,
        token_hint       TEXT,
        enabled          BOOLEAN NOT NULL DEFAULT TRUE,
        note             TEXT,
        last_sync_status TEXT,
        last_sync_error  TEXT,
        last_synced_at   TIMESTAMPTZ,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(name)
      )
    `)
    await db.query(`CREATE INDEX IF NOT EXISTS idx_credit_hub_instances_enabled ON credit_hub_instances(enabled)`)
    await db.query(`CREATE INDEX IF NOT EXISTS idx_credit_hub_instances_last_synced_at ON credit_hub_instances(last_synced_at)`)

    await db.query(`
      CREATE TABLE IF NOT EXISTS credit_hub_snapshots (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        instance_id         UUID NOT NULL REFERENCES credit_hub_instances(id) ON DELETE CASCADE,
        balance             NUMERIC(12,2) NOT NULL DEFAULT 0,
        total_consumed      NUMERIC(12,2) NOT NULL DEFAULT 0,
        today_consumed      NUMERIC(12,2) NOT NULL DEFAULT 0,
        total_generations   INT NOT NULL DEFAULT 0,
        last_transaction_at TIMESTAMPTZ,
        server_time         TIMESTAMPTZ,
        status              TEXT NOT NULL DEFAULT 'online',
        error_message       TEXT,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await db.query(`CREATE INDEX IF NOT EXISTS idx_credit_hub_snapshots_instance_created ON credit_hub_snapshots(instance_id, created_at DESC)`)

    await db.query(`
      CREATE TABLE IF NOT EXISTS credit_hub_actions (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        instance_id   UUID NOT NULL REFERENCES credit_hub_instances(id) ON DELETE CASCADE,
        type          TEXT NOT NULL,
        amount        NUMERIC(12,2),
        request_id    TEXT,
        note          TEXT,
        status        TEXT NOT NULL DEFAULT 'pending',
        error_message TEXT,
        response      JSONB,
        created_by    TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await db.query(`CREATE INDEX IF NOT EXISTS idx_credit_hub_actions_instance_created ON credit_hub_actions(instance_id, created_at DESC)`)
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_hub_actions_request_id ON credit_hub_actions(request_id) WHERE request_id IS NOT NULL`)

    console.log('[usage-db] Tables initialized successfully.')
  } catch (err) {
    console.error('[usage-db] Failed to initialize tables:', err.message)
  }
}

export async function closePool() {
  if (pool) {
    await pool.end()
    pool = null
  }
}
