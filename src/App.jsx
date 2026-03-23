import { useCallback, useEffect, useRef, useState } from 'react'
import { PROVIDERS, PROVIDER_ORDER } from './modelConfig'
import {
  getLatestSnapshotMeta,
  loadLatestSnapshot,
  saveLatestSnapshot,
} from './snapshotStorage'

const VIDEO_PROVIDERS = new Set(
  PROVIDER_ORDER.filter((key) => PROVIDERS[key].outputType !== 'image')
)
function isVideoProvider(id) {
  return VIDEO_PROVIDERS.has(id)
}
import Header from './components/Header'
import ProviderTabs from './components/ProviderTabs'
import PromptInput from './components/PromptInput'
import ParameterPanel from './components/ParameterPanel'
import VideoPreview from './components/VideoPreview'
import './App.css'

function App() {
  const [provider, setProvider] = useState('veo')
  const [allParams, setAllParams] = useState(createInitialParams)
  const [prompt, setPrompt] = useState('')
  const [generationMode, setGenerationMode] = useState('t2v')
  const [referenceMedia, setReferenceMedia] = useState([])
  const [videoReferences, setVideoReferences] = useState(createEmptyVideoReferences)
  const [selectedTemplate, setSelectedTemplate] = useState(null)
  const [providerState, setProviderState] = useState(createInitialProviderState)
  const [snapshotMeta, setSnapshotMeta] = useState(() => getLatestSnapshotMeta())
  const [snapshotBusy, setSnapshotBusy] = useState(false)
  const [snapshotNotice, setSnapshotNotice] = useState(null)
  const videoReferencesRef = useRef(videoReferences)
  const providerStateRef = useRef(providerState)

  useEffect(() => {
    videoReferencesRef.current = videoReferences
  }, [videoReferences])

  useEffect(() => {
    providerStateRef.current = providerState
  }, [providerState])

  useEffect(() => () => {
    releaseVideoReferences(videoReferencesRef.current)
    releaseProviderPreviewUrls(providerStateRef.current)
  }, [])

  const params = allParams[provider]
  const config = PROVIDERS[provider]
  const currentState = providerState[provider] || { generating: false, progress: 0, videoUrl: null, error: null }
  const hasActiveGeneration = PROVIDER_ORDER.some((key) => providerState[key]?.generating)
  const maxImages = resolveLimit(config.maxReferenceImages, generationMode)
  const maxVideos = resolveLimit(config.maxReferenceVideos, generationMode)
  const maxAudios = resolveLimit(config.maxReferenceAudios, generationMode)

  const updateParam = useCallback((key, value) => {
    setAllParams((prev) => ({
      ...prev,
      [provider]: { ...prev[provider], [key]: value },
    }))
  }, [provider])

  const updateProviderState = useCallback((targetProvider, updates) => {
    setProviderState((prev) => ({
      ...prev,
      [targetProvider]: mergeProviderRuntimeState(prev[targetProvider], updates),
    }))
  }, [])

  const replaceVideoReferences = useCallback((updater) => {
    setVideoReferences((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      return next
    })
  }, [])

  const resetReferences = useCallback(() => {
    setReferenceMedia([])
    setVideoReferences((prev) => {
      releaseVideoReferences(prev)
      return createEmptyVideoReferences()
    })
  }, [])

  const handleSaveSnapshot = useCallback(async () => {
    setSnapshotBusy(true)
    setSnapshotNotice({ type: 'info', text: '\u6b63\u5728\u4fdd\u5b58\u5feb\u7167...' })

    try {
      const savedAt = Date.now()
      const serializedProviderState = await serializeProviderState(providerState)
      await saveLatestSnapshot({
        savedAt,
        version: 1,
        payload: {
          provider,
          allParams,
          prompt,
          generationMode,
          referenceMedia,
          videoReferences: serializeVideoReferences(videoReferences),
          selectedTemplate,
          providerState: serializedProviderState,
        },
      })

      setSnapshotMeta({ savedAt })
      setSnapshotNotice({ type: 'success', text: `\u5feb\u7167\u5df2\u4fdd\u5b58 ${formatSnapshotTime(savedAt)}` })
    } catch (error) {
      setSnapshotNotice({ type: 'error', text: error.message || '\u4fdd\u5b58\u5feb\u7167\u5931\u8d25' })
    } finally {
      setSnapshotBusy(false)
    }
  }, [
    allParams,
    generationMode,
    prompt,
    provider,
    providerState,
    referenceMedia,
    selectedTemplate,
    videoReferences,
  ])

  const handleLoadSnapshot = useCallback(async () => {
    if (hasActiveGeneration) {
      setSnapshotNotice({
        type: 'error',
        text: '\u8bf7\u5148\u7b49\u5f53\u524d\u751f\u6210\u4efb\u52a1\u7ed3\u675f\u540e\u518d\u52a0\u8f7d\u5feb\u7167',
      })
      return
    }

    setSnapshotBusy(true)
    setSnapshotNotice({ type: 'info', text: '\u6b63\u5728\u52a0\u8f7d\u5feb\u7167...' })

    try {
      const snapshot = await loadLatestSnapshot()
      if (!snapshot?.payload) {
        throw new Error('\u6d4f\u89c8\u5668\u91cc\u8fd8\u6ca1\u6709\u53ef\u52a0\u8f7d\u7684\u5feb\u7167')
      }

      const payload = snapshot.payload
      const nextProvider = isSupportedProvider(payload.provider) ? payload.provider : 'veo'
      const nextGenerationMode = getSafeGenerationMode(nextProvider, payload.generationMode)
      const nextParams = mergeSnapshotParams(payload.allParams)
      const nextProviderState = hydrateSnapshotProviderState(payload.providerState)
      const nextReferenceMedia = Array.isArray(payload.referenceMedia)
        ? payload.referenceMedia.filter((item) => typeof item === 'string')
        : []
      const nextVideoReferences = hydrateVideoReferences(payload.videoReferences)

      setProvider(nextProvider)
      setAllParams(nextParams)
      setPrompt(typeof payload.prompt === 'string' ? payload.prompt : '')
      setGenerationMode(nextGenerationMode)
      setReferenceMedia(nextReferenceMedia)
      setSelectedTemplate(payload.selectedTemplate ?? null)
      setVideoReferences((prev) => {
        releaseVideoReferences(prev)
        return nextVideoReferences
      })
      setProviderState((prev) => {
        releaseProviderPreviewUrls(prev)
        return nextProviderState
      })

      const restoredSavedAt = typeof snapshot.savedAt === 'number' ? snapshot.savedAt : Date.now()
      setSnapshotMeta({ savedAt: restoredSavedAt })
      setSnapshotNotice({
        type: 'success',
        text: `\u5df2\u52a0\u8f7d ${formatSnapshotTime(restoredSavedAt)} \u7684\u5feb\u7167`,
      })
    } catch (error) {
      setSnapshotNotice({ type: 'error', text: error.message || '\u52a0\u8f7d\u5feb\u7167\u5931\u8d25' })
    } finally {
      setSnapshotBusy(false)
    }
  }, [hasActiveGeneration])

  const handleProviderChange = useCallback((nextProvider) => {
    setProvider(nextProvider)
    setPrompt('')
    setSelectedTemplate(null)
    const nextConfig = PROVIDERS[nextProvider]
    const firstMode = nextConfig.generationModes?.[0]?.value || 't2v'
    setGenerationMode(firstMode)
    resetReferences()
  }, [resetReferences])

  const handleModeChange = useCallback((nextMode) => {
    setGenerationMode(nextMode)
    resetReferences()
  }, [resetReferences])

  const handleGenerate = useCallback(async () => {
    const finalPrompt = selectedTemplate
      ? (prompt.trim() ? `${selectedTemplate.prompt}. Additional requirements: ${prompt.trim()}` : selectedTemplate.prompt)
      : prompt.trim()

    if (!finalPrompt) return

    if (isVideoProvider(provider)) {
      const validationError = validateVideoReferenceInput(generationMode, videoReferences)
      if (validationError) {
        updateProviderState(provider, { error: validationError })
        return
      }
    } else if (generationMode !== 't2v' && referenceMedia.length === 0) {
      updateProviderState(provider, { error: '请先添加参考图片' })
      return
    }

    updateProviderState(provider, { generating: true, progress: 0, error: null, videoUrl: null })

    let progress = 0
    const progressTimer = window.setInterval(() => {
      progress += Math.random() * 8 + 3
      if (progress > 94) progress = 94
      updateProviderState(provider, { progress: Math.round(progress) })
    }, 900)

    try {
      if (isVideoProvider(provider)) {
        const uploadedReferences = await uploadVideoReferences(provider, params, videoReferences)
        if (uploadedReferences.requiresPublicBaseUrl) {
          throw new Error('参考素材已经上传到本地后端，但当前后端地址不是公网可访问地址。请部署后端到公网，或设置 PUBLIC_BASE_URL 指向公网域名/隧道。')
        }

        const requestInfo = buildVideoRequest(provider, params, finalPrompt, generationMode, uploadedReferences)
        updateProviderState(provider, { progress: 18 })

        const response = await fetch(requestInfo.url, {
          method: 'POST',
          headers: requestInfo.headers,
          body: JSON.stringify(requestInfo.body),
        })

        if (!response.ok) {
          throw new Error(await formatHttpError(response))
        }

        const data = await response.json()
        if (!data?.success) {
          throw new Error(data?.msg || data?.message || '视频生成请求失败')
        }

        const payload = data.data || {}
        const initialTask = {
          taskId: payload.result?.taskId || payload.taskId,
          status: payload.status ?? null,
          message: payload.result?.content || payload.message,
        }

        if (initialTask.status === 2 && initialTask.message) {
          window.clearInterval(progressTimer)
          const previewUrl = await resolvePreviewUrl(initialTask.message)
          updateProviderState(provider, { progress: 100, videoUrl: previewUrl })
          return
        }

        if (initialTask.status === 3) {
          throw new Error(initialTask.message || '视频生成失败')
        }

        if (!initialTask.taskId) {
          throw new Error('接口已响应，但没有返回 taskId')
        }

        let finished = false
        while (!finished) {
          await sleep(5000)
          const pollResponse = await fetch('/api/veo/queryResult', {
            method: 'POST',
            headers: requestInfo.headers,
            body: JSON.stringify({
              taskId: initialTask.taskId,
              abilityType: 'VIDEO',
            }),
          })

          if (!pollResponse.ok) {
            throw new Error(await formatHttpError(pollResponse))
          }

          const pollData = await pollResponse.json()
          if (!pollData?.success) {
            throw new Error(pollData?.msg || pollData?.message || '查询任务状态失败')
          }

          const task = pollData.data || {}
          if (task.status === 2) {
            finished = true
            window.clearInterval(progressTimer)
            const previewUrl = await resolvePreviewUrl(task.message)
            updateProviderState(provider, { progress: 100, videoUrl: previewUrl })
            return
          }

          if (task.status === 3) {
            throw new Error(task.message || '视频生成失败')
          }
        }
      } else if (!isVideoProvider(provider)) {
        const requestInfo = buildImageRequest(params, finalPrompt, generationMode, referenceMedia)
        const response = await fetch(requestInfo.url, {
          method: 'POST',
          headers: requestInfo.headers,
          body: JSON.stringify(requestInfo.body),
        })

        if (!response.ok) {
          throw new Error(await formatHttpError(response))
        }

        const data = await response.json()
        window.clearInterval(progressTimer)
        updateProviderState(provider, { progress: 100 })

        const imageResult = parseImageChatResponse(data, finalPrompt)
        if (imageResult) {
          updateProviderState(provider, { videoUrl: imageResult.url })
          return
        }

        throw new Error('图片生成已完成，但没有在响应中找到图片数据')
      }
    } catch (error) {
      updateProviderState(provider, { error: error.message || '生成失败' })
    } finally {
      window.clearInterval(progressTimer)
      updateProviderState(provider, { generating: false })
    }
  }, [
    generationMode,
    params,
    prompt,
    provider,
    referenceMedia,
    selectedTemplate,
    updateProviderState,
    videoReferences,
  ])

  return (
    <div className="app-layout">
      <Header
        onSaveSnapshot={handleSaveSnapshot}
        onLoadSnapshot={handleLoadSnapshot}
        snapshotBusy={snapshotBusy}
        snapshotLoadDisabled={hasActiveGeneration}
        hasSnapshot={Boolean(snapshotMeta?.savedAt)}
        lastSavedAt={snapshotMeta?.savedAt ?? null}
        snapshotNotice={snapshotNotice}
      />
      <main className="app-main">
        <div className="left-panel">
          <ProviderTabs provider={provider} onChange={handleProviderChange} />
          <PromptInput
            prompt={prompt}
            onPromptChange={setPrompt}
            mode={generationMode}
            onModeChange={handleModeChange}
            mediaList={referenceMedia}
            onMediaListChange={setReferenceMedia}
            videoReferences={videoReferences}
            onVideoReferencesChange={replaceVideoReferences}
            maxImages={maxImages}
            maxVideos={maxVideos}
            maxAudios={maxAudios}
            providerConfig={config}
            onGenerate={handleGenerate}
            generating={currentState.generating}
            negativePrompt={params.negativePrompt ?? ''}
            onNegativePromptChange={(value) => updateParam('negativePrompt', value)}
            providerColor={config.color}
            selectedTemplate={selectedTemplate}
            onTemplateSelect={setSelectedTemplate}
          />
          <ParameterPanel
            provider={provider}
            config={config}
            params={params}
            onUpdate={updateParam}
          />
        </div>
        <div className="right-panel">
          <VideoPreview
            videoUrl={currentState.videoUrl}
            generating={currentState.generating}
            progress={currentState.progress}
            error={currentState.error}
            params={params}
            provider={provider}
          />
        </div>
      </main>
    </div>
  )
}

