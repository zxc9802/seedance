import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

async function loadProviders() {
  const modelConfigPath = path.resolve('src/modelConfig.js')
  const yunwuProvidersUrl = pathToFileURL(path.resolve('src/yunwuProviders.js')).href
  const source = await fs.readFile(modelConfigPath, 'utf8')
  const rewrittenSource = source.replace("'./yunwuProviders'", `'${yunwuProvidersUrl}'`)
  const moduleUrl = `data:text/javascript,${encodeURIComponent(rewrittenSource)}`
  return (await import(moduleUrl)).PROVIDERS
}

test('gpt image2(Medium) exposes fixed fal.ai quality, ratios, and 1080p-class sizes', async () => {
  const providers = await loadProviders()
  const provider = providers['fal-gpt-image2-medium']

  assert.ok(provider)
  assert.equal(provider.selectorLabel, 'gpt image2(Medium)')
  assert.equal(provider.vendor, 'fal.ai')
  assert.equal(provider.backendKind, 'fal-gpt-image2')
  assert.equal(provider.defaults.model, 'openai/gpt-image-2')
  assert.equal(provider.defaults.quality, 'medium')
  assert.deepEqual(provider.aspectRatios, ['1:1', '3:4', '9:16', '16:9'])
  assert.deepEqual(provider.resolutionByAspectRatio, {
    '1:1': '1920x1920',
    '3:4': '1440x1920',
    '9:16': '1080x1920',
    '16:9': '1920x1080',
  })
  assert.equal(provider.maxReferenceImages, 16)
})

test('gpt image2(Medium) frontend uploads references and polls the fal.ai backend', async () => {
  const appSource = await fs.readFile(path.resolve('src/App.jsx'), 'utf8')

  assert.match(appSource, /function isFalGptImage2Provider\(id\)/)
  assert.match(appSource, /buildFalGptImage2Request/)
  assert.match(appSource, /url: '\/api\/fal\/gpt-image2\/generate'/)
  assert.match(appSource, /url: '\/api\/fal\/gpt-image2\/query'/)
  assert.match(appSource, /uploadImageReferences\(referenceMedia\)/)
  assert.match(appSource, /resolveImageSizeForParams\(provider, params\)/)
})

test('gpt image2(Medium) backend uses fal.ai queue endpoints with fixed medium quality', async () => {
  const serverSource = await fs.readFile(path.resolve('server.js'), 'utf8')

  assert.match(serverSource, /process\.env\.FAL_GPT_IMAGE2_API_BASE_URL/)
  assert.match(serverSource, /process\.env\.FAL_GPT_IMAGE2_API_KEY/)
  assert.match(serverSource, /'openai\/gpt-image-2'/)
  assert.match(serverSource, /'openai\/gpt-image-2\/edit'/)
  assert.match(serverSource, /quality: 'medium'/)
  assert.match(serverSource, /body\.inputUrls\.length > 16/)
  assert.match(serverSource, /\/status/)
  assert.match(serverSource, /requestFalGptImage2Json\(requestBaseUrl, apiKey\)/)
  assert.doesNotMatch(serverSource, /\$\{requestBaseUrl\}\/response/)
})
