import crypto from 'node:crypto'
import ExcelJS from 'exceljs'
import express from 'express'
import multer from 'multer'
import { getPool } from '../db/postgres.js'
import { convertCreditsToCny, getCreditBalanceAccountId, rechargeSiteCredits } from '../db/credits.js'
import { syncUsageLogBackupByIds } from '../integrations/larkBaseUsageBackup.js'
import { buildCostImportPreview, parseCostImportFile } from './costImport.js'
import creditHubRouter from './creditHub.js'
import { buildUsageChannelSql, formatUsageChannelLabel, resolveUsageChannel } from './usageChannel.js'

const router = express.Router()
const costImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter: (_, file, callback) => {
    if (/\.(xlsx|xls|csv)$/i.test(file?.originalname || '')) {
      callback(null, true)
      return
    }
    callback(new Error('仅支持上传 .xlsx / .xls / .csv 文件'))
  },
})
const COST_IMPORT_PREVIEW_TTL_MS = 30 * 60 * 1000
const COST_IMPORT_APPLY_BATCH_SIZE = 500
const costImportPreviewCache = new Map()

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

function normalizeCreditSpent(value) {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) return 0
  return Number(amount.toFixed(2))
}

function enhanceUsageLog(log) {
  const requestParams = log?.request_params || {}
  const promptText = normalizeText(requestParams.rawPrompt)
    || normalizeText(requestParams.prompt)
    || normalizeText(log?.prompt)
    || extractPromptFromContent(asArray(requestParams.messages).at(-1)?.content)

  const mediaCounts = extractMediaCounts(log)
  const mediaSizes = extractMediaSizes(log)
  const rawChannel = log?.channel || null
  const statsChannel = resolveUsageChannel(rawChannel, log?.provider_id, log?.upstream_url) || rawChannel
  const creditSpent = normalizeCreditSpent(log?.credit_spent)

  return {
    ...log,
    credit_spent: creditSpent,
    credit_cost: convertCreditsToCny(creditSpent),
    rawChannel,
    statsChannel,
    channel: statsChannel,
    promptText,
    imageCount: mediaCounts.images,
    videoCount: mediaCounts.videos,
    audioCount: mediaCounts.audios,
    imageBytes: mediaSizes.images,
    videoBytes: mediaSizes.videos,
    audioBytes: mediaSizes.audios,
  }
}

const STATUS_LABELS = Object.freeze({
  submitted: '\u5df2\u63d0\u4ea4',
  processing: '\u5904\u7406\u4e2d',
  succeeded: '\u6210\u529f',
  failed: '\u5931\u8d25',
  pending: '\u5f85\u5904\u7406',
  queued: '\u6392\u961f\u4e2d',
  running: '\u5904\u7406\u4e2d',
  needs_review: '\u5f85\u6838\u5bf9',
  cancelled: '\u5df2\u53d6\u6d88',
})

const EXCEL_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const ADMIN_DISPLAY_TIME_ZONE = 'Asia/Shanghai'
const EXCEL_BORDER = Object.freeze({
  top: { style: 'thin', color: { argb: 'FFD8E0EF' } },
  left: { style: 'thin', color: { argb: 'FFD8E0EF' } },
  bottom: { style: 'thin', color: { argb: 'FFD8E0EF' } },
  right: { style: 'thin', color: { argb: 'FFD8E0EF' } },
})
const TASK_EXPORT_COLUMNS = Object.freeze([
  { header: '\u65f6\u95f4', width: 22, align: 'center', value: (log) => formatExcelTimestamp(log.created_at) },
  { header: '\u7528\u6237', width: 16, value: (log) => log.user_nickname || log.user_email || log.user_id || '' },
  { header: '\u90ae\u7bb1', width: 28, value: (log) => log.user_email || '' },
  { header: '\u901a\u9053', width: 12, align: 'center', value: (log) => formatChannelLabel(log.channel, log.provider_id, log.upstream_url) },
  { header: '\u6a21\u578b', width: 28, value: (log) => log.model || '' },
  { header: '\u6a21\u5f0f', width: 12, align: 'center', value: (log) => log.generation_mode || '' },
  { header: '\u65f6\u957f(\u79d2)', width: 12, align: 'center', value: (log) => formatDurationLabel(log.duration) },
  { header: '\u751f\u6210\u6570\u91cf', width: 12, align: 'center', value: (log) => Math.max(1, Number(log.sample_count) || 1) },
  { header: '\u63d0\u793a\u8bcd', width: 56, value: (log) => log.promptText || '' },
  { header: '\u56fe\u7247(\u6570\u91cf/\u5927\u5c0f)', width: 18, align: 'center', value: (log) => formatMediaMetric(log.imageCount, log.imageBytes) },
  { header: '\u89c6\u9891(\u6570\u91cf/\u5927\u5c0f)', width: 18, align: 'center', value: (log) => formatMediaMetric(log.videoCount, log.videoBytes) },
  { header: '\u97f3\u9891(\u6570\u91cf/\u5927\u5c0f)', width: 18, align: 'center', value: (log) => formatMediaMetric(log.audioCount, log.audioBytes) },
  { header: '\u72b6\u6001', width: 12, align: 'center', value: (log) => formatStatusLabel(log.status) },
  { header: 'engine_task_id', width: 30, value: (log) => log.engine_task_id || '' },
  { header: 'upstream_url', width: 42, value: (log) => log.upstream_url || '' },
  { header: '\u6d88\u8017\u79ef\u5206', width: 14, align: 'right', type: 'credit', value: (log) => safeExcelAmount(log.credit_spent) },
  { header: '\u8d39\u7528', width: 14, align: 'right', type: 'amount', value: (log) => safeExcelAmount(log.credit_cost) },
])