function createInitialParams() {
  const initial = {}
  for (const key of PROVIDER_ORDER) initial[key] = { ...PROVIDERS[key].defaults }
  return initial
}

function createProviderRuntimeState() {
  return { generating: false, progress: 0, videoUrl: null, error: null }
}

function createInitialProviderState() {
  const state = {}
  for (const key of PROVIDER_ORDER) {
    state[key] = createProviderRuntimeState()
  }
  return state
}

function mergeProviderRuntimeState(currentState, updates) {
  const previous = currentState || createProviderRuntimeState()
  const next = { ...previous, ...updates }

  if (
    Object.prototype.hasOwnProperty.call(updates, 'videoUrl')
    && previous.videoUrl
    && previous.videoUrl !== next.videoUrl
  ) {
    revokeObjectUrl(previous.videoUrl)
  }

  return next
}

function serializeVideoReferences(references) {
  return {
    images: serializeVideoAssetList(references?.images),
    videos: serializeVideoAssetList(references?.videos),
    audios: serializeVideoAssetList(references?.audios),
  }
}

function serializeVideoAssetList(list) {
  if (!Array.isArray(list)) return []

  return list
    .filter((asset) => asset?.file)
    .map((asset) => ({
      id: asset.id,
      name: asset.name,
      size: asset.size,
      mimeType: asset.mimeType,
      file: asset.file,
    }))
}

