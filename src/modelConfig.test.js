import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

async function loadModelConfig() {
  const modelConfigPath = path.resolve('src/modelConfig.js')
  const yunwuProvidersUrl = pathToFileURL(path.resolve('src/yunwuProviders.js')).href
  const source = await fs.readFile(modelConfigPath, 'utf8')
  const rewrittenSource = source.replace("'./yunwuProviders'", `'${yunwuProvidersUrl}'`)
  const moduleUrl = `data:text/javascript,${encodeURIComponent(rewrittenSource)}`
  return import(moduleUrl)
}

async function loadProviders() {
  const module = await loadModelConfig()
  return module.PROVIDERS
}

test('Seedance enterprise stable exposes priced resolution options while defaulting to 720p', async () => {
  const providers = await loadProviders()

  assert.equal(providers.veo.selectorLabel, 'seedance企业稳定版')
  assert.equal(providers.veo.name, 'seedance企业稳定版')
  assert.deepEqual(providers.veo.resolutions.default, ['480p', '720p', '1080p'])
  assert.equal(providers.veo.defaults.resolution, '720p')
  assert.equal(providers.veo.defaults.imageMaterialType, 'role')
})

test('main model selector only shows the approved provider entries', async () => {
  const { PROVIDERS, PROVIDER_ORDER, MODEL_TYPES } = await loadModelConfig()

  assert.deepEqual(PROVIDER_ORDER, ['veo', 'gpt-image2', 'gemini-image-aggregation', 'happyhorse'])
  assert.equal(PROVIDERS['gemini-image-aggregation'].selectorLabel, 'nanobanana企业稳定版')
  assert.equal(PROVIDERS['gemini-image-aggregation'].name, 'nanobanana企业稳定版')
  assert.deepEqual(MODEL_TYPES.seedance.providers, ['veo'])
  assert.deepEqual(MODEL_TYPES.image.providers, ['gpt-image2', 'gemini-image-aggregation'])
  assert.equal(MODEL_TYPES.veo, undefined)
  assert.equal(MODEL_TYPES.kling, undefined)
  assert.equal(MODEL_TYPES.wan, undefined)
  assert.equal(MODEL_TYPES.copywriting, undefined)
})

test('public header exposes the current credit pricing explanation', async () => {
  const headerSource = await fs.readFile(path.resolve('src/components/Header.jsx'), 'utf8')
  const pricingIndex = headerSource.indexOf('pricing-info')
  const adminIndex = headerSource.indexOf('{showAdminEntry ?')

  assert.ok(pricingIndex > 0)
  assert.ok(pricingIndex < adminIndex)
  assert.match(headerSource, /价格说明/)
  assert.match(headerSource, /seedance2\.0[\s\S]*文生视频[\s\S]*480P: 2积分\/秒[\s\S]*720P: 4积分\/秒[\s\S]*1080P: 10积分\/秒/)
  assert.match(headerSource, /seedance2\.0 fast[\s\S]*文生视频[\s\S]*480P: 1积分\/秒[\s\S]*720P: 3积分\/秒/)
  assert.match(headerSource, /nanobanana企业稳定版[\s\S]*3\.5积分\/张/)
})

test('happyhorse exposes an open reference-image video provider locked to 720P', async () => {
  const { MODEL_TYPES, PROVIDERS, PROVIDER_ORDER } = await loadModelConfig()
  const provider = PROVIDERS.happyhorse

  assert.ok(provider)
  assert.equal(provider.id, 'happyhorse')
  assert.equal(provider.backendKind, 'yunwu')
  assert.equal(provider.typeId, 'happyhorse')
  assert.equal(provider.selectorLabel, 'happyhorse')
  assert.equal(provider.name, 'happyhorse')
  assert.deepEqual(provider.models, [
    { value: 'happyhorse-1.0-r2v', label: 'HappyHorse 1.0 R2V', tag: 'Yunwu' },
  ])
  assert.deepEqual(provider.resolutions.default, ['720P'])
  assert.equal(provider.defaults.resolution, '720P')
  assert.deepEqual(provider.aspectRatios, ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'])
  assert.deepEqual(provider.durations, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
  assert.deepEqual(provider.maxReferenceImages, { ref: 10 })
  assert.deepEqual(provider.generationModes.map((mode) => mode.value), ['ref'])
  assert.ok(PROVIDER_ORDER.includes('happyhorse'))
  assert.deepEqual(MODEL_TYPES.happyhorse.providers, ['happyhorse'])
})

test('gpt-image2 exposes Yunwu image generation parameters in the frontend config', async () => {
  const providers = await loadProviders()
  const provider = providers['gpt-image2']

  assert.equal(provider.id, 'gpt-image2')
  assert.equal(provider.outputType, 'image')
  assert.equal(provider.backendKind, 'gpt-image2')
  assert.equal(provider.defaults.model, 'gpt-image-2')
  assert.deepEqual(provider.aspectRatios, ['1:1', '16:9', '9:16', '3:4'])
  assert.deepEqual(provider.resolutions.default, ['1024x1024', '1536x864', '864x1536', '1152x1536'])
  assert.equal(provider.hideResolutionSelector, true)
  assert.deepEqual(provider.resolutionByAspectRatio, {
    '1:1': '1024x1024',
    '16:9': '1536x864',
    '9:16': '864x1536',
    '3:4': '1152x1536',
  })
  assert.deepEqual(provider.aspectRatioByResolution, {
    '1024x1024': '1:1',
    '1536x864': '16:9',
    '864x1536': '9:16',
    '1152x1536': '3:4',
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
