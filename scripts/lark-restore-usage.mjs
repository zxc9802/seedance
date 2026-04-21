import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { initDatabase } from '../db/postgres.js'
import {
  buildConnectionSummary,
  closePool,
  createPool,
  loadProjectEnv,
} from './db-common.mjs'

const DEFAULT_PAGE_SIZE = 500
const DEFAULT_TIMEOUT_MS = 20000
const UPSERT_BATCH_SIZE = 100
const LARK_CONFIG_BRAND = 'feishu'

const STATUS_MAP = Object.freeze({
  已提交: 'submitted',
  处理中: 'processing',
  成功: 'succeeded',
  失败: 'failed',
  待处理: 'pending',
  排队中: 'queued',
  已取消: 'cancelled',
})

function parseArgs(argv) {
  const options = {
    limit: 0,
    pageSize: DEFAULT_PAGE_SIZE,
  }

  for (const arg of argv) {
    if (arg.startsWith('--limit=')) {
      options.limit = Math.max(0, Number(arg.slice('--limit='.length)) || 0)
      continue
    }
    if (arg.startsWith('--page-size=')) {
      options.pageSize = Math.max(1, Number(arg.slice('--page-size='.length)) || DEFAULT_PAGE_SIZE)
    }
  }

  return options
}

function getBackupConfig() {
  const baseToken = process.env.LARK_BASE_BACKUP_BASE_TOKEN?.trim() || ''
  const tableId = process.env.LARK_BASE_BACKUP_TABLE_ID?.trim() || ''
  return {
    baseToken,
    tableId,
    as: process.env.LARK_BASE_BACKUP_AS?.trim() || 'bot',
    appId: process.env.LARK_CLI_APP_ID?.trim() || '',
    appSecret: process.env.LARK_CLI_APP_SECRET?.trim() || '',
    brand: process.env.LARK_CLI_BRAND?.trim() || LARK_CONFIG_BRAND,
    timeoutMs: Math.max(5000, Number(process.env.LARK_BASE_BACKUP_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS),
  }
}

function resolveCliInvocation() {
  const explicit = process.env.LARK_CLI_BIN?.trim()
  if (explicit) {
    return { command: explicit, prefixArgs: [] }
  }

  const localScript = path.join(
    process.cwd(),
    'node_modules',
    '@larksuite',
    'cli',
    'scripts',
    'run.js',
  )
  if (fs.existsSync(localScript)) {
    return { command: process.execPath, prefixArgs: [localScript] }
  }

  const localBinary = path.join(
    process.cwd(),
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'lark-cli.cmd' : 'lark-cli',
  )
  if (fs.existsSync(localBinary)) {
    return { command: localBinary, prefixArgs: [] }
  }

  return {
    command: process.platform === 'win32' ? 'lark-cli.cmd' : 'lark-cli',
    prefixArgs: [],
  }
}

function spawnCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: process.env,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
      stdio: 'pipe',
      windowsHide: true,
    })

    const stdoutChunks = []
    const stderrChunks = []
    let settled = false
    let timeoutId = null

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
    }

    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk))
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk))
    child.on('error', (error) => {
      cleanup()
      settled = true
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      cleanup()
      resolve({
        code: code ?? 0,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      })
    })

    if (options.input) {
      child.stdin.write(options.input)
    }
    child.stdin.end()

    timeoutId = setTimeout(() => {
      settled = true
      child.kill('SIGTERM')
      reject(new Error(`Command timed out after ${options.timeoutMs}ms: ${command} ${args.join(' ')}`))
    }, options.timeoutMs || DEFAULT_TIMEOUT_MS)
  })
}

function extractFirstJsonObject(text) {
  const source = String(text || '')
  const start = source.indexOf('{')
  if (start < 0) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < source.length; index += 1) {
    const char = source[index]

    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue

    if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return source.slice(start, index + 1)
      }
    }
  }

  return null
}

function parseCliJsonOutput(stdout, stderr) {
  const jsonText = extractFirstJsonObject(stdout) || extractFirstJsonObject(stderr)
  if (!jsonText) return null

  try {
    return JSON.parse(jsonText)
  } catch {
    return null
  }
}

async function runLarkCli(args, config, options = {}) {
  const invocation = resolveCliInvocation()
  const result = await spawnCommand(invocation.command, [...invocation.prefixArgs, ...args], {
    timeoutMs: options.timeoutMs || config.timeoutMs || DEFAULT_TIMEOUT_MS,
    input: options.input,
  })

  const parsed = parseCliJsonOutput(result.stdout, result.stderr)
  if (result.code !== 0) {
    throw new Error(
      parsed?.error?.message
        || result.stderr.trim()
        || result.stdout.trim()
        || `lark-cli exited with code ${result.code}`,
    )
  }

  if (parsed?.ok === false) {
    throw new Error(parsed?.error?.message || 'lark-cli returned an error response.')
  }

  return parsed || { ok: true, data: null }
}

let cliReadyPromise = null

