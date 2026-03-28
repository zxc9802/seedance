import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const { Pool } = pg

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const BACKUP_TABLES = [
  { name: 'video_usage_logs', orderBy: '"created_at" ASC, "id" ASC' },
  { name: 'model_pricing', orderBy: '"channel" ASC, "model" ASC' },
]

export function resolveRepoPath(...parts) {
  return path.join(REPO_ROOT, ...parts)
}

export async function ensureDirectory(dirPath) {
  await fs.mkdir(dirPath, { recursive: true })
}

export async function loadProjectEnv() {
  await loadEnvFile(resolveRepoPath('.env'))
  await loadEnvFile(resolveRepoPath('.env.local'))
}

async function loadEnvFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const separatorIndex = trimmed.indexOf('=')
      if (separatorIndex < 0) continue

      const key = trimmed.slice(0, separatorIndex).trim()
      if (!key || process.env[key] !== undefined) continue

      let value = trimmed.slice(separatorIndex + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }

      process.env[key] = value
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error
    }
  }
}

export function getConnectionString() {
  const connectionString = process.env.DATABASE_URL || ''
  if (!connectionString) {
    throw new Error('DATABASE_URL is not configured in the current environment.')
  }
  return connectionString
}

export function createPool() {
  const connectionString = getConnectionString()

  return new Pool({
    connectionString,
    ssl: connectionString.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
    max: 2,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  })
}

export function buildConnectionSummary(connectionString) {
  const url = new URL(connectionString)
  return {
    protocol: url.protocol.replace(/:$/, ''),
    host: url.hostname,
    port: url.port || '5432',
    database: url.pathname.replace(/^\/+/, ''),
    username: url.username,
  }
}

export function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`
}

export function makeBackupFilename(prefix = 'db-backup') {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `${prefix}-${timestamp}.json`
}

export async function getTableColumns(db, tableName) {
  const result = await db.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `,
    [tableName]
  )

  return result.rows.map((row) => row.column_name)
}

export async function closePool(pool) {
  await pool.end()
}