function hydrateVideoReferences(references) {
  return {
    images: hydrateVideoAssetList(references?.images),
    videos: hydrateVideoAssetList(references?.videos),
    audios: hydrateVideoAssetList(references?.audios),
  }
}

function hydrateVideoAssetList(list) {
  if (!Array.isArray(list)) return []

  return list
    .map((asset) => hydrateVideoAsset(asset))
    .filter(Boolean)
}

function hydrateVideoAsset(asset) {
  if (!asset?.file && !asset?.blob) return null

  const blob = asset.file || asset.blob
  const file = blob instanceof File
    ? blob
    : new File([blob], asset.name || 'snapshot-asset', { type: asset.mimeType || blob.type || '' })

  return {
    id: asset.id || crypto.randomUUID(),
    file,
    name: asset.name || file.name,
    size: asset.size ?? file.size,
    mimeType: asset.mimeType || file.type,
    previewUrl: canPreviewAsset(file.type) ? URL.createObjectURL(file) : '',
  }
}

async function serializeProviderState(state) {
  const serialized = {}
  for (const key of PROVIDER_ORDER) {
    const current = state?.[key] || createProviderRuntimeState()
    serialized[key] = {
      generating: false,
      progress: 0,
      error: null,
      previewAsset: await serializePreviewAsset(current.videoUrl),
    }
  }
  return serialized
}

