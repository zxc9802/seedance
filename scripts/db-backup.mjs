import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {
  BACKUP_TABLES,
  buildConnectionSummary,
  closePool,
  createPool,
  ensureDirectory,
  getConnectionString,
  getTableColumns,
  loadProjectEnv,
  makeBackupFilename,
  quoteIdentifier,
  resolveRepoPath,
} from './db-common.mjs'

async function main() {
  await loadProjectEnv()

  const outputArg = process.argv[2]
  const outputDir = outputArg
    ? path.resolve(process.cwd(), outputArg)
    : resolveRepoPath('backups')

  await ensureDirectory(outputDir)

  const connectionString = getConnectionString()
  const db = createPool()

  try {
    const dump = {
      version: 1,
      exportedAt: new Date().toISOString(),
      source: buildConnectionSummary(connectionString),
      tables: {},
    }

    for (const table of BACKUP_TABLES) {
      const columns = await getTableColumns(db, table.name)
      const selectColumns = columns.map(quoteIdentifier).join(', ')
      const rowsResult = await db.query(
        `SELECT ${selectColumns} FROM ${quoteIdentifier(table.name)} ORDER BY ${table.orderBy}`
      )

      dump.tables[table.name] = {
        columns,
        rowCount: rowsResult.rows.length,
        rows: rowsResult.rows,
      }
    }

    const filePath = path.join(outputDir, makeBackupFilename())
    await fs.writeFile(filePath, `${JSON.stringify(dump, null, 2)}\n`, 'utf8')

    console.log(`Backup written to: ${filePath}`)
    for (const [tableName, tableDump] of Object.entries(dump.tables)) {
      console.log(`${tableName}: ${tableDump.rowCount} rows`)
    }
  } finally {
    await closePool(db)
  }
}

main().catch((error) => {
  console.error(error.message || error)
  process.exitCode = 1
})
