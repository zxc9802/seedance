import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

async function loadPromptInputHelpers() {
  const promptInputPath = path.resolve('src/components/PromptInput.jsx')
  const source = await fs.readFile(promptInputPath, 'utf8')

  const marker = 'function hasRequiredVideoAssets(mode, references) {'
  const markerIndex = source.indexOf(marker)
  if (markerIndex === -1) {
    throw new Error('Unable to locate helper export boundary in PromptInput.jsx')
  }

  const helperSource = `${source.slice(markerIndex)}\nexport { hasAllRequiredInputs, hasRequiredVideoAssets }\n`
  const moduleUrl = `data:text/javascript,${encodeURIComponent(helperSource)}`
  return import(moduleUrl)
}

test('url-based video providers should enable generation when fusion mode has uploaded image references', async () => {
  const { hasAllRequiredInputs } = await loadPromptInputHelpers()

  const enabled = hasAllRequiredInputs({
    providerConfig: {
      id: 'veo',
      outputType: 'video',
      referenceInputMode: 'url',
    },
    mode: 'fusion',
    prompt: 'make it move',
    hasTemplate: false,
    mediaList: [],
    videoReferences: {
      images: [{ id: 'img-1' }],
      videos: [],
      audios: [],
    },
    params: {},
  })

  assert.equal(enabled, true)
})
