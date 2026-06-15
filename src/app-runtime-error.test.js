import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

async function loadRuntimeErrorFormatter() {
  const appPath = path.resolve('src/App.jsx')
  const source = await fs.readFile(appPath, 'utf8')

  const marker = 'function formatRuntimeErrorMessage(provider, message) {'
  const markerIndex = source.indexOf(marker)
  if (markerIndex === -1) {
    throw new Error('Unable to locate formatRuntimeErrorMessage in App.jsx')
  }

  const nextFunctionIndex = source.indexOf('function buildOpenAiImageRequest', markerIndex)
  if (nextFunctionIndex === -1) {
    throw new Error('Unable to locate helper export boundary in App.jsx')
  }

  const helperSource = `${source.slice(markerIndex, nextFunctionIndex)}\nexport { formatRuntimeErrorMessage }\n`
  const moduleUrl = `data:text/javascript,${encodeURIComponent(helperSource)}`
  return import(moduleUrl)
}

test('runtime error formatter leaves empty error state blank for the initial preview', async () => {
  const { formatRuntimeErrorMessage } = await loadRuntimeErrorFormatter()

  assert.equal(formatRuntimeErrorMessage('veo', null), null)
})
