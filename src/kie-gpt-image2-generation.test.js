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

test('gpt image2(2) exposes the verified Kie text and reference-image modes', async () => {
  const providers = await loadProviders()
  const provider = providers['gpt-image2-2']

  assert.ok(provider)
  assert.equal(provider.selectorLabel, 'gpt image2(2)')
  assert.equal(provider.name, 'gpt image2(2)')
  assert.equal(provider.backendKind, 'kie-gpt-image2')
  assert.equal(provider.defaults.model, 'gpt-image-2-text-to-image')
  assert.deepEqual(provider.aspectRatios, ['auto', '1:1'])
  assert.equal(provider.maxReferenceImages, 1)
})

test('gpt image2(2) frontend uploads references and polls the Kie backend', async () => {
  const appSource = await fs.readFile(path.resolve('src/App.jsx'), 'utf8')

  assert.match(appSource, /function isKieGptImage2Provider\(id\)/)
  assert.match(appSource, /buildKieGptImage2Request/)
  assert.match(appSource, /url: '\/api\/kie\/gpt-image2\/generate'/)
  assert.match(appSource, /url: '\/api\/kie\/gpt-image2\/query'/)
  assert.match(appSource, /uploadImageReferences\(referenceMedia\)/)
  assert.match(appSource, /inputUrls/)
})

test('gpt image2(2) backend selects both Kie models and normalizes task results', async () => {
  const serverSource = await fs.readFile(path.resolve('server.js'), 'utf8')

  assert.match(serverSource, /process\.env\.KIE_GPT_IMAGE2_API_BASE_URL/)
  assert.match(serverSource, /process\.env\.KIE_GPT_IMAGE2_API_KEY/)
  assert.match(serverSource, /'gpt-image-2-text-to-image'/)
  assert.match(serverSource, /'gpt-image-2-image-to-image'/)
  assert.match(serverSource, /\/api\/v1\/jobs\/createTask/)
  assert.match(serverSource, /\/api\/v1\/jobs\/recordInfo/)
  assert.match(serverSource, /parseKieGptImage2ResultJson\(data\.resultJson\)/)
  assert.match(serverSource, /result\?\.resultUrls/)
})
