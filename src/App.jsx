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

function isDreaminaProvider(id) {
  return PROVIDERS[id]?.backendKind === 'dreamina'
}

function resolveSeedance2OperationalMode(mode, references = createEmptyVideoReferences()) {
  if (mode !== 'generate') {
    return mode
  }

  const imageCount = Array.isArray(references?.images) ? references.images.length : 0
  if (imageCount >= 2) return 'flf'
  if (imageCount === 1) return 'i2v'
  return 't2v'
}

function resolveOperationalMode(provider, mode, references = createEmptyVideoReferences()) {
  if (provider === 'seedance2') {
    return resolveSeedance2OperationalMode(mode, references)
  }

  return mode
}

function usesLocalReferenceAssetsConfig(config) {
  return config?.referenceInputMode === 'local'
}

function isYunwuProvider(id) {
  return PROVIDERS[id]?.backendKind === 'yunwu'
}

function isArkProvider(id) {
  return PROVIDERS[id]?.backendKind === 'ark'
}

function isAggregationImageProvider(id) {
  return PROVIDERS[id]?.backendKind === 'aggregation-image'
}

function isOpenAiImageProvider(id) {
  return PROVIDERS[id]?.backendKind === 'openai-image'
}

const OPENAI_IMAGE_DIMENSIONS = Object.freeze({
  '1:1': { width: 1024, height: 1024 },
  '16:9': { width: 1280, height: 720 },
  '9:16': { width: 720, height: 1280 },
  '3:4': { width: 768, height: 1024 },
  '4:3': { width: 1024, height: 768 },
})
const TASK_POLL_INTERVAL_MS = 2000

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

  const params = normalizeParamsForProvider(provider, allParams[provider], generationMode, videoReferences)
  const config = PROVIDERS[provider]
  const panelConfig = getConfigForGenerationMode(config, generationMode, params, videoReferences)
  const currentState = providerState[provider] || { generating: false, progress: 0, videoUrl: null, error: null }
  const hasActiveGeneration = PROVIDER_ORDER.some((key) => providerState[key]?.generating)
  const maxImages = resolveImageLimit(config, generationMode, videoReferences)
  const maxVideos = resolveVideoLimit(config, generationMode, videoReferences)
  const maxAudios = resolveLimit(config.maxReferenceAudios, generationMode)

  const updateParam = useCallback((key, value) => {
    setAllParams((prev) => ({
      ...prev,
      [provider]: normalizeParamsForProvider(provider, { ...prev[provider], [key]: value }, generationMode, videoReferences),
    }))
  }, [generationMode, provider, videoReferences])

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
    const emptyReferences = createEmptyVideoReferences()
    setAllParams((prev) => ({
      ...prev,
      [nextProvider]: normalizeParamsForProvider(nextProvider, prev[nextProvider], firstMode, emptyReferences),
    }))
    setGenerationMode(firstMode)
    resetReferences()
  }, [resetReferences])

  const handleModeChange = useCallback((nextMode) => {
    const emptyReferences = createEmptyVideoReferences()
    setAllParams((prev) => ({
      ...prev,
      [provider]: normalizeParamsForProvider(provider, prev[provider], nextMode, emptyReferences),
    }))
    setGenerationMode(nextMode)
    resetReferences()
  }, [provider, resetReferences])

  const handleOpenAdmin = useCallback(() => {
    window.open('/admin', '_blank', 'noopener')
  }, [])

  const handleGenerate = useCallback(async () => {
    const finalPrompt = selectedTemplate
      ? (prompt.trim() ? `${selectedTemplate.prompt}. Additional requirements: ${prompt.trim()}` : selectedTemplate.prompt)
      : prompt.trim()
    const usesLocalReferenceAssets = usesLocalReferenceAssetsConfig(config)
    const usageMediaSummary = (isVideoProvider(provider) || usesLocalReferenceAssets)
      ? buildUsageMediaSummaryFromVideoReferences(videoReferences)
      : buildUsageMediaSummaryFromImageMedia(referenceMedia)
    const promptRequired = isPromptRequiredForGeneration(config, generationMode, videoReferences)

    if (!finalPrompt && promptRequired) return

    if (isVideoProvider(provider)) {
      const validationError = validateVideoReferenceInput(provider, params, generationMode, videoReferences, finalPrompt)
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
        const taskId = extractTaskId(data)
        if (!taskId) {
          throw new Error('接口已响应，但没有返回 task_id')
        }

        updateProviderState(provider, { progress: 25 })

        let finished = false
        while (!finished) {
          await sleep(TASK_POLL_INTERVAL_MS)
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
          /*
          throw new Error('鍙傝€冪礌鏉愬凡缁忎笂浼犲埌鏈湴鍚庣锛屼絾褰撳墠鍚庣鍦板潃涓嶆槸鍏綉鍙闂湴鍧€銆傝閮ㄧ讲鍚庣鍒板叕缃戯紝鎴栬缃?PUBLIC_BASE_URL 鎸囧悜鍏綉鍩熷悕/闅ч亾銆?)
          */
          throw new Error('Reference assets were uploaded locally, but the backend is not reachable from the public internet. Set PUBLIC_BASE_URL to a public host before using DashScope Wan references.')
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
          throw new Error(data?.message || '瑙嗛鐢熸垚璇锋眰澶辫触')
        }

        const initialTask = normalizeYunwuTask(data?.data)
        if (initialTask.videoUrl) {
          window.clearInterval(progressTimer)
          const previewUrl = await resolveArkPlaybackUrl(initialTask, provider)
          updateProviderState(provider, { progress: 100, videoUrl: previewUrl })
          return
        }

        if (!initialTask.taskId) {
          throw new Error('鎺ュ彛宸插搷搴旓紝浣嗘病鏈夎繑鍥?taskId')
        }

        let finished = false
        while (!finished) {
          await sleep(TASK_POLL_INTERVAL_MS)
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
            /*
            throw new Error(pollData?.message || '鏌ヨ浠诲姟鐘舵€佸け璐?)
            */
            throw new Error(pollData?.message || 'Failed to query Wan task status')
          }

          const task = normalizeYunwuTask(pollData.data)
          const state = normalizeTaskState(task.status)
          if ((state === 'succeeded' || state === 'completed') && task.videoUrl) {
            finished = true
            window.clearInterval(progressTimer)
            const previewUrl = await resolveArkPlaybackUrl(task, provider)
            updateProviderState(provider, { progress: 100, videoUrl: previewUrl })
            return
          }

          if (state === 'failed') {
            /*
            throw new Error(task.message || '瑙嗛鐢熸垚澶辫触')
            */
            throw new Error(task.message || 'Wan video generation failed')
          }
        }
      } else if (isYunwuProvider(provider)) {
        const uploadedReferences = await uploadVideoReferences(provider, params, videoReferences)
        if (uploadedReferences.requiresPublicBaseUrl) {
          throw new Error('参考素材已经上传到本地后端，但当前后端地址不是公网可访问地址。请部署后端到公网，或设置 PUBLIC_BASE_URL 指向公网域名/隧道。')
        }

        const requestInfo = buildYunwuVideoRequest(provider, params, finalPrompt, generationMode, uploadedReferences)
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

        const initialTask = normalizeYunwuTask(data?.data)
        if (initialTask.videoUrl) {
          window.clearInterval(progressTimer)
          const previewUrl = await resolveArkPlaybackUrl(initialTask, provider)
          updateProviderState(provider, { progress: 100, videoUrl: previewUrl })
          return
        }

        if (!initialTask.taskId) {
          throw new Error('接口已响应，但没有返回 taskId')
        }

        let finished = false
        while (!finished) {
          await sleep(TASK_POLL_INTERVAL_MS)
          const pollRequest = buildYunwuQueryRequest(provider, initialTask.taskId, initialTask.queryContext)
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

          const task = normalizeYunwuTask(pollData.data)
          const state = normalizeTaskState(task.status)
          if ((state === 'succeeded' || state === 'completed') && task.videoUrl) {
            finished = true
            window.clearInterval(progressTimer)
            const previewUrl = await resolveArkPlaybackUrl(task, provider)
            updateProviderState(provider, { progress: 100, videoUrl: previewUrl })
            return
          }

          if (state === 'failed') {
            throw new Error(task.message || '视频生成失败')
          }
        }
      } else if (isArkProvider(provider)) {
        const uploadedReferences = await uploadVideoReferences(provider, params, videoReferences)
        if (uploadedReferences.requiresPublicBaseUrl) {
          throw new Error('参考素材已经上传到本地后端，但当前后端地址不是公网可访问地址。请部署后端到公网，或设置 PUBLIC_BASE_URL 指向公网域名/隧道。')
        }

        const requestInfo = buildArkVideoRequest(provider, params, finalPrompt, generationMode, uploadedReferences)
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
          throw new Error(data?.message || 'Ark 视频生成请求失败')
        }

        const initialTask = normalizeYunwuTask(data?.data)
        if (initialTask.videoUrl) {
          window.clearInterval(progressTimer)
          const previewUrl = await resolveArkPlaybackUrl(initialTask, provider)
          updateProviderState(provider, { progress: 100, videoUrl: previewUrl })
          return
        }

        if (!initialTask.taskId) {
          throw new Error('接口已响应，但没有返回 taskId')
        }

        let finished = false
        while (!finished) {
          await sleep(TASK_POLL_INTERVAL_MS)
          const pollRequest = buildArkQueryRequest(provider, initialTask.taskId)
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

          const task = normalizeYunwuTask(pollData.data)
          const state = normalizeTaskState(task.status)
          if ((state === 'succeeded' || state === 'completed') && task.videoUrl) {
            finished = true
            window.clearInterval(progressTimer)
            const previewUrl = await resolveArkPlaybackUrl(task, provider)
            updateProviderState(provider, { progress: 100, videoUrl: previewUrl })
            return
          }

          if (state === 'failed') {
            throw new Error(task.message || 'Ark 视频生成失败')
          }
        }
      } else if (isDreaminaProvider(provider)) {
        const uploadedReferences = await uploadVideoReferences(provider, params, videoReferences)
        const requestInfo = buildDreaminaRequest(provider, params, finalPrompt, generationMode, uploadedReferences)
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
          throw new Error(data?.message || 'Dreamina 请求失败')
        }

        const initialTask = normalizeDreaminaTask(data?.data)
        if (initialTask.videoUrl || initialTask.imageUrl) {
          window.clearInterval(progressTimer)
          const previewUrl = await resolveDreaminaPlaybackUrl(initialTask, provider)
          updateProviderState(provider, { progress: 100, videoUrl: previewUrl })
          return
        }

        if (!initialTask.taskId) {
          throw new Error('接口已响应，但没有返回 submit_id')
        }

        let finished = false
        while (!finished) {
          await sleep(TASK_POLL_INTERVAL_MS)
          const pollRequest = buildDreaminaQueryRequest(provider, initialTask.taskId)
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

          const task = normalizeDreaminaTask(pollData.data)
          const state = normalizeTaskState(task.status)
          if ((state === 'succeeded' || state === 'completed') && (task.videoUrl || task.imageUrl)) {
            finished = true
            window.clearInterval(progressTimer)
            const previewUrl = await resolveDreaminaPlaybackUrl(task, provider)
            updateProviderState(provider, { progress: 100, videoUrl: previewUrl })
            return
          }

          if (state === 'failed' || state === 'cancelled') {
            throw new Error(task.message || 'Dreamina 生成失败')
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
          taskId: extractTaskId(payload),
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
          await sleep(TASK_POLL_INTERVAL_MS)
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
        if (isAggregationImageProvider(provider)) {
          const uploadedReferences = await uploadImageReferences(referenceMedia)
          if (uploadedReferences.requiresPublicBaseUrl) {
            throw new Error('Reference images were uploaded locally, but the backend is not reachable from the public internet. Set PUBLIC_BASE_URL to a public host before using aggregation image references.')
          }

          const requestInfo = buildAggregationImageRequest(provider, params, finalPrompt, generationMode, uploadedReferences.resourceRefs)
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
            throw new Error(data?.msg || data?.message || 'Image generation request failed')
          }

          const initialTask = normalizeAggregationImageTask(data, finalPrompt)
          const initialState = normalizeAggregationTaskState(initialTask.status)
          if (initialState === 'succeeded' || initialState === 'completed') {
            if (initialTask.imageUrl) {
              window.clearInterval(progressTimer)
              const previewUrl = await resolvePreviewUrl(initialTask.imageUrl)
              updateProviderState(provider, { progress: 100, videoUrl: previewUrl })
              return
            }

            throw new Error(initialTask.message || 'Image generation finished without a result image')
          }

          if (initialState === 'failed' || initialState === 'cancelled') {
            throw new Error(initialTask.message || 'Image generation failed')
          }

          if (!initialTask.taskId) {
            throw new Error('The upstream request succeeded, but no taskId was returned')
          }

          const pollTimeoutMs = 5 * 60 * 1000
          const pollDeadline = Date.now() + pollTimeoutMs
          let lastTask = initialTask
          while (Date.now() < pollDeadline) {
            await sleep(TASK_POLL_INTERVAL_MS)
            const pollRequest = buildAggregationImageQueryRequest(initialTask.taskId)
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
              throw new Error(pollData?.msg || pollData?.message || 'Failed to query image task status')
            }

            const task = normalizeAggregationImageTask(pollData, finalPrompt)
            const state = normalizeAggregationTaskState(task.status)
            lastTask = task
            if (state === 'succeeded' || state === 'completed') {
              if (task.imageUrl) {
                window.clearInterval(progressTimer)
                const previewUrl = await resolvePreviewUrl(task.imageUrl)
                updateProviderState(provider, { progress: 100, videoUrl: previewUrl })
                return
              }

              throw new Error(task.message || 'Image generation finished without a result image')
            }

            if (state === 'failed' || state === 'cancelled') {
              throw new Error(task.message || 'Image generation failed')
            }
          }

          const timeoutStatus = normalizeAggregationTaskState(lastTask?.status) || 'unknown'
          const timeoutMessage = lastTask?.message ? ` ${lastTask.message}` : ''
          throw new Error(`Image generation timed out while waiting for the upstream task. Last status: ${timeoutStatus}.${timeoutMessage}`)
        }

        const requestInfo = buildOpenAiImageRequest(provider, params, finalPrompt, generationMode, referenceMedia)
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
          const finalImageUrl = await finalizeOpenAiImageOutput(provider, params, imageResult.url)
          updateProviderState(provider, { videoUrl: finalImageUrl })
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
        onSaveSnapshot={handleSaveSnapshot}
        onLoadSnapshot={handleLoadSnapshot}
        onOpenAdmin={handleOpenAdmin}
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
            params={params}
            onParamUpdate={updateParam}
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
            config={panelConfig}
            params={params}
            onUpdate={updateParam}
          />
        </div>
        <div className="right-panel">
          <VideoPreview
            videoUrl={currentState.videoUrl}
            generating={currentState.generating}
            progress={currentState.progress}
            error={formatRuntimeErrorMessage(provider, currentState.error)}
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
    const previewUrl = resolvePersistableSnapshotPreviewUrl(key, current.videoUrl)
    serialized[key] = {
      generating: false,
      progress: 0,
      error: null,
      previewAsset: await serializePreviewAsset(previewUrl),
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
      videoUrl: resolvePersistableSnapshotPreviewUrl(
        key,
        hydratePreviewAsset(current.previewAsset) || current.videoUrl || null,
      ),
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

function normalizeParamsForProvider(provider, params, mode = 't2v', references = createEmptyVideoReferences()) {
  const config = PROVIDERS[provider]
  if (!config) return params

  const sourceParams = params && typeof params === 'object' ? params : {}
  let nextParams = sourceParams
  let changed = nextParams !== params
  const operationalMode = resolveOperationalMode(provider, mode, references)
  const isSeedanceStoryboardMode = provider === 'seedance2' && operationalMode === 'multiframe'

  if (!isSeedanceStoryboardMode) {
    const availableModels = resolveAvailableModels(config, operationalMode)

    if (availableModels.length > 0 && !availableModels.includes(nextParams.model)) {
      const fallbackModel = availableModels.includes(config.defaults?.model)
        ? config.defaults.model
        : availableModels[0]
      nextParams = {
        ...nextParams,
        model: fallbackModel,
      }
      changed = true
    }

    const resolutionOptions = config.resolutions?.[nextParams.model] || config.resolutions?.default || []

    if (resolutionOptions.length > 0 && !resolutionOptions.includes(nextParams.resolution)) {
      nextParams = {
        ...nextParams,
        resolution: resolutionOptions[0],
      }
      changed = true
    }

    const durationOptions = resolveDurationOptions(config, nextParams, operationalMode, references)
    const normalizedDuration = resolveSupportedDurationValue(
      nextParams.duration,
      durationOptions,
      config.defaults?.duration,
    )

    if (durationOptions.length > 0 && nextParams.duration !== normalizedDuration) {
      nextParams = {
        ...nextParams,
        duration: normalizedDuration,
      }
      changed = true
    }
  }

  if (provider === 'seedance2' && operationalMode === 'multiframe') {
    const segmentCount = Math.max(0, (references?.images?.length || 0) - 1)
    const transitionPrompts = normalizeStoryFieldArray(nextParams.transitionPrompts, segmentCount, '')
    const transitionDurations = normalizeStoryFieldArray(nextParams.transitionDurations, segmentCount, '3')
    const singleTransitionDuration = normalizeStoryDurationValue(nextParams.singleTransitionDuration, '3')

    if (
      !areStringArraysEqual(nextParams.transitionPrompts, transitionPrompts)
      || !areStringArraysEqual(nextParams.transitionDurations, transitionDurations)
      || nextParams.singleTransitionDuration !== singleTransitionDuration
    ) {
      nextParams = {
        ...nextParams,
        transitionPrompts,
        transitionDurations,
        singleTransitionDuration,
      }
      changed = true
    }
  }

  return changed ? nextParams : sourceParams
}

function getConfigForGenerationMode(config, mode, params, references = createEmptyVideoReferences()) {
  if (!config) return config

  const operationalMode = resolveOperationalMode(config.id, mode, references)
  const availableModels = resolveAvailableModels(config, operationalMode)
  const durationOptions = resolveDurationOptions(config, params, operationalMode, references)
  const allowedSet = new Set(availableModels)
  const filteredModels = config.models.filter((model) => allowedSet.has(model.value))
  const hidesAspectRatio = config.id === 'seedance2' && (operationalMode === 'i2v' || operationalMode === 'flf' || operationalMode === 'multiframe')
  const hidesResolution = config.id === 'seedance2' && operationalMode === 'multiframe'
  const hidesDuration = config.id === 'seedance2' && operationalMode === 'multiframe'
  const hidesModel = config.id === 'seedance2' && operationalMode === 'multiframe'
  const nextModels = hidesModel ? [] : filteredModels
  const nextAspectRatios = hidesAspectRatio ? [] : config.aspectRatios
  const nextResolutions = hidesResolution ? { default: [] } : config.resolutions
  const nextDurations = hidesDuration ? [] : durationOptions
  const modelsUnchanged = nextModels.length === config.models.length
    && nextModels.every((model, index) => model.value === config.models[index]?.value)
  const aspectRatiosUnchanged = nextAspectRatios.length === config.aspectRatios.length
    && nextAspectRatios.every((ratio, index) => ratio === config.aspectRatios[index])
  const durationsUnchanged = nextDurations.length === config.durations.length
    && nextDurations.every((duration, index) => duration === config.durations[index])
  const resolutionsUnchanged = nextResolutions === config.resolutions

  if (modelsUnchanged && aspectRatiosUnchanged && durationsUnchanged && resolutionsUnchanged) {
    return config
  }

  return {
    ...config,
    models: nextModels,
    aspectRatios: nextAspectRatios,
    resolutions: nextResolutions,
    durations: nextDurations,
  }
}

function resolveDurationOptions(config, params, mode, references = createEmptyVideoReferences()) {
  const operationalMode = resolveOperationalMode(config?.id, mode, references)
  const baseOptions = Array.isArray(config?.durations)
    ? config.durations.filter((duration) => Number.isFinite(Number(duration)))
    : []
  if (baseOptions.length === 0) return []

  const durationRules = config?.durationRules
  if (!durationRules || typeof durationRules !== 'object') {
    return baseOptions
  }

  const model = typeof params?.model === 'string' ? params.model.trim() : ''
  const hasVideoReference = Array.isArray(references?.videos) && references.videos.length > 0
  let nextOptions = [...baseOptions]

  nextOptions = applyDurationRuleOptions(nextOptions, durationRules.modelDefaults?.[model])
  nextOptions = applyDurationRuleOptions(nextOptions, durationRules.modes?.[operationalMode])
  nextOptions = applyDurationRuleOptions(nextOptions, durationRules.modelModes?.[model]?.[operationalMode])

  if (hasVideoReference) {
    nextOptions = applyDurationRuleOptions(nextOptions, durationRules.modesWithVideoReference?.[operationalMode])
  }

  return nextOptions
}

function applyDurationRuleOptions(currentOptions, ruleOptions) {
  if (!Array.isArray(ruleOptions) || ruleOptions.length === 0) {
    return currentOptions
  }

  const allowedSet = new Set(ruleOptions)
  const filtered = currentOptions.filter((option) => allowedSet.has(option))
  return filtered.length > 0 ? filtered : currentOptions
}

function resolveSupportedDurationValue(currentValue, durationOptions, fallbackValue) {
  if (!Array.isArray(durationOptions) || durationOptions.length === 0) {
    return currentValue
  }

  const currentDuration = normalizeDurationNumber(currentValue)
  if (currentDuration !== null && durationOptions.includes(currentDuration)) {
    return currentDuration
  }

  const fallbackDuration = normalizeDurationNumber(fallbackValue)
  if (fallbackDuration !== null && durationOptions.includes(fallbackDuration)) {
    return fallbackDuration
  }

  const targetDuration = currentDuration ?? fallbackDuration
  if (targetDuration !== null) {
    return pickClosestDurationOption(durationOptions, targetDuration)
  }

  return durationOptions[0]
}

function normalizeDurationNumber(value) {
  const numericValue = Math.trunc(Number(value))
  return Number.isFinite(numericValue) ? numericValue : null
}

function pickClosestDurationOption(durationOptions, targetDuration) {
  let closest = durationOptions[0]
  let minDistance = Math.abs(closest - targetDuration)

  for (const option of durationOptions.slice(1)) {
    const distance = Math.abs(option - targetDuration)
    if (distance < minDistance) {
      closest = option
      minDistance = distance
    }
  }

  return closest
}

function normalizeStoryFieldArray(value, targetLength, fallbackValue) {
  const source = Array.isArray(value) ? value : []
  const result = []

  for (let index = 0; index < targetLength; index += 1) {
    const item = source[index]
    result.push(typeof item === 'string' && item.trim() ? item : fallbackValue)
  }

  return result
}

function areStringArraysEqual(left, right) {
  const leftArray = Array.isArray(left) ? left : []
  const rightArray = Array.isArray(right) ? right : []
  if (leftArray.length !== rightArray.length) {
    return false
  }

  return leftArray.every((value, index) => value === rightArray[index])
}

function normalizeStoryDurationValue(value, fallbackValue = '3') {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }

  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }

  return fallbackValue
}

