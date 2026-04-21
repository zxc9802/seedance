import path from 'node:path'
import process from 'node:process'
import XLSX from 'xlsx'
import { createPool, closePool, loadProjectEnv } from './db-common.mjs'

const REQUIRED_COLUMNS = Object.freeze({
  taskId: ['taskid', 'task_id', 'taskId', '任务ID'],
  calledAt: ['调用时间', '时间'],
  completedAt: ['完成时间'],
  amount: ['金额', '费用', 'cost', 'amount'],
})

const IMPORT_USER_ID = '__settlement_import__'
const IMPORT_CHANNEL = 'aggregation'
const IMPORT_STATUS = 'succeeded'

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

function detectColumn(headers, aliases) {
  const aliasSet = new Set(aliases.map(normalizeHeaderName))
  for (let index = 0; index < headers.length; index += 1) {
    if (aliasSet.has(normalizeHeaderName(headers[index]))) {
      return index
    }
  }
  return -1
}

function parseArgs(argv) {
  const args = {
    filePath: '',
  }

  for (const arg of argv) {
    if (!arg) continue
    if (!args.filePath) {
      args.filePath = path.resolve(process.cwd(), arg)
    }
  }

  if (!args.filePath) {
    throw new Error('Usage: node scripts/import-settlement-missing.mjs <xlsx-file>')
  }

  return args
}

function parseAmount(value) {
  const raw = normalizeCellText(value)
    .replace(/[,\s，]/g, '')
    .replace(/[¥￥$]/g, '')
    .replace(/元$/u, '')

  if (!raw) return null
  const amount = Number(raw)
  if (!Number.isFinite(amount)) return null
  return Number(amount.toFixed(4))
}

function parseShanghaiTimestamp(value) {
  const raw = normalizeCellText(value)
  if (!raw) return null
  const normalized = raw.replace(/\//g, '-').replace('T', ' ')
  const match = normalized.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/
  )
  if (!match) return null

  const [, year, month, day, hour = '00', minute = '00', second = '00'] = match
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

function readWorkbookRows(filePath) {
  const workbook = XLSX.readFile(filePath, {
    raw: false,
  })
  const firstSheetName = workbook.SheetNames?.[0]
  if (!firstSheetName) {
    throw new Error('Workbook does not contain any sheets.')
  }

  const worksheet = workbook.Sheets[firstSheetName]
  const rawRows = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: '',
    raw: false,
    blankrows: false,
  })

  const headerRowIndex = rawRows.findIndex((row) => Array.isArray(row) && row.some((cell) => normalizeCellText(cell)))
  if (headerRowIndex < 0) {
    throw new Error('Unable to locate header row in workbook.')
  }

  const headers = rawRows[headerRowIndex] || []
  const taskIdIndex = detectColumn(headers, REQUIRED_COLUMNS.taskId)
  const calledAtIndex = detectColumn(headers, REQUIRED_COLUMNS.calledAt)
  const completedAtIndex = detectColumn(headers, REQUIRED_COLUMNS.completedAt)
  const amountIndex = detectColumn(headers, REQUIRED_COLUMNS.amount)

  if (taskIdIndex < 0 || calledAtIndex < 0 || amountIndex < 0) {
    throw new Error('Workbook is missing one or more required columns: taskid, 调用时间, 金额')
  }

  return {
    sheetName: firstSheetName,
    rows: rawRows
      .slice(headerRowIndex + 1)
      .map((row, index) => ({
        rowNumber: headerRowIndex + 2 + index,
        taskId: normalizeCellText(row[taskIdIndex]),
        calledAtRaw: normalizeCellText(row[calledAtIndex]),
        completedAtRaw: completedAtIndex >= 0 ? normalizeCellText(row[completedAtIndex]) : '',
        amountRaw: normalizeCellText(row[amountIndex]),
        rawRow: Object.fromEntries(
          headers.map((header, headerIndex) => [normalizeCellText(header) || `Column ${headerIndex + 1}`, row[headerIndex] ?? ''])
        ),
      }))
      .filter((row) => row.taskId),
  }
}

async function loadExistingTaskIds(db, taskIds) {
  if (!taskIds.length) return new Set()

  const existing = new Set()
  const chunkSize = 500
  for (let index = 0; index < taskIds.length; index += chunkSize) {
    const chunk = taskIds.slice(index, index + chunkSize)
    const result = await db.query(
      'SELECT engine_task_id FROM video_usage_logs WHERE engine_task_id = ANY($1::text[])',
      [chunk],
    )
    result.rows.forEach((row) => {
      const taskId = normalizeCellText(row.engine_task_id)
      if (taskId) existing.add(taskId)
    })
  }

  return existing
}

