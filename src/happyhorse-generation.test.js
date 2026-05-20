import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

test('happyhorse backend maps reference images to AliBailian video synthesis media', async () => {
  const serverSource = await fs.readFile(path.resolve('server.js'), 'utf8')

  assert.match(serverSource, /'happyhorse': \{ family: 'happyhorse' \}/)
  assert.match(serverSource, /case 'happyhorse':\s*return \{\s*method: 'POST',\s*path: '\/alibailian\/api\/v1\/services\/aigc\/video-generation\/video-synthesis'/s)
  assert.match(serverSource, /model: params\.model,\s*input: \{\s*prompt,\s*media: references\.images\.map\(\(url\) => \(\{\s*type: 'reference_image',\s*url,\s*\}\)\),\s*\},/s)
  assert.match(serverSource, /parameters: \{\s*resolution: params\.resolution \|\| '720P',\s*ratio: params\.aspectRatio \|\| '16:9',\s*duration: coercePositiveNumber\(params\.duration, 5\),\s*\},/s)
})

test('happyhorse backend queries AliBailian tasks by task id', async () => {
  const serverSource = await fs.readFile(path.resolve('server.js'), 'utf8')

  assert.match(serverSource, /case 'wanxiang':\s*case 'happyhorse':\s*return \{\s*method: 'GET',\s*path: `\/alibailian\/api\/v1\/tasks\/\$\{encodeURIComponent\(taskId\)\}`/s)
})
