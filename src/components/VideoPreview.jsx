import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Copy, Download, FileText, Loader2, Maximize2, MonitorPlay, X } from 'lucide-react'
import { PROVIDERS } from '../modelConfig'
import './VideoPreview.css'

export default function VideoPreview({ videoUrl, imageUrls = [], downloadUrl, textOutput, generating, progress, error, params, provider }) {
  const cfg = PROVIDERS[provider]
  const isTextOutput = cfg.outputType === 'text'
  const isImageOutput = cfg.outputType === 'image'
  const outputLabel = isTextOutput ? '文案' : (isImageOutput ? '图片' : '视频')
  const displayModelName = cfg.selectorLabel || cfg.name
  const [showFullscreen, setShowFullscreen] = useState(false)
  const [playbackError, setPlaybackError] = useState(null)
  const [playbackRetryCount, setPlaybackRetryCount] = useState(0)
  const [selectedImageIndex, setSelectedImageIndex] = useState(0)

  const previewImageUrls = useMemo(
    () => normalizePreviewImageUrls(imageUrls, videoUrl),
    [imageUrls, videoUrl],
  )
  const selectedImageUrl = isImageOutput
    ? (previewImageUrls[selectedImageIndex] || previewImageUrls[0] || null)
    : null
  const playbackUrl = isImageOutput ? selectedImageUrl : videoUrl

  useEffect(() => {
    setPlaybackError(null)
    setPlaybackRetryCount(0)
  }, [playbackUrl, provider])

  useEffect(() => {
    setSelectedImageIndex(0)
  }, [imageUrls, videoUrl, provider])

  useEffect(() => {
    if (selectedImageIndex >= previewImageUrls.length) {
      setSelectedImageIndex(0)
    }
  }, [previewImageUrls.length, selectedImageIndex])

  const effectivePlaybackUrl = useMemo(
    () => buildRetryablePlaybackUrl(playbackUrl, playbackRetryCount),
    [playbackUrl, playbackRetryCount],
  )
  const effectiveDownloadUrl = isImageOutput ? selectedImageUrl : (downloadUrl || videoUrl)
  const hasPreviewOutput = isTextOutput ? textOutput : (isImageOutput ? selectedImageUrl : videoUrl)

  const frameClass = isTextOutput ? 'text' : resolveAspectRatioFrameClass(params.aspectRatio)
  const frameStyle = isTextOutput ? undefined : resolveAspectRatioFrameStyle(params.aspectRatio)

  const handleDownloadUrl = (url, filename) => {
    if (!url) return
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  const handleCopyUrl = (url) => {
    if (!url) return
    navigator.clipboard.writeText(url)
  }

  const handleDownload = () => {
    if (isTextOutput) {
      if (!textOutput) return
      const objectUrl = URL.createObjectURL(new Blob([textOutput], { type: 'text/plain;charset=utf-8' }))
      handleDownloadUrl(objectUrl, `copywriting-${Date.now()}.txt`)
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
      return
    }

    if (!effectiveDownloadUrl) return
    handleDownloadUrl(
      effectiveDownloadUrl,
      `${isImageOutput ? 'image' : 'video'}-${Date.now()}.${inferExtension(effectiveDownloadUrl, isImageOutput)}`,
    )
  }

  const handlePlaybackRecovered = () => {
    if (playbackError) {
      setPlaybackError(null)
    }
  }

  const handlePlaybackError = () => {
    if (isImageOutput) {
      setPlaybackError('图片已返回，但浏览器无法显示该文件。请先下载检查文件内容或稍后重试。')
      return
    }

    if (isRetryablePlaybackUrl(playbackUrl) && playbackRetryCount < 2) {
      setPlaybackRetryCount((current) => current + 1)
      return
    }

    setPlaybackError('视频已返回，但浏览器暂时无法播放该文件。请先下载检查文件内容，或稍后重试。')
  }

  return (
    <div className="preview-container">
      <div className="preview-header">
        <div className="preview-title">
          <MonitorPlay size={15} strokeWidth={1.5} />
          <span>{isTextOutput ? '文案预览' : (isImageOutput ? '图片预览' : '视频预览')}</span>
        </div>

        {hasPreviewOutput && (
          <div className="preview-actions">
            {!isTextOutput && (
              <button className="pa-btn" onClick={() => setShowFullscreen(true)}>
                <Maximize2 size={13} /> 放大预览
              </button>
            )}
            <button className="pa-btn" onClick={handleDownload}>
              <Download size={13} /> 下载
            </button>
            <button className="pa-btn" onClick={() => handleCopyUrl(isTextOutput ? textOutput : effectiveDownloadUrl)}>
              <Copy size={13} /> {isTextOutput ? '复制内容' : '复制链接'}
            </button>
          </div>
        )}
      </div>

      <div className="preview-area">
        <div className="preview-content">
          {isImageOutput && previewImageUrls.length > 1 && hasPreviewOutput && !playbackError ? (
          <motion.div
            className="image-preview-shell"
            style={{ '--prov': cfg.color }}
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.3 }}
            key={`image-shell-${previewImageUrls.length}-${params.aspectRatio}`}
          >
            <div className={`preview-frame ${frameClass}`} style={frameStyle}>
              <img
                src={effectivePlaybackUrl}
                className="preview-video preview-image"
                alt={`Generated ${selectedImageIndex + 1}`}
                onClick={() => setShowFullscreen(true)}
                onLoad={handlePlaybackRecovered}
                onError={handlePlaybackError}
                style={{ cursor: 'pointer' }}
              />
            </div>

            <div className="image-thumb-strip" role="list" aria-label="Generated images">
              {previewImageUrls.map((url, index) => (
                <button
                  key={`${url}-${index}`}
                  type="button"
                  className={`image-thumb ${selectedImageIndex === index ? 'active' : ''}`}
                  onClick={() => setSelectedImageIndex(index)}
                  aria-label={`Select image ${index + 1}`}
                  aria-pressed={selectedImageIndex === index}
                  role="listitem"
                >
                  <img
                    src={url}
                    className="image-thumb-img"
                    alt={`Generated ${index + 1}`}
                    onLoad={handlePlaybackRecovered}
                  />
                  <span className="image-thumb-index">{index + 1}</span>
                </button>
              ))}
            </div>
          </motion.div>
        ) : (
          <motion.div
            className={`preview-frame ${frameClass}`}
            style={frameStyle}
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.3 }}
            key={isTextOutput ? provider : params.aspectRatio}
          >
            {isTextOutput && textOutput ? (
              <div className="preview-text-output">{textOutput}</div>
            ) : hasPreviewOutput && !playbackError ? (
              isImageOutput ? (
                <img
                  src={effectivePlaybackUrl}
                  className="preview-video preview-image"
                  alt="Generated"
                  onClick={() => setShowFullscreen(true)}
                  onLoad={handlePlaybackRecovered}
                  onError={handlePlaybackError}
                  style={{ cursor: 'pointer' }}
                />
              ) : (
                <video
                  key={effectivePlaybackUrl}
                  src={effectivePlaybackUrl}
                  controls
                  autoPlay
                  muted
                  playsInline
                  preload="metadata"
                  loop
                  className="preview-video"
                  onCanPlay={handlePlaybackRecovered}
                  onLoadedData={handlePlaybackRecovered}
                  onError={handlePlaybackError}
                />
              )
            ) : generating ? (
              <div className="preview-generating">
                <div className="gen-ring" style={{ '--ring-color': cfg.color }}>
                  <Loader2 size={28} className="spin" style={{ color: cfg.color }} />
                </div>
                <div className="gen-info">
                  <span className="gen-label">正在使用 {displayModelName} 生成{outputLabel}...</span>
                  <div className="gen-progress-bar">
                    <motion.div
                      className="gen-progress-fill"
                      style={{ background: cfg.color }}
                      initial={{ width: 0 }}
                      animate={{ width: `${progress}%` }}
                      transition={{ duration: 0.3 }}
                    />
                  </div>
                  <span className="gen-percent">{progress}%</span>
                </div>
              </div>
            ) : (error || playbackError) ? (
              <div className="preview-msg">
                <p className="preview-error">{playbackError || error}</p>
              </div>
            ) : (
              <div className="preview-empty">
                <div className="empty-icon" style={{ '--ec': cfg.color }}>
                  {isTextOutput ? <FileText size={32} strokeWidth={1} /> : <MonitorPlay size={32} strokeWidth={1} />}
                </div>
                <p className="empty-title">准备就绪</p>
                <p className="empty-desc">输入提示词并点击生成按钮来创建{outputLabel}</p>
              </div>
            )}
          </motion.div>
        )}

          <div className="preview-meta">
          <MetaTag label="模型" value={displayModelName} color={cfg.color} />
          {!isTextOutput && params.aspectRatio && <MetaTag label="比例" value={params.aspectRatio} />}
          {!isTextOutput && params.duration != null && <MetaTag label="时长" value={`${params.duration}秒`} />}
          {!isTextOutput && !cfg.hideResolutionSelector && params.resolution && <MetaTag label="分辨率" value={params.resolution} />}
          {isImageOutput && previewImageUrls.length > 1 && <MetaTag label="数量" value={`${previewImageUrls.length}/${previewImageUrls.length}`} />}
          </div>
        </div>
      </div>

      <AnimatePresence>
        {!isTextOutput && showFullscreen && hasPreviewOutput && !playbackError && (
          <motion.div
            className="fullscreen-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowFullscreen(false)}
          >
            <motion.div
              className="fullscreen-content"
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              onClick={(event) => event.stopPropagation()}
            >
              {isImageOutput ? (
                <img
                  src={effectivePlaybackUrl}
                  className="fullscreen-image"
                  alt="Preview"
                  onLoad={handlePlaybackRecovered}
                  onError={handlePlaybackError}
                />
              ) : (
                <video
                  key={`fullscreen-${effectivePlaybackUrl}`}
                  src={effectivePlaybackUrl}
                  controls
                  autoPlay
                  muted
                  playsInline
                  preload="metadata"
                  loop
                  className="fullscreen-video"
                  onCanPlay={handlePlaybackRecovered}
                  onLoadedData={handlePlaybackRecovered}
                  onError={() => {
                    handlePlaybackError()
                    setShowFullscreen(false)
                  }}
                />
              )}
              <div className="fullscreen-toolbar">
                <button className="fs-btn" onClick={handleDownload}>
                  <Download size={16} /> {isImageOutput ? '下载图片' : '下载视频'}
                </button>
                <button className="fs-btn fs-close" onClick={() => setShowFullscreen(false)}>
                  <X size={16} /> 关闭
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function MetaTag({ label, value, color }) {
  return (
    <span className="meta-tag" style={color ? { borderColor: `color-mix(in srgb, ${color} 25%, transparent)` } : {}}>
      <span className="mt-label">{label}</span>
      <span className="mt-value">{value}</span>
    </span>
  )
}

function resolveAspectRatioFrameClass(ratio) {
  const parsed = parseAspectRatio(ratio)
  if (!parsed) return 'portrait'

  const { width, height } = parsed
  if (width === height) return 'square'
  return width > height ? 'landscape' : 'portrait'
}

function resolveAspectRatioFrameStyle(ratio) {
  const parsed = parseAspectRatio(ratio)
  if (!parsed) return undefined

  return {
    '--preview-aspect-ratio': `${parsed.width} / ${parsed.height}`,
  }
}

function parseAspectRatio(ratio) {
  const [width, height] = String(ratio || '').split(':').map((item) => Number(item))
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null
  }

  return { width, height }
}

function inferExtension(url, isImageOutput) {
  if (isImageOutput) {
    if (url.startsWith('data:image/png')) return 'png'
    if (url.startsWith('data:image/webp')) return 'webp'
    if (url.startsWith('data:image/gif')) return 'gif'
    return 'jpg'
  }

  if (url.includes('.mov')) return 'mov'
  return 'mp4'
}

function normalizePreviewImageUrls(imageUrls, fallbackUrl) {
  const urls = (Array.isArray(imageUrls) ? imageUrls : [])
    .filter((url) => typeof url === 'string' && url.trim())
    .map((url) => url.trim())

  if (typeof fallbackUrl === 'string' && fallbackUrl.trim() && !urls.includes(fallbackUrl.trim())) {
    urls.unshift(fallbackUrl.trim())
  }

  return urls
}

function isRetryablePlaybackUrl(url) {
  return typeof url === 'string' && (/^(https?:)?\/\//i.test(url) || url.startsWith('/'))
}

function buildRetryablePlaybackUrl(url, retryCount) {
  if (!isRetryablePlaybackUrl(url) || retryCount <= 0) {
    return url
  }

  try {
    const parsed = new URL(url, window.location.origin)
    parsed.searchParams.set('_playbackRetry', String(retryCount))
    return parsed.toString()
  } catch {
    return url
  }
}