async function ensureLarkCliReady(config) {
  if (cliReadyPromise) return cliReadyPromise

  cliReadyPromise = (async () => {
    let currentConfig = null

    try {
      currentConfig = await runLarkCli(['config', 'show'], config)
    } catch {
      currentConfig = null
    }

    const configuredAppId = currentConfig?.appId || currentConfig?.data?.appId || ''
    const configuredBrand = currentConfig?.brand || currentConfig?.data?.brand || ''
    const shouldInit = Boolean(
      config.appId
      && config.appSecret
      && (!configuredAppId || configuredAppId !== config.appId || (configuredBrand && configuredBrand !== config.brand)),
    )

    if (shouldInit) {
      await runLarkCli(
        ['config', 'init', '--app-id', config.appId, '--brand', config.brand, '--app-secret-stdin'],
        config,
        { input: `${config.appSecret}\n` },
      )
    }
  })()

  try {
    await cliReadyPromise
  } catch (error) {
    cliReadyPromise = null
    throw error
  }

  return cliReadyPromise
}

function asFirstString(value) {
  if (Array.isArray(value)) {
    return asFirstString(value[0])
  }
  if (typeof value !== 'string') return ''
  return value.trim()
}

function parseJsonValue(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

function parseNumber(value) {
  if (value == null || value === '') return null
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function parseLarkDateTime(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null

  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/)
  if (!match) return null

  const [, year, month, day, hour, minute, second] = match
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`).toISOString()
}

function normalizeStatus(value) {
  const text = asFirstString(value)
  return STATUS_MAP[text] || text || 'submitted'
}

function unwrapMarkdownLink(value) {
  const text = asFirstString(value)
  if (!text) return null

  const markdownMatch = text.match(/^\[[^\]]*]\((https?:\/\/[^)]+)\)$/)
  if (markdownMatch?.[1]) return markdownMatch[1]
  return text
}

function deriveChannelAndProvider(channelLabel, mode, model) {
  const normalizedLabel = asFirstString(channelLabel)
  const normalizedMode = asFirstString(mode).toLowerCase()
  const normalizedModel = asFirstString(model).toLowerCase()

  if (normalizedLabel === '国达丰') {
    if (normalizedMode === 'image') {
      return { channel: 'image', providerId: 'gemini-image-aggregation' }
    }
    return { channel: 'aggregation', providerId: null }
  }

  if (normalizedLabel === '周总') {
    if (normalizedMode === 'image' || normalizedModel.includes('image')) {
      return { channel: 'image', providerId: 'gemini-image' }
    }
    return { channel: 'veo_fast', providerId: null }
  }

  if (normalizedLabel === 'yunwu') {
    return { channel: 'yunwu', providerId: null }
  }

  if (normalizedLabel === '即梦' || normalizedLabel.toLowerCase() === 'dreamina') {
    return { channel: 'dreamina', providerId: null }
  }

  if (normalizedLabel.toLowerCase() === 'wan') {
    return { channel: 'wan', providerId: null }
  }

  return {
    channel: normalizedLabel || 'unknown',
    providerId: null,
  }
}

function pickRequestParams(record) {
  const parsed = parseJsonValue(record['请求参数JSON'])
  return parsed && typeof parsed === 'object' ? parsed : null
}

function deriveExtraColumns(requestParams) {
  const payloadParams = requestParams?.payload?.params || {}
  const requestedParams = requestParams?.requestedParams || {}

  return {
    aspectRatio: payloadParams.scale || requestedParams.aspectRatio || null,
    resolution: payloadParams.resolution || requestedParams.resolution || null,
    duration: parseNumber(payloadParams.duration ?? requestedParams.duration),
    sampleCount: parseNumber(requestedParams.sampleCount) || 1,
  }
}

function mapRecord(fields, values, recordId) {
  return Object.fromEntries(
    fields.map((field, index) => [field, values[index] ?? null]).concat([['__record_id__', recordId]]),
  )
}

function buildUsageRow(record) {
  const logId = asFirstString(record.日志ID)
  if (!logId) return null

  const requestParams = pickRequestParams(record)
  const extra = deriveExtraColumns(requestParams)
  const { channel, providerId } = deriveChannelAndProvider(record.通道, record.模式, record.模型)
  const createdAt = parseLarkDateTime(record.创建时间)
  const completedAt = parseLarkDateTime(record.完成时间)
  const updatedAt = completedAt || createdAt || new Date().toISOString()

  return {
    id: logId,
    user_id: asFirstString(record.用户ID) || 'unknown',
    user_email: asFirstString(record.用户邮箱) || null,
    user_nickname: asFirstString(record.用户昵称) || null,
    user_group: asFirstString(record.用户分组) || null,
    channel,
    provider_id: providerId,
    model: asFirstString(record.模型) || null,
    generation_mode: asFirstString(record.模式) || null,
    prompt: asFirstString(record.提示词) || null,
    aspect_ratio: extra.aspectRatio,
    resolution: extra.resolution,
    duration: extra.duration,
    sample_count: extra.sampleCount,
    request_params: requestParams,
    engine_task_id: asFirstString(record.EngineTaskID) || null,
    upstream_request_id: asFirstString(record.上游请求ID) || null,
    upstream_trace_id: asFirstString(record.上游TraceID) || null,
    upstream_url: unwrapMarkdownLink(record.上游URL),
    status: normalizeStatus(record.状态),
    error_message: asFirstString(record.错误信息) || null,
    video_url: unwrapMarkdownLink(record.视频结果URL),
    unit_price: null,
    estimated_cost: parseNumber(record.费用),
    created_at: createdAt,
    updated_at: updatedAt,
    completed_at: completedAt,
    lark_backup_record_id: asFirstString(record.__record_id__) || null,
    lark_backup_synced_at: new Date().toISOString(),
    lark_backup_error: null,
  }
}

async function fetchAllRecords(config, options) {
  await ensureLarkCliReady(config)

  const allRecords = []
  let offset = 0
  let page = 0

  while (true) {
    const limit = options.limit > 0
      ? Math.min(options.pageSize, options.limit - allRecords.length)
      : options.pageSize

    if (limit <= 0) break

    const response = await runLarkCli([
      'base',
      '+record-list',
      '--as',
      config.as,
      '--base-token',
      config.baseToken,
      '--table-id',
      config.tableId,
      '--limit',
      String(limit),
      '--offset',
      String(offset),
    ], config)

    const payload = response?.data || {}
    const fields = Array.isArray(payload.fields) ? payload.fields : []
    const rows = Array.isArray(payload.data) ? payload.data : []
    const recordIds = Array.isArray(payload.record_id_list) ? payload.record_id_list : []

    page += 1
    console.log(`[lark-restore] Fetched page ${page}: ${rows.length} rows`)

    if (rows.length === 0) break

    for (let index = 0; index < rows.length; index += 1) {
      allRecords.push(mapRecord(fields, rows[index], recordIds[index] || null))
    }

    offset += rows.length

    if (!payload.has_more) break
    if (options.limit > 0 && allRecords.length >= options.limit) break
  }

  return allRecords
}

function buildBatchInsert(rows) {
  const columns = [
    'id',
    'user_id',
    'user_email',
    'user_nickname',
    'user_group',
    'channel',
    'provider_id',
    'model',
    'generation_mode',
    'prompt',
    'aspect_ratio',
    'resolution',
    'duration',
    'sample_count',
    'request_params',
    'engine_task_id',
    'upstream_request_id',
    'upstream_trace_id',
    'upstream_url',
    'status',
    'error_message',
    'video_url',
    'unit_price',
    'estimated_cost',
    'created_at',
    'updated_at',
    'completed_at',
    'lark_backup_record_id',
    'lark_backup_synced_at',
    'lark_backup_error',
  ]

  const values = []
  const groups = rows.map((row, rowIndex) => {
    const placeholders = columns.map((column, columnIndex) => {
      const value = row[column]
      values.push(column === 'request_params' && value ? JSON.stringify(value) : value)
      return `$${rowIndex * columns.length + columnIndex + 1}`
    })
    return `(${placeholders.join(', ')})`
  })

  const updates = columns
    .filter((column) => column !== 'id')
    .map((column) => `${column} = EXCLUDED.${column}`)
    .join(', ')

  return {
    sql: `
      INSERT INTO video_usage_logs (${columns.join(', ')})
      VALUES ${groups.join(', ')}
      ON CONFLICT (id) DO UPDATE SET ${updates}
    `,
    values,
  }
}

async function upsertUsageRows(db, rows) {
  let affected = 0
  for (let index = 0; index < rows.length; index += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(index, index + UPSERT_BATCH_SIZE)
    const { sql, values } = buildBatchInsert(batch)
    const result = await db.query(sql, values)
    affected += result.rowCount
    console.log(`[lark-restore] Upserted ${Math.min(index + batch.length, rows.length)}/${rows.length}`)
  }
  return affected
}

async function main() {
  await loadProjectEnv()
  await initDatabase()

  const config = getBackupConfig()
  if (!config.baseToken || !config.tableId) {
    throw new Error('Lark restore is not configured. Set LARK_BASE_BACKUP_BASE_TOKEN and LARK_BASE_BACKUP_TABLE_ID.')
  }

  const options = parseArgs(process.argv.slice(2))
  const db = createPool()

  try {
    const connectionSummary = buildConnectionSummary(process.env.DATABASE_URL)
    console.log('[lark-restore] Database:', `${connectionSummary.host}:${connectionSummary.port}/${connectionSummary.database}`)

    const rawRecords = await fetchAllRecords(config, options)
    const rows = rawRecords
      .map(buildUsageRow)
      .filter(Boolean)

    console.log('[lark-restore] Rows fetched:', rawRecords.length)
    console.log('[lark-restore] Rows ready :', rows.length)

    await db.query('BEGIN')
    await upsertUsageRows(db, rows)
    await db.query('COMMIT')

    const totalResult = await db.query('SELECT COUNT(*)::int AS total FROM video_usage_logs')
    console.log('[lark-restore] Database total:', totalResult.rows[0]?.total ?? 0)
    console.log('[lark-restore] Completed.')
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    await closePool(db)
  }
}

main().catch((error) => {
  console.error('[lark-restore] Failed:', error.message)
  process.exitCode = 1
})
