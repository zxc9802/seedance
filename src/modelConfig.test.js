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

test('Claude copywriting providers expose claude1 and claude2 options', async () => {
  const providers = await loadProviders()
  const claude1 = providers['claude1-copywriting']
  const claude2 = providers['bcai-copywriting']

  assert.equal(claude1.id, 'claude1-copywriting')
  assert.equal(claude1.typeId, 'copywriting')
  assert.equal(claude1.typeLabel, '文案模型')
  assert.equal(claude1.selectorLabel, 'claude1')
  assert.equal(claude1.outputType, 'text')
  assert.equal(claude1.backendKind, 'copywriting-chat')
  assert.equal(claude1.defaults.model, 'claude-sonnet-4-6')

  assert.equal(claude2.id, 'bcai-copywriting')
  assert.equal(claude2.selectorLabel, 'claude2')
  assert.equal(claude2.outputType, 'text')
  assert.equal(claude2.backendKind, 'copywriting-chat')
  assert.equal(claude2.defaults.model, 'claude-sonnet-4-6')

  assert.deepEqual(claude1.generationModes, [
    { value: 'copywriting', label: '文案生成' },
  ])
})
