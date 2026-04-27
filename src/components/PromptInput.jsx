import { useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ChevronDown,
  ChevronUp,
  FileText,
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
const COPYWRITING_ATTACHMENT_LIMIT = 8
const COPYWRITING_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
const COPYWRITING_DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]
const COPYWRITING_ATTACHMENT_ACCEPT = [
  ...COPYWRITING_IMAGE_MIME_TYPES,
  ...COPYWRITING_DOCUMENT_MIME_TYPES,
  '.md',
  '.doc',
  '.docx',
].join(',')

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
  params,
  onParamUpdate,
  mediaList,
  onMediaListChange,
  copywritingAttachments = [],
  onCopywritingAttachmentsChange,
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
  const [attachmentDropActive, setAttachmentDropActive] = useState(false)
  const fileInputRef = useRef(null)
  const attachmentInputRef = useRef(null)

  const isImageOutput = providerConfig.outputType === 'image'
  const isTextOutput = providerConfig.outputType === 'text'
  const usesLocalReferenceAssets = providerConfig.referenceInputMode === 'local'
  const isVideoProvider = (providerConfig.outputType || 'video') === 'video'
  const usesAssetBuckets = isVideoProvider || usesLocalReferenceAssets
  const templates = providerConfig.promptTemplates || []
  const modeOptions = providerConfig.generationModes || buildDefaultModes(providerConfig, isImageOutput)
  const imageAccept = getImageAccept(providerConfig)
  const videoAccept = getVideoAccept(providerConfig)
  const multiframeSegmentCount = Math.max(0, videoReferences.images.length - 1)
  const isSeedanceMultiframe = providerConfig.id === 'seedance2' && mode === 'multiframe'
  const shouldShowReferenceSection = isTextOutput
    ? false
    : usesAssetBuckets
    ? maxImages > 0 || maxVideos > 0 || maxAudios > 0
    : mode !== 't2v'

  const generationDisabled = generating || !hasAllRequiredInputs({
    providerConfig,
    mode,
    prompt,
    hasTemplate: Boolean(selectedTemplate),
    mediaList,
    videoReferences,
    params,
  })

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

  const processCopywritingAttachmentFiles = async (files) => {
    if (!onCopywritingAttachmentsChange) return

    setMediaError(null)
    const currentAttachments = Array.isArray(copywritingAttachments) ? copywritingAttachments : []
    const remaining = COPYWRITING_ATTACHMENT_LIMIT - currentAttachments.length
    if (remaining <= 0) {
      setMediaError(`最多只能添加 ${COPYWRITING_ATTACHMENT_LIMIT} 个附件`)
      return
    }

    const accepted = []
    for (const file of files.slice(0, remaining)) {
      const error = validateCopywritingAttachmentFile(file)
      if (error) {
        setMediaError(error)
        continue
      }

      try {
        const mimeType = file.type || inferMimeTypeFromFilename(file.name)
        const dataUrl = await readFileAsDataUrl(file)
        accepted.push({
          id: crypto.randomUUID(),
          name: file.name,
          size: file.size,
          mimeType,
          kind: mimeType.startsWith('image/') ? 'image' : 'document',
          dataUrl,
        })
      } catch {
        setMediaError('读取附件失败')
      }
    }

    if (accepted.length > 0) {
      onCopywritingAttachmentsChange((prev) => [
        ...(Array.isArray(prev) ? prev : []),
        ...accepted,
      ].slice(0, COPYWRITING_ATTACHMENT_LIMIT))
    }

    if (files.length > remaining) {
      setMediaError(`最多只能添加 ${COPYWRITING_ATTACHMENT_LIMIT} 个附件，超出的已忽略`)
    }
  }

  const attachmentDropHandlers = createFileDropHandlers({
    onFiles: processCopywritingAttachmentFiles,
    onActiveChange: setAttachmentDropActive,
  })

  const removeCopywritingAttachment = (attachmentId) => {
    onCopywritingAttachmentsChange?.((prev) => (
      Array.isArray(prev) ? prev.filter((attachment) => attachment.id !== attachmentId) : []
    ))
    setMediaError(null)
  }

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

  const updateTransitionPrompt = (index, value) => {
    const nextPrompts = Array.isArray(params?.transitionPrompts)
      ? [...params.transitionPrompts]
      : Array.from({ length: multiframeSegmentCount }, () => '')
    nextPrompts[index] = value
    onParamUpdate('transitionPrompts', nextPrompts)
  }

  const updateTransitionDuration = (index, value) => {
    const nextDurations = Array.isArray(params?.transitionDurations)
      ? [...params.transitionDurations]
      : Array.from({ length: multiframeSegmentCount }, () => '3')
    nextDurations[index] = value
    onParamUpdate('transitionDurations', nextDurations)
  }

  const promptPlaceholder = (() => {
    if (selectedTemplate) {
      return `已选择“${selectedTemplate.title}”模板，可直接生成或补充额外要求...`
    }

    if (providerConfig.id === 'seedance2' && mode === 'generate') {
      if (videoReferences.images.length === 0) {
        return '描述你想生成的视频，也可以上传 1 张图做图生视频，或上传 2 张图生成首尾帧过渡...'
      }

      if (videoReferences.images.length === 1) {
        return '描述这张图将如何动起来、镜头如何推进或场景如何变化...'
      }

      return '描述首帧到尾帧之间的动作、运镜和场景变化...'
    }

    if (isSeedanceMultiframe) {
      return videoReferences.images.length <= 2
        ? '上传 2 张图后，描述它们之间的动作、运镜或状态变化...'
        : '可选：补充整体风格说明；真正生效的是下方每一段过渡提示词...'
    }

    if (isTextOutput) {
      return '输入你要生成的文案需求、产品卖点、发布平台、语气和字数...'
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
              {renderModeIcon(option.value, isImageOutput, isTextOutput)}
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

      {isTextOutput && (
        <div className="copywriting-attachments">
          <div className="ref-images-header">
            <UploadCloud size={13} />
            <span>Claude 附件</span>
            <span className="ref-count">{copywritingAttachments.length}/{COPYWRITING_ATTACHMENT_LIMIT}</span>
          </div>

          <div
            className={`copywriting-attachment-drop ${attachmentDropActive ? 'drag-active' : ''}`}
            {...attachmentDropHandlers}
          >
            {attachmentDropActive && (
              <div className="drop-overlay">
                <UploadCloud size={18} />
                <span>拖拽到这里上传文档或图片</span>
              </div>
            )}

            <div className="copywriting-attachment-grid">
              {copywritingAttachments.map((attachment) => (
                <div key={attachment.id} className={`copywriting-attachment-card ${attachment.kind}`}>
                  <button
                    className="asset-card-remove"
                    onClick={() => removeCopywritingAttachment(attachment.id)}
                    type="button"
                  >
                    <X size={10} />
                  </button>
                  {attachment.kind === 'image' ? (
                    <img src={attachment.dataUrl} alt={attachment.name} className="copywriting-attachment-preview" />
                  ) : (
                    <div className="copywriting-attachment-fileicon">
                      <FileText size={18} />
                    </div>
                  )}
                  <div className="asset-card-meta">
                    <span className="asset-card-name" title={attachment.name}>{attachment.name}</span>
                    <span className="asset-card-size">{formatFileSize(attachment.size)}</span>
                  </div>
                </div>
              ))}

              {copywritingAttachments.length < COPYWRITING_ATTACHMENT_LIMIT && (
                <button
                  className="copywriting-attachment-add"
                  onClick={() => attachmentInputRef.current?.click()}
                  type="button"
                >
                  <input
                    ref={attachmentInputRef}
                    type="file"
                    className="hidden-input"
                    accept={COPYWRITING_ATTACHMENT_ACCEPT}
                    multiple
                    onChange={(event) => {
                      if (event.target.files?.length) {
                        void processCopywritingAttachmentFiles(Array.from(event.target.files))
                      }
                      event.target.value = ''
                    }}
                  />
                  <Plus size={18} />
                  <span>添加附件</span>
                </button>
              )}
            </div>
            <div className="copywriting-attachment-help">
              支持 PDF、TXT、Markdown、CSV、Word 文档，以及 JPG、PNG、WebP、GIF 图片。
            </div>
          </div>
          {mediaError && <div className="ref-error">{mediaError}</div>}
        </div>
      )}

      <AnimatePresence>
        {shouldShowReferenceSection && (
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

            {usesAssetBuckets ? (
              <div className="ref-upload-grid">
                {maxImages > 0 && (
                  <AssetUploadBucket
                    title={getImageBucketTitle(providerConfig, mode)}
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

            {providerConfig.features.transitionStoryboard && isSeedanceMultiframe && (
              <div className="storyboard-editor">
                <div className="storyboard-head">
                  <div className="storyboard-title">
                    <Layers3 size={14} />
                    <span>过渡编排</span>
                  </div>
                  <span className="storyboard-count">{multiframeSegmentCount} 段</span>
                </div>

                {videoReferences.images.length < 2 ? (
                  <div className="storyboard-empty">
                    先上传至少 2 张图片，再填写动作过渡描述。
                  </div>
                ) : videoReferences.images.length === 2 ? (
                  <div className="storyboard-single">
                    <div className="storyboard-tip">
                      请直接在上方主提示词里描述从第 1 张到第 2 张的动作/镜头变化；这里单独控制这 1 段的时长。
                    </div>
                    <label className="storyboard-duration">
                      <span>单段时长（秒）</span>
                      <input
                        type="number"
                        min="2"
                        max="8"
                        step="0.5"
                        value={params?.singleTransitionDuration || '3'}
                        onChange={(event) => onParamUpdate('singleTransitionDuration', event.target.value)}
                      />
                    </label>
                  </div>
                ) : (
                  <div className="storyboard-list">
                    {Array.from({ length: multiframeSegmentCount }).map((_, index) => (
                      <div key={`transition-${index}`} className="storyboard-card">
                        <div className="storyboard-card-head">
                          <span>{`过渡 ${index + 1}`}</span>
                          <span>{`${index + 1} -> ${index + 2}`}</span>
                        </div>
                        <textarea
                          className="storyboard-prompt"
                          placeholder={`描述第 ${index + 1} 张图如何过渡到第 ${index + 2} 张图...`}
                          value={params?.transitionPrompts?.[index] || ''}
                          onChange={(event) => updateTransitionPrompt(index, event.target.value)}
                          rows={2}
                        />
                        <label className="storyboard-duration">
                          <span>时长（秒）</span>
                          <input
                            type="number"
                            min="0.5"
                            max="8"
                            step="0.5"
                            value={params?.transitionDurations?.[index] || '3'}
                            onChange={(event) => updateTransitionDuration(index, event.target.value)}
                          />
                        </label>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {usesAssetBuckets && (
              <div className="ref-url-note">
                {providerConfig.backendKind === 'dreamina'
                  ? (
                    <>
                      本地文件会先上传到项目后端的临时目录，再由 Dreamina CLI 直接读取本地文件路径，不依赖
                      {' '}
                      <code>PUBLIC_BASE_URL</code>
                      {' '}
                      的公网映射。
                    </>
                  )
                  : (
                    <>
                      本地文件会先上传到项目后端的临时目录，再转成素材 URL 提交给模型。若要在本机开发环境使用参考素材，需要把后端部署到公网，或设置
                      {' '}
                      <code>PUBLIC_BASE_URL</code>
                      {' '}
                      指向公网域名/隧道。
                    </>
                  )}
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

function renderModeIcon(mode, isImageOutput, isTextOutput) {
  switch (mode) {
    case 'copywriting':
      return <FileText size={13} />
    case 'i2v':
      return <ImageIcon size={13} />
    case 'flf':
      return <Layers3 size={13} />
    case 'multiframe':
      return <Video size={13} />
    case 'fusion':
      return <Video size={13} />
    case 'generate':
      return <Video size={13} />
    case 'ref':
      return <ImageIcon size={13} />
    case 't2v':
    default:
      if (isTextOutput) return <FileText size={13} />
      return isImageOutput ? <Palette size={13} /> : <FileImage size={13} />
  }
}

function getImageBucketTitle(providerConfig, mode) {
  if (providerConfig.id === 'seedance2' && mode === 'multiframe') {
    return '动作参考图'
  }

  if (mode === 'flf') {
    return '首尾帧图片'
  }

  return '参考图片'
}

function getImageBucketSubtitle(providerConfig, mode, maxImages) {
  if (providerConfig.id === 'seedance2' && mode === 'generate') {
    return '可不传图；1 张图走图生视频；2 张图按顺序作为首尾帧'
  }

  if (providerConfig.id === 'seedance2' && mode === 'multiframe') {
    return '按顺序上传 2-20 张图片，系统会根据相邻图片生成动作过渡'
  }

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
  if (mode === 'generate') return true
  if (mode === 'i2v') return references.images.length === 1
  if (mode === 'flf') return references.images.length === 2
  if (mode === 'multiframe') return references.images.length >= 2
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

function hasAllRequiredInputs({ providerConfig, mode, prompt, hasTemplate, mediaList, videoReferences, params }) {
  const localAssetProvider = providerConfig.referenceInputMode === 'local'
  const isVideoProvider = (providerConfig.outputType || 'video') === 'video'
  const promptRequired = isPromptRequiredForMode(providerConfig, mode, videoReferences)

  if (promptRequired && !prompt.trim() && !hasTemplate) {
    return false
  }

  if (providerConfig.id === 'seedance2' && mode === 'multiframe') {
    const imageCount = videoReferences.images.length
    if (imageCount < 2) {
      return false
    }

    if (imageCount === 2) {
      return Boolean(params?.singleTransitionDuration)
    }

    const segmentCount = imageCount - 1
    const prompts = Array.isArray(params?.transitionPrompts) ? params.transitionPrompts : []
    const durations = Array.isArray(params?.transitionDurations) ? params.transitionDurations : []
    return prompts.length >= segmentCount
      && durations.length >= segmentCount
      && prompts.slice(0, segmentCount).every((item) => typeof item === 'string' && item.trim())
      && durations.slice(0, segmentCount).every((item) => typeof item === 'string' && item.trim())
  }

  if (providerConfig.outputType === 'text') {
    return true
  }

  if (isVideoProvider) {
    return hasRequiredVideoAssets(mode, videoReferences)
  }

  if (!localAssetProvider) {
    return mode === 't2v' ? true : mediaList.length > 0
  }

  if (providerConfig.outputType === 'image') {
    return mode === 't2v' ? true : videoReferences.images.length > 0
  }

  return hasRequiredVideoAssets(mode, videoReferences)
}

function isPromptRequiredForMode(providerConfig, mode, references) {
  if (providerConfig.id === 'seedance2' && mode === 'multiframe') {
    return (references?.images?.length || 0) <= 2
  }

  return !Array.isArray(providerConfig.promptOptionalModes) || !providerConfig.promptOptionalModes.includes(mode)
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

function validateCopywritingAttachmentFile(file) {
  const mimeType = file.type || inferMimeTypeFromFilename(file.name)
  const isImage = COPYWRITING_IMAGE_MIME_TYPES.includes(mimeType)
  const isDocument = COPYWRITING_DOCUMENT_MIME_TYPES.includes(mimeType)

  if (!isImage && !isDocument) {
    return 'Claude 附件仅支持图片、PDF、TXT、Markdown、CSV、Word 文档'
  }

  const maxSizeMb = isImage ? 10 : 15
  if (file.size > maxSizeMb * 1024 * 1024) {
    return `${isImage ? '单张图片' : '单个文档'}不能超过 ${maxSizeMb}MB`
  }

  return null
}

function inferMimeTypeFromFilename(filename = '') {
  const lowerName = filename.toLowerCase()
  if (lowerName.endsWith('.md') || lowerName.endsWith('.markdown')) return 'text/markdown'
  if (lowerName.endsWith('.txt')) return 'text/plain'
  if (lowerName.endsWith('.csv')) return 'text/csv'
  if (lowerName.endsWith('.pdf')) return 'application/pdf'
  if (lowerName.endsWith('.doc')) return 'application/msword'
  if (lowerName.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) return 'image/jpeg'
  if (lowerName.endsWith('.png')) return 'image/png'
  if (lowerName.endsWith('.webp')) return 'image/webp'
  if (lowerName.endsWith('.gif')) return 'image/gif'
  return ''
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