function hydrateSnapshotProviderState(snapshotState) {
  const initial = createInitialProviderState()

  for (const key of PROVIDER_ORDER) {
    const current = snapshotState?.[key]
    if (!current) continue

    initial[key] = {
      ...initial[key],
      videoUrl: hydratePreviewAsset(current.previewAsset) || (isPersistablePreviewUrl(current.videoUrl) ? current.videoUrl : null),
    }
  }

  return initial
}

function mergeSnapshotParams(snapshotParams) {
  const initial = createInitialParams()

  for (const key of PROVIDER_ORDER) {
    if (snapshotParams?.[key] && typeof snapshotParams[key] === 'object') {
      initial[key] = {
        ...initial[key],
        ...snapshotParams[key],
      }
    }
  }

  return initial
}

function isSupportedProvider(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROVIDERS, value)
}

function getSafeGenerationMode(provider, mode) {
  const config = PROVIDERS[provider]
  const availableModes = config?.generationModes?.map((item) => item.value) || ['t2v']
  return availableModes.includes(mode) ? mode : availableModes[0]
}

function canPreviewAsset(mimeType) {
  return typeof mimeType === 'string'
    && (mimeType.startsWith('image/') || mimeType.startsWith('video/'))
}

async function serializePreviewAsset(url) {
  if (typeof url !== 'string' || url.length === 0) return null

  if (url.startsWith('blob:')) {
    try {
      const response = await fetch(url)
      if (!response.ok) return null

      const blob = await response.blob()
      return {
        type: 'blob',
        blob,
        mimeType: blob.type || null,
      }
    } catch {
      return null
    }
  }

  if (isPersistablePreviewUrl(url)) {
    return {
      type: 'url',
      url,
    }
  }

  return null
}

