import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

test('gpt-image2 frontend sends prompt, exposed params, and image references to its backend route', async () => {
  const appSource = await fs.readFile(path.resolve('src/App.jsx'), 'utf8')

  assert.match(appSource, /function buildGptImage2Request\(provider, params, prompt, mode, mediaList\)/)
  assert.match(appSource, /url: '\/api\/gpt-image2\/generations'/)
  assert.match(appSource, /quality: params\.quality/)
  assert.match(appSource, /format: params\.format/)
  assert.match(appSource, /image: mediaList/)
})

test('gpt-image2 backend proxies to Yunwu image generations with a private API key', async () => {
  const serverSource = await fs.readFile(path.resolve('server.js'), 'utf8')

  assert.match(serverSource, /app\.post\('\/api\/gpt-image2\/generations', handleGptImage2GenerateRequest\)/)
  assert.match(serverSource, /\/v1\/images\/generations/)
  assert.match(serverSource, /process\.env\.GPT_IMAGE2_API_KEY/)
  assert.match(serverSource, /image: normalizeStringArray\(body\.image\)/)
})
