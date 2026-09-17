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

test('gpt-image2-vip exposes the verified APIYi model and reference-image limit', async () => {
  const providers = await loadProviders()
  const provider = providers['gpt-image2-vip']

  assert.ok(provider)
  assert.equal(provider.selectorLabel, 'gpt-image2-vip')
  assert.equal(provider.backendKind, 'gpt-image2-vip')
  assert.equal(provider.defaults.model, 'gpt-image-2-vip')
  assert.deepEqual(provider.models.map((item) => item.value), ['gpt-image-2-vip'])
  assert.equal(provider.maxReferenceImages, 3)
  assert.deepEqual(provider.sampleCounts, [1])
  assert.deepEqual(provider.aspectRatios, ['1:1', '16:9', '9:16', '3:4'])
  assert.deepEqual(provider.resolutionByAspectRatio, {
    '1:1': 'auto',
    '16:9': '1536x864',
    '9:16': '864x1536',
    '3:4': '1152x1536',
  })
})

test('gpt-image2-vip frontend uses its private backend route and preserves image references', async () => {
  const appSource = await fs.readFile(path.resolve('src/App.jsx'), 'utf8')

  assert.match(appSource, /function isGptImage2VipProvider\(id\)/)
  assert.match(appSource, /url: '\/api\/gpt-image2-vip\/generations'/)
  assert.match(appSource, /model: params\.model/)
  assert.match(appSource, /prompt,/)
  assert.match(appSource, /size && size !== 'auto' \? \{ size \} : \{\}/)
  assert.match(appSource, /image: mediaList/)
})

test('gpt-image2-vip backend switches between JSON generations and multipart edits', async () => {
  const serverSource = await fs.readFile(path.resolve('server.js'), 'utf8')

  assert.match(serverSource, /process\.env\.GPT_IMAGE2_VIP_API_BASE_URL/)
  assert.match(serverSource, /process\.env\.GPT_IMAGE2_VIP_API_KEY/)
  assert.match(serverSource, /app\.post\('\/api\/gpt-image2-vip\/generations', handleGptImage2VipGenerateRequest\)/)
  assert.match(serverSource, /\/v1\/images\/\$\{isImageEdit && !isMixtoken \? 'edits' : 'generations'\}/)
  assert.match(serverSource, /formData\.append\('model', body\.model\)/)
  assert.match(serverSource, /formData\.append\('size', body\.size\)/)
  assert.match(serverSource, /formData\.append\(\s*'image'/s)
  assert.match(serverSource, /new Blob\(\[reference\.buffer\], \{ type: reference\.mimeType \}\)/)
  assert.match(serverSource, /model: readFirstString\(body\.model\) \|\| 'gpt-image-2-vip'/)
  assert.match(serverSource, /size: readFirstString\(body\.size, body\.resolution\)/)
})
