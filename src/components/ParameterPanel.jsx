import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Monitor, Clock, Grid3x3, Film, Volume2, Wand2, Shield,
  Layers, ChevronDown, ChevronRight, Maximize, Sliders,
  Video, Move3d,
} from 'lucide-react'
import './ParameterPanel.css'

export default function ParameterPanel({ provider, config, params, onUpdate }) {
  const [advOpen, setAdvOpen] = useState(false)

  return (
    <div className="param-panel">
      {config.models.length > 1 && (
        <Section icon={<Film size={13} />} title="模型">
          <div className="model-grid">
            {config.models.map((model) => (
              <button
                key={model.value}
                className={`model-card ${params.model === model.value ? 'active' : ''}`}
                onClick={() => onUpdate('model', model.value)}
                style={{ '--prov': config.color }}
              >
                <span className="mc-label">{model.label}</span>
                {model.tag && <span className="mc-tag">{model.tag}</span>}
              </button>
            ))}
          </div>
        </Section>
      )}

      <Section icon={<Maximize size={13} />} title="宽高比">
        <div className="chip-row">
          {config.aspectRatios.map((ratio) => (
            <Chip
              key={ratio}
              active={params.aspectRatio === ratio}
              onClick={() => onUpdate('aspectRatio', ratio)}
              color={config.color}
            >
              <AspectIcon ratio={ratio} />
              {ratio}
            </Chip>
          ))}
        </div>
      </Section>

      {config.resolutions.default.length > 0 && (
        <Section icon={<Monitor size={13} />} title="分辨率">
          <div className="chip-row">
            {(config.resolutions[params.model] || config.resolutions.default).map((resolution) => (
              <Chip
                key={resolution}
                active={params.resolution === resolution}
                onClick={() => onUpdate('resolution', resolution)}
                color={config.color}
              >
                {resolution}
              </Chip>
            ))}
          </div>
        </Section>
      )}

      {config.durations.length > 0 && (
        <Section icon={<Clock size={13} />} title="时长">
          <div className="chip-row compact">
            {config.durations.map((duration) => (
              <Chip
                key={duration}
                active={params.duration === duration}
                onClick={() => onUpdate('duration', duration)}
                color={config.color}
                compact
              >
                {duration}s
              </Chip>
            ))}
          </div>
        </Section>
      )}

      {config.features.guidanceScale && (
        <Section icon={<Wand2 size={13} />} title="引导强度">
          <div className="slider-row">
            <input
              type="range"
              className="cfg-slider"
              min="1"
              max="100"
              step="1"
              value={params.guidanceScale ?? 50}
              onChange={(event) => onUpdate('guidanceScale', parseInt(event.target.value, 10))}
              style={{ '--prov': config.color }}
            />
            <span className="cfg-val">{params.guidanceScale ?? 50}</span>
          </div>
          <div className="slider-labels">
            <span>创意</span>
            <span>精准</span>
          </div>
        </Section>
      )}

      {config.sampleCounts.length > 1 && (
        <Section icon={<Grid3x3 size={13} />} title="输出数量">
          <div className="chip-row compact">
            {config.sampleCounts.map((sampleCount) => (
              <Chip
                key={sampleCount}
                active={params.sampleCount === sampleCount}
                onClick={() => onUpdate('sampleCount', sampleCount)}
                color={config.color}
                compact
              >
                {sampleCount}
              </Chip>
            ))}
          </div>
        </Section>
      )}

      {config.features.mode && config.modes && (
        <Section icon={<Sliders size={13} />} title="质量模式">
          <div className="chip-row compact">
            {config.modes.map((mode) => (
              <Chip
                key={mode.value}
                active={params.mode === mode.value}
                onClick={() => onUpdate('mode', mode.value)}
                color={config.color}
                compact
              >
                {mode.label}
              </Chip>
            ))}
          </div>
        </Section>
      )}

      {config.features.generateAudio && (
        <Section icon={<Volume2 size={13} />} title="音频">
          <Toggle
            label="生成音频"
            desc="AI 自动为视频生成配套音频"
            checked={Boolean(params.generateAudio)}
            onChange={(value) => onUpdate('generateAudio', value)}
          />
        </Section>
      )}

      {config.features.materialLibrary && config.materialTypes && (
        <Section icon={<Shield size={13} />} title="图片素材">
          <div className="chip-row compact">
            {config.materialTypes.map((item) => (
              <Chip
                key={item.value}
                active={(params.imageMaterialType ?? 'direct') === item.value}
                onClick={() => onUpdate('imageMaterialType', item.value)}
                color={config.color}
                compact
              >
                {item.label}
              </Chip>
            ))}
          </div>
          <div className="param-help">
            人物参考图请切到“人物审核”，前端会先把图片送到素材接口审核，再把审核后的素材标识提交给视频模型。
          </div>
        </Section>
      )}

      {config.features.cfgScale && (
        <Section icon={<Wand2 size={13} />} title="CFG 引导强度">
          <div className="slider-row">
            <input
              type="range"
              className="cfg-slider"
              min="0"
              max="1"
              step="0.05"
              value={params.cfgScale}
              onChange={(event) => onUpdate('cfgScale', parseFloat(event.target.value))}
              style={{ '--prov': config.color }}
            />
            <span className="cfg-val">{params.cfgScale.toFixed(2)}</span>
          </div>
          <div className="slider-labels">
            <span>创意</span>
            <span>精准</span>
          </div>
        </Section>
      )}

      {(config.features.personGeneration
        || config.features.compressionQuality
        || config.features.enhancePrompt
        || config.features.watermark
        || config.features.cameraControl) && (
        <div className="adv-section">
          <button className="adv-toggle" onClick={() => setAdvOpen(!advOpen)}>
            {advOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span>高级设置</span>
          </button>
          <AnimatePresence>
            {advOpen && (
              <motion.div
                className="adv-content"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
              >
                {config.features.personGeneration && config.personOptions && (
                  <Section icon={<Shield size={13} />} title="人物生成" compact>
                    <div className="chip-row compact">
                      {config.personOptions.map((option) => (
                        <Chip
                          key={option.value}
                          active={params.personGeneration === option.value}
                          onClick={() => onUpdate('personGeneration', option.value)}
                          color={config.color}
                          compact
                        >
                          {option.label}
                        </Chip>
                      ))}
                    </div>
                  </Section>
                )}

                {config.features.compressionQuality && config.compressionOptions && (
                  <Section icon={<Layers size={13} />} title="压缩质量" compact>
                    <div className="chip-row compact">
                      {config.compressionOptions.map((option) => (
                        <Chip
                          key={option.value}
                          active={params.compressionQuality === option.value}
                          onClick={() => onUpdate('compressionQuality', option.value)}
                          color={config.color}
                          compact
                        >
                          {option.label}
                        </Chip>
                      ))}
                    </div>
                  </Section>
                )}

                {config.features.enhancePrompt && params.model?.includes('veo-2') && (
                  <Section icon={<Wand2 size={13} />} title="增强提示词" compact>
                    <Toggle
                      label="使用 Gemini"
                      desc="用 AI 自动补全和优化提示词"
                      checked={Boolean(params.enhancePrompt)}
                      onChange={(value) => onUpdate('enhancePrompt', value)}
                    />
                  </Section>
                )}

                {config.features.watermark && (
                  <Section icon={<Video size={13} />} title="水印" compact>
                    <Toggle
                      label="添加水印"
                      desc=""
                      checked={Boolean(params.watermark)}
                      onChange={(value) => onUpdate('watermark', value)}
                    />
                  </Section>
                )}

                {config.features.cameraControl && config.cameraAxes && (
                  <Section icon={<Move3d size={13} />} title="镜头控制" compact>
                    <div className="camera-grid">
                      {config.cameraAxes.map((axis) => (
                        <div key={axis.key} className="cam-row">
                          <span className="cam-label">{axis.label}</span>
                          <input
                            type="range"
                            className="cam-slider"
                            min={axis.min}
                            max={axis.max}
                            step="1"
                            value={params.cameraControl?.[axis.key] ?? 0}
                            onChange={(event) => onUpdate('cameraControl', {
                              ...params.cameraControl,
                              [axis.key]: parseInt(event.target.value, 10),
                            })}
                            style={{ '--prov': config.color }}
                          />
                          <span className="cam-val">{params.cameraControl?.[axis.key] ?? 0}</span>
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
      <div className="param-lbl">
        {icon}
        <span>{title}</span>
      </div>
      {children}
    </div>
  )
}

function Chip({ children, active, onClick, color, compact }) {
  return (
    <button
      className={`chip ${active ? 'active' : ''} ${compact ? 'sm' : ''}`}
      onClick={onClick}
      style={{ '--prov': color }}
    >
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
      <div
        className={`tgl-sw ${checked ? 'on' : ''}`}
        onClick={(event) => {
          event.preventDefault()
          onChange(!checked)
        }}
        role="switch"
        aria-checked={checked}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === ' ' || event.key === 'Enter') {
            event.preventDefault()
            onChange(!checked)
          }
        }}
      >
        <div className="tgl-thumb" />
      </div>
    </label>
  )
}

function AspectIcon({ ratio }) {
  const landscape = ratio === '16:9'
  const square = ratio === '1:1'
  return (
    <svg width="14" height="12" viewBox="0 0 14 12" fill="none" style={{ flexShrink: 0 }}>
      {landscape
        ? <rect x="0.5" y="2" width="13" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.1" />
        : square
          ? <rect x="2" y="0.5" width="10" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.1" />
          : <rect x="4" y="0" width="6" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.1" />}
    </svg>
  )
}
