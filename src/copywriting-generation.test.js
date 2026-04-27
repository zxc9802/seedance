import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

test('copywriting frontend posts a chat completion request and stores text output', async () => {
  const appSource = await fs.readFile(path.resolve('src/App.jsx'), 'utf8')

  assert.match(appSource, /function isCopywritingProvider\(id\)/)
  assert.match(appSource, /function buildCopywritingRequest\(provider, params, prompt, attachments\)/)
  assert.match(appSource, /url: '\/api\/copywriting\/chat\/completions'/)
  assert.match(appSource, /content: buildCopywritingContentParts\(prompt, attachments\)/)
  assert.match(appSource, /function parseCopywritingChatResponse\(data\)/)
  assert.match(appSource, /textOutput: textResult/)
  assert.match(appSource, /textOutput=\{currentState\.textOutput\}/)
})

test('copywriting frontend parses Claude-style root content arrays', async () => {
  const appSource = await fs.readFile(path.resolve('src/App.jsx'), 'utf8')

  assert.match(appSource, /extractChatTextContent\(data\?\.content\)/)
})

test('copywriting frontend asks for and displays plain readable text instead of markdown', async () => {
  const appSource = await fs.readFile(path.resolve('src/App.jsx'), 'utf8')

  assert.match(appSource, /const COPYWRITING_PLAIN_TEXT_INSTRUCTION = /)
  assert.match(appSource, /role: 'system', content: COPYWRITING_PLAIN_TEXT_INSTRUCTION/)
  assert.match(appSource, /function normalizeCopywritingDisplayText\(text\)/)
  assert.match(appSource, /\.replace\(\/\^\\s\*\#\{1,6\}\\s\*\/, ''\)/)
  assert.ok(appSource.includes(".replace(/\\*\\*([^*\\n]+)\\*\\*/g, '$1')"))
  assert.match(appSource, /return normalizeCopywritingDisplayText\(parsedContent\)/)
})

test('copywriting frontend can send image and document attachments as chat content parts', async () => {
  const appSource = await fs.readFile(path.resolve('src/App.jsx'), 'utf8')
  const promptInputSource = await fs.readFile(path.resolve('src/components/PromptInput.jsx'), 'utf8')

  assert.match(appSource, /const \[copywritingAttachments, setCopywritingAttachments\] = useState\(\[\]\)/)
  assert.match(appSource, /function buildCopywritingContentParts\(prompt, attachments\)/)
  assert.match(appSource, /type: 'image_url'/)
  assert.match(appSource, /image_url: \{ url: attachment\.dataUrl \}/)
  assert.match(appSource, /type: 'file'/)
  assert.match(appSource, /file_data: attachment\.dataUrl/)
  assert.match(promptInputSource, /copywritingAttachments/)
  assert.match(promptInputSource, /COPYWRITING_ATTACHMENT_ACCEPT/)
  assert.match(promptInputSource, /copywriting-attachments/)
})

test('copywriting backend proxies to BCAI chat completions with a private API key', async () => {
  const serverSource = await fs.readFile(path.resolve('server.js'), 'utf8')

  assert.match(serverSource, /app\.post\('\/api\/copywriting\/chat\/completions', handleCopywritingChatRequest\)/)
  assert.match(serverSource, /process\.env\.BCAI_API_KEY/)
  assert.match(serverSource, /claude-sonnet-4-6/)
  assert.match(serverSource, /\/v1\/chat\/completions/)
})

test('copywriting backend preserves multimodal chat content arrays', async () => {
  const serverSource = await fs.readFile(path.resolve('server.js'), 'utf8')

  assert.match(serverSource, /function normalizeCopywritingContentPart\(part\)/)
  assert.match(serverSource, /part\?\.type === 'image_url'/)
  assert.match(serverSource, /part\?\.type === 'file'/)
  assert.match(serverSource, /normalizeCopywritingContentParts\(item\?\.content\)/)
})

test('copywriting backend treats Claude-style root content as successful text output', async () => {
  const serverSource = await fs.readFile(path.resolve('server.js'), 'utf8')

  assert.match(serverSource, /normalizeCopywritingMessageContent\(payload\?\.content\)/)
})

test('copywriting backend does not retry billable transient failures by default', async () => {
  const serverSource = await fs.readFile(path.resolve('server.js'), 'utf8')

  assert.match(serverSource, /const COPYWRITING_RETRY_OPTIONS = Object\.freeze\(\{/)
  assert.match(serverSource, /maxAttempts: readPositiveIntegerEnv\(process\.env\.BCAI_COPYWRITING_MAX_ATTEMPTS, 1\)/)
  assert.match(serverSource, /statusCodes: new Set\(\[429, 502, 503, 504, 529\]\)/)
  assert.match(serverSource, /retry: COPYWRITING_RETRY_OPTIONS/)
  assert.match(serverSource, /function shouldRetryProxyResponse\(status, retryOptions, attempt\)/)
  assert.match(serverSource, /function didExhaustProxyRetries\(status, retryOptions, attempt\)/)
  assert.match(serverSource, /X-Proxy-Retry-Attempts/)
  assert.match(serverSource, /BCAI 文案服务暂时不可用，可能已产生计费但未返回内容。请不要连续点击生成/)
})

test('copywriting frontend maps transient BCAI failures to a billing-safe message', async () => {
  const appSource = await fs.readFile(path.resolve('src/App.jsx'), 'utf8')

  assert.match(appSource, /function isTransientCopywritingError\(response, message\)/)
  assert.match(appSource, /response\.url\.includes\('\/api\/copywriting\/chat\/completions'\)/)
  assert.match(appSource, /BCAI 文案服务暂时不可用，可能已产生计费但未返回内容。请不要连续点击生成/)
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
