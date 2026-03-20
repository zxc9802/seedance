import { useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ChevronDown,
  ChevronUp,
  FileImage,
  Film,
  Image as ImageIcon,
  Layers3,
  Loader2,
  Music4,
  Palette,
  Plus,
  Send,
  UploadCloud,
  Video,
  X,
} from 'lucide-react'
import './PromptInput.css'

export default function PromptInput({
  prompt,
  onPromptChange,
  onGenerate,
  generating,
  negativePrompt,
  onNegativePromptChange,
  providerColor,
  mode,
  onModeChange,
  mediaList,
  onMediaListChange,
  videoReferences,
  onVideoReferencesChange,
  maxImages,
  maxVideos,
  maxAudios,
  providerConfig,
  selectedTemplate,
  onTemplateSelect,
}) {
  const [showNeg, setShowNeg] = useState(false)
  const [mediaError, setMediaError] = useState(null)
  const fileInputRef = useRef(null)

  const isImageOutput = providerConfig.outputType === 'image'
  const isVideoProvider = providerConfig.id === 'veo'
  const templates = providerConfig.promptTemplates || []
  const modeOptions = providerConfig.generationModes || buildDefaultModes(providerConfig, isImageOutput)

  const generationDisabled = generating
    || (!prompt.trim() && !selectedTemplate)
    || (isVideoProvider
      ? !hasRequiredVideoAssets(mode, videoReferences)
      : (mode !== 't2v' && mediaList.length === 0))

  const processImageFiles = (files) => {
    const remaining = maxImages - mediaList.length
    if (remaining <= 0) {
      setMediaError(`最多只能添加 ${maxImages} 张参考图`)
      return
    }

    const nextFiles = files.slice(0, remaining)
    nextFiles.forEach((file) => {
      if (!file.type.startsWith('image/')) {
        setMediaError('请上传 JPG、PNG 或 WebP 图片')
        return
      }

      if (file.size > 20 * 1024 * 1024) {
        setMediaError('图片不能超过 20MB')
        return
      }

      const reader = new FileReader()
      reader.onload = (event) => {
        onMediaListChange((prev) => {
          if (prev.length >= maxImages) return prev
          return [...prev, event.target.result]
        })
      }
      reader.onerror = () => setMediaError('读取图片失败')
      reader.readAsDataURL(file)
    })

    if (files.length > remaining) {
      setMediaError(`最多只能添加 ${maxImages} 张参考图，超出的已忽略`)
    }
  }

  const addVideoAssets = (kind, files, limit) => {
    if (!files.length) return

    setMediaError(null)
    onVideoReferencesChange((prev) => {
      const current = prev[kind]
      const remaining = limit - current.length
      if (remaining <= 0) {
        setMediaError(`最多只能添加 ${limit} 个${bucketLabel(kind)}`)
        return prev
      }

      const accepted = []
      for (const file of files.slice(0, remaining)) {
        const error = validateAssetFile(kind, file)
        if (error) {
          setMediaError(error)
          continue
        }
        accepted.push(createLocalAsset(file))
      }

      return {
        ...prev,
        [kind]: [...current, ...accepted],
      }
    })
  }

  const removeVideoAsset = (kind, assetId) => {
    onVideoReferencesChange((prev) => {
      const nextAssets = []
      for (const asset of prev[kind]) {
        if (asset.id === assetId) {
          if (asset.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(asset.previewUrl)
          continue
        }
        nextAssets.push(asset)
      }
      return {
        ...prev,
        [kind]: nextAssets,
      }
    })
  }

  const removeImageMedia = (index) => {
    onMediaListChange((prev) => prev.filter((_, currentIndex) => currentIndex !== index))
    setMediaError(null)
  }

  const promptPlaceholder = (() => {
    if (selectedTemplate) {
      return `已选择“${selectedTemplate.title}”模板，可直接生成或补充额外要求...`
    }

    if (mode === 't2v') {
      return isImageOutput ? '描述你想生成的图片...' : '描述你想生成的视频...'
    }

    return isImageOutput
      ? '描述参考图需要怎么修改...'
      : '描述这些参考素材将如何被转换、融合或延展...'
  })()

  return (
    <div className="prompt-section">
      <div className="prompt-header">
        <div className="mode-tabs">
          {modeOptions.map((option) => (
            <button
              key={option.value}
              className={`mode-tab ${mode === option.value ? 'active' : ''}`}
              onClick={() => onModeChange(option.value)}
              style={{ '--tc': providerColor }}
            >
              {renderModeIcon(option.value, isImageOutput)}
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      </div>

      {templates.length > 0 && (
        <div className="template-row">
          {templates.map((template) => (
            <button
              key={template.id}
              className={`template-card ${selectedTemplate?.id === template.id ? 'active' : ''}`}
              style={{ '--tc': providerColor }}
              onClick={() => onTemplateSelect(selectedTemplate?.id === template.id ? null : template)}
              title={template.prompt}
            >
              <span className="tpl-emoji">{template.emoji}</span>
              <span className="tpl-title">{template.title}</span>
            </button>
          ))}
        </div>
      )}

      <div className="prompt-wrap">
        <div className="prompt-inner">
          <div className="prompt-text-area">
            <textarea
              className="prompt-ta"
              placeholder={promptPlaceholder}
              value={prompt}
              onChange={(event) => onPromptChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  onGenerate()
                }
              }}
              rows={6}
            />
          </div>
        </div>

        <div className="prompt-bar">
          {providerConfig.features.negativePrompt ? (
            <button className="neg-toggle" onClick={() => setShowNeg((prev) => !prev)}>
              {showNeg ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              <span>反向提示词</span>
            </button>
          ) : (
            <span className="prompt-bar-spacer" />
          )}

          <button
            className="gen-btn"
            onClick={onGenerate}
            disabled={generationDisabled}
            style={{ '--btn-color': providerColor }}
          >
            {generating ? (
              <>
                <Loader2 size={13} className="spin" />
                <span>生成中...</span>
              </>
            ) : (
              <>
                <Send size={12} />
                <span>生成</span>
              </>
            )}
          </button>
        </div>
      </div>

      <AnimatePresence>
        {providerConfig.features.negativePrompt && showNeg && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="neg-wrap"
          >
            <textarea
              className="neg-ta"
              placeholder="排除元素：模糊、低质量、字幕、水印..."
              value={negativePrompt}
              onChange={(event) => onNegativePromptChange(event.target.value)}
              rows={2}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <div className="prompt-hint">
        按 <kbd>Ctrl</kbd>+<kbd>Enter</kbd> 生成
      </div>

      <AnimatePresence>
        {mode !== 't2v' && (
          <motion.div
            className="ref-images-section"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25 }}
          >
            <div className="ref-images-header">
              <UploadCloud size={13} />
              <span>{isVideoProvider ? '参考素材' : '参考图片'}</span>
            </div>

            {isVideoProvider ? (
              <div className="ref-upload-grid">
                {maxImages > 0 && (
                  <AssetUploadBucket
                    title={mode === 'flf' ? '首尾帧图片' : '参考图片'}
                    subtitle={mode === 'flf' ? '顺序上传：先首帧，再尾帧' : mode === 'fusion' ? '最多 9 张参考图片' : '上传 1 张参考图片'}
                    icon={<ImageIcon size={14} />}
                    accept="image/jpeg,image/png,image/webp"
                    assets={videoReferences.images}
                    maxItems={maxImages}
                    onAdd={(files) => addVideoAssets('images', files, maxImages)}
                    onRemove={(assetId) => removeVideoAsset('images', assetId)}
                    kind="images"
                  />
                )}

                {mode === 'fusion' && maxVideos > 0 && (
                  <AssetUploadBucket
                    title="参考视频"
                    subtitle="支持 mp4、mov，最多 3 段视频"
                    icon={<Film size={14} />}
                    accept="video/mp4,video/quicktime"
                    assets={videoReferences.videos}
                    maxItems={maxVideos}
                    onAdd={(files) => addVideoAssets('videos', files, maxVideos)}
                    onRemove={(assetId) => removeVideoAsset('videos', assetId)}
                    kind="videos"
                  />
                )}

                {mode === 'fusion' && maxAudios > 0 && (
                  <AssetUploadBucket
                    title="参考音频"
                    subtitle="支持 mp3、wav，最多 3 段音频。音频不能单独作为参考。"
                    icon={<Music4 size={14} />}
                    accept="audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/wave"
                    assets={videoReferences.audios}
                    maxItems={maxAudios}
                    onAdd={(files) => addVideoAssets('audios', files, maxAudios)}
                    onRemove={(assetId) => removeVideoAsset('audios', assetId)}
                    kind="audios"
                  />
                )}
              </div>
            ) : (
              <div className="ref-images-body">
                {mediaList.map((media, index) => (
                  <div key={`${media}-${index}`} className="ref-thumb">
                    <img src={media} alt={`参考图 ${index + 1}`} />
                    <button className="ref-thumb-remove" onClick={() => removeImageMedia(index)}>
                      <X size={10} />
                    </button>
                    <span className="ref-thumb-index">{index + 1}</span>
                  </div>
                ))}

                {mediaList.length < maxImages && (
                  <div className="ref-add-btn" onClick={() => fileInputRef.current?.click()}>
                    <input
                      ref={fileInputRef}
                      type="file"
                      className="hidden-input"
                      accept="image/jpeg,image/png,image/webp"
                      multiple
                      onChange={(event) => {
                        if (event.target.files?.length) {
                          processImageFiles(Array.from(event.target.files))
                        }
                        event.target.value = ''
                      }}
                    />
                    <Plus size={20} strokeWidth={1.5} />
                    <span>添加图片</span>
                  </div>
                )}
              </div>
            )}

            {isVideoProvider && (
              <div className="ref-url-note">
                本地文件会先上传到项目后端的临时目录，再转成素材 URL 提交给模型。若要在本机开发环境使用参考素材，需要把后端部署到公网，或设置 `PUBLIC_BASE_URL` 指向公网域名/隧道。
              </div>
            )}

            {mediaError && <div className="ref-error">{mediaError}</div>}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function AssetUploadBucket({ title, subtitle, icon, accept, assets, maxItems, onAdd, onRemove, kind }) {
  const inputRef = useRef(null)

  return (
    <div className="asset-bucket">
      <div className="asset-bucket-head">
        <div className="asset-bucket-title">
          {icon}
          <span>{title}</span>
        </div>
        <span className="asset-bucket-limit">{assets.length}/{maxItems}</span>
      </div>
      {subtitle && <div className="asset-bucket-subtitle">{subtitle}</div>}

      <div className="asset-bucket-grid">
        {assets.map((asset, index) => (
          <div key={asset.id} className={`asset-card ${kind}`}>
            <button className="asset-card-remove" onClick={() => onRemove(asset.id)}>
              <X size={10} />
            </button>
            <span className="asset-card-index">{index + 1}</span>
            {kind === 'images' && (
              <img src={asset.previewUrl} alt={asset.name} className="asset-card-preview" />
            )}
            {kind === 'videos' && (
              <video src={asset.previewUrl} className="asset-card-preview" muted />
            )}
            {kind === 'audios' && (
              <div className="asset-card-fileicon">
                <Music4 size={18} />
              </div>
            )}
            <div className="asset-card-meta">
              <span className="asset-card-name" title={asset.name}>{asset.name}</span>
              <span className="asset-card-size">{formatFileSize(asset.size)}</span>
            </div>
          </div>
        ))}

        {assets.length < maxItems && (
          <button className="asset-card asset-card-add" onClick={() => inputRef.current?.click()}>
            <input
              ref={inputRef}
              type="file"
              className="hidden-input"
              accept={accept}
              multiple
              onChange={(event) => {
                if (event.target.files?.length) {
                  onAdd(Array.from(event.target.files))
                }
                event.target.value = ''
              }}
            />
            <Plus size={18} />
            <span>添加文件</span>
          </button>
        )}
      </div>
    </div>
  )
}

function buildDefaultModes(providerConfig, isImageOutput) {
  const modes = [
    { value: 't2v', label: isImageOutput ? '文生图' : '文生视频' },
  ]

  if (providerConfig.features.referenceImage) {
    modes.push({ value: 'i2v', label: isImageOutput ? '图生图' : '图生视频' })
  }

  if (providerConfig.features.referenceVideo) {
    modes.push({ value: 'v2v', label: '视频生成视频' })
  }

  return modes
}

function renderModeIcon(mode, isImageOutput) {
  switch (mode) {
    case 'i2v':
      return <ImageIcon size={13} />
    case 'flf':
      return <Layers3 size={13} />
    case 'fusion':
      return <Video size={13} />
    case 't2v':
    default:
      return isImageOutput ? <Palette size={13} /> : <FileImage size={13} />
  }
}

function hasRequiredVideoAssets(mode, references) {
  if (mode === 't2v') return true
  if (mode === 'i2v') return references.images.length === 1
  if (mode === 'flf') return references.images.length === 2
  if (mode === 'fusion') {
    const imageCount = references.images.length
    const videoCount = references.videos.length
    const audioCount = references.audios.length
    return imageCount + videoCount + audioCount > 0 && imageCount + videoCount > 0
  }
  return false
}

function createLocalAsset(file) {
  return {
    id: crypto.randomUUID(),
    file,
    name: file.name,
    size: file.size,
    mimeType: file.type,
    previewUrl: file.type.startsWith('image/') || file.type.startsWith('video/')
      ? URL.createObjectURL(file)
      : '',
  }
}

function validateAssetFile(kind, file) {
  if (kind === 'images') {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      return '图片仅支持 JPG、PNG、WebP'
    }
    if (file.size > 20 * 1024 * 1024) {
      return '单张图片不能超过 20MB'
    }
    return null
  }

  if (kind === 'videos') {
    if (!['video/mp4', 'video/quicktime'].includes(file.type)) {
      return '参考视频仅支持 mp4、mov'
    }
    if (file.size > 50 * 1024 * 1024) {
      return '单个参考视频不能超过 50MB'
    }
    return null
  }

  if (kind === 'audios') {
    if (!['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave'].includes(file.type)) {
      return '参考音频仅支持 mp3、wav'
    }
    if (file.size > 15 * 1024 * 1024) {
      return '单个参考音频不能超过 15MB'
    }
  }

  return null
}

function bucketLabel(kind) {
  switch (kind) {
    case 'images':
      return '参考图片'
    case 'videos':
      return '参考视频'
    case 'audios':
      return '参考音频'
    default:
      return '文件'
  }
}

function formatFileSize(size) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}
