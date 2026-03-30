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

let referenceAssetOrderCounter = 0

function nextReferenceAssetOrder() {
  referenceAssetOrderCounter += 1
  return Date.now() * 1000 + referenceAssetOrderCounter
}

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
  const [imageDropActive, setImageDropActive] = useState(false)
  const fileInputRef = useRef(null)

  const isImageOutput = providerConfig.outputType === 'image'
  const isVideoProvider = providerConfig.outputType !== 'image' && providerConfig.id !== 'gemini-image'
  const templates = providerConfig.promptTemplates || []
  const modeOptions = providerConfig.generationModes || buildDefaultModes(providerConfig, isImageOutput)
  const imageAccept = getImageAccept(providerConfig)
  const videoAccept = getVideoAccept(providerConfig)

  const generationDisabled = generating
    || (!prompt.trim() && !selectedTemplate)
    || (isVideoProvider
      ? !hasRequiredVideoAssets(mode, videoReferences)
      : (mode !== 't2v' && mediaList.length === 0))

  const processImageFiles = async (files) => {
    setMediaError(null)
    const remaining = maxImages - mediaList.length
    if (remaining <= 0) {
      setMediaError(`最多只能添加 ${maxImages} 张参考图`)
      return
    }

    const nextFiles = files.slice(0, remaining)
    const accepted = []

    for (const file of nextFiles) {
      const error = await validateAssetFile('images', file, providerConfig)
      if (error) {
        setMediaError(error)
        continue
      }

      try {
        accepted.push(await readFileAsDataUrl(file))
      } catch {
        setMediaError('读取图片失败')
      }
    }

    if (accepted.length > 0) {
      onMediaListChange((prev) => [...prev, ...accepted].slice(0, maxImages))
    }

    if (files.length > remaining) {
      setMediaError(`最多只能添加 ${maxImages} 张参考图，超出的已忽略`)
    }
  }

  const imageDropHandlers = createFileDropHandlers({
    onFiles: processImageFiles,
    onActiveChange: setImageDropActive,
  })

  const addVideoAssets = async (kind, files, limit) => {
    if (!files.length) return

    setMediaError(null)
    const currentAssets = videoReferences[kind]
    const remaining = limit - currentAssets.length
    if (remaining <= 0) {
      setMediaError(`最多只能添加 ${limit} 个${bucketLabel(kind)}`)
      return
    }

    if (
      providerConfig.id === 'kling'
      && kind === 'videos'
      && mode === 'fusion'
      && videoReferences.images.length > 4
    ) {
      setMediaError('可灵带参考视频时，参考图片最多保留 4 张，请先删减图片')
      return
    }

    const accepted = []
    for (const file of files.slice(0, remaining)) {
      const error = await validateAssetFile(kind, file, providerConfig)
      if (error) {
        setMediaError(error)
        continue
      }
      accepted.push(createLocalAsset(file))
    }

    if (accepted.length > 0) {
      onVideoReferencesChange((prev) => ({
        ...prev,
        [kind]: [...prev[kind], ...accepted].slice(0, limit),
      }))
    }

    if (files.length > remaining) {
      setMediaError(`最多只能添加 ${limit} 个${bucketLabel(kind)}，超出的已忽略`)
    }
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
                    subtitle={getImageBucketSubtitle(providerConfig, mode, maxImages)}
                    icon={<ImageIcon size={14} />}
                    accept={imageAccept}
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
                    subtitle={getVideoBucketSubtitle(providerConfig, maxVideos)}
                    icon={<Film size={14} />}
                    accept={videoAccept}
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
                    subtitle="支持 mp3、wav，最多 3 段。音频不能单独作为参考。"
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
              <div
                className={`ref-images-body ${imageDropActive ? 'drag-active' : ''}`}
                {...imageDropHandlers}
              >
                {imageDropActive && (
                  <div className="drop-overlay">
                    <UploadCloud size={18} />
                    <span>{'拖拽到这里上传参考图片'}</span>
                  </div>
                )}
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
                      accept={imageAccept}
                      multiple
                      onChange={(event) => {
                        if (event.target.files?.length) {
                          void processImageFiles(Array.from(event.target.files))
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
                本地文件会先上传到项目后端的临时目录，再转成素材 URL 提交给模型。若要在本机开发环境使用参考素材，需要把后端部署到公网，或设置
                {' '}
                <code>PUBLIC_BASE_URL</code>
                {' '}
                指向公网域名/隧道。
                {providerConfig.referenceHelpText && (
                  <>
                    {' '}
                    {providerConfig.referenceHelpText}
                  </>
                )}
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
  const [dragActive, setDragActive] = useState(false)
  const inputRef = useRef(null)
  const dropHandlers = createFileDropHandlers({
    onFiles: onAdd,
    onActiveChange: setDragActive,
  })

  return (
    <div
      className={`asset-bucket ${dragActive ? 'drag-active' : ''}`}
      {...dropHandlers}
    >
      <div className="asset-bucket-head">
        <div className="asset-bucket-title">
          {icon}
          <span>{title}</span>
        </div>
        <span className="asset-bucket-limit">{assets.length}/{maxItems}</span>
      </div>
      {subtitle && <div className="asset-bucket-subtitle">{subtitle}</div>}

      <div className="asset-bucket-grid">
        {dragActive && (
          <div className="drop-overlay bucket">
            <UploadCloud size={18} />
            <span>{`拖拽到这里上传${bucketLabel(kind)}`}</span>
          </div>
        )}
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
                  void onAdd(Array.from(event.target.files))
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
    modes.push({ value: 'v2v', label: '视频生视频' })
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
    case 'ref':
      return <ImageIcon size={13} />
    case 't2v':
    default:
      return isImageOutput ? <Palette size={13} /> : <FileImage size={13} />
  }
}

function getImageBucketSubtitle(providerConfig, mode, maxImages) {
  if (mode === 'flf') {
    return '顺序上传：先首帧，再尾帧'
  }

  if (providerConfig.id === 'kling' && mode === 'fusion') {
    return '无参考视频时最多 7 张；带参考视频时最多 4 张'
  }

  if (mode === 'ref') {
    return `最多 ${maxImages} 张参考图片`
  }

  if (mode === 'i2v') {
    return '上传 1 张参考图片'
  }

  return `最多 ${maxImages} 张参考图片`
}

function getVideoBucketSubtitle(providerConfig, maxVideos) {
  if (providerConfig.id === 'kling') {
    return '支持 MP4、MOV，最多 1 段，时长不少于 3 秒'
  }

  return `支持 mp4、mov，最多 ${maxVideos} 段参考视频`
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
  if (mode === 'ref') {
    return references.images.length > 0
  }
  return false
}

function createLocalAsset(file) {
  return {
    id: crypto.randomUUID(),
    order: nextReferenceAssetOrder(),
    file,
    name: file.name,
    size: file.size,
    mimeType: file.type,
    previewUrl: file.type.startsWith('image/') || file.type.startsWith('video/')
      ? URL.createObjectURL(file)
      : '',
  }
}

async function validateAssetFile(kind, file, providerConfig) {
  if (kind === 'images') {
    const allowedImageMimeTypes = getAllowedImageMimeTypes(providerConfig)
    if (!allowedImageMimeTypes.includes(file.type)) {
      return `图片仅支持 ${getMimeTypeLabel(providerConfig, 'images')}`
    }

    const imageMaxSizeMb = getFileSizeLimitMb(providerConfig, 'images')
    if (file.size > imageMaxSizeMb * 1024 * 1024) {
      return `单张参考图不能超过 ${imageMaxSizeMb}MB`
    }

    const imageValidation = providerConfig?.imageValidation
    if (imageValidation) {
      const metadata = await readImageMetadata(file)
      if (metadata.width < imageValidation.minWidth || metadata.height < imageValidation.minHeight) {
        return `图片宽高不能小于 ${imageValidation.minWidth}px`
      }

      if (imageValidation.minAspectRatio && imageValidation.maxAspectRatio) {
        const aspectRatio = metadata.width / metadata.height
        if (aspectRatio < imageValidation.minAspectRatio || aspectRatio > imageValidation.maxAspectRatio) {
          return `图片宽高比需在 ${imageValidation.aspectRatioLabel || '限制范围内'}`
        }
      }
    }

    return null
  }

  if (kind === 'videos') {
    const allowedVideoMimeTypes = getAllowedVideoMimeTypes(providerConfig)
    if (!allowedVideoMimeTypes.includes(file.type)) {
      return `参考视频仅支持 ${getMimeTypeLabel(providerConfig, 'videos')}`
    }

    const videoMaxSizeMb = getFileSizeLimitMb(providerConfig, 'videos')
    if (file.size > videoMaxSizeMb * 1024 * 1024) {
      return `单个参考视频不能超过 ${videoMaxSizeMb}MB`
    }

    const videoValidation = providerConfig?.videoValidation
    if (videoValidation) {
      const metadata = await readVideoMetadata(file)
      if (videoValidation.minDurationSec && metadata.duration < videoValidation.minDurationSec) {
        return `参考视频时长不能少于 ${videoValidation.minDurationSec} 秒`
      }

      if (
        (videoValidation.minWidth && metadata.width < videoValidation.minWidth)
        || (videoValidation.minHeight && metadata.height < videoValidation.minHeight)
        || (videoValidation.maxWidth && metadata.width > videoValidation.maxWidth)
        || (videoValidation.maxHeight && metadata.height > videoValidation.maxHeight)
      ) {
        return `参考视频宽高需介于 ${videoValidation.minWidth}px 和 ${videoValidation.maxWidth}px 之间`
      }
    }

    return null
  }

  if (kind === 'audios') {
    if (!['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave'].includes(file.type)) {
      return '参考音频仅支持 mp3、wav'
    }

    const audioMaxSizeMb = getFileSizeLimitMb(providerConfig, 'audios')
    if (file.size > audioMaxSizeMb * 1024 * 1024) {
      return `单个参考音频不能超过 ${audioMaxSizeMb}MB`
    }
  }

  return null
}

function getAllowedImageMimeTypes(providerConfig) {
  const mimeTypes = providerConfig?.imageMimeTypes
  return Array.isArray(mimeTypes) && mimeTypes.length > 0
    ? mimeTypes
    : ['image/jpeg', 'image/png', 'image/webp']
}

function getAllowedVideoMimeTypes(providerConfig) {
  const mimeTypes = providerConfig?.videoMimeTypes
  return Array.isArray(mimeTypes) && mimeTypes.length > 0
    ? mimeTypes
    : ['video/mp4', 'video/quicktime']
}

function getImageAccept(providerConfig) {
  return getAllowedImageMimeTypes(providerConfig).join(',')
}

function getVideoAccept(providerConfig) {
  return getAllowedVideoMimeTypes(providerConfig).join(',')
}

function getFileSizeLimitMb(providerConfig, kind) {
  if (kind === 'images') {
    return Number(providerConfig?.imageMaxSizeMb || 20)
  }

  if (kind === 'videos') {
    return Number(providerConfig?.videoMaxSizeMb || 50)
  }

  if (kind === 'audios') {
    return Number(providerConfig?.audioMaxSizeMb || 15)
  }

  return 20
}

function getMimeTypeLabel(providerConfig, kind) {
  if (kind === 'images') {
    return providerConfig?.imageMimeTypeLabel || 'JPG/JPEG、PNG、WebP'
  }

  if (kind === 'videos') {
    return providerConfig?.videoMimeTypeLabel || 'MP4、MOV'
  }

  return 'mp3、wav'
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

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (event) => resolve(event.target?.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function readImageMetadata(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(objectUrl)
      resolve({
        width: image.naturalWidth,
        height: image.naturalHeight,
      })
    }
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('Failed to read image metadata'))
    }
    image.src = objectUrl
  })
}

function readVideoMetadata(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(objectUrl)
      resolve({
        width: video.videoWidth,
        height: video.videoHeight,
        duration: video.duration,
      })
    }
    video.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('Failed to read video metadata'))
    }
    video.src = objectUrl
  })
}

function createFileDropHandlers({ onFiles, onActiveChange }) {
  const activate = (event) => {
    if (!hasFilePayload(event)) return

    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
    onActiveChange(true)
  }

  return {
    onDragEnter: activate,
    onDragOver: activate,
    onDragLeave: (event) => {
      if (!hasFilePayload(event)) return

      event.preventDefault()
      event.stopPropagation()

      if (event.currentTarget.contains(event.relatedTarget)) return
      onActiveChange(false)
    },
    onDrop: (event) => {
      if (!hasFilePayload(event)) return

      event.preventDefault()
      event.stopPropagation()
      onActiveChange(false)

      const files = Array.from(event.dataTransfer?.files || [])
      if (files.length > 0) {
        void onFiles(files)
      }
    },
  }
}

function hasFilePayload(event) {
  return Array.from(event.dataTransfer?.types || []).includes('Files')
}
