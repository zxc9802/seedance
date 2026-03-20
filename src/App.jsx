import { useCallback, useState } from 'react'
import { PROVIDERS, PROVIDER_ORDER } from './modelConfig'
import Header from './components/Header'
import ProviderTabs from './components/ProviderTabs'
import PromptInput from './components/PromptInput'
import ParameterPanel from './components/ParameterPanel'
import VideoPreview from './components/VideoPreview'
import './App.css'

function App() {
  const [provider, setProvider] = useState('veo')
  const [allParams, setAllParams] = useState(() => {
    const initial = {}
    for (const key of PROVIDER_ORDER) initial[key] = { ...PROVIDERS[key].defaults }
    return initial
  })
  const [prompt, setPrompt] = useState('')
  const [generationMode, setGenerationMode] = useState('t2v')
  const [referenceMedia, setReferenceMedia] = useState([])
  const [videoReferences, setVideoReferences] = useState(createEmptyVideoReferences)
  const [selectedTemplate, setSelectedTemplate] = useState(null)
  const [providerState, setProviderState] = useState(() => {
    const state = {}
    for (const key of PROVIDER_ORDER) {
      state[key] = { generating: false, progress: 0, videoUrl: null, error: null }
    }
    return state
  })

  const params = allParams[provider]
  const config = PROVIDERS[provider]
  const currentState = providerState[provider] || { generating: false, progress: 0, videoUrl: null, error: null }
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
      [targetProvider]: { ...prev[targetProvider], ...updates },
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

  const handleProviderChange = useCallback((nextProvider) => {
    setProvider(nextProvider)
    setPrompt('')
    setSelectedTemplate(null)
    setGenerationMode('t2v')
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

    if (provider === 'veo') {
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
      if (provider === 'veo') {
        const uploadedReferences = await uploadVideoReferences(videoReferences)
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
      } else if (provider === 'gemini-image') {
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
      <Header />
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

function buildVideoRequest(provider, params, prompt, mode, references) {
  if (provider !== 'veo') throw new Error(`Unsupported provider: ${provider}`)

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

async function uploadVideoReferences(references) {
  const images = await uploadReferenceBatch(references.images)
  const videos = await uploadReferenceBatch(references.videos)
  const audios = await uploadReferenceBatch(references.audios)

  return {
    images: images.urls,
    videos: videos.urls,
    audios: audios.urls,
    requiresPublicBaseUrl: images.requiresPublicBaseUrl || videos.requiresPublicBaseUrl || audios.requiresPublicBaseUrl,
  }
}

async function uploadReferenceBatch(assets) {
  if (!assets.length) {
    return { urls: [], requiresPublicBaseUrl: false }
  }

  const formData = new FormData()
  for (const asset of assets) {
    formData.append('files', asset.file, asset.file.name)
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
    urls: data.files.map((file) => file.url),
    requiresPublicBaseUrl: data.publiclyReachable === false,
  }
}

function createEmptyVideoReferences() {
  return { images: [], videos: [], audios: [] }
}

function releaseVideoReferences(references) {
  for (const key of ['images', 'videos', 'audios']) {
    for (const asset of references[key] || []) {
      if (asset.previewUrl && asset.previewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(asset.previewUrl)
      }
    }
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
