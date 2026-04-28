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

test('seedance1 is configured to use the real backend path', async () => {
  const providers = await loadProviders()
  const seedance1 = providers.veo

  assert.notEqual(seedance1.frontendMock, true)
  assert.equal(seedance1.referenceInputMode, 'url')
})

test('seedance1 exposes the Seedance 2 fast model on the same channel', async () => {
  const providers = await loadProviders()
  const seedance1 = providers.veo

  assert.ok(seedance1.models.some((model) => model.value === 'doubao-seedance-2-0-fast-260128'))
})

test('seedance1 defaults Seedance 2 models to person material review', async () => {
  const providers = await loadProviders()
  const seedance1 = providers.veo

  assert.equal(seedance1.defaults.imageMaterialType, 'role')
  assert.equal(seedance1.modelMaterialTypeDefaults?.['doubao-seedance-2-0-fast-260128'], 'role')
})

test('App generation flow no longer short-circuits seedance1 to a frontend mock', async () => {
  const appSource = await fs.readFile(path.resolve('src/App.jsx'), 'utf8')

  assert.doesNotMatch(appSource, /mockVideoGeneration/)
  assert.doesNotMatch(appSource, /isFrontendMockVideoProvider/)
  assert.doesNotMatch(appSource, /Failed to fetch/)
  assert.match(appSource, /function resolveImageMaterialType\(provider, params\) \{\s+if \(provider !== 'veo'\) return 'direct'\s+return params\.imageMaterialType \|\| 'direct'/s)
  assert.match(appSource, /function resolveModelMaterialTypeDefault\(config, model\)/)
})