function hydratePreviewAsset(asset) {
  if (!asset || typeof asset !== 'object') return null

  if (asset.type === 'url' && typeof asset.url === 'string' && asset.url.length > 0) {
    return asset.url
  }

  const blob = asset.blob || asset.file
  if (asset.type === 'blob' && blob instanceof Blob) {
    return URL.createObjectURL(blob)
  }

  return null
}

function isPersistablePreviewUrl(url) {
  return typeof url === 'string' && url.length > 0 && !url.startsWith('blob:')
}

function formatSnapshotTime(timestamp) {
  if (typeof timestamp !== 'number') return ''

  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp)
}

function buildVideoRequest(provider, params, prompt, mode, references) {
  if (!isVideoProvider(provider)) throw new Error(`Unsupported provider: ${provider}`)

  return {
    url: '/api/veo/generate',
    headers: {
      'Content-Type': 'application/json',
    },
    body: {
      modelId: params.model,
      abilityType: 'VIDEO',
      prompt,
      payload: {
        resources: references.images,
        referVideoUrl: references.videos,
        referAudioUrl: references.audios,
        params: {
          mode: mapVideoMode(mode),
          resolution: params.resolution,
          scale: params.aspectRatio,
          duration: params.duration,
          generateAudio: Boolean(params.generateAudio),
        },
      },
    },
  }
}

function buildImageRequest(params, prompt, mode, mediaList) {
  const content = [{ type: 'text', text: prompt }]
  if (mode === 'i2v') {
    for (const media of mediaList) {
      content.push({
        type: 'image_url',
        image_url: { url: media },
      })
    }
  }

  return {
    url: '/api/image/chat/completions',
    headers: {
      'Content-Type': 'application/json',
    },
    body: {
      model: params.model,
      messages: [{ role: 'user', content }],
    },
  }
}

function mapVideoMode(mode) {
  switch (mode) {
    case 'i2v':
      return 'image_to_video'
    case 'flf':
      return 'first_last_frame'
    case 'fusion':
    case 'ref':
      return 'fusion_video'
    case 't2v':
    default:
      return 'text_to_video'
  }
}

function resolveLimit(limitConfig, mode) {
  if (typeof limitConfig === 'number') return limitConfig
  if (!limitConfig) return 0
  return limitConfig[mode] ?? 0
}

function validateVideoReferenceInput(mode, references) {
  if (mode === 't2v') return null
  if (mode === 'i2v' && references.images.length !== 1) return '图生视频模式需要 1 张参考图片'
  if (mode === 'flf' && references.images.length !== 2) return '首尾帧模式需要 2 张图片，第一张是首帧，第二张是尾帧'

  if (mode === 'ref') {
    if (references.images.length === 0) return '参考图片模式至少需要 1 张参考图片'
  }

  if (mode === 'fusion') {
    const imageCount = references.images.length
    const videoCount = references.videos.length
    const audioCount = references.audios.length
    if (imageCount + videoCount + audioCount === 0) {
      return '融合参考模式至少需要 1 个参考素材'
    }
    if (imageCount + videoCount === 0) {
      return '音频不能单独作为参考，至少还需要 1 张图片或 1 段视频'
    }
  }

  return null
}

async function uploadVideoReferences(provider, params, references) {
  const imageMaterialType = resolveImageMaterialType(provider, params)
  const images = await uploadReferenceBatch(references.images, { materialType: imageMaterialType })
  const videos = await uploadReferenceBatch(references.videos)
  const audios = await uploadReferenceBatch(references.audios)

  return {
    images: images.resourceRefs,
    videos: videos.resourceRefs,
    audios: audios.resourceRefs,
    requiresPublicBaseUrl: images.requiresPublicBaseUrl || videos.requiresPublicBaseUrl || audios.requiresPublicBaseUrl,
  }
}

