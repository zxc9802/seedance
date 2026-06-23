import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

test('gpt-image2 frontend sends prompt, exposed params, and image references to its backend route', async () => {
  const appSource = await fs.readFile(path.resolve('src/App.jsx'), 'utf8')

  assert.match(appSource, /function buildGptImage2Request\(provider, params, prompt, mode, mediaList\)/)
  assert.match(appSource, /url: '\/api\/gpt-image2\/generations'/)
  assert.match(appSource, /const size = resolveImageSizeForParams\(provider, params\)/)
  assert.match(appSource, /prompt: buildGptImage2Prompt\(prompt, params, size\)/)
  assert.match(appSource, /size,/)
  assert.match(appSource, /function buildGptImage2Prompt\(prompt, params, size\)/)
  assert.match(appSource, /The final image must be exactly \$\{size\} pixels/)
  assert.match(appSource, /Fill the entire canvas edge-to-edge/)
  assert.match(appSource, /function resolveImageSizeForParams\(provider, params\)/)
  assert.match(appSource, /n: params\.sampleCount/)
  assert.match(appSource, /quality: params\.quality/)
  assert.match(appSource, /format: params\.format/)
  assert.match(appSource, /image: mediaList/)
})

test('gpt-image2 frontend preserves every returned image for preview', async () => {
  const appSource = await fs.readFile(path.resolve('src/App.jsx'), 'utf8')
  const previewSource = await fs.readFile(path.resolve('src/components/VideoPreview.jsx'), 'utf8')

  assert.match(appSource, /const imageResults = parseImageChatResponses\(data, finalPrompt\)/)
  assert.match(appSource, /imageUrls: imageResults\.map\(\(result\) => result\.url\)/)
  assert.match(appSource, /imageUrls=\{currentState\.imageUrls\}/)
  assert.match(previewSource, /imageUrls = \[\]/)
  assert.match(previewSource, /previewImageUrls\.map/)
})

test('image preview renders multiple generated images as selectable thumbnails', async () => {
  const previewSource = await fs.readFile(path.resolve('src/components/VideoPreview.jsx'), 'utf8')
  const previewCss = await fs.readFile(path.resolve('src/components/VideoPreview.css'), 'utf8')

  assert.match(previewSource, /className="image-preview-shell"/)
  assert.match(previewSource, /className=\{`image-thumb \$\{selectedImageIndex === index \? 'active' : ''\}`\}/)
  assert.match(previewSource, /setSelectedImageIndex\(index\)/)
  assert.match(previewSource, /previewImageUrls\.length > 1/)
  assert.doesNotMatch(previewSource, /className="image-result-gallery"/)
  assert.match(previewCss, /\.image-preview-shell/)
  assert.match(previewCss, /\.image-thumb-strip/)
  assert.match(previewCss, /\.image-thumb\.active/)
})

test('image preview keeps the preview group centered in the right panel', async () => {
  const previewSource = await fs.readFile(path.resolve('src/components/VideoPreview.jsx'), 'utf8')
  const previewCss = await fs.readFile(path.resolve('src/components/VideoPreview.css'), 'utf8')

  assert.match(previewSource, /className="preview-content"/)
  assert.match(previewCss, /\.preview-area\s*\{[^}]*align-items: stretch;[^}]*justify-content: flex-start;/s)
  assert.match(previewCss, /\.preview-content\s*\{[^}]*margin: auto 0;/s)
})

test('preview frames keep the original visible size instead of shrinking to their contents', async () => {
  const previewCss = await fs.readFile(path.resolve('src/components/VideoPreview.css'), 'utf8')

  assert.match(previewCss, /\.preview-frame\s*\{[^}]*flex: 0 0 auto;/s)
  assert.match(previewCss, /\.preview-frame\.portrait\s*\{\s*height: 420px;/s)
  assert.match(previewCss, /\.preview-frame\.ratio-3-4\s*\{\s*height: 420px;/s)
  assert.match(previewCss, /\.preview-frame\.landscape\s*\{\s*width: min\(100%, 520px\);/s)
  assert.match(previewCss, /\.preview-frame\.square\s*\{\s*width: min\(100%, 360px\);/s)
  assert.doesNotMatch(previewCss, /\.preview-frame\.portrait\s*\{[^}]*height: min\(100%, 420px\)/s)
})

test('gpt-image2 backend proxies to Yunwu image generations with a private API key', async () => {
  const serverSource = await fs.readFile(path.resolve('server.js'), 'utf8')

  assert.match(serverSource, /app\.post\('\/api\/gpt-image2\/generations', handleGptImage2GenerateRequest\)/)
  assert.match(serverSource, /\/v1\/images\/generations/)
  assert.match(serverSource, /process\.env\.GPT_IMAGE2_API_KEY/)
  assert.match(serverSource, /model: readFirstString\(body\.model\) \|\| 'gpt-image-2'/)
  assert.doesNotMatch(serverSource, /aspect_ratio: readFirstString/)
  assert.match(serverSource, /image: normalizeStringArray\(body\.image\)/)
})

test('gpt-image2 backend fans out multi-image requests when upstream returns one image per call', async () => {
  const serverSource = await fs.readFile(path.resolve('server.js'), 'utf8')

  assert.match(serverSource, /if \(upstreamBody\.n > 1\)/)
  assert.match(serverSource, /handleGptImage2FanoutGenerateRequest/)
  assert.match(serverSource, /Promise\.allSettled/)
  assert.match(serverSource, /n: 1/)
  assert.match(serverSource, /aggregateGptImage2FanoutPayload/)
})

test('gpt-image2 fan-out returns partial successes instead of failing the whole batch', async () => {
  const serverSource = await fs.readFile(path.resolve('server.js'), 'utf8')

  assert.match(serverSource, /const successfulPayloads = fanoutResults/)
  assert.match(serverSource, /result\.status === 'fulfilled'/)
  assert.match(serverSource, /const failedResults = fanoutResults/)
  assert.match(serverSource, /partial_error/)
  assert.match(serverSource, /requestedCount: upstreamBody\.n/)
  assert.match(serverSource, /succeededCount: successfulPayloads\.length/)
  assert.match(serverSource, /failedCount: failedResults\.length/)
})

test('image preview derives its frame from the selected aspect ratio geometry', async () => {
  const previewSource = await fs.readFile(path.resolve('src/components/VideoPreview.jsx'), 'utf8')
  const previewCss = await fs.readFile(path.resolve('src/components/VideoPreview.css'), 'utf8')

  assert.match(previewSource, /resolveAspectRatioFrameClass\(params\.aspectRatio\)/)
  assert.match(previewSource, /resolveAspectRatioFrameStyle\(params\.aspectRatio\)/)
  assert.doesNotMatch(previewSource, /case '16:9': return 'landscape'/)
  assert.match(previewCss, /aspect-ratio: var\(--preview-aspect-ratio/)
})

test('image preview hides resolution metadata when the provider hides resolution controls', async () => {
  const previewSource = await fs.readFile(path.resolve('src/components/VideoPreview.jsx'), 'utf8')

  assert.match(previewSource, /!cfg\.hideResolutionSelector && params\.resolution/)
})
