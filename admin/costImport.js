import * as XLSX from 'xlsx'
import { buildUsageChannelSql } from './usageChannel.js'

const USAGE_CHANNEL_SQL = buildUsageChannelSql()

const TASK_ID_ALIASES = [
  'task_id',
  'taskid',
  'task id',
  'taskId',
  '任务ID',
  '任务id',
]

const AMOUNT_ALIASES = [
  'amount',
  'cost',
  'price',
  '金额',
  '费用',
  '单价金额',
]

function normalizeHeaderName(value) {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_\-:：()（）【】\[\]<>]/g, '')
}

function normalizeCellText(value) {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .trim()
}

function isBlankRow(row) {
  return !Array.isArray(row) || row.every((cell) => normalizeCellText(cell) === '')
}

function findHeaderRowIndex(rows) {
  return rows.findIndex((row) => !isBlankRow(row))
}

function buildAliasSet(values) {
  return new Set(values.map(normalizeHeaderName))
}

function detectColumn(headers, aliases) {
  const aliasSet = buildAliasSet(aliases)
  for (let index = 0; index < headers.length; index += 1) {
    if (aliasSet.has(normalizeHeaderName(headers[index]))) {
      return {
        index,
        label: normalizeCellText(headers[index]) || `Column ${index + 1}`,
      }
    }
  }
  return null
}

function parseAmount(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return { valid: false, reason: '金额不是有效数字' }
    }
    if (value < 0) {
      return { valid: false, reason: '金额不能为负数' }
    }
    return {
      valid: true,
      amount: Number(value.toFixed(4)),
    }
  }

  const raw = normalizeCellText(value)
  if (!raw) {
    return { valid: false, reason: '金额为空' }
  }

  let normalized = raw
    .replace(/[,\s，]/g, '')
    .replace(/[¥￥$]/g, '')
    .replace(/元$/u, '')

  if (/^\(.+\)$/.test(normalized)) {
    normalized = `-${normalized.slice(1, -1)}`
  }

  if (normalized.startsWith('+')) {
    normalized = normalized.slice(1)
  }

  if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
    return { valid: false, reason: '金额格式非法' }
  }

  const amount = Number(normalized)
  if (!Number.isFinite(amount)) {
    return { valid: false, reason: '金额不是有效数字' }
  }
  if (amount < 0) {
    return { valid: false, reason: '金额不能为负数' }
  }

  return {
    valid: true,
    amount: Number(amount.toFixed(4)),
  }
}

function buildDuplicateInfo(rows) {
  const rowNumbersByTaskId = new Map()

  rows.forEach((row) => {
    if (!row.taskId) return
    const numbers = rowNumbersByTaskId.get(row.taskId) || []
    numbers.push(row.rowNumber)
    rowNumbersByTaskId.set(row.taskId, numbers)
  })

  const duplicateTaskIds = Array.from(rowNumbersByTaskId.entries())
    .filter(([, rowNumbers]) => rowNumbers.length > 1)
    .map(([taskId, rowNumbers]) => ({ taskId, rowNumbers }))

  const lastRowNumberByTaskId = new Map(
    duplicateTaskIds.map(({ taskId, rowNumbers }) => [taskId, rowNumbers[rowNumbers.length - 1]])
  )

  return {
    duplicateTaskIds,
    lastRowNumberByTaskId,
  }
}

function buildDetailRow(base, overrides = {}) {
  return {
    rowNumber: base.rowNumber,
    taskId: base.taskId || '',
    amountRaw: base.amountRaw,
    amount: base.amount ?? null,
    existingCost: base.existingCost ?? null,
    matchedCount: base.matchedCount ?? 0,
    status: base.status || 'unknown',
    reason: base.reason || '',
    ...overrides,
  }
}

function sumRowAmounts(rows) {
  return Number(
    rows
      .reduce((total, row) => total + (Number(row?.amount) || 0), 0)
      .toFixed(4)
  )
}

export function parseCostImportFile(file) {
  if (!file?.buffer?.length) {
    throw new Error('未读取到上传文件内容')
  }

  const workbook = XLSX.read(file.buffer, {
    type: 'buffer',
    raw: false,
  })

  const firstSheetName = workbook.SheetNames?.[0]
  if (!firstSheetName) {
    throw new Error('文件中没有可读取的工作表')
  }

  const worksheet = workbook.Sheets[firstSheetName]
  const rawRows = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: '',
    raw: false,
    blankrows: false,
  })

  const headerRowIndex = findHeaderRowIndex(rawRows)
  if (headerRowIndex < 0) {
    throw new Error('未识别到表头，请确认第一行包含列名')
  }

  const headers = rawRows[headerRowIndex] || []
  const taskColumn = detectColumn(headers, TASK_ID_ALIASES)
  if (!taskColumn) {
    throw new Error('未识别到 task_id 列，请使用 task_id / taskId / taskid / 任务ID 等别名')
  }

  const amountColumn = detectColumn(headers, AMOUNT_ALIASES)
  if (!amountColumn) {
    throw new Error('未识别到金额列，请使用 amount / cost / price / 金额 / 费用 / 单价金额 等别名')
  }

  const dataRows = rawRows
    .slice(headerRowIndex + 1)
    .map((row, index) => ({
      rowNumber: headerRowIndex + 2 + index,
      taskId: normalizeCellText(row[taskColumn.index]),
      amountRaw: normalizeCellText(row[amountColumn.index]),
    }))
    .filter((row) => row.taskId || row.amountRaw || rawRows[row.rowNumber - 1]?.some((cell) => normalizeCellText(cell)))

  return {
    fileName: file.originalname || 'import.xlsx',
    sheetName: firstSheetName,
    recognizedColumns: {
      taskId: taskColumn.label,
      amount: amountColumn.label,
    },
    dataRows,
  }
}

