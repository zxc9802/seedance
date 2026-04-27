import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

test('copywriting frontend posts a chat completion request and stores text output', async () => {
  const appSource = await fs.readFile(path.resolve('src/App.jsx'), 'utf8')

  assert.match(appSource, /function isCopywritingProvider\(id\)/)
  assert.match(appSource, /function buildCopywritingRequest\(provider, params, prompt\)/)
  assert.match(appSource, /url: '\/api\/copywriting\/chat\/completions'/)
  assert.match(appSource, /messages: \[\{ role: 'user', content: prompt \}\]/)
  assert.match(appSource, /function parseCopywritingChatResponse\(data\)/)
  assert.match(appSource, /textOutput: textResult/)
})

test('copywriting backend proxies to BCAI chat completions with a private API key', async () => {
  const serverSource = await fs.readFile(path.resolve('server.js'), 'utf8')

  assert.match(serverSource, /app\.post\('\/api\/copywriting\/chat\/completions', handleCopywritingChatRequest\)/)
  assert.match(serverSource, /process\.env\.BCAI_API_KEY/)
  assert.match(serverSource, /claude-sonnet-4-6/)
  assert.match(serverSource, /\/v1\/chat\/completions/)
})

test('preview panel renders text output for copywriting models', async () => {
  const previewSource = await fs.readFile(path.resolve('src/components/VideoPreview.jsx'), 'utf8')
  const previewCss = await fs.readFile(path.resolve('src/components/VideoPreview.css'), 'utf8')

  assert.match(previewSource, /const isTextOutput = cfg\.outputType === 'text'/)
  assert.match(previewSource, /文案预览/)
  assert.match(previewSource, /preview-text-output/)
  assert.match(previewCss, /\.preview-frame\.text/)
  assert.match(previewCss, /\.preview-text-output/)
})