async function uploadReferenceBatch(assets, options = {}) {
  if (!assets.length) {
    return { resourceRefs: [], requiresPublicBaseUrl: false }
  }

  const formData = new FormData()
  for (const asset of assets) {
    formData.append('files', asset.file, asset.file.name)
  }
  if (options.materialType && options.materialType !== 'direct') {
    formData.append('materialType', options.materialType)
  }

  const response = await fetch('/api/upload', {
    method: 'POST',
    body: formData,
  })

  if (!response.ok) {
    throw new Error(await formatHttpError(response))
  }

  const data = await response.json()
  if (!data?.success || !Array.isArray(data.files)) {
    throw new Error(data?.message || '上传参考素材失败')
  }

  return {
    resourceRefs: data.files.map((file) => file.resourceRef || file.url),
    requiresPublicBaseUrl: data.publiclyReachable === false,
  }
}

function resolveImageMaterialType(provider, params) {
  if (provider !== 'veo') return 'direct'
  return params.imageMaterialType || 'role'
}

function createEmptyVideoReferences() {
  return { images: [], videos: [], audios: [] }
}

function releaseVideoReferences(references) {
  for (const key of ['images', 'videos', 'audios']) {
    for (const asset of references[key] || []) {
      revokeObjectUrl(asset.previewUrl)
    }
  }
}

function releaseProviderPreviewUrls(state) {
  if (!state) return

  for (const key of PROVIDER_ORDER) {
    revokeObjectUrl(state[key]?.videoUrl)
  }
}

function revokeObjectUrl(url) {
  if (typeof url === 'string' && url.startsWith('blob:')) {
    URL.revokeObjectURL(url)
  }
}

async function resolvePreviewUrl(url) {
  if (!url || url.startsWith('blob:') || url.startsWith('data:')) return url

  try {
    const response = await fetch(url)
    if (!response.ok) return url
    const blob = await response.blob()
    return URL.createObjectURL(blob)
  } catch {
    return url
  }
}

async function formatHttpError(response) {
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    const payload = await response.json()
    const message = payload?.message || payload?.error?.message || JSON.stringify(payload)

    if (response.status === 401 && payload?.redirectUrl && typeof window !== 'undefined') {
      window.location.href = payload.redirectUrl
      return message || '登录已失效，正在返回主站...'
    }

    return `API 错误 (${response.status}): ${message}`
  }
  const body = await response.text()
  return `API 错误 (${response.status}): ${body}`
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function parseImageChatResponse(data, fallbackPrompt) {
  const content = data?.choices?.[0]?.message?.content

  if (typeof content === 'string') {
    const markdownMatch = content.match(/!\[.*?\]\((data:image\/[^;]+;base64,[^)]+)\)/)
    if (markdownMatch) {
      return { url: markdownMatch[1], revised_prompt: fallbackPrompt }
    }

    if (content.startsWith('data:image/')) {
      return { url: content, revised_prompt: fallbackPrompt }
    }

    const dataUrlMatch = content.match(/data:(image\/[a-zA-Z+]+);base64,([A-Za-z0-9+/=\s]+)/)
    if (dataUrlMatch) {
      return { url: dataUrlMatch[0].replace(/\s/g, ''), revised_prompt: fallbackPrompt }
    }

    const rawBase64Match = content.match(/\b([A-Za-z0-9+/]{100,}={0,2})\b/)
    if (rawBase64Match) {
      return { url: `data:image/png;base64,${rawBase64Match[1]}`, revised_prompt: fallbackPrompt }
    }
  }

  if (Array.isArray(content)) {
    const imageItem = content.find((item) => item?.type === 'image_url' && item?.image_url?.url)
    if (imageItem) {
      return { url: imageItem.image_url.url, revised_prompt: fallbackPrompt }
    }
  }

  const parts = data?.choices?.[0]?.message?.parts
  if (parts) {
    const imagePart = parts.find((part) => part.inline_data)
    if (imagePart) {
      const mimeType = imagePart.inline_data.mime_type || 'image/png'
      return { url: `data:${mimeType};base64,${imagePart.inline_data.data}`, revised_prompt: fallbackPrompt }
    }
  }

  return null
}

export default App
