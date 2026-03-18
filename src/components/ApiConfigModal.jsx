import { useState } from 'react'
import { motion } from 'framer-motion'
import { X, Key, Globe, FolderOpen } from 'lucide-react'
import { PROVIDERS, PROVIDER_ORDER } from '../modelConfig'
import './ApiConfigModal.css'

export default function ApiConfigModal({ apiKeys, onSave, onClose, activeProvider }) {
  const [tab, setTab] = useState(activeProvider)
  const [draft, setDraft] = useState({ ...apiKeys })

  const update = (provider, field, value) => {
    setDraft(prev => ({
      ...prev,
      [provider]: { ...(prev[provider] || {}), [field]: value }
    }))
  }

  return (
    <motion.div className="modal-overlay"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={onClose}>
      <motion.div className="modal-box"
        initial={{ opacity: 0, y: 20, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.97 }}
        onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h3>API 配置</h3>
          <button className="modal-close" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="modal-tabs">
          {PROVIDER_ORDER.map(id => {
            const p = PROVIDERS[id]
            return (
              <button key={id}
                className={`modal-tab ${tab === id ? 'active' : ''}`}
                onClick={() => setTab(id)}
                style={{ '--tc': p.color }}>
                <span className="mt-dot" />{p.name}
              </button>
            )
          })}
        </div>

        <div className="modal-body">
          {tab === 'veo' && (
            <>
              <Field icon={<Key size={14} />} label="访问令牌" placeholder="gcloud auth print-access-token"
                value={draft.veo?.apiKey || ''} onChange={v => update('veo', 'apiKey', v)} type="password" />
              <Field icon={<FolderOpen size={14} />} label="项目 ID" placeholder="your-gcp-project-id"
                value={draft.veo?.projectId || ''} onChange={v => update('veo', 'projectId', v)} />
              <Field icon={<Globe size={14} />} label="区域" placeholder="us-central1"
                value={draft.veo?.location || ''} onChange={v => update('veo', 'location', v)} />
            </>
          )}
          {tab === 'wan' && (
            <>
              <Field icon={<Key size={14} />} label="API 密钥 (DashScope)" placeholder="sk-..."
                value={draft.wan?.apiKey || ''} onChange={v => update('wan', 'apiKey', v)} type="password" />
              <Field icon={<Globe size={14} />} label="接口地址（可选）" placeholder="https://dashscope-intl.aliyuncs.com/api/v1/..."
                value={draft.wan?.endpoint || ''} onChange={v => update('wan', 'endpoint', v)} />
            </>
          )}
          {tab === 'kling' && (
            <>
              <Field icon={<Key size={14} />} label="API 密钥" placeholder="Bearer token..."
                value={draft.kling?.apiKey || ''} onChange={v => update('kling', 'apiKey', v)} type="password" />
              <Field icon={<Globe size={14} />} label="接口地址（可选）" placeholder="https://api.klingai.com/v1/..."
                value={draft.kling?.endpoint || ''} onChange={v => update('kling', 'endpoint', v)} />
            </>
          )}
          {tab === 'gemini-image' && (
            <>
              <Field icon={<Key size={14} />} label="API 密钥" placeholder="sk-..."
                value={draft['gemini-image']?.apiKey || ''} onChange={v => update('gemini-image', 'apiKey', v)} type="password" />
              <Field icon={<Globe size={14} />} label="接口地址" placeholder="http://47.77.198.47:3001/v1/chat/completions"
                value={draft['gemini-image']?.endpoint || ''} onChange={v => update('gemini-image', 'endpoint', v)} />
            </>
          )}
        </div>

        <div className="modal-foot">
          <button className="modal-cancel" onClick={onClose}>取消</button>
          <button className="modal-save" onClick={() => onSave(draft)}>保存配置</button>
        </div>
      </motion.div>
    </motion.div>
  )
}

function Field({ icon, label, placeholder, value, onChange, type = 'text' }) {
  return (
    <div className="field">
      <label className="field-label">{icon}<span>{label}</span></label>
      <input className="field-input" type={type} placeholder={placeholder}
        value={value} onChange={e => onChange(e.target.value)} />
    </div>
  )
}
