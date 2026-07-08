import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('user analysis aggregates one row per user id so export uses the same population', async () => {
  const apiSource = await readFile(new URL('../admin/api.js', import.meta.url), 'utf8')

  assert.match(apiSource, /GROUP BY user_id\s+ORDER BY requests DESC/s)
  assert.doesNotMatch(apiSource, /GROUP BY user_id, user_nickname, user_email, user_group/)
  assert.match(apiSource, /array_agg\(user_nickname ORDER BY created_at DESC\)/)
})

test('user detail export exposes generation count and the visible detail endpoint is not capped below export', async () => {
  const apiSource = await readFile(new URL('../admin/api.js', import.meta.url), 'utf8')
  const userDetailStart = apiSource.indexOf("router.get('/user-detail',")
  const userDetailEnd = apiSource.indexOf("router.get('/user-detail/export',")
  const userDetailRoute = apiSource.slice(userDetailStart, userDetailEnd)

  assert.match(apiSource, /header: '\\u751f\\u6210\\u6570\\u91cf'[\s\S]*sample_count/)
  assert.doesNotMatch(userDetailRoute, /FROM video_usage_logs\s+WHERE \$\{where\}\s+ORDER BY created_at DESC\s+LIMIT/s)
})

test('user detail export carries the selected day range like the visible detail table', async () => {
  const adminSource = await readFile(new URL('../admin/index.html', import.meta.url), 'utf8')
  const exportStart = adminSource.indexOf('async function exportUserDetailCSV()')
  const exportEnd = adminSource.indexOf('function fmtTime', exportStart)
  const exportFunction = adminSource.slice(exportStart, exportEnd)

  assert.match(exportFunction, /document\.getElementById\('dayRange'\)\?\.value/)
  assert.match(exportFunction, /params\.set\('days',\s*days\)/)
})

test('admin overview day range can request all data without the 90 day cap', async () => {
  const apiSource = await readFile(new URL('../admin/api.js', import.meta.url), 'utf8')
  const adminSource = await readFile(new URL('../admin/index.html', import.meta.url), 'utf8')

  assert.match(adminSource, /<option value="all">全部数据<\/option>/)
  assert.match(adminSource, /function getSelectedOverviewRange\(\)/)
  assert.match(adminSource, /return range === 'all' \? '全部数据请求'/)
  assert.match(apiSource, /function parseUsageDayRange\(value\)/)
  assert.match(apiSource, /normalized === 'all'[\s\S]*return null/)
  assert.doesNotMatch(apiSource, /Number\(req\.query\.days\) \|\| 30/)
})

test('main admin shows shared credit balance and converted credit fees', async () => {
  const apiSource = await readFile(new URL('../admin/api.js', import.meta.url), 'utf8')
  const adminSource = await readFile(new URL('../admin/index.html', import.meta.url), 'utf8')

  assert.match(adminSource, /剩余积分/)
  assert.match(adminSource, /消耗积分[\s\S]*费用/)
  assert.match(adminSource, /id="s-credit-balance"/)
  assert.match(adminSource, /overview\.creditBalance/)
  assert.match(adminSource, /formatCredits\(task\.credit_spent\)[\s\S]*formatMoney\(task\.credit_cost\)/)
  assert.match(adminSource, /formatCredits\(user\.credit_spent\)[\s\S]*formatMoney\(user\.credit_cost\)/)
  assert.match(apiSource, /creditBalance/)
  assert.match(apiSource, /creditConsumed/)
  assert.match(apiSource, /creditCost/)
})

test('main admin removes cost import, channel splitting, task id search, and success rate', async () => {
  const apiSource = await readFile(new URL('../admin/api.js', import.meta.url), 'utf8')
  const adminSource = await readFile(new URL('../admin/index.html', import.meta.url), 'utf8')
  const whereStart = apiSource.indexOf('function buildUsageLogWhereClause')
  const whereEnd = apiSource.indexOf('function parseUsageDayRange', whereStart)
  const whereSource = apiSource.slice(whereStart, whereEnd)

  assert.doesNotMatch(adminSource, /费用导入/)
  assert.doesNotMatch(adminSource, /ci-channel|ci-file|cost-import/)
  assert.doesNotMatch(adminSource, /id="f-channel"|id="f-task-id"/)
  assert.doesNotMatch(adminSource, /成功率|id="s-rate"/)
  assert.match(adminSource, /const CHANNEL_LABEL = '起芽'/)
  assert.doesNotMatch(adminSource, /CHANNEL_LABELS/)
  assert.doesNotMatch(adminSource, /api\('\/by-channel'\)/)
  assert.doesNotMatch(apiSource, /cost-import/)
  assert.doesNotMatch(apiSource, /buildCostImportPreview|parseCostImportFile|multer/)
  assert.doesNotMatch(whereSource, /taskId|engineTaskId|engine_task_id ILIKE|query\.channel|USAGE_CHANNEL_SQL =/)
})

test('admin Excel export puts consumed credits before converted fee', async () => {
  const apiSource = await readFile(new URL('../admin/api.js', import.meta.url), 'utf8')

  assert.match(apiSource, /header: '\\u6d88\\u8017\\u79ef\\u5206'[\s\S]*value: \(log\) => safeExcelAmount\(log\.credit_spent\)/)
  assert.match(apiSource, /header: '\\u8d39\\u7528'[\s\S]*value: \(log\) => safeExcelAmount\(log\.credit_cost\)/)
})
