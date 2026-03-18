import { useState, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Sparkles, ChevronDown, ChevronUp, Send, Loader2, Image as ImageIcon, Video, FileImage, UploadCloud, X, Palette } from 'lucide-react'
import './PromptInput.css'

export default function PromptInput({
  prompt, onPromptChange, onGenerate, generating,
  negativePrompt, onNegativePromptChange, providerColor,
  mode, onModeChange, media, onMediaChange, providerConfig,
  selectedTemplate, onTemplateSelect
}) {
  const [showNeg, setShowNeg] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [mediaError, setMediaError] = useState(null)
  const fileInputRef = useRef(null)

  const isImage = providerConfig.outputType === 'image'
  const templates = providerConfig.promptTemplates || []

  const modeOptions = [
    { value: 't2v', label: isImage ? '文生图' : '文生视频', icon: isImage ? <Palette size={13} /> : <FileImage size={13} /> },
  ]
  if (providerConfig.features.referenceImage) {
    modeOptions.push({ value: 'i2v', label: isImage ? '图生图' : '图生视频', icon: <ImageIcon size={13} /> })
  }
  if (providerConfig.features.referenceVideo) {
    modeOptions.push({ value: 'v2v', label: '视频生视频', icon: <Video size={13} /> })
  }

  if (mode !== 't2v' && !modeOptions.find(m => m.value === mode)) {
    setTimeout(() => onModeChange('t2v'), 0)
  }

  const handleDrag = (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setIsDragging(true)
    } else if (e.type === 'dragleave') {
      setIsDragging(false)
    }
  }

  const handleDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    setMediaError(null)
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processFile(e.dataTransfer.files[0])
    }
  }

  const handleChange = (e) => {
    e.preventDefault()
    setMediaError(null)
    if (e.target.files && e.target.files[0]) {
      processFile(e.target.files[0])
    }
  }

  const processFile = (file) => {
    const isVideo = file.type.startsWith('video/')
    const isImage = file.type.startsWith('image/')
    
    if (mode === 'i2v' && !isImage) {
      setMediaError('请上传图片 (JPG/PNG/WebP)')
      return
    }
    if (mode === 'v2v' && !isVideo) {
      setMediaError('请上传视频 (MP4)')
      return
    }
    if (file.size > 20 * 1024 * 1024) {
      setMediaError('文件过大 (限 20MB)')
      return
    }

    const reader = new FileReader()
    reader.onload = (e) => onMediaChange(e.target.result)
    reader.onerror = () => setMediaError('读取文件失败')
    reader.readAsDataURL(file)
  }

  return (
    <div className="prompt-section">
      <div className="prompt-header">
        <div className="mode-tabs">
          {modeOptions.map(opt => (
            <button
              key={opt.value}
              className={`mode-tab ${mode === opt.value ? 'active' : ''}`}
              onClick={() => onModeChange(opt.value)}
              style={{ '--tc': providerColor }}
            >
              {opt.icon}<span>{opt.label}</span>
            </button>
          ))}
        </div>
      </div>

      {templates.length > 0 && (
        <div className="template-row">
          {templates.map(t => (
            <button
              key={t.id}
              className={`template-card ${selectedTemplate?.id === t.id ? 'active' : ''}`}
              style={{ '--tc': providerColor }}
              onClick={() => onTemplateSelect(selectedTemplate?.id === t.id ? null : t)}
              title={t.prompt}
            >
              <span className="tpl-emoji">{t.emoji}</span>
              <span className="tpl-title">{t.title}</span>
            </button>
          ))}
        </div>
      )}

      <div className="prompt-wrap">
        <div className="prompt-inner">
          <AnimatePresence>
            {mode !== 't2v' && (
              <motion.div 
                className="media-upload-area"
                initial={{ width: 0, opacity: 0, paddingRight: 0 }}
                animate={{ width: 90, opacity: 1, paddingRight: 10 }}
                exit={{ width: 0, opacity: 0, paddingRight: 0 }}
                transition={{ duration: 0.2 }}
              >
                {media ? (
                  <div className="media-preview" style={{ '--mc': providerColor }}>
                    {media.startsWith('data:video') ? (
                      <video src={media} className="mp-element" controls autoPlay loop muted />
                    ) : (
                      <img src={media} className="mp-element" alt="Reference" />
                    )}
                    <button className="mp-remove" onClick={() => onMediaChange(null)}>
                      <X size={12} />
                    </button>
                  </div>
                ) : (
                  <div 
                    className={`dropzone ${isDragging ? 'drag-active' : ''} ${mediaError ? 'has-err' : ''}`}
                    onDragEnter={handleDrag} onDragLeave={handleDrag} onDragOver={handleDrag} onDrop={handleDrop}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <input
                      ref={fileInputRef} type="file" className="hidden-input"
                      accept={mode === 'i2v' ? 'image/jpeg,image/png,image/webp' : 'video/mp4'}
                      onChange={handleChange}
                    />
                    <div className="dz-icon"><UploadCloud size={20} strokeWidth={1.5} /></div>
                    <div className="dz-text">上传</div>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
          <div className="prompt-text-area">
            <textarea
              className="prompt-ta"
              placeholder={selectedTemplate
                ? `已选择「${selectedTemplate.title}」模板，可直接生成或输入额外要求...`
                : mode === 't2v' ? (isImage ? "描述你想要生成的图片..." : "描述你想要生成的视频...") : (isImage ? "描述关于参考图的修改..." : "描述关于上传参考素材的修改...")}
              value={prompt}
              onChange={e => onPromptChange(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onGenerate() }}}
              rows={4}
            />
            {mediaError && <div className="media-err-msg">{mediaError}</div>}
          </div>
        </div>

        <div className="prompt-bar">
          <button className="neg-toggle" onClick={() => setShowNeg(!showNeg)}>
            {showNeg ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            <span>反向提示词</span>
          </button>
          <button
            className="gen-btn"
            onClick={onGenerate}
            disabled={generating || (!prompt.trim() && !selectedTemplate) || (mode !== 't2v' && !media)}
            style={{ '--btn-color': providerColor }}
          >
            {generating
              ? <><Loader2 size={13} className="spin" /><span>生成中...</span></>
              : <><Send size={12} /><span>生成</span></>}
          </button>
        </div>
      </div>
      
      <AnimatePresence>
        {showNeg && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="neg-wrap">
            <textarea
              className="neg-ta"
              placeholder="排除的元素：模糊、低质量、文字水印..."
              value={negativePrompt}
              onChange={e => onNegativePromptChange(e.target.value)}
              rows={2}
            />
          </motion.div>
        )}
      </AnimatePresence>
      <div className="prompt-hint">按 <kbd>Ctrl</kbd>+<kbd>Enter</kbd> 生成</div>
    </div>
  )
}
