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
  const module = await import(moduleUrl)
  return module.PROVIDERS
}

test('Seedance 1 exposes 480p and 720p resolution options while defaulting to 720p', async () => {
  const providers = await loadProviders()

  assert.deepEqual(providers.veo.resolutions.default, ['480p', '720p'])
  assert.equal(providers.veo.defaults.resolution, '720p')
  assert.equal(providers.veo.defaults.imageMaterialType, 'direct')
})

test('gpt-image2 exposes Yunwu image generation parameters in the frontend config', async () => {
  const providers = await loadProviders()
  const provider = providers['gpt-image2']

  assert.equal(provider.id, 'gpt-image2')
  assert.equal(provider.outputType, 'image')
  assert.equal(provider.backendKind, 'gpt-image2')
  assert.equal(provider.defaults.model, 'gpt-image-2-all')
  assert.deepEqual(provider.aspectRatios, ['1:1', '16:9', '9:16'])
  assert.deepEqual(provider.resolutions.default, ['1024x1024', '1536x1024', '1024x1536'])
  assert.equal(provider.hideResolutionSelector, true)
  assert.deepEqual(provider.resolutionByAspectRatio, {
    '1:1': '1024x1024',
    '16:9': '1536x1024',
    '9:16': '1024x1536',
  })
  assert.deepEqual(provider.aspectRatioByResolution, {
    '1024x1024': '1:1',
    '1536x1024': '16:9',
    '1024x1536': '9:16',
  })
  assert.deepEqual(provider.sampleCounts, [1, 2, 3, 4])
  assert.deepEqual(provider.qualityOptions.map((item) => item.value), ['low', 'medium', 'high'])
  assert.deepEqual(provider.formatOptions.map((item) => item.value), ['png', 'jpeg', 'webp'])
})

test('BCAI Claude is exposed as a copywriting text model', async () => {
  const providers = await loadProviders()
  const provider = providers['bcai-copywriting']

  assert.equal(provider.id, 'bcai-copywriting')
  assert.equal(provider.typeId, 'copywriting')
  assert.equal(provider.typeLabel, '文案模型')
  assert.equal(provider.outputType, 'text')
  assert.equal(provider.backendKind, 'copywriting-chat')
  assert.equal(provider.defaults.model, 'claude-sonnet-4-6')
  assert.deepEqual(provider.generationModes, [
    { value: 'copywriting', label: '文案生成' },
  ])
})
