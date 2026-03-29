import { initDatabase, getPool, closePool } from '../db/postgres.js'
import { syncUsageLogBackupByIds, getLarkUsageBackupStatus } from '../integrations/larkBaseUsageBackup.js'
import { loadProjectEnv, buildConnectionSummary } from './db-common.mjs'

function parseArgs(argv) {
  const options = {
    all: false,
    limit: 0,
  }

  for (const arg of argv) {
    if (arg === '--all') {
      options.all = true
      continue
    }
    if (arg.startsWith('--limit=')) {
      options.limit = Math.max(0, Number(arg.slice('--limit='.length)) || 0)
    }
  }

  return options
}

async function main() {
  await loadProjectEnv()
  await initDatabase()

  const status = getLarkUsageBackupStatus()
  if (!status.enabled || !status.baseTokenConfigured || !status.tableIdConfigured) {
    throw new Error('Lark usage backup is not configured. Set LARK_BASE_BACKUP_ENABLED, LARK_BASE_BACKUP_BASE_TOKEN, and LARK_BASE_BACKUP_TABLE_ID.')
  }

  const options = parseArgs(process.argv.slice(2))
  const db = getPool()
  if (!db) {
    throw new Error('DATABASE_URL is not configured.')
  }

  const connectionSummary = buildConnectionSummary(process.env.DATABASE_URL)
  console.log('[lark-backfill] Database:', `${connectionSummary.host}:${connectionSummary.port}/${connectionSummary.database}`)
  console.log('[lark-backfill] Identity:', status.identity)

  const limitClause = options.limit > 0 ? `LIMIT ${options.limit}` : ''
  const whereClause = options.all ? '' : 'WHERE lark_backup_record_id IS NULL'
  const result = await db.query(`
    SELECT id
    FROM video_usage_logs
    ${whereClause}
    ORDER BY created_at ASC, id ASC
    ${limitClause}
  `)

  const ids = result.rows.map((row) => row.id)
  console.log('[lark-backfill] Rows selected:', ids.length)

  if (ids.length === 0) {
    return
  }

  await syncUsageLogBackupByIds(ids, { throwOnError: true })
  console.log('[lark-backfill] Completed.')
}

main()
  .catch((error) => {
    console.error('[lark-backfill] Failed:', error.message)
    process.exitCode = 1
  })
  .finally(async () => {
    await closePool().catch(() => {})
  })
