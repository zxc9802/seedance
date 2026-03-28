import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { closePool, createPool, getTableColumns, loadProjectEnv, quoteIdentifier } from './db-common.mjs'

const UPSERT_CONFIG = {
  video_usage_logs: {
    conflictTarget: ['id'],
    immutableColumns: ['id'],
  },
  model_pricing: {
    conflictTarget: ['channel', 'model'],
    immutableColumns: ['id', 'channel', 'model'],
  },
}

function parseArgs(argv) {
  const args = {
    backupPath: '',
    appendOnly: false,
  }

  for (const arg of argv) {
    if (!arg) continue
    if (arg === '--append-only') {
      args.appendOnly = true
      continue
    }
    if (!args.backupPath) {
      args.backupPath = arg
    }
  }

  return args
}

async function main() {
  const { backupPath: backupPathArg, appendOnly } = parseArgs(process.argv.slice(2))
  if (!backupPathArg) {
    throw new Error('Usage: npm run db:restore -- <backup-file> [--append-only]')
  }

  await loadProjectEnv()
  const { initDatabase } = await import('../db/postgres.js')
  await initDatabase()

  const filePath = path.resolve(process.cwd(), backupPathArg)
  const raw = await fs.readFile(filePath, 'utf8')
  const backup = JSON.parse(raw)

  const db = createPool()

  try {
    await db.query('BEGIN')

    for (const [tableName, tableDump] of Object.entries(backup.tables || {})) {
      const upsertConfig = UPSERT_CONFIG[tableName]
      if (!upsertConfig) {
        console.warn(`Skipping unsupported table: ${tableName}`)
        continue
      }

      const targetColumns = await getTableColumns(db, tableName)
      const columns = (tableDump.columns || []).filter((column) => targetColumns.includes(column))
      if (!columns.length) {
        console.warn(`Skipping table without matching columns: ${tableName}`)
        continue
      }

      const insertColumns = columns.map(quoteIdentifier).join(', ')
      const conflictTarget = upsertConfig.conflictTarget.map(quoteIdentifier).join(', ')
      const updateColumns = columns.filter((column) => !upsertConfig.immutableColumns.includes(column))
      let insertedCount = 0
      let skippedCount = 0

      for (const row of tableDump.rows || []) {
        const values = columns.map((column) => row[column] ?? null)
        const placeholders = values.map((_, index) => `$${index + 1}`).join(', ')

        let sql = `INSERT INTO ${quoteIdentifier(tableName)} (${insertColumns}) VALUES (${placeholders})`

        if (appendOnly || !updateColumns.length) {
          sql += ` ON CONFLICT (${conflictTarget}) DO NOTHING`
        } else if (updateColumns.length) {
          const updates = updateColumns
            .map((column) => `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`)
            .join(', ')
          sql += ` ON CONFLICT (${conflictTarget}) DO UPDATE SET ${updates}`
        }

        const result = await db.query(sql, values)
        if (appendOnly) {
          if (result.rowCount > 0) {
            insertedCount += result.rowCount
          } else {
            skippedCount += 1
          }
        } else {
          insertedCount += result.rowCount
        }
      }

      if (appendOnly) {
        console.log(`Restored ${insertedCount} rows into ${tableName}, skipped ${skippedCount} existing rows`)
      } else {
        console.log(`Restored ${tableDump.rows?.length || 0} rows into ${tableName}`)
      }
    }

    await db.query('COMMIT')
    console.log(`Restore completed from: ${filePath}${appendOnly ? ' (append-only mode)' : ''}`)
  } catch (error) {
    await db.query('ROLLBACK')
    throw error
  } finally {
    await closePool(db)
  }
}

main().catch((error) => {
  console.error(error.message || error)
  process.exitCode = 1
})
