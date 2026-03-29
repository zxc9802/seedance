import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { getPool } from '../db/postgres.js'

const DEFAULT_TIMEOUT_MS = 20000
const MAX_ERROR_LENGTH = 1000
const MAX_TEXT_LENGTH = 50000
const MAX_JSON_LENGTH = 50000
const LARK_CONFIG_BRAND = 'feishu'

const CHANNEL_LABELS = Object.freeze({
  aggregation: '国达丰',
  veo_fast: '周总',
  image: '周总',
  yunwu: 'yunwu',
})

const STATUS_LABELS = Object.freeze({
  submitted: '已提交',
  processing: '处理中',
  succeeded: '成功',
  failed: '失败',
  pending: '待处理',
  queued: '排队中',
  running: '处理中',
  cancelled: '已取消',
})

let cliReadyPromise = null
let backupQueue = Promise.resolve()

function readBooleanEnv(value, fallbackValue = false) {
  if (value == null || value === '') return fallbackValue
  const normalized = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallbackValue
}

function getBackupConfig() {
  const baseToken = process.env.LARK_BASE_BACKUP_BASE_TOKEN?.trim() || ''
  const tableId = process.env.LARK_BASE_BACKUP_TABLE_ID?.trim() || ''
  return {
    baseToken,
    tableId,
    enabled: readBooleanEnv(
      process.env.LARK_BASE_BACKUP_ENABLED,
      Boolean(baseToken && tableId),
    ),
    as: process.env.LARK_BASE_BACKUP_AS?.trim() || 'bot',
    appId: process.env.LARK_CLI_APP_ID?.trim() || '',
    appSecret: process.env.LARK_CLI_APP_SECRET?.trim() || '',
    brand: process.env.LARK_CLI_BRAND?.trim() || LARK_CONFIG_BRAND,
    timeoutMs: Math.max(5000, Number(process.env.LARK_BASE_BACKUP_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS),
    timeZone: process.env.LARK_BASE_BACKUP_TIMEZONE?.trim() || 'Asia/Shanghai',
  }
}

function resolveCliInvocation() {
  const explicit = process.env.LARK_CLI_BIN?.trim()
  if (explicit) {
    return {
      command: explicit,
      prefixArgs: [],
    }
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
    return {
      command: process.execPath,
      prefixArgs: [localScript],
    }
  }

  const localBinary = path.join(
    process.cwd(),
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'lark-cli.cmd' : 'lark-cli',
  )
  if (fs.existsSync(localBinary)) {
    return {
      command: localBinary,
      prefixArgs: [],
    }
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
  if (!jsonText) {
    return null
  }

  try {
    return JSON.parse(jsonText)
  } catch {
    return null
  }
}

async function runLarkCli(args, options = {}) {
  const invocation = resolveCliInvocation()
  const result = await spawnCommand(invocation.command, [...invocation.prefixArgs, ...args], {
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    input: options.input,
  })

  const parsed = parseCliJsonOutput(result.stdout, result.stderr)
  if (result.code !== 0) {
    const errorMessage = parsed?.error?.message
      || result.stderr.trim()
      || result.stdout.trim()
      || `lark-cli exited with code ${result.code}`
    const error = new Error(errorMessage)
    error.code = parsed?.error?.code || result.code
    error.stdout = result.stdout
    error.stderr = result.stderr
    throw error
  }

  if (parsed?.ok === false) {
    const error = new Error(parsed?.error?.message || 'lark-cli returned an error response.')
    error.code = parsed?.error?.code || 'LARK_CLI_ERROR'
    error.payload = parsed
    throw error
  }

  return parsed || { ok: true, identity: null, data: null, stdout: result.stdout }
}

async function ensureLarkCliReady(config) {
  if (cliReadyPromise) return cliReadyPromise

  cliReadyPromise = (async () => {
    let currentConfig = null

    try {
      currentConfig = await runLarkCli(['config', 'show'], { timeoutMs: config.timeoutMs })
    } catch (error) {
      currentConfig = null
      if (!config.appId || !config.appSecret) {
        throw new Error(
          'Lark CLI is not configured. Set LARK_CLI_APP_ID and LARK_CLI_APP_SECRET for server-side sync.',
        )
      }
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
        {
          timeoutMs: config.timeoutMs,
          input: `${config.appSecret}\n`,
        },
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

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function normalizeText(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''

  const escapedMatch = trimmed.match(/\\"text\\":\\"([^"]*)\\"/)
  if (escapedMatch?.[1]) {
    return escapedMatch[1]
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .trim()
  }

  const directMatch = trimmed.match(/"text":"([^"]*)"/)
  if (directMatch?.[1]) {
    return directMatch[1].trim()
  }

  return trimmed
}

function extractPromptFromContent(content) {
  if (typeof content === 'string') {
    return content.trim()
  }

  if (!Array.isArray(content)) {
    return ''
  }

  return content
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join('\n')
}

function normalizeMediaCounts(counts) {
  return {
    images: Math.max(0, Number(counts?.images) || 0),
    videos: Math.max(0, Number(counts?.videos) || 0),
    audios: Math.max(0, Number(counts?.audios) || 0),
  }
}

function normalizeMediaSummary(summary) {
  if (!summary || typeof summary !== 'object') {
    return null
  }

  return {
    images: {
      count: Math.max(0, Number(summary?.images?.count) || 0),
      bytes: Math.max(0, Number(summary?.images?.bytes) || 0),
    },
    videos: {
      count: Math.max(0, Number(summary?.videos?.count) || 0),
      bytes: Math.max(0, Number(summary?.videos?.bytes) || 0),
    },
    audios: {
      count: Math.max(0, Number(summary?.audios?.count) || 0),
      bytes: Math.max(0, Number(summary?.audios?.bytes) || 0),
    },
  }
}

function extractMediaCounts(log) {
  const requestParams = log?.request_params || {}
  const mediaSummary = normalizeMediaSummary(requestParams.mediaSummary)
  if (mediaSummary) {
    return {
      images: mediaSummary.images.count,
      videos: mediaSummary.videos.count,
      audios: mediaSummary.audios.count,
    }
  }

  if (requestParams.mediaCounts || requestParams.referenceCounts) {
    return normalizeMediaCounts(requestParams.mediaCounts || requestParams.referenceCounts)
  }

  if (requestParams.payload) {
    return {
      images: asArray(requestParams.payload.resources).length,
      videos: asArray(requestParams.payload.referVideoUrl).length,
      audios: asArray(requestParams.payload.referAudioUrl).length,
    }
  }

  if (requestParams.references) {
    return {
      images: asArray(requestParams.references.images).length,
      videos: asArray(requestParams.references.videos).length,
      audios: asArray(requestParams.references.audios).length,
    }
  }

  const firstInstance = asArray(requestParams.instances)[0]
  if (firstInstance) {
    return {
      images: [
        firstInstance.image,
        firstInstance.lastFrame,
        ...asArray(firstInstance.referenceImages).map((item) => item?.image),
      ].filter(Boolean).length,
      videos: 0,
      audios: 0,
    }
  }

  const content = asArray(requestParams.messages).at(-1)?.content
  if (Array.isArray(content)) {
    return {
      images: content.filter((item) => item?.type === 'image_base64' || item?.type === 'image_url').length,
      videos: 0,
      audios: 0,
    }
  }

  return { images: 0, videos: 0, audios: 0 }
}

function extractMediaSizes(log) {
  const requestParams = log?.request_params || {}
  const mediaSummary = normalizeMediaSummary(requestParams.mediaSummary)
  if (mediaSummary) {
    return {
      images: mediaSummary.images.bytes,
      videos: mediaSummary.videos.bytes,
      audios: mediaSummary.audios.bytes,
    }
  }

  return { images: 0, videos: 0, audios: 0 }
}

function enrichUsageLog(log) {
  const requestParams = log?.request_params || {}
  const promptText = normalizeText(requestParams.rawPrompt)
    || normalizeText(requestParams.prompt)
    || normalizeText(log?.prompt)
    || extractPromptFromContent(asArray(requestParams.messages).at(-1)?.content)

  const mediaCounts = extractMediaCounts(log)
  const mediaSizes = extractMediaSizes(log)

  return {
    ...log,
    promptText,
    imageCount: mediaCounts.images,
    videoCount: mediaCounts.videos,
    audioCount: mediaCounts.audios,
    imageBytes: mediaSizes.images,
    videoBytes: mediaSizes.videos,
    audioBytes: mediaSizes.audios,
  }
}

function truncateText(value, limit = MAX_TEXT_LENGTH) {
  if (value == null) return null
  const text = String(value)
  if (!text) return null
  return text.length > limit ? text.slice(0, limit) : text
}

function formatChannelLabel(channel) {
  return CHANNEL_LABELS[channel] || channel || null
}

function formatStatusLabel(status) {
  return STATUS_LABELS[status] || status || null
}

function formatDateTime(value, timeZone) {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return null

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })

  const parts = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  )

  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
}

function safeNumber(value) {
  if (value == null || value === '') return null
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function safeJson(value) {
  if (!value) return null
  try {
    const text = JSON.stringify(value)
    return text.length > MAX_JSON_LENGTH ? text.slice(0, MAX_JSON_LENGTH) : text
  } catch {
    return null
  }
}

function buildRecordPayload(log, config) {
  const entry = enrichUsageLog(log)

  return {
    日志ID: entry.id,
    创建时间: formatDateTime(entry.created_at, config.timeZone),
    完成时间: formatDateTime(entry.completed_at, config.timeZone),
    用户ID: truncateText(entry.user_id),
    用户邮箱: truncateText(entry.user_email),
    用户昵称: truncateText(entry.user_nickname),
    用户分组: truncateText(entry.user_group),
    通道: formatChannelLabel(entry.channel),
    模型: truncateText(entry.model),
    模式: truncateText(entry.generation_mode),
    提示词: truncateText(entry.promptText),
    图片数量: safeNumber(entry.imageCount) ?? 0,
    图片大小Byte: safeNumber(entry.imageBytes) ?? 0,
    视频数量: safeNumber(entry.videoCount) ?? 0,
    视频大小Byte: safeNumber(entry.videoBytes) ?? 0,
    音频数量: safeNumber(entry.audioCount) ?? 0,
    音频大小Byte: safeNumber(entry.audioBytes) ?? 0,
    状态: formatStatusLabel(entry.status),
    EngineTaskID: truncateText(entry.engine_task_id),
    上游请求ID: truncateText(entry.upstream_request_id),
    上游TraceID: truncateText(entry.upstream_trace_id),
    上游URL: truncateText(entry.upstream_url),
    视频结果URL: truncateText(entry.video_url),
    费用: safeNumber(entry.estimated_cost),
    错误信息: truncateText(entry.error_message),
    请求参数JSON: safeJson(entry.request_params),
  }
}

function isRetryableLarkError(error) {
  const message = `${error?.message || ''} ${error?.stderr || ''} ${error?.stdout || ''}`
  return (
    String(error?.code || '') === '800004135'
    || String(error?.code || '') === '429'
    || message.includes('800004135')
    || /retry[_\s-]?after/i.test(message)
    || /rate limit/i.test(message)
  )
}

function trimErrorMessage(error) {
  const message = String(error?.message || error || '').trim()
  if (!message) return 'Unknown Lark backup error'
  return message.length > MAX_ERROR_LENGTH ? message.slice(0, MAX_ERROR_LENGTH) : message
}

async function markSyncSuccess(db, logId, recordId) {
  await db.query(
    `
      UPDATE video_usage_logs
      SET lark_backup_record_id = $1,
          lark_backup_synced_at = NOW(),
          lark_backup_error = NULL
      WHERE id = $2::uuid
    `,
    [recordId, logId],
  )
}

async function markSyncFailure(db, logId, error) {
  await db.query(
    `
      UPDATE video_usage_logs
      SET lark_backup_error = $1
      WHERE id = $2::uuid
    `,
    [trimErrorMessage(error), logId],
  )
}

async function loadUsageLogById(db, logId) {
  const result = await db.query(
    `
      SELECT *
      FROM video_usage_logs
      WHERE id = $1::uuid
      LIMIT 1
    `,
    [logId],
  )
  return result.rows[0] || null
}

async function upsertRecord(config, row) {
  await ensureLarkCliReady(config)

  const payload = buildRecordPayload(row, config)
  const args = [
    'base',
    '+record-upsert',
    '--as',
    config.as,
    '--base-token',
    config.baseToken,
    '--table-id',
    config.tableId,
    '--json',
    JSON.stringify(payload),
  ]

  if (row.lark_backup_record_id) {
    args.push('--record-id', row.lark_backup_record_id)
  }

  let attempt = 0
  while (true) {
    attempt += 1
    try {
      const response = await runLarkCli(args, { timeoutMs: config.timeoutMs })
      const recordId = response?.data?.record?.record_id
        || response?.data?.record?.id
        || response?.data?.record?.recordId
        || response?.data?.record?.record_id_list?.[0]
        || row.lark_backup_record_id
      if (!recordId) {
        throw new Error('Lark backup succeeded but record id is missing in response.')
      }
      return {
        recordId,
        response,
      }
    } catch (error) {
      if (attempt >= 4 || !isRetryableLarkError(error)) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
    }
  }
}

async function performUsageLogBackupSync(logId) {
  const config = getBackupConfig()
  if (!config.enabled) return { skipped: true, reason: 'disabled' }
  if (!config.baseToken || !config.tableId) return { skipped: true, reason: 'missing-config' }

  const db = getPool()
  if (!db) return { skipped: true, reason: 'db-unavailable' }

  const row = await loadUsageLogById(db, logId)
  if (!row) return { skipped: true, reason: 'not-found' }

  try {
    const result = await upsertRecord(config, row)
    await markSyncSuccess(db, logId, result.recordId)
    return {
      skipped: false,
      recordId: result.recordId,
    }
  } catch (error) {
    await markSyncFailure(db, logId, error).catch(() => {})
    throw error
  }
}

function enqueueBackupWork(work) {
  const scheduled = backupQueue.then(work)
  backupQueue = scheduled.catch(() => {})
  return scheduled
}

export function scheduleUsageLogBackupSyncById(logId) {
  if (!logId) return Promise.resolve(null)
  return enqueueBackupWork(async () => {
    try {
      return await performUsageLogBackupSync(logId)
    } catch (error) {
      console.error(`[lark-backup] Failed to sync usage log ${logId}:`, error.message)
      return null
    }
  })
}

export async function syncUsageLogBackupByIds(logIds, options = {}) {
  const uniqueIds = [...new Set((Array.isArray(logIds) ? logIds : [logIds]).filter(Boolean))]
  const results = []

  for (const logId of uniqueIds) {
    results.push(await enqueueBackupWork(async () => {
      try {
        return await performUsageLogBackupSync(logId)
      } catch (error) {
        console.error(`[lark-backup] Failed to sync usage log ${logId}:`, error.message)
        if (options.throwOnError) {
          throw error
        }
        return null
      }
    }))
  }

  return results
}

export function getLarkUsageBackupStatus() {
  const config = getBackupConfig()
  return {
    enabled: config.enabled,
    baseTokenConfigured: Boolean(config.baseToken),
    tableIdConfigured: Boolean(config.tableId),
    identity: config.as,
    timeZone: config.timeZone,
  }
}
