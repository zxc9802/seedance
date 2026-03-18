import { useState, useCallback } from 'react'
import { AnimatePresence } from 'framer-motion'
import { PROVIDERS, PROVIDER_ORDER } from './modelConfig'
import Header from './components/Header'
import ProviderTabs from './components/ProviderTabs'
import PromptInput from './components/PromptInput'
import ParameterPanel from './components/ParameterPanel'
import VideoPreview from './components/VideoPreview'
import ApiConfigModal from './components/ApiConfigModal'
import './App.css'

function App() {
  const [provider, setProvider] = useState('veo')
  const [allParams, setAllParams] = useState(() => {
    const p = {}
    for (const key of PROVIDER_ORDER) p[key] = { ...PROVIDERS[key].defaults }
    return p
  })
  const [prompt, setPrompt] = useState('')
  const [generating, setGenerating] = useState(false)
  const [progress, setProgress] = useState(0)
  const [videoUrl, setVideoUrl] = useState(null)
  const [error, setError] = useState(null)
  const [generationMode, setGenerationMode] = useState('t2v')
  const [referenceMedia, setReferenceMedia] = useState(null)
  const [selectedTemplate, setSelectedTemplate] = useState(null)
  const [showApiConfig, setShowApiConfig] = useState(false)
  const [apiKeys, setApiKeys] = useState(() => {
    try {
      const s = localStorage.getItem('video_api_keys')
      return s ? JSON.parse(s) : {}
    } catch { return {} }
  })

  const params = allParams[provider]
  const config = PROVIDERS[provider]

  const updateParam = useCallback((key, value) => {
    setAllParams(prev => ({
      ...prev,
      [provider]: { ...prev[provider], [key]: value }
    }))
  }, [provider])

  const saveApiKeys = useCallback((keys) => {
    setApiKeys(keys)
    localStorage.setItem('video_api_keys', JSON.stringify(keys))
    setShowApiConfig(false)
  }, [])

  const handleGenerate = useCallback(async () => {
    if (!prompt.trim() && !selectedTemplate) return
    const hasKey = apiKeys[provider]?.apiKey
    if (!hasKey) {
      setShowApiConfig(true)
      return
    }
    setGenerating(true)
    setError(null)
    setVideoUrl(null)
    setProgress(0)

    try {
      let p = 0
      const iv = setInterval(() => {
        p += Math.random() * 8 + 2
        if (p > 95) p = 95
        setProgress(Math.round(p))
      }, 800)

      const finalPrompt = selectedTemplate
        ? (prompt.trim() ? `${selectedTemplate.prompt}. Additional requirements: ${prompt.trim()}` : selectedTemplate.prompt)
        : prompt
      const requestInfo = buildRequest(provider, params, finalPrompt, apiKeys[provider], generationMode, referenceMedia)
      console.log('Request:', JSON.stringify(requestInfo, null, 2))

      if (provider === 'gemini-image') {
        // Real API call for Gemini image generation
        const res = await fetch(requestInfo.url, {
          method: 'POST',
          headers: requestInfo.headers,
          body: JSON.stringify(requestInfo.body),
        })
        clearInterval(iv)
        if (!res.ok) {
          const errData = await res.text()
          throw new Error(`API 错误 (${res.status}): ${errData}`)
        }
        const data = await res.json()
        setProgress(100)
        // Extract base64 image from response
        const content = data.choices?.[0]?.message?.content
        if (content) {
          // Check if content contains inline_data with base64 image
          const parts = data.choices?.[0]?.message?.parts
          if (parts) {
            const imagePart = parts.find(p => p.inline_data)
            if (imagePart) {
              const mimeType = imagePart.inline_data.mime_type || 'image/png'
              setVideoUrl(`data:${mimeType};base64,${imagePart.inline_data.data}`)
              return
            }
          }
          // Try to extract base64 from markdown image in content
          const b64Match = content.match(/data:(image\/[a-zA-Z+]+);base64,([A-Za-z0-9+/=\s]+)/)
          if (b64Match) {
            setVideoUrl(b64Match[0].replace(/\s/g, ''))
          } else {
            // Check if the response has image data in a different format  
            // Some APIs return raw base64 blocks
            const rawB64 = content.match(/\b([A-Za-z0-9+/]{100,}={0,2})\b/)
            if (rawB64) {
              setVideoUrl(`data:image/png;base64,${rawB64[1]}`)
            } else {
              setError(`生成完成，但未找到图片数据。返回内容: ${content.substring(0, 200)}`)
            }
          }
        } else {
          setError('API 返回格式异常，未找到内容')
        }
      } else {
        // Simulation for other providers
        await new Promise(r => setTimeout(r, 3000))
        clearInterval(iv)
        setProgress(100)
        const isImageProvider = PROVIDERS[provider].outputType === 'image'
        setError(`演示模式：API 调用已记录到控制台。请连接你的 API 密钥以进行真实${isImageProvider ? '图片' : '视频'}生成。`)
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setGenerating(false)
    }
  }, [prompt, params, provider, apiKeys, generationMode, referenceMedia, selectedTemplate])

  return (
    <div className="app-layout">
      <Header onApiConfig={() => setShowApiConfig(true)} apiKeys={apiKeys} provider={provider} />
      <main className="app-main">
        <div className="left-panel">
          <ProviderTabs provider={provider} onChange={(p) => { setProvider(p); setSelectedTemplate(null) }} />
          <PromptInput
            prompt={prompt}
            onPromptChange={setPrompt}
            mode={generationMode}
            onModeChange={setGenerationMode}
            media={referenceMedia}
            onMediaChange={setReferenceMedia}
            providerConfig={config}
            onGenerate={handleGenerate}
            generating={generating}
            negativePrompt={params.negativePrompt ?? ''}
            onNegativePromptChange={(v) => updateParam('negativePrompt', v)}
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
            videoUrl={videoUrl}
            generating={generating}
            progress={progress}
            error={error}
            params={params}
            provider={provider}
          />
        </div>
      </main>
      <AnimatePresence>
        {showApiConfig && (
          <ApiConfigModal
            apiKeys={apiKeys}
            onSave={saveApiKeys}
            onClose={() => setShowApiConfig(false)}
            activeProvider={provider}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

function buildRequest(provider, params, prompt, creds, mode, media) {
  if (provider === 'veo') {
    const isVeo3 = params.model.includes('veo-3')
    const isVeo2 = params.model.includes('veo-2')
    const p = {
      aspectRatio: params.aspectRatio,
      durationSeconds: params.duration,
      sampleCount: params.sampleCount,
      compressionQuality: params.compressionQuality,
      personGeneration: params.personGeneration,
      generateAudio: params.generateAudio,
    }
    if (isVeo3) p.resolution = params.resolution
    if (isVeo2) p.enhancePrompt = params.enhancePrompt
    if (params.negativePrompt) p.negativePrompt = params.negativePrompt
    if (mode === 'i2v' && media) p.image = { bytesBase64Encoded: media.split(',')[1] }
    return {
      url: `https://${creds.location || 'us-central1'}-aiplatform.googleapis.com/v1/projects/${creds.projectId}/locations/${creds.location || 'us-central1'}/publishers/google/models/${params.model}:predictLongRunning`,
      body: { instances: [{ prompt }], parameters: p },
    }
  }
  if (provider === 'wan') {
    let modelName = params.model
    if (mode === 'i2v') modelName = modelName.replace('-t2v', '-i2v')
    const body = { model: `alibaba/${modelName}`, prompt, resolution: params.resolution, aspect_ratio: params.aspectRatio }
    if (mode === 'i2v' && media) body.image_url = media
    if (params.negativePrompt) body.negative_prompt = params.negativePrompt
    if (params.watermark !== undefined) body.watermark = params.watermark
    return { url: creds.endpoint || 'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/text2video/video-synthesis/', body }
  }
  if (provider === 'kling') {
    const body = {
      model: params.model,
      prompt,
      duration: String(params.duration),
      mode: params.mode,
      cfg_scale: params.cfgScale,
    }
    if (mode === 't2v') body.aspect_ratio = params.aspectRatio
    if (mode === 'i2v' && media) body.image = media
    if (mode === 'v2v' && media) body.video = media
    if (params.negativePrompt) body.negative_prompt = params.negativePrompt
    if (params.generateAudio) body.sound = true
    const cam = params.cameraControl
    if (cam && Object.values(cam).some(v => v !== 0)) {
      body.camera_control = { type: 'simple', config: cam }
    }
    let endpointPath = 'text2video'
    if (mode === 'i2v') endpointPath = 'image2video'
    if (mode === 'v2v') endpointPath = 'video2video'
    return { url: creds.endpoint || `https://api.klingai.com/v1/videos/${endpointPath}`, body }
  }
  if (provider === 'gemini-image') {
    const content = []
    content.push({ type: 'text', text: prompt })
    if (mode === 'i2v' && media) {
      // Use standard OpenAI image_url format with data URI for maximum compatibility
      content.push({
        type: 'image_url',
        image_url: { url: media }
      })
    }
    const endpoint = creds.endpoint || 'http://47.77.198.47:3001/v1/chat/completions'
    return {
      url: endpoint,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${creds.apiKey}`,
      },
      body: {
        model: params.model,
        messages: [{ role: 'user', content }],
      },
    }
  }
}

export default App