export async function buildCostImportPreview({ db, channel, parsedFile }) {
  const duplicateInfo = buildDuplicateInfo(parsedFile.dataRows)
  const duplicateRows = []
  const effectiveRows = []

  parsedFile.dataRows.forEach((row) => {
    const lastRowNumber = row.taskId ? duplicateInfo.lastRowNumberByTaskId.get(row.taskId) : undefined
    if (lastRowNumber && lastRowNumber !== row.rowNumber) {
      duplicateRows.push(buildDetailRow({
        ...row,
        status: 'duplicate_ignored',
        reason: `同一文件内重复 task_id，按第 ${lastRowNumber} 行为准`,
      }))
      return
    }
    effectiveRows.push({ ...row })
  })

  const validCandidateRows = []
  const detailRows = []

  effectiveRows.forEach((row) => {
    if (!row.taskId) {
      detailRows.push(buildDetailRow({
        ...row,
        status: 'invalid',
        reason: 'task_id 为空',
      }))
      return
    }

    const amountResult = parseAmount(row.amountRaw)
    if (!amountResult.valid) {
      detailRows.push(buildDetailRow({
        ...row,
        status: 'invalid',
        reason: amountResult.reason,
      }))
      return
    }

    validCandidateRows.push({
      ...row,
      amount: amountResult.amount,
    })
  })

  const candidateTaskIds = [...new Set(validCandidateRows.map((row) => row.taskId))]
  const matchesByTaskId = new Map()

  if (candidateTaskIds.length > 0) {
    const result = await db.query(
      `
        SELECT id, engine_task_id, estimated_cost
        FROM video_usage_logs
        WHERE ${USAGE_CHANNEL_SQL} = $1
          AND engine_task_id = ANY($2::text[])
      `,
      [channel, candidateTaskIds]
    )

    result.rows.forEach((row) => {
      const group = matchesByTaskId.get(row.engine_task_id) || []
      group.push({
        id: row.id,
        existingCost: row.estimated_cost === null ? null : Number(row.estimated_cost),
      })
      matchesByTaskId.set(row.engine_task_id, group)
    })
  }

  const writableActions = []

  validCandidateRows.forEach((row) => {
    const matches = matchesByTaskId.get(row.taskId) || []
    if (matches.length === 0) {
      detailRows.push(buildDetailRow({
        ...row,
        status: 'unmatched',
        reason: '当前通道下未找到本地记录',
      }))
      return
    }

    if (matches.length > 1) {
      detailRows.push(buildDetailRow({
        ...row,
        status: 'conflict',
        matchedCount: matches.length,
        reason: `当前通道下匹配到 ${matches.length} 条本地记录`,
      }))
      return
    }

    const match = matches[0]
    writableActions.push({
      rowNumber: row.rowNumber,
      taskId: row.taskId,
      amountRaw: row.amountRaw,
      amount: row.amount,
      targetId: match.id,
      existingCost: match.existingCost,
    })
    detailRows.push(buildDetailRow({
      ...row,
      existingCost: match.existingCost,
      status: 'writable',
      reason: match.existingCost === null ? '可写入费用' : '将覆盖现有费用',
    }))
  })

  const allDetailRows = [...detailRows, ...duplicateRows].sort((left, right) => left.rowNumber - right.rowNumber)
  const invalidRows = allDetailRows.filter((row) => row.status === 'invalid')
  const unmatchedRows = allDetailRows.filter((row) => row.status === 'unmatched')
  const conflictRows = allDetailRows.filter((row) => row.status === 'conflict')
  const writableRows = allDetailRows.filter((row) => row.status === 'writable')
  const validAmount = sumRowAmounts(validCandidateRows)
  const writableAmount = sumRowAmounts(writableRows)

  return {
    fileName: parsedFile.fileName,
    sheetName: parsedFile.sheetName,
    recognizedColumns: parsedFile.recognizedColumns,
    duplicateTaskIds: duplicateInfo.duplicateTaskIds,
    detailRows: allDetailRows,
    actions: writableActions,
    summary: {
      totalRows: parsedFile.dataRows.length,
      effectiveRows: effectiveRows.length,
      validRows: validCandidateRows.length,
      validAmount,
      invalidRows: invalidRows.length,
      unmatchedRows: unmatchedRows.length,
      conflictRows: conflictRows.length,
      writableRows: writableRows.length,
      writableAmount,
      overwriteRows: writableRows.filter((row) => row.existingCost !== null).length,
      duplicateRowCount: duplicateRows.length,
      duplicateTaskIdCount: duplicateInfo.duplicateTaskIds.length,
    },
  }
}
