import { useCallback, useEffect, useRef, useState } from 'react'
import { PROVIDERS, PROVIDER_ORDER } from './modelConfig'
import {
  getLatestSnapshotMeta,
  loadLatestSnapshot,
  saveLatestSnapshot,
} from './snapshotStorage'
import Header from './components/Header'
import ModelSelector from './components/ModelSelector'
import PromptInput from './components/PromptInput'
import ParameterPanel from './components/ParameterPanel'
import VideoPreview from './components/VideoPreview'
import './App.css'

const VIDEO_PROVIDERS = new Set(
  PROVIDER_ORDER.filter((key) => PROVIDERS[key].outputType !== 'image')
)
function isVideoProvider(id) {
  return VIDEO_PROVIDERS.has(id)
}
function isVeoFastProvider(id) {
  return id === 'veo31fast'
}

function isKlingProvider(id) {
  return id === 'kling'
}

function isWanProvider(id) {
  return PROVIDERS[id]?.backendKind === 'dashscope-wan'
}

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
  const [showAdminEntry, setShowAdminEntry] = useState(false)
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

  useEffect(() => {
    setAllParams((prev) => normalizeAllParams(prev))
  }, [])

  useEffect(() => {
    let cancelled = false

    fetch('/api/session')
      .then(async (response) => {
        const payload = await response.json().catch(() => null)
        if (cancelled) return
        setShowAdminEntry(response.ok && payload?.data?.isAdmin === true)
      })
      .catch(() => {
        if (!cancelled) {
          setShowAdminEntry(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  const params = normalizeParamsForProvider(provider, allParams[provider])
  const config = PROVIDERS[provider]
  const currentState = providerState[provider] || { generating: false, progress: 0, videoUrl: null, error: null }
  const hasActiveGeneration = PROVIDER_ORDER.some((key) => providerState[key]?.generating)
  const maxImages = resolveImageLimit(config, generationMode, videoReferences)
  const maxVideos = resolveVideoLimit(config, generationMode, videoReferences)
  const maxAudios = resolveLimit(config.maxReferenceAudios, generationMode)

  const updateParam = useCallback((key, value) => {
    setAllParams((prev) => ({
      ...prev,
      [provider]: normalizeParamsForProvider(provider, { ...prev[provider], [key]: value }),
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
          allParams: normalizeAllParams(allParams),
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

  const handleOpenAdmin = useCallback(() => {
    window.open('/admin', '_blank', 'noopener')
  }, [])

  const handleGenerate = useCallback(async () => {
    const finalPrompt = selectedTemplate
      ? (prompt.trim() ? `${selectedTemplate.prompt}. Additional requirements: ${prompt.trim()}` : selectedTemplate.prompt)
      : prompt.trim()
    const usageMediaSummary = isVideoProvider(provider)
      ? buildUsageMediaSummaryFromVideoReferences(videoReferences)
      : buildUsageMediaSummaryFromImageMedia(referenceMedia)

    if (!finalPrompt) return

    if (isVideoProvider(provider)) {
        const validationError = validateVideoReferenceInput(provider, params, generationMode, videoReferences)
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
      if (isVeoFastProvider(provider)) {
        const base64Images = await readVideoReferencesAsBase64(videoReferences)
        const requestBody = buildVeoFastRequest(params, finalPrompt, generationMode, base64Images)
        updateProviderState(provider, { progress: 15 })

        const response = await fetch('/api/veo-fast/generate', {
          method: 'POST',
          headers: withUsageMediaSummaryHeaders({ 'Content-Type': 'application/json' }, usageMediaSummary),
          body: JSON.stringify(requestBody),
        })

        if (!response.ok) {
          throw new Error(await formatHttpError(response))
        }

        const data = await response.json()
        const taskId = data?.task_id || data?.data?.task_id || data?.taskId
        if (!taskId) {
          throw new Error('接口已响应，但没有返回 task_id')
        }

        updateProviderState(provider, { progress: 25 })

        let finished = false
        while (!finished) {
          await sleep(5000)
          const pollResponse = await fetch(`/api/veo-fast/status/${encodeURIComponent(taskId)}`)

          if (!pollResponse.ok) {
            throw new Error(await formatHttpError(pollResponse))
          }

          const pollData = await pollResponse.json()
          const pollPayload = pollData?.data || pollData
          const state = normalizeTaskState(
            pollPayload?.state || pollPayload?.status || pollData?.state || pollData?.status,
          )
          const directUrl = extractVeoFastVideoUrl(pollData)

          if (
            state === 'succeeded'
            || state === 'completed'
            || ((pollPayload?.success === true || pollData?.success === true) && directUrl)
          ) {
            finished = true
            window.clearInterval(progressTimer)
            const previewUrl = directUrl
              ? await resolvePreviewUrl(directUrl)
              : await resolveVeoFastPreviewUrl(taskId)
            updateProviderState(provider, { progress: 100, videoUrl: previewUrl })
            return
          }

          if (state === 'failed') {
            throw new Error(
              pollPayload?.error
                || pollPayload?.message
                || pollData?.error
                || pollData?.message
                || '视频生成失败',
            )
          }
        }
      } else if (isWanProvider(provider)) {
        const uploadedReferences = await uploadVideoReferences(provider, params, videoReferences)
        if (uploadedReferences.requiresPublicBaseUrl) {
          throw new Error('参考素材已经上传到本地后端，但当前后端地址不是公网可访问地址。请部署后端到公网，或设置 PUBLIC_BASE_URL 指向公网域名/隧道。')
        }

        const requestInfo = buildWanVideoRequest(provider, params, finalPrompt, generationMode, uploadedReferences)
        updateProviderState(provider, { progress: 18 })

        const response = await fetch(requestInfo.url, {
          method: 'POST',
          headers: withUsageMediaSummaryHeaders(requestInfo.headers, usageMediaSummary),
          body: JSON.stringify(requestInfo.body),
        })

        if (!response.ok) {
          throw new Error(await formatHttpError(response))
        }

        const data = await response.json()
        if (!data?.success) {
          throw new Error(data?.message || '视频生成请求失败')
        }

        const initialTask = normalizeWanTask(data?.data)
        if (initialTask.videoUrl) {
          window.clearInterval(progressTimer)
          const previewUrl = await resolveWanPreviewUrl(initialTask)
          updateProviderState(provider, { progress: 100, videoUrl: previewUrl })
          return
        }

        if (!initialTask.taskId) {
          throw new Error('接口已响应，但没有返回 taskId')
        }

        let finished = false
        while (!finished) {
          await sleep(5000)
          const pollRequest = buildWanQueryRequest(provider, initialTask.taskId)
          const pollResponse = await fetch(pollRequest.url, {
            method: 'POST',
            headers: pollRequest.headers,
            body: JSON.stringify(pollRequest.body),
          })

          if (!pollResponse.ok) {
            throw new Error(await formatHttpError(pollResponse))
          }

          const pollData = await pollResponse.json()
          if (!pollData?.success) {
            throw new Error(pollData?.message || '查询任务状态失败')
          }

          const task = normalizeWanTask(pollData.data)
          const state = normalizeTaskState(task.status)
          if ((state === 'succeeded' || state === 'completed') && task.videoUrl) {
            finished = true
            window.clearInterval(progressTimer)
            const previewUrl = await resolveWanPreviewUrl(task)
            updateProviderState(provider, { progress: 100, videoUrl: previewUrl })
            return
          }

          if (state === 'failed') {
            throw new Error(task.message || '视频生成失败')
          }
        }
      } else if (isVideoProvider(provider)) {
        const uploadedReferences = await uploadVideoReferences(provider, params, videoReferences)
        if (uploadedReferences.requiresPublicBaseUrl) {
          throw new Error('参考素材已经上传到本地后端，但当前后端地址不是公网可访问地址。请部署后端到公网，或设置 PUBLIC_BASE_URL 指向公网域名/隧道。')
        }

        const requestInfo = buildVideoRequest(provider, params, finalPrompt, generationMode, uploadedReferences)
        updateProviderState(provider, { progress: 18 })

        const response = await fetch(requestInfo.url, {
          method: 'POST',
          headers: withUsageMediaSummaryHeaders(requestInfo.headers, usageMediaSummary),
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
          headers: withUsageMediaSummaryHeaders(requestInfo.headers, usageMediaSummary),
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

        throw new Error(buildImageResponseParseError(data))
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
        onOpenAdmin={handleOpenAdmin}
        onSaveSnapshot={handleSaveSnapshot}
        onLoadSnapshot={handleLoadSnapshot}
        snapshotBusy={snapshotBusy}
        snapshotLoadDisabled={hasActiveGeneration}
        hasSnapshot={Boolean(snapshotMeta?.savedAt)}
        lastSavedAt={snapshotMeta?.savedAt ?? null}
        snapshotNotice={snapshotNotice}
        showAdminEntry={showAdminEntry}
      />
      <main className="app-main">
        <div className="left-panel">
          <ModelSelector provider={provider} onChange={handleProviderChange} />
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

let videoAssetOrderCounter = 0

function nextVideoAssetOrder() {
  videoAssetOrderCounter += 1
  return Date.now() * 1000 + videoAssetOrderCounter
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
      order: asset.order,
      name: asset.name,
      size: asset.size,
      mimeType: asset.mimeType,
      file: asset.file,
    }))
}

const USAGE_MEDIA_SUMMARY_HEADER = 'X-Usage-Media-Summary'

function createEmptyUsageMediaSummary() {
  return {
    images: { count: 0, bytes: 0 },
    videos: { count: 0, bytes: 0 },
    audios: { count: 0, bytes: 0 },
  }
}

function normalizeUsageMediaMetric(items) {
  return {
    count: items.length,
    bytes: items.reduce((total, item) => total + Math.max(0, Number(item?.size) || 0), 0),
  }
}

function buildUsageMediaSummaryFromVideoReferences(references) {
  return {
    images: normalizeUsageMediaMetric(Array.isArray(references?.images) ? references.images : []),
    videos: normalizeUsageMediaMetric(Array.isArray(references?.videos) ? references.videos : []),
    audios: normalizeUsageMediaMetric(Array.isArray(references?.audios) ? references.audios : []),
  }
}

function estimateBase64Bytes(base64) {
  if (typeof base64 !== 'string' || !base64.trim()) return 0
  const normalized = base64.replace(/\s/g, '')
  const paddingLength = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - paddingLength)
}

function buildUsageMediaSummaryFromImageMedia(mediaList) {
  const images = Array.isArray(mediaList) ? mediaList : []
  return {
    ...createEmptyUsageMediaSummary(),
    images: {
      count: images.length,
      bytes: images.reduce((total, media) => total + estimateBase64Bytes(extractImageBase64Payload(media)), 0),
    },
  }
}

function encodeUsageMediaSummary(summary) {
  try {
    return encodeURIComponent(JSON.stringify(summary))
  } catch {
    return ''
  }
}

function withUsageMediaSummaryHeaders(headers, summary) {
  const encoded = encodeUsageMediaSummary(summary)
  if (!encoded) return headers

  return {
    ...headers,
    [USAGE_MEDIA_SUMMARY_HEADER]: encoded,
  }
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
    order: typeof asset.order === 'number' ? asset.order : nextVideoAssetOrder(),
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

  return normalizeAllParams(initial)
}

function normalizeAllParams(allParams) {
  let changed = false
  const next = { ...allParams }

  for (const key of PROVIDER_ORDER) {
    const normalized = normalizeParamsForProvider(key, next[key])
    if (normalized !== next[key]) {
      next[key] = normalized
      changed = true
    }
  }

  return changed ? next : allParams
}

function normalizeParamsForProvider(provider, params) {
  const config = PROVIDERS[provider]
  if (!config) return params

  const resolutionOptions = config.resolutions?.[params.model] || config.resolutions?.default || []

  if (resolutionOptions.length > 0 && !resolutionOptions.includes(params.resolution)) {
    return {
      ...params,
      resolution: resolutionOptions[0],
    }
  }

  return params
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

  if (isKlingProvider(provider) && mode === 'fusion') {
    if (references.videos.length > 1) {
      return '可灵参考模式最多上传 1 段参考视频'
    }

    if (references.videos.length > 0 && references.images.length > 4) {
      return '可灵带参考视频时，参考图片最多 4 张'
    }

    if (references.videos.length === 0 && references.images.length > 7) {
      return '可灵参考模式最多上传 7 张参考图片'
    }

    if (references.videos.length > 0 && params.generateAudio) {
      return '可灵带参考视频时仅支持无声，请关闭“生成音频”'
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
  const generateAudio = isKlingProvider(provider) && references.videos.length > 0
    ? false
    : Boolean(params.generateAudio)

  const payload = {
    params: {
      mode: mapVideoMode(mode),
      resolution: params.resolution,
      scale: params.aspectRatio,
      duration: params.duration,
      generateAudio,
    },
  }

  if (references.images.length > 0) payload.resources = references.images
  if (references.videos.length > 0) payload.referVideoUrl = references.videos
  if (references.audios.length > 0) payload.referAudioUrl = references.audios

  return {
    url: '/api/veo/generate',
    headers: {
      'Content-Type': 'application/json',
    },
    body: {
      modelId: params.model,
      abilityType: 'VIDEO',
      prompt,
      payload,
    },
  }
}

function buildWanVideoRequest(provider, params, prompt, mode, references) {
  return {
    url: '/api/wan/generate',
    headers: {
      'Content-Type': 'application/json',
    },
    body: {
      providerId: provider,
      prompt,
      mode,
      params: {
        ...params,
        generateAudio: Boolean(params.generateAudio),
        watermark: Boolean(params.watermark),
      },
      references,
    },
  }
}

function buildWanQueryRequest(provider, taskId) {
  return {
    url: '/api/wan/query',
    headers: {
      'Content-Type': 'application/json',
    },
    body: {
      providerId: provider,
      taskId,
    },
  }
}

function normalizeWanTask(data) {
  return {
    taskId: typeof data?.taskId === 'string' ? data.taskId : null,
    status: typeof data?.status === 'string' ? data.status : null,
    message: typeof data?.message === 'string' ? data.message : null,
    videoUrl: typeof data?.videoUrl === 'string' ? data.videoUrl : null,
    previewUrl: typeof data?.previewUrl === 'string' ? data.previewUrl : null,
  }
}

async function resolveWanPreviewUrl(task) {
  if (typeof task?.previewUrl === 'string' && task.previewUrl.length > 0) {
    return task.previewUrl
  }

  return resolvePreviewUrl(task?.videoUrl || null)
}

function buildImageRequest(params, prompt, mode, mediaList) {
  const content = [{ type: 'text', text: prompt }]
  if (mode === 'i2v') {
    for (const media of mediaList) {
      const rawBase64 = extractImageBase64Payload(media)
      if (!rawBase64) {
        throw new Error('参考图片格式无效，图生图仅支持 Base64 图片输入')
      }

      content.push({
        type: 'image_base64',
        image_base64: rawBase64,
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

function extractImageBase64Payload(media) {
  if (typeof media !== 'string') return null

  const dataUrlMatch = media.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i)
  if (dataUrlMatch) {
    return dataUrlMatch[1].replace(/\s/g, '')
  }

  const normalized = media.replace(/\s/g, '')
  if (/^[A-Za-z0-9+/=]+$/.test(normalized) && normalized.length > 100) {
    return normalized
  }

  return null
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

function buildVeoFastRequest(params, prompt, mode, base64Images) {
  const instance = { prompt }

  if ((mode === 'i2v' || mode === 'flf' || mode === 'ref') && base64Images.length >= 1) {
    instance.image = {
      bytesBase64Encoded: base64Images[0].base64,
      mimeType: base64Images[0].mimeType,
    }
  }

  if ((mode === 'flf' || mode === 'ref') && base64Images.length >= 2) {
    instance.lastFrame = {
      bytesBase64Encoded: base64Images[1].base64,
      mimeType: base64Images[1].mimeType,
    }
  }

  if (mode === 'ref' && base64Images.length > 2) {
    instance.referenceImages = base64Images.slice(2).map((img) => ({
      image: {
        bytesBase64Encoded: img.base64,
        mimeType: img.mimeType,
      },
    }))
  }

  return {
    model: params.model,
    prompt,
    instances: [instance],
    parameters: {
      aspectRatio: params.aspectRatio,
      durationSeconds: params.duration,
      resolution: params.resolution,
    },
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result
      const base64 = dataUrl.split(',')[1]
      resolve({ base64, mimeType: file.type || 'image/png' })
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

async function readVideoReferencesAsBase64(references) {
  const results = []
  for (const asset of references.images) {
    if (asset.file) {
      const converted = await fileToBase64(asset.file)
      results.push(converted)
    }
  }
  return results
}

function resolveLimit(limitConfig, mode) {
  if (typeof limitConfig === 'number') return limitConfig
  if (!limitConfig) return 0
  return limitConfig[mode] ?? 0
}

function resolveImageLimit(config, mode, references) {
  const baseLimit = resolveLimit(config?.maxReferenceImages, mode)
  if (config?.id === 'wan1') {
    return Math.max(0, Math.min(baseLimit, 5 - (references?.videos?.length || 0)))
  }
  if (config?.id === 'kling' && mode === 'fusion' && references?.videos?.length > 0) {
    return Math.min(baseLimit, 4)
  }
  return baseLimit
}

function resolveVideoLimit(config, mode, references) {
  const baseLimit = resolveLimit(config?.maxReferenceVideos, mode)
  if (config?.id === 'wan1') {
    return Math.max(0, Math.min(baseLimit, 5 - (references?.images?.length || 0)))
  }
  return baseLimit
}

function validateVideoReferenceInput(provider, params, mode, references) {
  const wanValidationError = validateWanReferenceInput(provider, mode, references)
  const klingValidationError = validateKlingReferenceInput(provider, params, mode, references)
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

  if (wanValidationError) {
    return wanValidationError
  }

  return klingValidationError
}

function validateWanReferenceInput(provider, mode, references) {
  if (!isWanProvider(provider) || mode !== 'fusion') return null

  const imageCount = references.images.length
  const videoCount = references.videos.length
  const totalVisualCount = imageCount + videoCount

  if (videoCount > 3) {
    return '万象参考视频最多 3 段'
  }

  if (imageCount > 5) {
    return '万象参考图片最多 5 张'
  }

  if (totalVisualCount > 5) {
    return '万象参考图片和视频总数不能超过 5 个'
  }

  return null
}

function validateKlingReferenceInput(provider, params, mode, references) {
  if (!isKlingProvider(provider) || mode !== 'fusion') return null

  if (references.videos.length > 1) {
    return '可灵参考模式最多上传 1 段参考视频'
  }

  if (references.videos.length > 0 && references.images.length > 4) {
    return '可灵带参考视频时，参考图片最多 4 张'
  }

  if (references.videos.length === 0 && references.images.length > 7) {
    return '可灵参考模式最多上传 7 张参考图片'
  }

  if (references.videos.length > 0 && params.generateAudio) {
    return '可灵带参考视频时仅支持无声，请关闭“生成音频”'
  }

  return null
}

async function uploadVideoReferences(provider, params, references) {
  const imageMaterialType = resolveImageMaterialType(provider, params)
  const uploadOptions = resolveReferenceUploadOptions(provider, params)
  const images = await uploadReferenceBatch(references.images, { materialType: imageMaterialType, ...uploadOptions })
  const videos = await uploadReferenceBatch(references.videos, uploadOptions)
  const audios = await uploadReferenceBatch(references.audios, uploadOptions)
  const orderedVisualRefs = [...images.items, ...videos.items]
    .sort((left, right) => left.order - right.order)
    .map((item) => item.resourceRef)

  return {
    images: images.resourceRefs,
    videos: videos.resourceRefs,
    audios: audios.resourceRefs,
    orderedVisualRefs,
    requiresPublicBaseUrl: images.requiresPublicBaseUrl || videos.requiresPublicBaseUrl || audios.requiresPublicBaseUrl,
  }
}

async function uploadReferenceBatch(assets, options = {}) {
  if (!assets.length) {
    return { resourceRefs: [], items: [], requiresPublicBaseUrl: false }
  }

  const formData = new FormData()
  for (const asset of assets) {
    formData.append('files', asset.file, asset.file.name)
  }
  if (options.materialType && options.materialType !== 'direct') {
    formData.append('materialType', options.materialType)
  }
  if (options.storageBackend) {
    formData.append('storageBackend', options.storageBackend)
  }
  if (options.dashscopeModel) {
    formData.append('dashscopeModel', options.dashscopeModel)
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
    items: data.files.map((file, index) => ({
      assetId: assets[index]?.id || null,
      order: typeof assets[index]?.order === 'number' ? assets[index].order : index,
      resourceRef: file.resourceRef || file.url,
    })),
    requiresPublicBaseUrl: data.publiclyReachable === false,
  }
}

function resolveImageMaterialType(provider, params) {
  if (provider !== 'veo') return 'direct'
  return params.imageMaterialType || 'role'
}

function resolveReferenceUploadOptions(provider, params) {
  if (!isWanProvider(provider)) {
    return {}
  }

  const configuredModel = typeof params?.model === 'string' ? params.model.trim() : ''
  const fallbackModel = PROVIDERS[provider]?.defaults?.model || 'wan2.6-r2v-flash'

  return {
    storageBackend: 'dashscope',
    dashscopeModel: configuredModel || fallbackModel,
  }
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

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(await formatHttpError(response))
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase()
  if (contentType.includes('application/json')) {
    const payload = await response.json()
    throw new Error(payload?.message || payload?.error?.message || '预览内容不是视频文件')
  }

  if (
    contentType
    && !contentType.startsWith('video/')
    && !contentType.startsWith('image/')
    && !contentType.includes('application/octet-stream')
  ) {
    const body = await response.text()
    throw new Error(formatPreviewContentTypeError(contentType, body))
  }

  const blob = await response.blob()
  if (!blob.size) {
    throw new Error('预览文件为空，无法播放')
  }

  if (
    blob.type
    && !blob.type.startsWith('video/')
    && !blob.type.startsWith('image/')
    && !blob.type.includes('application/octet-stream')
  ) {
    throw new Error(`预览文件类型异常: ${blob.type}`)
  }

  return URL.createObjectURL(blob)
}

function formatPreviewContentTypeError(contentType, body) {
  const normalizedType = (contentType || 'unknown').toLowerCase()
  const previewBody = typeof body === 'string' ? body.slice(0, 240) : ''
  const normalizedBody = previewBody.toLowerCase()

  if (
    normalizedType.includes('text/html')
    && normalizedBody.includes('cloudflare')
    && (normalizedBody.includes('502') || normalizedBody.includes('5xx'))
  ) {
    return '预览地址返回了 Cloudflare 502 错误页，不是视频文件。通常是上游结果地址暂时不可用，或者后端拿错了预览地址。'
  }

  if (normalizedType.includes('text/html')) {
    return '预览地址返回的是 HTML 网页，不是视频文件。通常是结果地址失效，或者后端拿错了预览地址。'
  }

  return `预览内容类型异常: ${normalizedType}${previewBody ? `，返回内容：${previewBody}` : ''}`
}

function normalizeTaskState(value) {
  if (typeof value !== 'string') return ''

  const normalized = value.trim().toLowerCase()
  switch (normalized) {
    case 'succeeded':
    case 'success':
      return 'succeeded'
    case 'completed':
    case 'complete':
      return 'completed'
    case 'failed':
    case 'failure':
    case 'error':
    case 'canceled':
    case 'cancelled':
    case 'unknown':
      return 'failed'
    default:
      return normalized
  }
}

function extractVeoFastVideoUrl(payload) {
  const candidates = [
    payload?.data?.videos?.[0]?.url,
    payload?.data?.videos?.[0]?.videoUrl,
    payload?.data?.video?.url,
    payload?.data?.videoUrl,
    payload?.data?.video_url,
    payload?.data?.downloadUrl,
    payload?.data?.download_url,
    payload?.data?.contentUrl,
    payload?.data?.content_url,
    payload?.data?.result?.videos?.[0]?.url,
    payload?.data?.result?.video?.url,
    payload?.data?.result?.videoUrl,
    payload?.data?.result?.video_url,
    payload?.data?.result?.downloadUrl,
    payload?.data?.result?.download_url,
    payload?.videos?.[0]?.url,
    payload?.video?.url,
    payload?.videoUrl,
    payload?.video_url,
    payload?.downloadUrl,
    payload?.download_url,
    payload?.contentUrl,
    payload?.content_url,
    payload?.content,
    payload?.url,
  ]

  return (
    candidates.find((value) => typeof value === 'string' && /^https?:\/\//i.test(value))
    || null
  )
}

async function resolveVeoFastPreviewUrl(taskId, attempts = 6) {
  const contentUrl = `/api/veo-fast/content/${encodeURIComponent(taskId)}`
  let lastError = null

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await resolvePreviewUrl(contentUrl)
    } catch (error) {
      lastError = error
      const message = error?.message || ''
      const canRetry = (
        message.includes('Failed to resolve Gemini video URL')
        || message.includes('解析Gemini视频URL失败')
        || message.includes('Task not found')
      )

      if (!canRetry || attempt === attempts - 1) {
        throw error
      }

      await sleep(5000)
    }
  }

  throw lastError || new Error('获取视频预览失败')
}

async function formatHttpError(response) {
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    const payload = await response.json()
    const message = payload?.message || payload?.error?.message || JSON.stringify(payload)
    const newApiVersion = response.headers.get('x-new-api-version')
    const requestId = resolveResponseRequestId(response, payload)

    if (
      newApiVersion
      && payload?.error?.type === 'upstream_error'
      && typeof message === 'string'
      && message.includes('API Key not found. Please pass a valid API key.')
    ) {
      return appendRequestId(
        `API 错误 (${response.status}): 当前 new-api 网关已收到请求，但它连接的上游模型渠道返回“API Key not found”。这通常表示网关侧没有为该模型配置可用的供应商密钥，或当前令牌未绑定到可用渠道`,
        requestId,
      )
    }

    if (response.status === 401 && payload?.redirectUrl && typeof window !== 'undefined') {
      window.location.href = payload.redirectUrl
      return message || '登录已失效，正在返回主站...'
    }

    return appendRequestId(`API 错误 (${response.status}): ${message}`, requestId)
  }
  const body = await response.text()
  return appendRequestId(
    `API 错误 (${response.status}): ${body}`,
    resolveResponseRequestId(response),
  )
}

function resolveResponseRequestId(response, payload = null) {
  return readFirstTraceValue(
    extractRequestIdFromPayload(payload),
    response.headers.get('x-upstream-request-id'),
    response.headers.get('x-oneapi-request-id'),
    response.headers.get('x-request-id'),
    response.headers.get('request-id'),
    response.headers.get('x-upstream-trace-id'),
    response.headers.get('trace-id'),
    response.headers.get('x-trace-id'),
    response.headers.get('cf-ray'),
  )
}

function extractRequestIdFromPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return null
  }

  return readFirstTraceValue(
    payload.requestId,
    payload.request_id,
    payload.RequestId,
    payload.traceId,
    payload.trace_id,
    payload.TraceId,
    payload.data?.requestId,
    payload.data?.request_id,
    payload.data?.RequestId,
    payload.data?.traceId,
    payload.data?.trace_id,
    payload.data?.TraceId,
    payload.error?.requestId,
    payload.error?.request_id,
    payload.error?.RequestId,
    payload.error?.traceId,
    payload.error?.trace_id,
    payload.error?.TraceId,
  )
}

function readFirstTraceValue(...values) {
  return values.find((value) => typeof value === 'string' && value.trim())?.trim() || null
}

function appendRequestId(message, requestId) {
  if (!requestId || typeof message !== 'string' || message.includes(requestId)) {
    return message
  }

  return `${message}（requestId: ${requestId}）`
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function buildImageResponseParseError(data) {
  const summary = summarizeImageResponseShape(data)
  if (!summary) {
    return '图片生成已完成，但没有在响应中找到图片数据'
  }

  return `图片生成已完成，但没有在响应中找到图片数据（响应字段: ${summary}）`
}

function summarizeImageResponseShape(data) {
  if (!data || typeof data !== 'object') {
    return null
  }

  const fields = []
  const topLevelKeys = Object.keys(data).slice(0, 8)
  if (topLevelKeys.length) {
    fields.push(topLevelKeys.join(', '))
  }

  if (Array.isArray(data?.choices)) {
    const choice = data.choices[0]
    if (choice?.message?.content !== undefined) {
      fields.push(`choices[0].message.content:${Array.isArray(choice.message.content) ? 'array' : typeof choice.message.content}`)
    }
    if (Array.isArray(choice?.message?.parts)) {
      fields.push(`choices[0].message.parts:${choice.message.parts.length}`)
    }
  }

  if (Array.isArray(data?.candidates)) {
    fields.push(`candidates:${data.candidates.length}`)
    const parts = data.candidates[0]?.content?.parts
    if (Array.isArray(parts)) {
      fields.push(`candidates[0].content.parts:${parts.length}`)
    }
  }

  if (Array.isArray(data?.data)) {
    fields.push(`data:${data.data.length}`)
  }

  if (Array.isArray(data?.images)) {
    fields.push(`images:${data.images.length}`)
  }

  if (Array.isArray(data?.output)) {
    fields.push(`output:${data.output.length}`)
  }

  return fields.filter(Boolean).join(' | ') || null
}

function parseInlineImagePayload(payload, fallbackPrompt) {
  if (!payload || typeof payload !== 'object') {
    return null
  }

  const rawData = typeof payload.data === 'string' ? payload.data : null
  if (!rawData) {
    return null
  }

  const mimeType = payload.mime_type || payload.mimeType || 'image/png'
  return {
    url: `data:${mimeType};base64,${rawData.replace(/\s/g, '')}`,
    revised_prompt: fallbackPrompt,
  }
}

function parseImageParts(parts, fallbackPrompt) {
  if (!Array.isArray(parts)) {
    return null
  }

  for (const part of parts) {
    const inlineImage = parseInlineImagePayload(part?.inline_data || part?.inlineData, fallbackPrompt)
    if (inlineImage) {
      return inlineImage
    }

    if (typeof part?.text === 'string') {
      const textResult = parseImageChatResponse({ choices: [{ message: { content: part.text } }] }, fallbackPrompt)
      if (textResult) {
        return textResult
      }
    }
  }

  return null
}

function parseImageRecord(record, fallbackPrompt) {
  if (!record || typeof record !== 'object') {
    return null
  }

  if (typeof record.url === 'string' && record.url) {
    return {
      url: record.url,
      revised_prompt: typeof record.revised_prompt === 'string' ? record.revised_prompt : fallbackPrompt,
    }
  }

  if (record.image_url?.url) {
    return {
      url: record.image_url.url,
      revised_prompt: typeof record.revised_prompt === 'string' ? record.revised_prompt : fallbackPrompt,
    }
  }

  if (typeof record.b64_json === 'string' && record.b64_json) {
    const mimeType = typeof record.mime_type === 'string' ? record.mime_type : 'image/png'
    return {
      url: `data:${mimeType};base64,${record.b64_json.replace(/\s/g, '')}`,
      revised_prompt: typeof record.revised_prompt === 'string' ? record.revised_prompt : fallbackPrompt,
    }
  }

  if (typeof record.image_base64 === 'string' && record.image_base64) {
    const mimeType = typeof record.mime_type === 'string' ? record.mime_type : 'image/png'
    return {
      url: `data:${mimeType};base64,${record.image_base64.replace(/\s/g, '')}`,
      revised_prompt: typeof record.revised_prompt === 'string' ? record.revised_prompt : fallbackPrompt,
    }
  }

  return null
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

    const base64Item = content.find((item) => item?.type === 'image_base64' && typeof item?.image_base64 === 'string')
    if (base64Item) {
      const mimeType = typeof base64Item.mime_type === 'string' ? base64Item.mime_type : 'image/png'
      return {
        url: `data:${mimeType};base64,${base64Item.image_base64.replace(/\s/g, '')}`,
        revised_prompt: fallbackPrompt,
      }
    }
  }

  const topLevelCollections = [data?.data, data?.images]
  for (const collection of topLevelCollections) {
    if (!Array.isArray(collection)) continue

    for (const record of collection) {
      const parsedRecord = parseImageRecord(record, fallbackPrompt)
      if (parsedRecord) {
        return parsedRecord
      }
    }
  }

  const outputEntries = Array.isArray(data?.output) ? data.output : []
  for (const entry of outputEntries) {
    const directRecord = parseImageRecord(entry, fallbackPrompt)
    if (directRecord) {
      return directRecord
    }

    if (!Array.isArray(entry?.content)) continue

    for (const contentItem of entry.content) {
      const parsedRecord = parseImageRecord(contentItem, fallbackPrompt)
      if (parsedRecord) {
        return parsedRecord
      }
    }
  }

  const parts = data?.choices?.[0]?.message?.parts
  if (parts) {
    const partResult = parseImageParts(parts, fallbackPrompt)
    if (partResult) {
      return partResult
    }
  }

  const candidates = Array.isArray(data?.candidates) ? data.candidates : []
  for (const candidate of candidates) {
    const partResult = parseImageParts(candidate?.content?.parts, fallbackPrompt)
    if (partResult) {
      return partResult
    }
  }

  return null
}

export default App