const USAGE_CHANNEL_SQL = buildUsageChannelSql()
const CREDIT_USAGE_WHERE_SQL = `(provider_id = 'veo' OR provider_id = 'seedance1')`
const CREDIT_USAGE_SUMMARY_SQL = `
  SELECT usage_log_id, COALESCE(SUM(-amount), 0)::float AS credit_spent
  FROM user_credit_transactions
  WHERE type = 'consume' AND usage_log_id IS NOT NULL
  GROUP BY usage_log_id
`

function emptyCreditSiteSummary() {
  return {
    balance: 0,
    userCount: 0,
    generationCount: 0,
    outputCount: 0,
    generatedSeconds: 0,
    consumedCredits: 0,
  }
}

function formatChannelLabel(channel, providerId = null, upstreamUrl = null) {
  return formatUsageChannelLabel(channel, providerId, upstreamUrl)
}

function formatStatusLabel(status) {
  return STATUS_LABELS[status] || status || ''
}

function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0)
  if (!value) return ''
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${value} B`
}

function formatMediaMetric(count, bytes) {
  const safeCount = Math.max(0, Number(count) || 0)
  const sizeLabel = formatBytes(bytes)
  return sizeLabel ? `${safeCount} (${sizeLabel})` : String(safeCount)
}

function formatDurationLabel(value) {
  if (value === null || value === undefined || value === '') return ''
  const duration = Number(value)
  if (!Number.isFinite(duration)) return String(value)
  return `${duration}秒`
}

function formatExcelTimestamp(value) {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    return String(value)
  }
  return date.toLocaleString('zh-CN', {
    timeZone: ADMIN_DISPLAY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).replace(/\//g, '-')
}

function safeExcelAmount(value) {
  if (value === null || value === undefined || value === '') return null
  const amount = Number(value)
  return Number.isFinite(amount) ? Number(amount.toFixed(4)) : null
}

function excelColumnName(index) {
  let dividend = index
  let columnName = ''

  while (dividend > 0) {
    const modulo = (dividend - 1) % 26
    columnName = String.fromCharCode(65 + modulo) + columnName
    dividend = Math.floor((dividend - modulo) / 26)
  }

  return columnName
}

function measureDisplayWidth(value) {
  const text = String(value ?? '')
  let width = 0
  for (const char of text) {
    width += /[^\u0000-\u00ff]/.test(char) ? 2 : 1
  }
  return width
}

function estimateRowHeight(values, columns) {
  let maxLines = 1

  values.forEach((value, index) => {
    if (value === null || value === undefined || typeof value === 'number') return
    const text = String(value)
    if (!text) return

    const width = Math.max(8, Number(columns[index]?.width) || 12)
    const lines = text
      .split(/\r?\n/)
      .reduce((sum, line) => sum + Math.max(1, Math.ceil(measureDisplayWidth(line) / Math.max(6, width - 2))), 0)
    maxLines = Math.max(maxLines, lines)
  })

  return Math.min(180, Math.max(22, maxLines * 18))
}

async function buildUsageWorkbook(logs, sheetName) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'VEO Studio'
  workbook.created = new Date()

  const worksheet = workbook.addWorksheet(sheetName)
  worksheet.views = [{ state: 'frozen', ySplit: 1 }]
  worksheet.columns = TASK_EXPORT_COLUMNS.map((column) => ({
    header: column.header,
    key: column.header,
    width: column.width,
  }))

  const headerRow = worksheet.getRow(1)
  headerRow.height = 26

  TASK_EXPORT_COLUMNS.forEach((column, index) => {
    const cell = headerRow.getCell(index + 1)
    cell.value = column.header
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF2F5EA8' },
    }
    cell.alignment = {
      vertical: 'middle',
      horizontal: 'center',
      wrapText: true,
    }
    cell.border = EXCEL_BORDER
  })

  logs.forEach((log) => {
    const rowValues = TASK_EXPORT_COLUMNS.map((column) => column.value(log))
    const row = worksheet.addRow(rowValues)
    row.height = estimateRowHeight(rowValues, TASK_EXPORT_COLUMNS)

    TASK_EXPORT_COLUMNS.forEach((column, index) => {
      const cell = row.getCell(index + 1)
      cell.alignment = {
        vertical: 'top',
        horizontal: column.align || 'left',
        wrapText: true,
      }
      cell.border = EXCEL_BORDER

      if (column.type === 'amount') {
        cell.numFmt = '\u00a5#,##0.00'
      } else if (column.type === 'credit') {
        cell.numFmt = '#,##0.00'
      }
    })
  })

  const totalRow = worksheet.addRow(new Array(TASK_EXPORT_COLUMNS.length).fill(''))
  totalRow.height = 24
  totalRow.eachCell({ includeEmpty: true }, (cell) => {
    cell.border = EXCEL_BORDER
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFF5F7FB' },
    }
  })

  const creditColumnIndex = TASK_EXPORT_COLUMNS.findIndex((column) => column.type === 'credit') + 1
  const amountColumnIndex = TASK_EXPORT_COLUMNS.findIndex((column) => column.type === 'amount') + 1
  const labelCell = totalRow.getCell(Math.max(1, creditColumnIndex - 1))
  labelCell.value = '\u5408\u8ba1'
  labelCell.font = { bold: true }
  labelCell.alignment = { vertical: 'middle', horizontal: 'right' }

  if (creditColumnIndex > 0) {
    const creditCell = totalRow.getCell(creditColumnIndex)
    creditCell.value = {
      formula: `SUM(${excelColumnName(creditColumnIndex)}2:${excelColumnName(creditColumnIndex)}${Math.max(2, totalRow.number - 1)})`,
    }
    creditCell.numFmt = '#,##0.00'
    creditCell.font = { bold: true }
    creditCell.alignment = { vertical: 'middle', horizontal: 'right' }
  }

  if (amountColumnIndex > 0) {
    const amountCell = totalRow.getCell(amountColumnIndex)
    amountCell.value = {
      formula: `SUM(${excelColumnName(amountColumnIndex)}2:${excelColumnName(amountColumnIndex)}${Math.max(2, totalRow.number - 1)})`,
    }
    amountCell.numFmt = '\u00a5#,##0.00'
    amountCell.font = { bold: true }
    amountCell.alignment = { vertical: 'middle', horizontal: 'right' }
  }

  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, totalRow.number - 1), column: TASK_EXPORT_COLUMNS.length },
  }

  return workbook.xlsx.writeBuffer()
}

function createBadRequest(message) {
  const error = new Error(message)
  error.statusCode = 400
  return error
}

function getCostImportErrorStatus(error) {
  if (error?.statusCode) return error.statusCode
  if (error?.name === 'MulterError' || error?.code === 'LIMIT_FILE_SIZE') return 400
  if (typeof error?.code === 'string') return 500
  return 400
}

function normalizeImportChannel(value) {
  const channel = String(value ?? '').trim()
  if (!channel) {
    throw createBadRequest('请选择要导入的通道')
  }
  return channel
}

function cleanupExpiredCostImportPreviews() {
  const now = Date.now()
  for (const [token, entry] of costImportPreviewCache.entries()) {
    if (!entry || entry.expiresAt <= now) {
      costImportPreviewCache.delete(token)
    }
  }
}

function createCostImportPreviewToken(payload) {
  cleanupExpiredCostImportPreviews()
  const token = crypto.randomUUID()
  costImportPreviewCache.set(token, {
    ...payload,
    expiresAt: Date.now() + COST_IMPORT_PREVIEW_TTL_MS,
  })
  return token
}

function readCostImportPreviewToken(token) {
  cleanupExpiredCostImportPreviews()
  const entry = costImportPreviewCache.get(token)
  if (!entry) {
    throw createBadRequest('预检令牌不存在或已过期，请重新预检')
  }
  return entry
}

function deleteCostImportPreviewToken(token) {
  if (!token) return
  costImportPreviewCache.delete(token)
}

function runCostImportUpload(req, res) {
  return new Promise((resolve, reject) => {
    costImportUpload.single('file')(req, res, (error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

function queueCostImportBackupSync(logIds, meta = {}) {
  const uniqueIds = [...new Set((Array.isArray(logIds) ? logIds : [logIds]).filter(Boolean))]
  if (uniqueIds.length === 0) return

  setImmediate(() => {
    syncUsageLogBackupByIds(uniqueIds).catch((error) => {
      console.error('[cost-import] Lark backup sync failed:', {
        ...meta,
        count: uniqueIds.length,
        error: error.message,
      })
    })
  })
}

async function applyCostImportActions(client, actions) {
  const appliedTargetIds = new Set()

  for (let index = 0; index < actions.length; index += COST_IMPORT_APPLY_BATCH_SIZE) {
    const batch = actions.slice(index, index + COST_IMPORT_APPLY_BATCH_SIZE)
    const targetIds = batch.map((action) => action.targetId)
    const amounts = batch.map((action) => String(action.amount))

    const result = await client.query(
      `
        WITH input AS (
          SELECT *
          FROM unnest($1::uuid[], $2::numeric[]) AS item(target_id, amount)
        )
        UPDATE video_usage_logs AS logs
        SET estimated_cost = input.amount,
            updated_at = NOW()
        FROM input
        WHERE logs.id = input.target_id
        RETURNING logs.id
      `,
      [targetIds, amounts]
    )

    result.rows.forEach((row) => {
      if (row?.id) {
        appliedTargetIds.add(row.id)
      }
    })
  }

  return appliedTargetIds
}

function getAdminActor(req) {
  const user = req.videoSiteSession?.user || {}
  return (
    user.id
    || user.userId
    || user.account
    || user.email
    || user.nickname
    || user.name
    || 'admin'
  )
}

function buildCostImportResponse(preview, extra = {}) {
  return {
    channel: extra.channel,
    fileName: preview.fileName,
    sheetName: preview.sheetName,
    recognizedColumns: preview.recognizedColumns,
    summary: preview.summary,
    duplicateTaskIds: preview.duplicateTaskIds,
    detailRows: extra.detailRows ?? preview.detailRows,
    previewToken: extra.previewToken || null,
    ...extra.meta,
  }
}

function buildUsageLogWhereClause(query = {}) {
  const conditions = ['1=1']
  const params = []
  let paramIdx = 1
  const taskId = String(query.taskId ?? query.engineTaskId ?? '').trim()

  if (query.userId) {
    conditions.push(`user_id = $${paramIdx++}`)
    params.push(query.userId)
  }
  if (taskId) {
    conditions.push(`engine_task_id ILIKE $${paramIdx++}`)
    params.push(`%${taskId}%`)
  }
  if (query.channel) {
    conditions.push(`${USAGE_CHANNEL_SQL} = $${paramIdx++}`)
    params.push(query.channel)
  }
  if (query.model) {
    conditions.push(`model ILIKE $${paramIdx++}`)
    params.push(`%${query.model}%`)
  }
  if (query.status) {
    conditions.push(`status = $${paramIdx++}`)
    params.push(query.status)
  }
  if (query.dateFrom) {
    conditions.push(`created_at >= $${paramIdx++}`)
    params.push(query.dateFrom)
  }
  if (query.dateTo) {
    conditions.push(`created_at <= $${paramIdx++}`)
    params.push(query.dateTo)
  }

  return {
    where: conditions.join(' AND '),
    params,
  }
}

function parseUsageDayRange(value) {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (normalized === 'all') return null
  if (!normalized) return 30

  const parsed = Number(normalized)
  if (!Number.isFinite(parsed) || parsed === 0) return 30
  return Math.min(90, Math.max(1, parsed))
}

function buildUsageDayRangeFilter(days) {
  if (days === null) {
    return {
      whereClause: '',
      params: [],
    }
  }

  return {
    whereClause: 'WHERE created_at >= CURRENT_DATE - GREATEST($1::int - 1, 0)',
    params: [days],
  }
}

function appendUsageDateWindowClause(query, conditions, params, paramIdx, fallbackDays = null) {
  if (query.dateFrom) {
    conditions.push(`created_at >= $${paramIdx++}`)
    params.push(query.dateFrom)
  } else if (fallbackDays !== null && fallbackDays !== undefined) {
    conditions.push(`created_at >= CURRENT_DATE - GREATEST($${paramIdx++}::int - 1, 0)`)
    params.push(fallbackDays)
  }

  if (query.dateTo) {
    conditions.push(`created_at <= $${paramIdx++}`)
    params.push(query.dateTo)
  }

  return paramIdx
}

function parseRequestedUserIds(query = {}) {
  const values = []
  const pushValue = (value) => {
    if (typeof value !== 'string') return
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .forEach((item) => values.push(item))
  }

  pushValue(query.userId)
  pushValue(query.userIds)

  return [...new Set(values)]
}

router.use((req, res, next) => {
  const adminPassword = process.env.ADMIN_PASSWORD || ''
  if (!adminPassword) {
    res.status(503).json({ error: 'ADMIN_PASSWORD not configured' })
    return
  }
  const auth = req.headers.authorization || ''
  const token = req.query.token || ''
  if (auth === `Bearer ${adminPassword}` || token === adminPassword) {
    next()
    return
  }
  res.status(401).json({ error: 'Unauthorized' })
})

router.use('/credit-hub', creditHubRouter)

router.get('/overview', async (req, res) => {
  const db = getPool()
  if (!db) return res.json({})
  const days = parseUsageDayRange(req.query.days)
  const rangeFilter = buildUsageDayRangeFilter(days)

  try {
    const [totals, ranged, account] = await Promise.all([
      db.query(`
        SELECT
          COUNT(*)::int AS total_requests
        FROM video_usage_logs
      `),
      db.query(`
        WITH filtered_logs AS (
          SELECT *
          FROM video_usage_logs
          ${rangeFilter.whereClause}
        )
        SELECT
          COUNT(*)::int AS range_requests,
          COUNT(*) FILTER (WHERE logs.status = 'succeeded')::int AS succeeded,
          COUNT(*) FILTER (WHERE logs.status = 'failed')::int AS failed,
          COALESCE(SUM(credit_usage.credit_spent), 0)::float AS credit_consumed,
          COUNT(DISTINCT logs.user_id)::int AS active_users
        FROM filtered_logs logs
        LEFT JOIN (${CREDIT_USAGE_SUMMARY_SQL}) credit_usage ON credit_usage.usage_log_id = logs.id
      `, rangeFilter.params),
      db.query(
        `SELECT COALESCE(balance, 0)::float AS credit_balance
         FROM user_credit_accounts
         WHERE user_id = $1`,
        [getCreditBalanceAccountId()],
      ),
    ])

    const t = totals.rows[0]
    const r = ranged.rows[0]
    const creditConsumed = normalizeCreditSpent(r.credit_consumed)
    const creditCost = convertCreditsToCny(creditConsumed)
    res.json({
      totalRequests: t.total_requests,
      rangeRequests: r.range_requests,
      succeeded: r.succeeded,
      failed: r.failed,
      successRate: r.range_requests > 0 ? ((r.succeeded / r.range_requests) * 100).toFixed(1) : '0',
      creditBalance: Number(account.rows[0]?.credit_balance || 0),
      creditConsumed,
      creditCost,
      totalCost: creditCost,
      todayRequests: r.range_requests,
      activeUsers: r.active_users,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/trend', async (req, res) => {
  const db = getPool()
  if (!db) return res.json([])

  const days = parseUsageDayRange(req.query.days)
  const rangeFilter = buildUsageDayRangeFilter(days)

  try {
    const result = await db.query(`
      SELECT
        DATE(created_at) AS date,
        COUNT(*)::int AS requests,
        COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
        COALESCE(SUM(estimated_cost), 0)::float AS estimated_cost
      FROM video_usage_logs
      ${rangeFilter.whereClause}
      GROUP BY DATE(created_at)
      ORDER BY date
    `, rangeFilter.params)

    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/by-model', async (req, res) => {
  const db = getPool()
  if (!db) return res.json([])

  const days = parseUsageDayRange(req.query.days)
  const rangeFilter = buildUsageDayRangeFilter(days)

  try {
    const result = await db.query(`
      SELECT
        COALESCE(model, 'unknown') AS model,
        ${USAGE_CHANNEL_SQL} AS channel,
        COUNT(*)::int AS requests,
        COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
        COALESCE(SUM(estimated_cost), 0)::float AS estimated_cost
      FROM video_usage_logs
      ${rangeFilter.whereClause}
      GROUP BY model, ${USAGE_CHANNEL_SQL}
      ORDER BY requests DESC
    `, rangeFilter.params)

    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/by-user', async (req, res) => {
  const db = getPool()
  if (!db) return res.json([])

  const days = parseUsageDayRange(req.query.days)
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50))
  const conditions = ['1=1']
  const params = []
  let paramIdx = 1

  paramIdx = appendUsageDateWindowClause(req.query, conditions, params, paramIdx, days)
  const where = conditions.join(' AND ')

  try {
    const result = await db.query(`
      SELECT
        user_id,
        COALESCE(
          (array_agg(user_nickname ORDER BY created_at DESC) FILTER (WHERE user_nickname IS NOT NULL AND user_nickname <> ''))[1],
          (array_agg(user_email ORDER BY created_at DESC) FILTER (WHERE user_email IS NOT NULL AND user_email <> ''))[1],
          user_id
        ) AS user_name,
        (array_agg(user_email ORDER BY created_at DESC) FILTER (WHERE user_email IS NOT NULL AND user_email <> ''))[1] AS user_email,
        (array_agg(user_group ORDER BY created_at DESC) FILTER (WHERE user_group IS NOT NULL AND user_group <> ''))[1] AS user_group,
        COUNT(*)::int AS requests,
        COALESCE(SUM(GREATEST(COALESCE(sample_count, 1), 1)), 0)::int AS generated_count,
        COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
        COALESCE(SUM(estimated_cost), 0)::float AS estimated_cost,
        COALESCE(SUM(credit_usage.credit_spent), 0)::float AS credit_spent,
        (COALESCE(SUM(credit_usage.credit_spent), 0) / 5)::float AS credit_cost
      FROM video_usage_logs
      LEFT JOIN (${CREDIT_USAGE_SUMMARY_SQL}) credit_usage ON credit_usage.usage_log_id = video_usage_logs.id
      WHERE ${where}
      GROUP BY user_id
      ORDER BY requests DESC
      LIMIT $${paramIdx}
    `, [...params, limit])

    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/by-channel', async (req, res) => {
  const db = getPool()
  if (!db) return res.json([])

  const days = parseUsageDayRange(req.query.days)
  const rangeFilter = buildUsageDayRangeFilter(days)

  try {
    const result = await db.query(`
      SELECT
        ${USAGE_CHANNEL_SQL} AS channel,
        COUNT(*)::int AS requests,
        COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
        COALESCE(SUM(estimated_cost), 0)::float AS estimated_cost
      FROM video_usage_logs
      ${rangeFilter.whereClause}
      GROUP BY ${USAGE_CHANNEL_SQL}
      ORDER BY requests DESC
    `, rangeFilter.params)

    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/tasks', async (req, res) => {
  const db = getPool()
  if (!db) return res.json({ items: [], total: 0 })

  const page = Math.max(1, Number(req.query.page) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 50))
  const offset = (page - 1) * pageSize
  const { where, params } = buildUsageLogWhereClause(req.query)
  const limitParamIndex = params.length + 1
  const offsetParamIndex = params.length + 2

  try {
    const [countResult, dataResult] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS total FROM video_usage_logs WHERE ${where}`, params),
      db.query(
        `SELECT logs.*, COALESCE(credit_usage.credit_spent, 0)::float AS credit_spent
         FROM video_usage_logs logs
         LEFT JOIN (${CREDIT_USAGE_SUMMARY_SQL}) credit_usage ON credit_usage.usage_log_id = logs.id
         WHERE ${where}
         ORDER BY logs.created_at DESC
         LIMIT $${limitParamIndex} OFFSET $${offsetParamIndex}`,
        [...params, pageSize, offset]
      ),
    ])

    res.json({
      items: dataResult.rows.map(enhanceUsageLog),
      total: countResult.rows[0].total,
      page,
      pageSize,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/tasks/export', async (req, res) => {
  const db = getPool()
  if (!db) {
    return res.status(503).json({ error: 'Database not available' })
  }

  const { where, params } = buildUsageLogWhereClause(req.query)

  try {
    const result = await db.query(
      `SELECT logs.*, COALESCE(credit_usage.credit_spent, 0)::float AS credit_spent
       FROM video_usage_logs logs
       LEFT JOIN (${CREDIT_USAGE_SUMMARY_SQL}) credit_usage ON credit_usage.usage_log_id = logs.id
       WHERE ${where}
       ORDER BY logs.created_at DESC`,
      params
    )

    const buffer = await buildUsageWorkbook(result.rows.map(enhanceUsageLog), '对账明细')
    const exportDate = new Date().toISOString().slice(0, 10)

    res.setHeader('Content-Type', EXCEL_CONTENT_TYPE)
    res.setHeader('Content-Disposition', `attachment; filename="usage_${exportDate}.xlsx"`)
    res.send(Buffer.from(buffer))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/cost-import/preview', async (req, res) => {
  const db = getPool()
  if (!db) {
    return res.status(503).json({ error: 'Database not available' })
  }

  try {
    await runCostImportUpload(req, res)

    const channel = normalizeImportChannel(req.body?.channel)
    if (!req.file) {
      throw createBadRequest('请上传待导入的 Excel 或 CSV 文件')
    }

    const parsedFile = parseCostImportFile(req.file)
    const preview = await buildCostImportPreview({
      db,
      channel,
      parsedFile,
    })
    const previewToken = createCostImportPreviewToken({
      channel,
      parsedFile,
      createdBy: getAdminActor(req),
    })

    console.info('[cost-import][preview]', {
      actor: getAdminActor(req),
      channel,
      fileName: parsedFile.fileName,
      ...preview.summary,
    })

    res.json(buildCostImportResponse(preview, {
      channel,
      previewToken,
    }))
  } catch (err) {
    const status = getCostImportErrorStatus(err)
    res.status(status).json({ error: err.message || '费用导入预检失败' })
  }
})

router.post('/cost-import/apply', async (req, res) => {
  const db = getPool()
  if (!db) {
    return res.status(503).json({ error: 'Database not available' })
  }

  let previewToken = ''

  try {
    await runCostImportUpload(req, res)

    previewToken = String(req.body?.importToken || '').trim()
    const actor = getAdminActor(req)

    let channel = ''
    let parsedFile = null

    if (previewToken) {
      const cachedPreview = readCostImportPreviewToken(previewToken)
      channel = cachedPreview.channel
      parsedFile = cachedPreview.parsedFile
    } else {
      channel = normalizeImportChannel(req.body?.channel)
      if (!req.file) {
        throw createBadRequest('请先上传文件预检，或提交有效的预检令牌')
      }
      parsedFile = parseCostImportFile(req.file)
    }

    const preview = await buildCostImportPreview({
      db,
      channel,
      parsedFile,
    })

    let updatedRows = 0
    let overwrittenRows = 0
    const appliedRowNumbers = new Set()
    const updatedUsageLogIds = []
    const applyStartedAt = Date.now()

    if (preview.actions.length > 0) {
      const client = await db.connect()
      try {
        await client.query('BEGIN')
        const appliedTargetIds = await applyCostImportActions(client, preview.actions)
        updatedRows = appliedTargetIds.size

        for (const action of preview.actions) {
          if (appliedTargetIds.has(action.targetId)) {
            appliedRowNumbers.add(action.rowNumber)
            updatedUsageLogIds.push(action.targetId)
            if (action.existingCost !== null) {
              overwrittenRows += 1
            }
          }
        }
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    }

    queueCostImportBackupSync(updatedUsageLogIds, {
      actor,
      channel,
      fileName: parsedFile.fileName,
    })

    const actionByRowNumber = new Map(preview.actions.map((action) => [action.rowNumber, action]))
    const appliedDetailRows = preview.detailRows.map((row) => {
      if (row.status !== 'writable') {
        return row
      }

      const action = actionByRowNumber.get(row.rowNumber)
      if (!action || !appliedRowNumbers.has(row.rowNumber)) {
        return {
          ...row,
          status: 'skipped',
          reason: '写入时未找到目标记录，请重新预检后再导入',
        }
      }

      return {
        ...row,
        status: action.existingCost === null ? 'applied' : 'overwritten',
        reason: action.existingCost === null ? '已写入费用' : '已覆盖原有费用',
      }
    })

    deleteCostImportPreviewToken(previewToken)

    console.info('[cost-import][apply]', {
      actor,
      channel,
      fileName: parsedFile.fileName,
      updatedRows,
      overwrittenRows,
      durationMs: Date.now() - applyStartedAt,
      invalidRows: preview.summary.invalidRows,
      unmatchedRows: preview.summary.unmatchedRows,
      conflictRows: preview.summary.conflictRows,
      duplicateRowCount: preview.summary.duplicateRowCount,
    })

    res.json(buildCostImportResponse(preview, {
      channel,
      detailRows: appliedDetailRows,
      meta: {
        applyResult: {
          updatedRows,
          overwrittenRows,
          skippedRows: preview.actions.length - updatedRows,
        },
      },
    }))
  } catch (err) {
    const status = getCostImportErrorStatus(err)
    res.status(status).json({ error: err.message || '费用导入失败' })
  }
})

router.get('/credits/site', async (req, res) => {
  const db = getPool()
  if (!db) return res.json(emptyCreditSiteSummary())

  try {
    const [accountResult, usageResult, transactionResult] = await Promise.all([
      db.query(
        `SELECT COALESCE(balance, 0)::float AS balance
         FROM user_credit_accounts
         WHERE user_id = $1`,
        [getCreditBalanceAccountId()],
      ),
      db.query(`
        SELECT
          COUNT(DISTINCT user_id)::int AS user_count,
          COUNT(*)::int AS generation_count,
          COALESCE(SUM(GREATEST(COALESCE(sample_count, 1), 1)), 0)::int AS output_count,
          COALESCE(SUM(duration * GREATEST(COALESCE(sample_count, 1), 1)), 0)::float AS generated_seconds
        FROM video_usage_logs
        WHERE ${CREDIT_USAGE_WHERE_SQL}
      `),
      db.query(`
        SELECT COALESCE(SUM(-amount), 0)::float AS consumed_credits
        FROM user_credit_transactions
        WHERE type = 'consume'
      `),
    ])

    res.json({
      balance: Number(accountResult.rows[0]?.balance || 0),
      userCount: Number(usageResult.rows[0]?.user_count || 0),
      generationCount: Number(usageResult.rows[0]?.generation_count || 0),
      outputCount: Number(usageResult.rows[0]?.output_count || 0),
      generatedSeconds: Number(usageResult.rows[0]?.generated_seconds || 0),
      consumedCredits: Number(transactionResult.rows[0]?.consumed_credits || 0),
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/credits/users', async (req, res) => {
  const db = getPool()
  if (!db) return res.json([])

  try {
    const result = await db.query(`
      WITH usage_stats AS (
        SELECT
          user_id,
          (array_agg(user_email ORDER BY created_at DESC) FILTER (WHERE user_email IS NOT NULL AND user_email <> ''))[1] AS user_email,
          (array_agg(user_nickname ORDER BY created_at DESC) FILTER (WHERE user_nickname IS NOT NULL AND user_nickname <> ''))[1] AS user_nickname,
          (array_agg(user_group ORDER BY created_at DESC) FILTER (WHERE user_group IS NOT NULL AND user_group <> ''))[1] AS user_group,
          COUNT(*)::int AS generation_count,
          COALESCE(SUM(GREATEST(COALESCE(sample_count, 1), 1)), 0)::int AS output_count,
          COALESCE(SUM(duration * GREATEST(COALESCE(sample_count, 1), 1)), 0)::float AS generated_seconds,
          MAX(created_at) AS last_generated_at
        FROM video_usage_logs
        WHERE ${CREDIT_USAGE_WHERE_SQL}
        GROUP BY user_id
      ),
      transaction_stats AS (
        SELECT
          user_id,
          COALESCE(SUM(-amount), 0)::float AS consumed_credits
        FROM user_credit_transactions
        WHERE type = 'consume'
        GROUP BY user_id
      )
      SELECT
        usage_stats.user_id,
        usage_stats.user_email,
        usage_stats.user_nickname,
        usage_stats.user_group,
        COALESCE(usage_stats.generation_count, 0)::int AS generation_count,
        COALESCE(usage_stats.output_count, 0)::int AS output_count,
        COALESCE(usage_stats.generated_seconds, 0)::float AS generated_seconds,
        COALESCE(transaction_stats.consumed_credits, 0)::float AS consumed_credits,
        usage_stats.last_generated_at
      FROM usage_stats
      LEFT JOIN transaction_stats ON transaction_stats.user_id = usage_stats.user_id
      ORDER BY last_generated_at DESC NULLS LAST, user_id
      LIMIT 300
    `)
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/credits/recharge', async (req, res) => {
  const { amount, note } = req.body || {}
  try {
    const result = await rechargeSiteCredits({
      amount,
      note: note ? String(note).trim() : null,
      actor: getAdminActor(req),
    })
    res.json({ success: true, ...result })
  } catch (err) {
    res.status(400).json({ error: err.message || '充值失败' })
  }
})

router.get('/credits/transactions', async (req, res) => {
  const db = getPool()
  if (!db) return res.json([])
  const userId = String(req.query.userId || '').trim()
  const params = []
  const where = userId ? 'WHERE user_id = $1' : ''
  if (userId) params.push(userId)

  try {
    const result = await db.query(`
      SELECT *
      FROM user_credit_transactions
      ${where}
      ORDER BY created_at DESC
      LIMIT 200
    `, params)
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/credits/usage', async (req, res) => {
  const db = getPool()
  if (!db) return res.json([])
  const userId = String(req.query.userId || '').trim()
  const params = []
  const where = userId ? `WHERE ${CREDIT_USAGE_WHERE_SQL} AND user_id = $1` : `WHERE ${CREDIT_USAGE_WHERE_SQL}`
  if (userId) params.push(userId)

  try {
    const result = await db.query(`
      SELECT *
      FROM video_usage_logs
      ${where}
      ORDER BY created_at DESC
      LIMIT 300
    `, params)
    res.json(result.rows.map(enhanceUsageLog))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/pricing', async (req, res) => {
  const db = getPool()
  if (!db) return res.json([])

  try {
    const result = await db.query('SELECT * FROM model_pricing ORDER BY channel, model')
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/pricing', async (req, res) => {
  const db = getPool()
  if (!db) return res.status(503).json({ error: 'Database not available' })

  const { channel, model, priceType, unitPrice, currency, note } = req.body || {}
  if (!channel || !model) {
    return res.status(400).json({ error: 'channel and model are required' })
  }

  try {
    await db.query(`
      INSERT INTO model_pricing (channel, model, price_type, unit_price, currency, note, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (channel, model)
      DO UPDATE SET price_type = $3, unit_price = $4, currency = $5, note = $6, updated_at = NOW()
    `, [channel, model, priceType || 'per_call', unitPrice || 0, currency || 'CNY', note || null])

    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/user-detail', async (req, res) => {
  const db = getPool()
  if (!db) return res.json([])

  const userIds = parseRequestedUserIds(req.query)
  if (!userIds.length) return res.status(400).json({ error: 'userId or userIds is required' })

  const days = parseUsageDayRange(req.query.days)
  const conditions = [`user_id = ANY($1::text[])`]
  const params = [userIds]
  let paramIdx = 2

  paramIdx = appendUsageDateWindowClause(req.query, conditions, params, paramIdx, days)
  const where = conditions.join(' AND ')

  try {
    const result = await db.query(`
      SELECT
        logs.id, logs.channel, logs.provider_id, logs.model, logs.generation_mode, logs.prompt,
        logs.aspect_ratio, logs.resolution, logs.duration, logs.sample_count, logs.request_params, logs.engine_task_id,
        logs.upstream_request_id, logs.upstream_trace_id, logs.upstream_url, logs.status, logs.error_message,
        logs.video_url, logs.estimated_cost, logs.created_at, logs.completed_at,
        COALESCE(credit_usage.credit_spent, 0)::float AS credit_spent
      FROM video_usage_logs logs
      LEFT JOIN (${CREDIT_USAGE_SUMMARY_SQL}) credit_usage ON credit_usage.usage_log_id = logs.id
      WHERE ${where}
      ORDER BY logs.created_at DESC
    `, params)

    res.json(result.rows.map(enhanceUsageLog))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/user-detail/export', async (req, res) => {
  const db = getPool()
  if (!db) {
    return res.status(503).json({ error: 'Database not available' })
  }

  const userIds = parseRequestedUserIds(req.query)
  if (!userIds.length) {
    return res.status(400).json({ error: 'userId or userIds is required' })
  }

  const days = parseUsageDayRange(req.query.days)
  const conditions = [`user_id = ANY($1::text[])`]
  const params = [userIds]
  let paramIdx = 2

  paramIdx = appendUsageDateWindowClause(req.query, conditions, params, paramIdx, days)
  const where = conditions.join(' AND ')

  try {
    const result = await db.query(
      `SELECT logs.*, COALESCE(credit_usage.credit_spent, 0)::float AS credit_spent
       FROM video_usage_logs logs
       LEFT JOIN (${CREDIT_USAGE_SUMMARY_SQL}) credit_usage ON credit_usage.usage_log_id = logs.id
       WHERE ${where}
       ORDER BY logs.created_at DESC`,
      params
    )

    const buffer = await buildUsageWorkbook(result.rows.map(enhanceUsageLog), '用户明细')
    const exportDate = new Date().toISOString().slice(0, 10)

    res.setHeader('Content-Type', EXCEL_CONTENT_TYPE)
    res.setHeader('Content-Disposition', `attachment; filename="user_usage_${exportDate}.xlsx"`)
    res.send(Buffer.from(buffer))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
