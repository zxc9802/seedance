import path from 'node:path'
import process from 'node:process'
import XLSX from 'xlsx'
import {
  buildConnectionSummary,
  closePool,
  createPool,
  loadProjectEnv,
} from './db-common.mjs'

const UPSERT_BATCH_SIZE = 25
const MAX_BATCH_ATTEMPTS = 3

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
    filePath: '',
    dryRun: false,
  }

  for (const arg of argv) {
    if (!arg) continue
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (!options.filePath) {
      options.filePath = path.resolve(process.cwd(), arg)
    }
  }

  if (!options.filePath) {
    throw new Error('Usage: node scripts/import-usage-csv.mjs <csv-or-xlsx-file> [--dry-run]')
  }

  return options
}

function normalizeCellText(value) {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .trim()
}

function asFirstString(value) {
  if (Array.isArray(value)) {
    return asFirstString(value[0])
  }
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  return normalizeCellText(value)
}

function parseJsonValue(value) {
  const text = asFirstString(value)
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function parseNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }

  let text = asFirstString(value)
    .replace(/[,\s，]/g, '')
    .replace(/[¥￥$]/g, '')
    .replace(/元$/u, '')

  if (!text) return null
  if (/^\(.+\)$/.test(text)) {
    text = `-${text.slice(1, -1)}`
  }
  if (text.startsWith('+')) {
    text = text.slice(1)
  }

  const numeric = Number(text)
  return Number.isFinite(numeric) ? numeric : null
}

function parseInteger(value) {
  const numeric = parseNumber(value)
  if (numeric === null) return 0
  return Math.max(0, Math.round(numeric))
}

function parseAmount(value) {
  const numeric = parseNumber(value)
  return numeric === null ? null : Number(numeric.toFixed(4))
}

function parseShanghaiDateTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const excelEpochMs = Date.UTC(1899, 11, 30)
    const date = new Date(excelEpochMs + Math.round(value * 24 * 60 * 60 * 1000))
    const pad = (part) => String(part).padStart(2, '0')
    return new Date(
      `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
      + `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}+08:00`
    ).toISOString()
  }

  const text = asFirstString(value)
  if (!text) return null

  const normalized = text.replace(/\//g, '-').replace('T', ' ')
  const match = normalized.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/
  )
  if (!match) return null

  const [, year, month, day, hour = '00', minute = '00', second = '00'] = match
  const pad = (part) => String(part).padStart(2, '0')
  const date = new Date(`${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}+08:00`)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
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

function deriveExtraColumns(requestParams) {
  const payloadParams = requestParams?.payload?.params || {}
  const requestedParams = requestParams?.requestedParams || {}

  return {
    aspectRatio: payloadParams.scale || requestedParams.aspectRatio || null,
    resolution: payloadParams.resolution || requestedParams.resolution || null,
    duration: parseInteger(payloadParams.duration ?? requestedParams.duration) || null,
    sampleCount: parseInteger(requestedParams.sampleCount) || 1,
  }
}

function buildMediaSummary(record) {
  return {
    images: {
      count: parseInteger(record.图片数量),
      bytes: parseInteger(record.图片大小Byte),
    },
    videos: {
      count: parseInteger(record.视频数量),
      bytes: parseInteger(record.视频大小Byte),
    },
    audios: {
      count: parseInteger(record.音频数量),
      bytes: parseInteger(record.音频大小Byte),
    },
  }
}

function hasMediaSummaryValue(mediaSummary) {
  return ['images', 'videos', 'audios'].some((type) => {
    const item = mediaSummary[type]
    return item.count > 0 || item.bytes > 0
  })
}

function buildRequestParams(record) {
  const parsed = parseJsonValue(record['请求参数JSON'])
  const base = parsed && typeof parsed === 'object' ? parsed : {}
  const mediaSummary = buildMediaSummary(record)

  if (!hasMediaSummaryValue(mediaSummary)) {
    return Object.keys(base).length > 0 ? base : null
  }

  return {
    ...base,
    mediaSummary,
  }
}

function buildUsageRow(record) {
  const logId = asFirstString(record.日志ID)
  if (!logId) return null

  const requestParams = buildRequestParams(record)
  const extra = deriveExtraColumns(requestParams)
  const { channel, providerId } = deriveChannelAndProvider(record.通道, record.模式, record.模型)
  const createdAt = parseShanghaiDateTime(record.创建时间)
  const completedAt = parseShanghaiDateTime(record.完成时间)
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
    estimated_cost: parseAmount(record.费用),
    created_at: createdAt,
    updated_at: updatedAt,
    completed_at: completedAt,
  }
}

function readUsageRows(filePath) {
  const workbook = XLSX.readFile(filePath, {
    raw: true,
  })
  const firstSheetName = workbook.SheetNames?.[0]
  if (!firstSheetName) {
    throw new Error('File does not contain any readable sheets.')
  }

  const worksheet = workbook.Sheets[firstSheetName]
  const records = XLSX.utils.sheet_to_json(worksheet, {
    defval: '',
    raw: true,
    blankrows: false,
  })

  return {
    sheetName: firstSheetName,
    records,
    rows: records.map(buildUsageRow).filter(Boolean),
  }
}

function buildBatchUpsert(rows) {
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

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function isRetryableDbError(error) {
  const message = String(error?.message || error || '')
  return (
    /connection terminated/i.test(message)
    || /timeout/i.test(message)
    || /ECONNRESET/i.test(message)
    || /ETIMEDOUT/i.test(message)
    || /Connection ended unexpectedly/i.test(message)
  )
}

async function runBatch(pool, sql, values, batchNumber) {
  for (let attempt = 1; attempt <= MAX_BATCH_ATTEMPTS; attempt += 1) {
    let client = null

    try {
      client = await pool.connect()
      await client.query('BEGIN')
      await client.query(`SET LOCAL statement_timeout = '30s'`)
      const result = await client.query(sql, values)
      await client.query('COMMIT')
      client.release()
      return result.rowCount
    } catch (error) {
      if (client) {
        await client.query('ROLLBACK').catch(() => {})
        client.release(error)
      }

      if (attempt < MAX_BATCH_ATTEMPTS && isRetryableDbError(error)) {
        const delayMs = attempt * 3000
        console.warn(
          `[usage-csv-import] Batch ${batchNumber} failed on attempt ${attempt}; retrying in ${delayMs / 1000}s: ${error.message}`
        )
        await sleep(delayMs)
        continue
      }

      throw error
    }
  }

  throw new Error(`Batch ${batchNumber} failed after ${MAX_BATCH_ATTEMPTS} attempts`)
}

async function upsertUsageRows(db, rows) {
  let affected = 0

  for (let index = 0; index < rows.length; index += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(index, index + UPSERT_BATCH_SIZE)
    const { sql, values } = buildBatchUpsert(batch)
    const batchNumber = Math.floor(index / UPSERT_BATCH_SIZE) + 1
    affected += await runBatch(db, sql, values, batchNumber)

    console.log(`[usage-csv-import] Upserted ${Math.min(index + batch.length, rows.length)}/${rows.length}`)
  }

  return affected
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  await loadProjectEnv()

  const { records, rows, sheetName } = readUsageRows(options.filePath)
  const invalidRows = records.length - rows.length
  const uniqueIds = new Set(rows.map((row) => row.id))
  if (uniqueIds.size !== rows.length) {
    throw new Error(`Input contains duplicate 日志ID values: ${rows.length - uniqueIds.size}`)
  }
  const missingCreatedAt = rows.filter((row) => !row.created_at)
  if (missingCreatedAt.length > 0) {
    throw new Error(
      `Input contains ${missingCreatedAt.length} rows with invalid 创建时间. Sample 日志ID: ${
        missingCreatedAt.slice(0, 5).map((row) => row.id).join(', ')
      }`
    )
  }

  const db = createPool()
  try {
    const connectionSummary = buildConnectionSummary(process.env.DATABASE_URL)
    console.log('[usage-csv-import] Database:', `${connectionSummary.host}:${connectionSummary.port}/${connectionSummary.database}`)
    console.log('[usage-csv-import] File    :', options.filePath)
    console.log('[usage-csv-import] Sheet   :', sheetName)
    console.log('[usage-csv-import] Parsed  :', rows.length)
    console.log('[usage-csv-import] Invalid :', invalidRows)

    if (options.dryRun) {
      console.log('[usage-csv-import] Dry run completed; no rows written.')
      return
    }

    const affected = await upsertUsageRows(db, rows)

    const totalResult = await db.query('SELECT COUNT(*)::int AS total FROM video_usage_logs')
    console.log('[usage-csv-import] Affected:', affected)
    console.log('[usage-csv-import] Database total:', totalResult.rows[0]?.total ?? 0)
    console.log('[usage-csv-import] Completed.')
  } catch (error) {
    throw error
  } finally {
    await closePool(db)
  }
}

main().catch((error) => {
  console.error('[usage-csv-import] Failed:', error.message)
  process.exitCode = 1
})
