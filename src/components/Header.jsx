import { motion } from 'framer-motion'
import { Settings, Film } from 'lucide-react'
import './Header.css'

export default function Header({ onApiConfig, apiKeys, provider }) {
  const hasKey = !!apiKeys[provider]?.apiKey
  return (
    <motion.header
      className="header"
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
    >
      <div className="header-left">
        <div className="logo-mark"><Film size={17} strokeWidth={1.5} /></div>
        <span className="logo-name">视频工作室</span>
        <span className="logo-badge">多模型</span>
      </div>
      <button className={`api-btn ${hasKey ? 'ok' : ''}`} onClick={onApiConfig}>
        <Settings size={14} strokeWidth={1.5} />
        <span>{hasKey ? 'API 已连接' : '配置 API'}</span>
        {hasKey && <span className="dot" />}
      </button>
    </motion.header>
  )
}
