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