function resolveAvailableModels(config, mode) {
  const allModels = Array.isArray(config?.models) ? config.models : []
  const scopedModels = config?.modeModels?.[mode]

  if (!Array.isArray(scopedModels) || scopedModels.length === 0) {
    return allModels.map((model) => model.value)
  }

  const allowedSet = new Set(scopedModels)
  const filteredModels = allModels.filter((model) => allowedSet.has(model.value))
  return filteredModels.length > 0
    ? filteredModels.map((model) => model.value)
    : allModels.map((model) => model.value)
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

function resolvePersistableSnapshotPreviewUrl(providerId, url) {
  if (!isPersistablePreviewUrl(url)) {
    return null
  }

  if (!isDreaminaProvider(providerId)) {
    return url
  }

  const taskId = extractDreaminaTaskIdFromPreviewUrl(url)
  if (!taskId) {
    return null
  }

  return `/api/dreamina/media/${encodeURIComponent(taskId)}`
}

function extractDreaminaTaskIdFromPreviewUrl(url) {
  if (typeof url !== 'string' || !url.trim()) {
    return null
  }

  try {
    const parsed = new URL(url, window.location.origin)
    const matched = parsed.pathname.match(/^\/api\/dreamina\/media\/([^/?#]+)/)
    return matched?.[1] ? decodeURIComponent(matched[1]) : null
  } catch {
    return null
  }
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

function buildYunwuVideoRequest(provider, params, prompt, mode, references) {
  return {
    url: '/api/yunwu/generate',
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
      },
      references,
    },
  }
}

function buildArkVideoRequest(provider, params, prompt, mode, references) {
  return {
    url: '/api/ark/generate',
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

function buildDreaminaRequest(provider, params, prompt, mode, references) {
  return {
    url: '/api/dreamina/generate',
    headers: {
      'Content-Type': 'application/json',
    },
    body: {
      providerId: provider,
      prompt,
      mode,
      params: {
        ...params,
      },
      references,
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

function buildDreaminaQueryRequest(provider, taskId) {
  return {
    url: '/api/dreamina/query',
    headers: {
      'Content-Type': 'application/json',
    },
    body: {
      providerId: provider,
      taskId,
    },
  }
}

function buildYunwuQueryRequest(provider, taskId, queryContext) {
  return {
    url: '/api/yunwu/query',
    headers: {
      'Content-Type': 'application/json',
    },
    body: {
      providerId: provider,
      taskId,
      queryContext,
    },
  }
}

function buildArkQueryRequest(provider, taskId) {
  return {
    url: '/api/ark/query',
    headers: {
      'Content-Type': 'application/json',
    },
    body: {
      providerId: provider,
      taskId,
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

function normalizeYunwuTask(data) {
  return {
    taskId: extractTaskId(data),
    status: data?.status || null,
    message: data?.message || null,
    videoUrl: data?.videoUrl || null,
    queryContext: data?.queryContext || null,
  }
}

function normalizeDreaminaTask(data) {
  return {
    taskId: extractTaskId(data),
    status: data?.status || null,
    message: data?.message || null,
    videoUrl: data?.videoUrl || null,
    imageUrl: data?.imageUrl || null,
  }
}

function normalizeAggregationImageTask(payload, fallbackPrompt) {
  const message = extractAggregationTaskMessage(payload)
  const imageUrl = extractAggregationImageUrl(payload, fallbackPrompt, message)

  return {
    taskId: extractTaskId(payload),
    status: extractAggregationTaskStatus(payload),
    message,
    imageUrl,
  }
}

function formatRuntimeErrorMessage(provider, message) {
  if (typeof message !== 'string' || !message.trim()) {
    return '生成失败'
  }

  if (
    provider === 'yunwu-veo'
    && message.toLowerCase().includes('download file failed')
  ) {
    return '云雾无法下载参考图片。请检查参考图链接是否能被外网直接访问，优先使用稳定的 HTTPS 公网图片链接，或确认 PUBLIC_BASE_URL 指向可公网访问的地址。'
  }

  return message
}

function buildOpenAiImageRequest(provider, params, prompt, mode, mediaList) {
  const parts = [{ text: prompt }]
  if (mode === 'i2v') {
    for (const media of mediaList) {
      const inlineImage = buildGeminiInlineImagePart(media)
      if (!inlineImage) {
        throw new Error('参考图片格式无效，图生图仅支持 Base64 图片输入')
      }

      parts.push({ inline_data: inlineImage })
    }
  }

  const generationConfig = buildGeminiImageGenerationConfig(params)

  return {
    url: '/api/image/generate-content',
    headers: {
      'Content-Type': 'application/json',
    },
    body: {
      providerId: provider,
      model: params.model,
      contents: [{ parts }],
      ...(generationConfig ? { generationConfig } : {}),
    },
  }
}

function buildOpenAiImageSystemInstruction(params, explicitDimensions) {
  const rules = []

  if (explicitDimensions) {
    rules.push(`Generate the final image at exactly ${explicitDimensions.width}x${explicitDimensions.height} pixels.`)
    rules.push('Make the composition fill the entire canvas edge-to-edge.')
  }

  if (params?.aspectRatio) {
    rules.push(`Use an output aspect ratio of ${params.aspectRatio}.`)
  }

  if (params?.resolution) {
    rules.push(`Target image size ${params.resolution}.`)
  }

  if (rules.length === 0) {
    return ''
  }

  return [
    'Image generation constraints:',
    ...rules,
    'Do not add blank padding, borders, frames, letterboxing, pillarboxing, inset compositions, or empty margins around the main scene.',
    'Do not ignore these output constraints unless the request is impossible.',
  ].join(' ')
}

function buildGeminiImageGenerationConfig(params) {
  const imageConfig = {}

  if (params?.aspectRatio) {
    imageConfig.aspectRatio = params.aspectRatio
  }

  if (params?.resolution) {
    imageConfig.imageSize = params.resolution
  }

  if (Object.keys(imageConfig).length === 0) {
    return null
  }

  return {
    imageConfig,
  }
}

function buildGeminiInlineImagePart(media) {
  const dataUrl = extractImageDataUrlPayload(media)
  if (!dataUrl) {
    return null
  }

  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i)
  if (!match) {
    return null
  }

  return {
    mime_type: match[1],
    data: match[2].replace(/\s/g, ''),
  }
}

function resolveOpenAiImageDimensions(params) {
  const explicitResolution = parseExplicitImageResolution(params?.resolution)
  if (explicitResolution) {
    return explicitResolution
  }

  return OPENAI_IMAGE_DIMENSIONS[params?.aspectRatio] || null
}

function parseExplicitImageResolution(value) {
  if (typeof value !== 'string') {
    return null
  }

  const match = value.trim().match(/^(\d{2,5})\s*[xX]\s*(\d{2,5})$/)
  if (!match) {
    return null
  }

  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null
  }

  return { width, height }
}

async function finalizeOpenAiImageOutput(provider, params, imageUrl) {
  if (!isOpenAiImageProvider(provider)) {
    return imageUrl
  }

  const dimensions = resolveOpenAiImageDimensions(params)
  if (!dimensions) {
    return imageUrl
  }

  try {
    return await cropImageToDimensions(imageUrl, dimensions)
  } catch {
    return imageUrl
  }
}

async function cropImageToDimensions(imageUrl, dimensions) {
  if (typeof imageUrl !== 'string' || !imageUrl.trim()) {
    return imageUrl
  }

  const response = await fetch(imageUrl)
  if (!response.ok) {
    throw new Error('Failed to load generated image for resizing')
  }

  const blob = await response.blob()
  const objectUrl = URL.createObjectURL(blob)

  try {
    const image = await loadImageElement(objectUrl)
    const sourceBounds = detectImageContentBounds(image)
    const canvas = document.createElement('canvas')
    canvas.width = dimensions.width
    canvas.height = dimensions.height

    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('Canvas 2D context is not available')
    }

    const scale = Math.max(
      dimensions.width / sourceBounds.width,
      dimensions.height / sourceBounds.height,
    )
    const drawWidth = sourceBounds.width * scale
    const drawHeight = sourceBounds.height * scale
    const drawX = (dimensions.width - drawWidth) / 2
    const drawY = (dimensions.height - drawHeight) / 2

    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(
      image,
      sourceBounds.x,
      sourceBounds.y,
      sourceBounds.width,
      sourceBounds.height,
      drawX,
      drawY,
      drawWidth,
      drawHeight,
    )

    const outputType = blob.type && blob.type.startsWith('image/') ? blob.type : 'image/jpeg'
    return outputType === 'image/png'
      ? canvas.toDataURL(outputType)
      : canvas.toDataURL(outputType, 0.92)
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

function detectImageContentBounds(image) {
  const width = image.naturalWidth
  const height = image.naturalHeight
  if (!width || !height) {
    return { x: 0, y: 0, width: Math.max(width || 1, 1), height: Math.max(height || 1, 1) }
  }

  const scratchCanvas = document.createElement('canvas')
  scratchCanvas.width = width
  scratchCanvas.height = height

  const scratchContext = scratchCanvas.getContext('2d', { willReadFrequently: true })
  if (!scratchContext) {
    return { x: 0, y: 0, width, height }
  }

  scratchContext.drawImage(image, 0, 0)
  const imageData = scratchContext.getImageData(0, 0, width, height)
  const cornerColors = sampleCornerColors(imageData, width, height)
  const maxTrimX = Math.max(0, Math.floor(width * 0.35))
  const maxTrimY = Math.max(0, Math.floor(height * 0.35))

  const top = scanPaddingFromTop(imageData, width, height, cornerColors, maxTrimY)
  const bottom = scanPaddingFromBottom(imageData, width, height, cornerColors, maxTrimY)
  const left = scanPaddingFromLeft(imageData, width, height, cornerColors, maxTrimX, top, bottom)
  const right = scanPaddingFromRight(imageData, width, height, cornerColors, maxTrimX, top, bottom)

  const contentWidth = width - left - right
  const contentHeight = height - top - bottom
  if (contentWidth < width * 0.2 || contentHeight < height * 0.2) {
    return { x: 0, y: 0, width, height }
  }

  if (left + right + top + bottom < 4) {
    return { x: 0, y: 0, width, height }
  }

  return {
    x: left,
    y: top,
    width: Math.max(1, contentWidth),
    height: Math.max(1, contentHeight),
  }
}

function sampleCornerColors(imageData, width, height) {
  const sampleSize = Math.max(4, Math.min(24, Math.floor(Math.min(width, height) * 0.04)))
  return [
    sampleAverageColor(imageData, width, 0, 0, sampleSize, sampleSize),
    sampleAverageColor(imageData, width, Math.max(0, width - sampleSize), 0, sampleSize, sampleSize),
    sampleAverageColor(imageData, width, 0, Math.max(0, height - sampleSize), sampleSize, sampleSize),
    sampleAverageColor(imageData, width, Math.max(0, width - sampleSize), Math.max(0, height - sampleSize), sampleSize, sampleSize),
  ]
}

function sampleAverageColor(imageData, width, startX, startY, sampleWidth, sampleHeight) {
  const endX = Math.min(width, startX + sampleWidth)
  const endY = Math.min(imageData.height, startY + sampleHeight)
  let totalR = 0
  let totalG = 0
  let totalB = 0
  let totalA = 0
  let count = 0

  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const offset = (y * width + x) * 4
      totalR += imageData.data[offset]
      totalG += imageData.data[offset + 1]
      totalB += imageData.data[offset + 2]
      totalA += imageData.data[offset + 3]
      count += 1
    }
  }

  if (count === 0) {
    return { r: 255, g: 255, b: 255, a: 255 }
  }

  return {
    r: totalR / count,
    g: totalG / count,
    b: totalB / count,
    a: totalA / count,
  }
}

function scanPaddingFromTop(imageData, width, height, cornerColors, maxTrim) {
  let trimmed = 0
  while (trimmed < maxTrim && trimmed < height - 1) {
    if (!isPaddingRow(imageData, width, height, trimmed, cornerColors)) {
      break
    }
    trimmed += 1
  }
  return trimmed
}

function scanPaddingFromBottom(imageData, width, height, cornerColors, maxTrim) {
  let trimmed = 0
  while (trimmed < maxTrim && trimmed < height - 1) {
    const y = height - 1 - trimmed
    if (!isPaddingRow(imageData, width, height, y, cornerColors)) {
      break
    }
    trimmed += 1
  }
  return trimmed
}

function scanPaddingFromLeft(imageData, width, height, cornerColors, maxTrim, topTrim, bottomTrim) {
  let trimmed = 0
  while (trimmed < maxTrim && trimmed < width - 1) {
    if (!isPaddingColumn(imageData, width, height, trimmed, cornerColors, topTrim, bottomTrim)) {
      break
    }
    trimmed += 1
  }
  return trimmed
}

function scanPaddingFromRight(imageData, width, height, cornerColors, maxTrim, topTrim, bottomTrim) {
  let trimmed = 0
  while (trimmed < maxTrim && trimmed < width - 1) {
    const x = width - 1 - trimmed
    if (!isPaddingColumn(imageData, width, height, x, cornerColors, topTrim, bottomTrim)) {
      break
    }
    trimmed += 1
  }
  return trimmed
}

function isPaddingRow(imageData, width, height, y, cornerColors) {
  const sampleCount = Math.max(12, Math.min(72, width))
  let matches = 0

  for (let index = 0; index < sampleCount; index += 1) {
    const x = sampleCount === 1
      ? 0
      : Math.round((index / (sampleCount - 1)) * (width - 1))
    if (matchesPaddingReference(readPixel(imageData, width, x, y), cornerColors)) {
      matches += 1
    }
  }

  return matches / sampleCount >= 0.94
}

function isPaddingColumn(imageData, width, height, x, cornerColors, topTrim, bottomTrim) {
  const startY = Math.min(Math.max(0, topTrim), height - 1)
  const endY = Math.max(startY, height - Math.max(0, bottomTrim))
  const span = Math.max(1, endY - startY)
  const sampleCount = Math.max(12, Math.min(72, span))
  let matches = 0

  for (let index = 0; index < sampleCount; index += 1) {
    const y = sampleCount === 1
      ? startY
      : Math.min(height - 1, Math.round(startY + (index / (sampleCount - 1)) * (span - 1)))
    if (matchesPaddingReference(readPixel(imageData, width, x, y), cornerColors)) {
      matches += 1
    }
  }

  return matches / sampleCount >= 0.94
}

function readPixel(imageData, width, x, y) {
  const offset = (y * width + x) * 4
  return {
    r: imageData.data[offset],
    g: imageData.data[offset + 1],
    b: imageData.data[offset + 2],
    a: imageData.data[offset + 3],
  }
}

function matchesPaddingReference(pixel, cornerColors) {
  if (!pixel) {
    return false
  }

  if (pixel.a <= 18) {
    return true
  }

  return cornerColors.some((referenceColor) => colorDistance(pixel, referenceColor) <= 46)
}

function colorDistance(a, b) {
  const dr = a.r - b.r
  const dg = a.g - b.g
  const db = a.b - b.b
  const da = (a.a ?? 255) - (b.a ?? 255)
  return Math.sqrt(dr * dr + dg * dg + db * db + da * da * 0.25)
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Failed to decode generated image'))
    image.src = src
  })
}

function buildAggregationImageRequest(provider, params, prompt, mode, resourceRefs) {
  const payload = {
    params: {
      resolution: params.resolution,
      scale: params.aspectRatio,
    },
  }

  if (mode === 'i2v' && resourceRefs.length > 0) {
    payload.resources = resourceRefs
  }

  return {
    url: '/api/image/aggregation/generate',
    headers: {
      'Content-Type': 'application/json',
    },
    body: {
      providerId: provider,
      modelId: params.model,
      abilityType: 'IMAGE',
      prompt,
      payload,
    },
  }
}

function buildAggregationImageQueryRequest(taskId) {
  return {
    url: '/api/image/aggregation/queryResult',
    headers: {
      'Content-Type': 'application/json',
    },
    body: {
      taskId,
      abilityType: 'IMAGE',
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

function extractImageDataUrlPayload(media) {
  if (typeof media !== 'string') return null

  const trimmed = media.trim()
  if (!trimmed) {
    return null
  }

  if (/^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+$/i.test(trimmed)) {
    return trimmed.replace(/\s/g, '')
  }

  const rawBase64 = extractImageBase64Payload(trimmed)
  if (!rawBase64) {
    return null
  }

  return `data:image/png;base64,${rawBase64}`
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

async function uploadImageReferences(mediaList) {
  if (!Array.isArray(mediaList) || mediaList.length === 0) {
    return { resourceRefs: [], requiresPublicBaseUrl: false }
  }

  const assets = mediaList.map((media, index) => ({
    id: `image-${index}`,
    order: index,
    file: imageMediaToFile(media, index),
  }))

  const uploaded = await uploadReferenceBatch(assets)
  return {
    resourceRefs: uploaded.resourceRefs,
    requiresPublicBaseUrl: uploaded.requiresPublicBaseUrl,
  }
}

function imageMediaToFile(media, index) {
  if (typeof media !== 'string') {
    throw new Error('Reference image format is invalid')
  }

  const dataUrlMatch = media.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i)
  if (dataUrlMatch) {
    const mimeType = dataUrlMatch[1]
    const base64 = dataUrlMatch[2].replace(/\s/g, '')
    const extension = mimeTypeToFileExtension(mimeType)
    return createFileFromBase64Data(base64, mimeType, `image-reference-${index + 1}.${extension}`)
  }

  const rawBase64 = extractImageBase64Payload(media)
  if (!rawBase64) {
    throw new Error('Reference image format is invalid')
  }

  return createFileFromBase64Data(rawBase64, 'image/png', `image-reference-${index + 1}.png`)
}

function createFileFromBase64Data(base64, mimeType, filename) {
  const binary = window.atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return new File([bytes], filename, { type: mimeType })
}

function mimeTypeToFileExtension(mimeType) {
  switch ((mimeType || '').toLowerCase()) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/webp':
      return 'webp'
    case 'image/gif':
      return 'gif'
    case 'image/png':
    default:
      return 'png'
  }
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

function isPromptRequiredForGeneration(config, mode, references = createEmptyVideoReferences()) {
  if (!config) {
    return true
  }

  if (config.id === 'seedance2' && mode === 'multiframe') {
    return (references?.images?.length || 0) <= 2
  }

  return !Array.isArray(config.promptOptionalModes) || !config.promptOptionalModes.includes(mode)
}

function validateVideoReferenceInput(provider, params, mode, references, prompt = '') {
  const operationalMode = resolveOperationalMode(provider, mode, references)
  const wanValidationError = validateWanReferenceInput(provider, mode, references)
  const klingValidationError = validateKlingReferenceInput(provider, params, mode, references)
  const dreaminaStoryValidationError = validateDreaminaStoryInput(provider, params, mode, references, prompt)
  const durationValidationError = validateRequestedDuration(provider, params, mode, references)
  if (provider === 'seedance2' && mode === 'generate') {
    if (references.images.length > 2) {
      return '视频生成模式最多支持 2 张参考图片'
    }

    if (references.videos.length > 0 || references.audios.length > 0) {
      return '视频生成模式仅支持 0-2 张图片，不支持参考视频或音频'
    }
  }

  if (operationalMode !== 't2v') {
    if (operationalMode === 'i2v' && references.images.length !== 1) return '图生视频模式需要 1 张参考图片'
    if (operationalMode === 'flf' && references.images.length !== 2) return '首尾帧模式需要 2 张图片，第一张是首帧，第二张是尾帧'

    if (operationalMode === 'ref') {
      if (references.images.length === 0) return '参考图片模式至少需要 1 张参考图片'
    }

    if (operationalMode === 'omni') {
      if (references.images.length + references.videos.length === 0) {
        return 'Omni 模式至少需要 1 张参考图片或 1 段参考视频'
      }
    }

    if (operationalMode === 'fusion') {
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
  }

  if (dreaminaStoryValidationError) {
    return dreaminaStoryValidationError
  }

  if (wanValidationError) {
    return wanValidationError
  }

  if (klingValidationError) {
    return klingValidationError
  }

  return durationValidationError
}

function validateDreaminaStoryInput(provider, params, mode, references, prompt) {
  if (provider !== 'seedance2' || mode !== 'multiframe') {
    return null
  }

  const imageCount = references.images.length
  if (imageCount < 2) {
    return '动作模仿模式至少需要 2 张参考图片'
  }
  if (imageCount > 20) {
    return '动作模仿模式最多支持 20 张参考图片'
  }
  if (references.videos.length > 0 || references.audios.length > 0) {
    return '动作模仿模式仅支持上传图片，不支持视频或音频'
  }

  if (imageCount === 2) {
    if (!String(prompt || '').trim()) {
      return '两张图的动作模仿模式需要填写主提示词'
    }

    return validateDreaminaSingleTransitionDuration(params?.singleTransitionDuration)
  }

  return validateDreaminaTransitionSegments(imageCount, params?.transitionPrompts, params?.transitionDurations)
}
function validateDreaminaSingleTransitionDuration(value) {
  const duration = parseDreaminaDurationFloat(value)
  if (duration === null) {
    return '请填写两张图模式的过渡时长'
  }
  if (duration < 2 || duration > 8) {
    return '两张图模式的过渡时长需介于 2 到 8 秒之间'
  }
  return null
}

function validateDreaminaTransitionSegments(imageCount, prompts, durations) {
  const segmentCount = imageCount - 1
  const promptList = Array.isArray(prompts) ? prompts.slice(0, segmentCount) : []
  const durationList = Array.isArray(durations) ? durations.slice(0, segmentCount) : []

  if (promptList.length !== segmentCount || promptList.some((item) => typeof item !== 'string' || !item.trim())) {
    return `请为 ${segmentCount} 段过渡分别填写提示词`
  }

  if (durationList.length !== segmentCount) {
    return `请为 ${segmentCount} 段过渡分别填写时长`
  }

  let totalDuration = 0
  for (let index = 0; index < segmentCount; index += 1) {
    const duration = parseDreaminaDurationFloat(durationList[index])
    if (duration === null) {
      return `第 ${index + 1} 段过渡时长格式不正确`
    }
    if (duration < 0.5 || duration > 8) {
      return `第 ${index + 1} 段过渡时长需介于 0.5 到 8 秒之间`
    }
    totalDuration += duration
  }

  if (totalDuration < 2) {
    return '多帧叙事总时长至少需要 2 秒'
  }

  return null
}

function parseDreaminaDurationFloat(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim()
  if (!normalized) {
    return null
  }

  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function validateRequestedDuration(provider, params, mode, references) {
  const config = PROVIDERS[provider]
  if (!config || !isVideoProvider(provider)) {
    return null
  }

  const operationalMode = resolveOperationalMode(provider, mode, references)
  const durationOptions = resolveDurationOptions(config, params, operationalMode, references)
  if (durationOptions.length === 0) {
    return null
  }

  const requestedDuration = normalizeDurationNumber(params?.duration)
  if (requestedDuration !== null && durationOptions.includes(requestedDuration)) {
    return null
  }

  if (provider === 'kling' && operationalMode === 'fusion' && references.videos.length > 0) {
    return `Kling with a reference video only supports ${durationOptions.join('/')} second durations`
  }

  if (provider === 'yunwu-kling') {
    const modelLabel = resolveModelLabel(config, params?.model)
    return `${modelLabel} only supports ${durationOptions.join('/')} second durations in this mode`
  }

  return `${config.name || 'Current model'} only supports ${durationOptions.join('/')} second durations`
}

function resolveModelLabel(config, modelValue) {
  const matchedModel = Array.isArray(config?.models)
    ? config.models.find((model) => model.value === modelValue)
    : null
  return matchedModel?.label || config?.name || 'Current model'
}

function validateWanReferenceInput(provider, mode, references) {
  if (!isWanProvider(provider) || mode !== 'fusion') return null

  const imageCount = references.images.length
  const videoCount = references.videos.length
  const totalVisualCount = imageCount + videoCount

  if (videoCount > 3) {
    return '\u4e07\u8c61\u53c2\u8003\u89c6\u9891\u6700\u591a 3 \u6bb5'
  }

  if (imageCount > 5) {
    return '\u4e07\u8c61\u53c2\u8003\u56fe\u7247\u6700\u591a 5 \u5f20'
  }

  if (totalVisualCount > 5) {
    return '\u4e07\u8c61\u53c2\u8003\u56fe\u7247\u548c\u89c6\u9891\u603b\u6570\u4e0d\u80fd\u8d85\u8fc7 5 \u4e2a'
  }

  return null
}

function validateKlingReferenceInput(provider, params, mode, references) {
  if (!isKlingProvider(provider) && provider !== 'yunwu-kling') return null

  if (provider === 'yunwu-kling' && mode === 'omni') {
    if (references.images.length > 1) {
      return 'Yunwu Kling Omni 模式最多上传 1 张参考图片'
    }

    if (references.videos.length > 1) {
      return 'Yunwu Kling Omni 模式最多上传 1 段参考视频'
    }

    return null
  }

  if (mode !== 'fusion') return null

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
  const fallbackModel = PROVIDERS[provider]?.defaults?.model || 'wan2.6-r2v'

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

async function resolveDreaminaPlaybackUrl(task, providerId) {
  if (!isDreaminaProvider(providerId)) {
    return resolvePreviewUrl(task?.videoUrl || null, providerId)
  }

  const taskId = typeof task?.taskId === 'string' ? task.taskId.trim() : ''
  if (taskId) {
    return `/api/dreamina/media/${encodeURIComponent(taskId)}`
  }

  return resolvePreviewUrl(task?.videoUrl || null, providerId)
}

async function resolveArkPlaybackUrl(task, providerId) {
  if (!isArkProvider(providerId)) {
    return resolvePreviewUrl(task?.videoUrl || null, providerId)
  }

  const taskId = typeof task?.taskId === 'string' ? task.taskId.trim() : ''
  if (taskId) {
    return `/api/ark/media/${encodeURIComponent(taskId)}`
  }

  return resolvePreviewUrl(task?.videoUrl || null, providerId)
}

async function resolvePreviewUrl(url, providerId = null, options = {}) {
  const { eagerFetch = false } = options
  if (!url || url.startsWith('blob:') || url.startsWith('data:')) return url

  if (isDreaminaProvider(providerId) || !eagerFetch) {
    return url
  }

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
    throw new Error(`预览内容类型异常: ${contentType || 'unknown'}${body ? `，返回内容：${body.slice(0, 120)}` : ''}`)
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

function normalizeTaskState(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    value = String(value)
  }

  if (typeof value !== 'string') return ''

  const normalized = value.trim().toLowerCase()
  switch (normalized) {
    case '2':
    case 'done':
    case 'finish':
    case 'finished':
    case 'succeeded':
    case 'success':
    case 'successed':
      return 'succeeded'
    case '0':
    case '1':
    case 'submitted':
    case 'pending':
    case 'queued':
    case 'processing':
    case 'running':
    case 'inprogress':
    case 'in_progress':
      return 'submitted'
    case 'completed':
    case 'complete':
      return 'completed'
    case '3':
    case '4':
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

function normalizeAggregationTaskState(value) {
  return normalizeTaskState(value)
}

function extractAggregationImageUrl(payload, fallbackPrompt, fallbackMessage = null) {
  const parsed = parseImageChatResponse(payload, fallbackPrompt)
    || extractImageUrlFromString(fallbackMessage || '', fallbackPrompt)

  if (parsed?.url) {
    return parsed.url
  }

  return (
    findFirstMatchingPathValue(payload, [
      'imageUrl',
      'image_url',
      'resultUrl',
      'url',
      'content',
      'message',
      'data.imageUrl',
      'data.image_url',
      'data.resultUrl',
      'data.url',
      'data.content',
      'data.message',
      'data.result.imageUrl',
      'data.result.image_url',
      'data.result.resultUrl',
      'data.result.url',
      'data.result.content',
      'data.result.message',
      'result.imageUrl',
      'result.image_url',
      'result.resultUrl',
      'result.url',
      'result.content',
      'result.message',
    ], isLikelyImageTextUrl)
    || findFirstMediaUrlDeep(payload, 0, '', isLikelyImageTextUrl)
  )
}

function normalizeTaskIdValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(Math.trunc(value))
  }

  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }

  return null
}

function getPathValue(target, pathExpression) {
  if (!target || typeof target !== 'object') {
    return undefined
  }

  const segments = pathExpression.split('.')
  let current = target

  for (const rawSegment of segments) {
    if (current === null || current === undefined) {
      return undefined
    }

    if (/^\d+$/.test(rawSegment)) {
      current = current[Number(rawSegment)]
      continue
    }

    current = current[rawSegment]
  }

  return current
}

function findFirstPathValue(target, paths) {
  for (const path of paths) {
    const value = getPathValue(target, path)
    if (value !== undefined && value !== null && value !== '') {
      return value
    }
  }

  return null
}

function extractAggregationTaskStatus(payload) {
  return findFirstPathValue(payload, [
    'status',
    'state',
    'task_status',
    'data.status',
    'data.state',
    'data.task_status',
    'data.result.status',
    'data.result.state',
    'data.result.task_status',
    'result.status',
    'result.state',
    'result.task_status',
  ])
}

function extractAggregationTaskMessage(payload) {
  return findFirstPathValue(payload, [
    'message',
    'msg',
    'content',
    'data.message',
    'data.msg',
    'data.content',
    'data.result.message',
    'data.result.msg',
    'data.result.content',
    'result.message',
    'result.msg',
    'result.content',
    'error.message',
  ]) || null
}

function extractTaskId(payload) {
  return normalizeTaskIdValue(findFirstPathValue(payload, [
    'taskId',
    'task_id',
    'id',
    'name',
    'data.taskId',
    'data.task_id',
    'data.id',
    'data.name',
    'data.result.taskId',
    'data.result.task_id',
    'data.result.id',
    'data.result.name',
    'result.taskId',
    'result.task_id',
    'result.id',
    'result.name',
  ]))
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
      return await resolvePreviewUrl(contentUrl, null, { eagerFetch: true })
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

      await sleep(TASK_POLL_INTERVAL_MS)
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
  if (isGatewayStatusPayload(data)) {
    return '图片接口返回的是网关状态，而不是模型生成结果。请检查部署路由是否把 /api/image/generate-content 转发到了本站后端，并确认 IMAGE_API_BASE_URL 填的是上游基础地址（例如 https://example.com），不要填当前站点地址，也不要重复带上 /v1beta/models/...:generateContent。'
  }

  const textFailureMessage = extractImageTextFailureMessage(data)
  if (textFailureMessage) {
    return textFailureMessage
  }

  const summary = summarizeImageResponseShape(data)
  if (!summary) {
    return '图片生成已完成，但没有在响应中找到图片数据'
  }

  return `图片生成已完成，但没有在响应中找到图片数据（响应字段: ${summary}）`
}

function isGatewayStatusPayload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return false
  }

  const keys = Object.keys(data)
  if (!keys.length || keys.some((key) => !['message', 'status', 'version'].includes(key))) {
    return false
  }

  return (
    typeof data.message === 'string'
    && /new api gateway is running/i.test(data.message)
    && typeof data.status === 'string'
    && typeof data.version === 'string'
  )
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

function normalizeParsedImageUrl(url) {
  if (typeof url !== 'string') {
    return null
  }

  const trimmed = url.trim()
  if (!trimmed) {
    return null
  }

  return trimmed.startsWith('data:image/')
    ? trimmed.replace(/\s/g, '')
    : trimmed
}

function extractImageTextFailureMessage(data) {
  const candidates = []
  const content = data?.choices?.[0]?.message?.content
  if (typeof content === 'string') {
    candidates.push(content)
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item?.text === 'string') {
        candidates.push(item.text)
      }
    }
  }

  const messageParts = data?.choices?.[0]?.message?.parts
  if (Array.isArray(messageParts)) {
    for (const part of messageParts) {
      if (typeof part?.text === 'string') {
        candidates.push(part.text)
      }
    }
  }

  const geminiCandidates = Array.isArray(data?.candidates) ? data.candidates : []
  for (const candidate of geminiCandidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []
    for (const part of parts) {
      if (typeof part?.text === 'string') {
        candidates.push(part.text)
      }
    }
  }

  for (const candidate of candidates) {
    const normalizedMessage = normalizeImageTextFailureMessage(candidate)
    if (normalizedMessage) {
      return normalizedMessage
    }
  }

  return null
}

function findFirstMatchingPathValue(target, paths, predicate) {
  for (const path of paths) {
    const value = getPathValue(target, path)
    if (typeof value !== 'string') continue

    const normalized = normalizeParsedImageUrl(value)
    if (normalized && predicate(normalized)) {
      return normalized
    }
  }

  return null
}

function findFirstMediaUrlDeep(target, depth = 0, keyPath = '', predicate = isLikelyImageTextUrl) {
  if (!target || depth > 6) {
    return null
  }

  if (typeof target === 'string') {
    const normalized = normalizeParsedImageUrl(target)
    return normalized && predicate(normalized, keyPath) ? normalized : null
  }

  if (Array.isArray(target)) {
    for (let index = 0; index < target.length; index += 1) {
      const match = findFirstMediaUrlDeep(
        target[index],
        depth + 1,
        keyPath ? `${keyPath}.${index}` : String(index),
        predicate,
      )
      if (match) {
        return match
      }
    }

    return null
  }

  if (typeof target === 'object') {
    for (const [key, value] of Object.entries(target)) {
      const nextPath = keyPath ? `${keyPath}.${key}` : key
      const match = findFirstMediaUrlDeep(value, depth + 1, nextPath, predicate)
      if (match) {
        return match
      }
    }
  }

  return null
}

function normalizeImageTextFailureMessage(content) {
  if (typeof content !== 'string') {
    return null
  }

  const trimmed = content.trim()
  if (!trimmed || isLikelyInlineImageText(trimmed)) {
    return null
  }

  const collapsed = trimmed.replace(/\s+/g, ' ').trim()
  if (!collapsed) {
    return null
  }

  if (looksLikeHtmlErrorText(collapsed)) {
    return '上游返回的是 HTML 报错页，不是图片数据。请检查 IMAGE_API_BASE_URL、上游路由或站点状态。'
  }

  return collapsed.slice(0, 300)
}

function isLikelyInlineImageText(content) {
  if (typeof content !== 'string') {
    return false
  }

  const trimmed = content.trim()
  if (!trimmed) {
    return false
  }

  if (trimmed.startsWith('data:image/')) {
    return true
  }

  const markdownMatch = trimmed.match(/!\[[^\]]*]\(([^)]+)\)/s)
  if (markdownMatch?.[1]) {
    return isLikelyImageTextUrl(markdownMatch[1])
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return isLikelyImageTextUrl(trimmed)
  }

  return false
}

function isLikelyImageTextUrl(url) {
  if (typeof url !== 'string') {
    return false
  }

  const trimmed = url.trim()
  if (!trimmed) {
    return false
  }

  if (trimmed.startsWith('data:image/')) {
    return true
  }

  try {
    const parsed = new URL(trimmed)
    const searchable = `${parsed.pathname}${parsed.search}`.toLowerCase()
    if (/\.(png|jpe?g|webp|gif|bmp|svg)(\?|$)/i.test(searchable)) {
      return true
    }

    if (/(?:format|image_format|img_format|response-content-type)=.*(?:png|jpe?g|webp|gif|bmp|svg|image%2f)/i.test(searchable)) {
      return true
    }

    if (/\/(image|images|img|thumbnail|cover|poster|file|files)\b/i.test(parsed.pathname)) {
      return true
    }
  } catch {
    return false
  }

  return false
}

function looksLikeHtmlErrorText(content) {
  return (
    /<(?:!doctype|html|head|body|div|span|title)\b/i.test(content)
    || /(?:class=|cf-error-|host error|cloudflare|working<\/span>)/i.test(content)
  )
}

function tryParseStructuredImageString(content, fallbackPrompt) {
  if (typeof content !== 'string') {
    return null
  }

  const candidates = [content]
  const fencedMatch = content.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fencedMatch?.[1]) {
    candidates.unshift(fencedMatch[1])
  }

  for (const candidate of candidates) {
    const trimmed = candidate.trim()
    if (!trimmed || !/^[\[{"]/.test(trimmed)) {
      continue
    }

    try {
      const parsed = JSON.parse(trimmed)
      const parsedResponse = parseImageChatResponse(parsed, fallbackPrompt)
      if (parsedResponse) {
        return parsedResponse
      }

      const directRecord = parseImageRecord(parsed, fallbackPrompt)
      if (directRecord) {
        return directRecord
      }
    } catch {
      // Ignore malformed JSON-like strings and continue with other strategies.
    }
  }

  return null
}

function extractImageUrlFromString(content, fallbackPrompt) {
  if (typeof content !== 'string') {
    return null
  }

  const trimmed = content.trim()
  if (!trimmed) {
    return null
  }

  const markdownMatch = trimmed.match(/!\[[^\]]*]\(([^)]+)\)/s)
  if (markdownMatch?.[1]) {
    const nestedMatch = extractImageUrlFromString(markdownMatch[1], fallbackPrompt)
    if (nestedMatch) {
      return nestedMatch
    }
  }

  if (trimmed.startsWith('data:image/')) {
    return { url: normalizeParsedImageUrl(trimmed), revised_prompt: fallbackPrompt }
  }

  const dataUrlMatch = trimmed.match(/data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)/)
  if (dataUrlMatch) {
    return { url: dataUrlMatch[0].replace(/\s/g, ''), revised_prompt: fallbackPrompt }
  }

  const structuredResult = tryParseStructuredImageString(trimmed, fallbackPrompt)
  if (structuredResult) {
    return structuredResult
  }

  const urlMatch = trimmed.match(/https?:\/\/[^\s"'`<>)]+/i)
  if (urlMatch && isLikelyImageTextUrl(urlMatch[0])) {
    return {
      url: normalizeParsedImageUrl(urlMatch[0]),
      revised_prompt: fallbackPrompt,
    }
  }

  const rawBase64Match = trimmed.match(/\b([A-Za-z0-9+/]{100,}={0,2})\b/)
  if (rawBase64Match) {
    return {
      url: `data:image/png;base64,${rawBase64Match[1]}`,
      revised_prompt: fallbackPrompt,
    }
  }

  return null
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
  if (typeof record === 'string') {
    return extractImageUrlFromString(record, fallbackPrompt)
  }

  if (!record || typeof record !== 'object') {
    return null
  }

  if (typeof record.url === 'string' && record.url) {
    const parsedUrl = extractImageUrlFromString(record.url, fallbackPrompt)
    const normalizedUrl = parsedUrl?.url || (
      isLikelyImageTextUrl(record.url)
        ? normalizeParsedImageUrl(record.url)
        : null
    )
    if (!normalizedUrl) {
      return null
    }
    return {
      url: normalizedUrl,
      revised_prompt: typeof record.revised_prompt === 'string' ? record.revised_prompt : fallbackPrompt,
    }
  }

  const imageUrlValue = typeof record.image_url === 'string'
    ? record.image_url
    : record.image_url?.url
  if (imageUrlValue) {
    const parsedUrl = extractImageUrlFromString(imageUrlValue, fallbackPrompt)
    return {
      url: parsedUrl?.url || normalizeParsedImageUrl(imageUrlValue),
      revised_prompt: typeof record.revised_prompt === 'string' ? record.revised_prompt : fallbackPrompt,
    }
  }

  const imageValue = typeof record.image === 'string'
    ? record.image
    : record.image?.url
  if (imageValue) {
    const parsedUrl = extractImageUrlFromString(imageValue, fallbackPrompt)
    return {
      url: parsedUrl?.url || normalizeParsedImageUrl(imageValue),
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
    const stringResult = extractImageUrlFromString(content, fallbackPrompt)
    if (stringResult) {
      return stringResult
    }
  }

  if (Array.isArray(content)) {
    const imageItem = content.find((item) => item?.type === 'image_url' && (
      item?.image_url?.url || typeof item?.image_url === 'string'
    ))
    if (imageItem) {
      const imageUrlValue = typeof imageItem.image_url === 'string'
        ? imageItem.image_url
        : imageItem.image_url.url
      return {
        url: normalizeParsedImageUrl(imageUrlValue),
        revised_prompt: fallbackPrompt,
      }
    }

    const base64Item = content.find((item) => item?.type === 'image_base64' && typeof item?.image_base64 === 'string')
    if (base64Item) {
      const mimeType = typeof base64Item.mime_type === 'string' ? base64Item.mime_type : 'image/png'
      return {
        url: `data:${mimeType};base64,${base64Item.image_base64.replace(/\s/g, '')}`,
        revised_prompt: fallbackPrompt,
      }
    }

    for (const contentItem of content) {
      const parsedRecord = parseImageRecord(contentItem, fallbackPrompt)
      if (parsedRecord) {
        return parsedRecord
      }
    }
  }

  const topLevelRecord = parseImageRecord(data, fallbackPrompt)
  if (topLevelRecord) {
    return topLevelRecord
  }

  const topLevelCollections = [data?.data, data?.images, data?.results, data?.artifacts]
  for (const collection of topLevelCollections) {
    if (!Array.isArray(collection)) continue

    for (const record of collection) {
      const parsedRecord = parseImageRecord(record, fallbackPrompt)
      if (parsedRecord) {
        return parsedRecord
      }
    }
  }

  const directContainers = [data?.result, data?.image]
  for (const entry of directContainers) {
    const directRecord = parseImageRecord(entry, fallbackPrompt)
    if (directRecord) {
      return directRecord
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
