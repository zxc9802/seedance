import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Copy, Download, Loader2, Maximize2, MonitorPlay, X } from 'lucide-react'
import { PROVIDERS } from '../modelConfig'
import './VideoPreview.css'

export default function VideoPreview({ videoUrl, generating, progress, error, params, provider }) {
  const cfg = PROVIDERS[provider]
  const isImageOutput = cfg.outputType === 'image'
  const displayModelName = cfg.selectorLabel || cfg.name
  const [showFullscreen, setShowFullscreen] = useState(false)
  const [playbackError, setPlaybackError] = useState(null)
  const [playbackRetryCount, setPlaybackRetryCount] = useState(0)

  useEffect(() => {
    setPlaybackError(null)
    setPlaybackRetryCount(0)
  }, [videoUrl, provider])

  const effectiveVideoUrl = useMemo(
    () => buildRetryablePlaybackUrl(videoUrl, playbackRetryCount),
    [videoUrl, playbackRetryCount],
  )

  const frameClass = (() => {
    switch (params.aspectRatio) {
      case '16:9': return 'landscape'
      case '1:1': return 'square'
      case '3:4': return 'ratio-3-4'
      case '4:3': return 'ratio-4-3'
      default: return 'portrait'
    }
  })()

  const handleDownload = () => {
    if (!videoUrl) return
    const link = document.createElement('a')
    link.href = videoUrl
    link.download = `${isImageOutput ? 'image' : 'video'}-${Date.now()}.${inferExtension(videoUrl, isImageOutput)}`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
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

    if (isRetryablePlaybackUrl(videoUrl) && playbackRetryCount < 2) {
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
          <span>{isImageOutput ? '图片预览' : '视频预览'}</span>
        </div>

        {videoUrl && (
          <div className="preview-actions">
            <button className="pa-btn" onClick={() => setShowFullscreen(true)}>
              <Maximize2 size={13} /> 放大预览
            </button>
            <button className="pa-btn" onClick={handleDownload}>
              <Download size={13} /> 下载
            </button>
            <button className="pa-btn" onClick={() => navigator.clipboard.writeText(videoUrl)}>
              <Copy size={13} /> 复制链接
            </button>
          </div>
        )}
      </div>

      <div className="preview-area">
        <motion.div
          className={`preview-frame ${frameClass}`}
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.3 }}
          key={params.aspectRatio}
        >
          {videoUrl && !playbackError ? (
            isImageOutput ? (
              <img
                src={effectiveVideoUrl}
                className="preview-video preview-image"
                alt="Generated"
                onClick={() => setShowFullscreen(true)}
                onLoad={handlePlaybackRecovered}
                onError={handlePlaybackError}
                style={{ cursor: 'pointer' }}
              />
            ) : (
              <video
                key={effectiveVideoUrl}
                src={effectiveVideoUrl}
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
                <span className="gen-label">正在使用 {displayModelName} 生成{isImageOutput ? '图片' : '视频'}...</span>
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
                <MonitorPlay size={32} strokeWidth={1} />
              </div>
              <p className="empty-title">准备就绪</p>
              <p className="empty-desc">输入提示词并点击生成按钮来创建{isImageOutput ? '图片' : '视频'}</p>
            </div>
          )}
        </motion.div>

        <div className="preview-meta">
          <MetaTag label="模型" value={displayModelName} color={cfg.color} />
          <MetaTag label="比例" value={params.aspectRatio} />
          {params.duration != null && <MetaTag label="时长" value={`${params.duration}秒`} />}
          {params.resolution && <MetaTag label="分辨率" value={params.resolution} />}
        </div>
      </div>

      <AnimatePresence>
        {showFullscreen && videoUrl && !playbackError && (
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
                  src={effectiveVideoUrl}
                  className="fullscreen-image"
                  alt="Preview"
                  onLoad={handlePlaybackRecovered}
                  onError={handlePlaybackError}
                />
              ) : (
                <video
                  key={`fullscreen-${effectiveVideoUrl}`}
                  src={effectiveVideoUrl}
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