function buildImportRows(filePath, parsedRows, existingTaskIds) {
  const importFileName = path.basename(filePath)
  const importedAt = new Date().toISOString()
  const rows = []
  const skipped = []

  for (const row of parsedRows) {
    if (existingTaskIds.has(row.taskId)) {
      skipped.push({ rowNumber: row.rowNumber, taskId: row.taskId, reason: 'already-exists' })
      continue
    }

    const createdAt = parseShanghaiTimestamp(row.calledAtRaw)
    const completedAt = parseShanghaiTimestamp(row.completedAtRaw)
    const amount = parseAmount(row.amountRaw)

    if (!createdAt || amount === null) {
      skipped.push({
        rowNumber: row.rowNumber,
        taskId: row.taskId,
        reason: !createdAt ? 'invalid-called-at' : 'invalid-amount',
      })
      continue
    }

    rows.push({
      user_id: IMPORT_USER_ID,
      user_email: null,
      user_nickname: null,
      user_group: null,
      channel: IMPORT_CHANNEL,
      provider_id: null,
      model: null,
      generation_mode: null,
      prompt: null,
      aspect_ratio: null,
      resolution: null,
      duration: null,
      sample_count: 1,
      request_params: JSON.stringify({
        importSource: 'settlement-xlsx',
        importFileName,
        importedAt,
        rawRow: row.rawRow,
      }),
      engine_task_id: row.taskId,
      upstream_request_id: null,
      upstream_trace_id: null,
      upstream_url: null,
      status: IMPORT_STATUS,
      error_message: null,
      video_url: null,
      unit_price: null,
      estimated_cost: amount,
      created_at: createdAt,
      updated_at: completedAt || createdAt,
      completed_at: completedAt,
    })
  }

  return { rows, skipped }
}

async function insertRows(db, rows) {
  if (!rows.length) return 0

  const columns = [
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

  const chunkSize = 200
  let inserted = 0

  await db.query('BEGIN')
  try {
    for (let index = 0; index < rows.length; index += chunkSize) {
      const chunk = rows.slice(index, index + chunkSize)
      const values = []
      const placeholders = chunk.map((row, rowIndex) => {
        const offset = rowIndex * columns.length
        columns.forEach((column) => {
          values.push(row[column] ?? null)
        })
        return `(${columns.map((_, columnIndex) => `$${offset + columnIndex + 1}`).join(', ')})`
      })

      const result = await db.query(
        `INSERT INTO video_usage_logs (${columns.join(', ')}) VALUES ${placeholders.join(', ')}`,
        values,
      )
      inserted += result.rowCount
    }

    await db.query('COMMIT')
  } catch (error) {
    await db.query('ROLLBACK')
    throw error
  }

  return inserted
}

async function main() {
  const { filePath } = parseArgs(process.argv.slice(2))
  await loadProjectEnv()

  const { rows: parsedRows, sheetName } = readWorkbookRows(filePath)
  const uniqueTaskIds = [...new Set(parsedRows.map((row) => row.taskId).filter(Boolean))]

  const db = createPool()
  try {
    const existingTaskIds = await loadExistingTaskIds(db, uniqueTaskIds)
    const { rows: rowsToInsert, skipped } = buildImportRows(filePath, parsedRows, existingTaskIds)
    const inserted = await insertRows(db, rowsToInsert)

    console.log('[settlement-import] file      :', filePath)
    console.log('[settlement-import] sheet     :', sheetName)
    console.log('[settlement-import] parsed    :', parsedRows.length)
    console.log('[settlement-import] existing  :', existingTaskIds.size)
    console.log('[settlement-import] inserted  :', inserted)
    console.log('[settlement-import] skipped   :', skipped.length)

    if (skipped.length > 0) {
      console.log('[settlement-import] skipped sample:')
      skipped.slice(0, 20).forEach((item) => {
        console.log(`  - row ${item.rowNumber} / ${item.taskId}: ${item.reason}`)
      })
    }
  } finally {
    await closePool(db)
  }
}

main().catch((error) => {
  console.error('[settlement-import] Failed:', error.message || error)
  process.exitCode = 1
})
