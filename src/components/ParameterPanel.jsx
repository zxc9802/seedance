import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Monitor, Clock, Grid3x3, Film, Volume2, Wand2, Shield,
  Layers, ChevronDown, ChevronRight, Maximize, Sliders,
  Video, Move3d
} from 'lucide-react'
import './ParameterPanel.css'

export default function ParameterPanel({ provider, config, params, onUpdate }) {
  const [advOpen, setAdvOpen] = useState(false)

  return (
    <div className="param-panel">
      {/* Model */}
      {config.models.length > 1 && (
        <Section icon={<Film size={13} />} title="模型">
          <div className="model-grid">
            {config.models.map(m => (
              <button key={m.value} className={`model-card ${params.model === m.value ? 'active' : ''}`}
                onClick={() => onUpdate('model', m.value)} style={{ '--prov': config.color }}>
                <span className="mc-label">{m.label}</span>
                {m.tag && <span className="mc-tag">{m.tag}</span>}
              </button>
            ))}
          </div>
        </Section>
      )}

      {/* Aspect Ratio */}
      <Section icon={<Maximize size={13} />} title="宽高比">
        <div className="chip-row">
          {config.aspectRatios.map(ar => (
            <Chip key={ar} active={params.aspectRatio === ar} onClick={() => onUpdate('aspectRatio', ar)}
              color={config.color}>
              <AspectIcon ratio={ar} />{ar}
            </Chip>
          ))}
        </div>
      </Section>

      {/* Resolution (if available) */}
      {config.resolutions.default.length > 0 && (
        <Section icon={<Monitor size={13} />} title="分辨率">
          <div className="chip-row">
            {(config.resolutions[params.model] || config.resolutions.default).map(r => (
              <Chip key={r} active={params.resolution === r} onClick={() => onUpdate('resolution', r)}
                color={config.color}>{r}</Chip>
            ))}
          </div>
        </Section>
      )}

      {/* Duration */}
      {config.durations.length > 0 && (
        <Section icon={<Clock size={13} />} title="时长">
          <div className="chip-row compact">
            {config.durations.map(d => (
              <Chip key={d} active={params.duration === d} onClick={() => onUpdate('duration', d)}
                color={config.color} compact>{d}s</Chip>
            ))}
          </div>
        </Section>
      )}

      {/* Guidance Scale (Imagen) */}
      {config.features.guidanceScale && (
        <Section icon={<Wand2 size={13} />} title="引导强度">
          <div className="slider-row">
            <input type="range" className="cfg-slider" min="1" max="100" step="1"
              value={params.guidanceScale ?? 50} onChange={e => onUpdate('guidanceScale', parseInt(e.target.value))}
              style={{ '--prov': config.color }} />
            <span className="cfg-val">{params.guidanceScale ?? 50}</span>
          </div>
          <div className="slider-labels">
            <span>创意</span><span>精确</span>
          </div>
        </Section>
      )}

      {/* Sample Count */}
      {config.sampleCounts.length > 1 && (
        <Section icon={<Grid3x3 size={13} />} title="输出数量">
          <div className="chip-row compact">
            {config.sampleCounts.map(s => (
              <Chip key={s} active={params.sampleCount === s} onClick={() => onUpdate('sampleCount', s)}
                color={config.color} compact>{s}</Chip>
            ))}
          </div>
        </Section>
      )}

      {/* Mode (Kling) */}
      {config.features.mode && config.modes && (
        <Section icon={<Sliders size={13} />} title="质量模式">
          <div className="chip-row compact">
            {config.modes.map(m => (
              <Chip key={m.value} active={params.mode === m.value}
                onClick={() => onUpdate('mode', m.value)} color={config.color} compact>{m.label}</Chip>
            ))}
          </div>
        </Section>
      )}

      {/* Toggles */}
      {config.features.generateAudio && (
        <Section icon={<Volume2 size={13} />} title="音频">
          <Toggle label="生成音频" desc="AI 生成的音效" checked={params.generateAudio}
            onChange={v => onUpdate('generateAudio', v)} />
        </Section>
      )}

      {/* CFG Scale (Kling) */}
      {config.features.cfgScale && (
        <Section icon={<Wand2 size={13} />} title="CFG 引导强度">
          <div className="slider-row">
            <input type="range" className="cfg-slider" min="0" max="1" step="0.05"
              value={params.cfgScale} onChange={e => onUpdate('cfgScale', parseFloat(e.target.value))}
              style={{ '--prov': config.color }} />
            <span className="cfg-val">{params.cfgScale.toFixed(2)}</span>
          </div>
          <div className="slider-labels">
            <span>创意</span><span>精确</span>
          </div>
        </Section>
      )}

      {/* Advanced - only show if provider has advanced features */}
      {(config.features.personGeneration || config.features.compressionQuality || config.features.enhancePrompt || config.features.watermark || config.features.cameraControl) && (
        <div className="adv-section">
          <button className="adv-toggle" onClick={() => setAdvOpen(!advOpen)}>
            {advOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span>高级设置</span>
          </button>
          <AnimatePresence>
            {advOpen && (
              <motion.div className="adv-content"
                initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}>

                {config.features.personGeneration && config.personOptions && (
                  <Section icon={<Shield size={13} />} title="人物生成" compact>
                    <div className="chip-row compact">
                      {config.personOptions.map(p => (
                        <Chip key={p.value} active={params.personGeneration === p.value}
                          onClick={() => onUpdate('personGeneration', p.value)} color={config.color} compact>
                          {p.label}
                        </Chip>
                      ))}
                    </div>
                  </Section>
                )}

                {config.features.compressionQuality && config.compressionOptions && (
                  <Section icon={<Layers size={13} />} title="压缩质量" compact>
                    <div className="chip-row compact">
                      {config.compressionOptions.map(c => (
                        <Chip key={c.value} active={params.compressionQuality === c.value}
                          onClick={() => onUpdate('compressionQuality', c.value)} color={config.color} compact>
                          {c.label}
                        </Chip>
                      ))}
                    </div>
                  </Section>
                )}

                {config.features.enhancePrompt && params.model?.includes('veo-2') && (
                  <Section icon={<Wand2 size={13} />} title="增强提示词" compact>
                    <Toggle label="使用 Gemini" desc="使用 AI 优化提示词" checked={params.enhancePrompt}
                      onChange={v => onUpdate('enhancePrompt', v)} />
                  </Section>
                )}

                {config.features.watermark && (
                  <Section icon={<Video size={13} />} title="水印" compact>
                    <Toggle label="添加水印" desc="" checked={params.watermark}
                      onChange={v => onUpdate('watermark', v)} />
                  </Section>
                )}

                {config.features.cameraControl && config.cameraAxes && (
                  <Section icon={<Move3d size={13} />} title="镜头控制" compact>
                    <div className="camera-grid">
                      {config.cameraAxes.map(ax => (
                        <div key={ax.key} className="cam-row">
                          <span className="cam-label">{ax.label}</span>
                          <input type="range" className="cam-slider" min={ax.min} max={ax.max} step="1"
                            value={params.cameraControl?.[ax.key] ?? 0}
                            onChange={e => onUpdate('cameraControl', {
                              ...params.cameraControl,
                              [ax.key]: parseInt(e.target.value)
                            })}
                            style={{ '--prov': config.color }} />
                          <span className="cam-val">{params.cameraControl?.[ax.key] ?? 0}</span>
                        </div>
                      ))}
                    </div>
                  </Section>
                )}

              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  )
}

function Section({ icon, title, children, compact }) {
  return (
    <div className={`param-sec ${compact ? 'compact' : ''}`}>
      <div className="param-lbl">{icon}<span>{title}</span></div>
      {children}
    </div>
  )
}

function Chip({ children, active, onClick, color, compact }) {
  return (
    <button className={`chip ${active ? 'active' : ''} ${compact ? 'sm' : ''}`}
      onClick={onClick} style={{ '--prov': color }}>
      {children}
    </button>
  )
}

function Toggle({ label, desc, checked, onChange }) {
  return (
    <label className="toggle-row">
      <div className="tgl-info">
        <span className="tgl-label">{label}</span>
        {desc && <span className="tgl-desc">{desc}</span>}
      </div>
      <div className={`tgl-sw ${checked ? 'on' : ''}`}
        onClick={e => { e.preventDefault(); onChange(!checked) }}
        role="switch" aria-checked={checked} tabIndex={0}
        onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onChange(!checked) }}}>
        <div className="tgl-thumb" />
      </div>
    </label>
  )
}

function AspectIcon({ ratio }) {
  const l = ratio === '16:9'
  const s = ratio === '1:1'
  return (
    <svg width="14" height="12" viewBox="0 0 14 12" fill="none" style={{ flexShrink: 0 }}>
      {l ? <rect x="0.5" y="2" width="13" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.1" />
       : s ? <rect x="2" y="0.5" width="10" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.1" />
       : <rect x="4" y="0" width="6" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.1" />}
    </svg>
  )
}
