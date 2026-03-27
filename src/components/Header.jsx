import { motion } from 'framer-motion'
import { Film, History, Loader2, Save, ShieldCheck } from 'lucide-react'
import './Header.css'

export default function Header({
  onOpenAdmin,
  onSaveSnapshot,
  onLoadSnapshot,
  snapshotBusy,
  snapshotLoadDisabled,
  hasSnapshot,
  lastSavedAt,
  snapshotNotice,
  showAdminEntry,
}) {
  const noticeType = snapshotNotice?.type || 'neutral'
  const noticeText = snapshotNotice?.text || `最近保存 ${lastSavedAt ? formatSnapshotTime(lastSavedAt) : '未保存'}`

  return (
    <motion.header
      className="header"
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
    >
      <div className="header-left">
        <div className="logo-mark"><Film size={17} strokeWidth={1.5} /></div>
        <span className="logo-name">视频工作台</span>
      </div>

      <div className="header-actions">
        {showAdminEntry ? (
          <button className="header-action-btn admin-entry-btn" onClick={onOpenAdmin}>
            <ShieldCheck size={14} />
            <span>后台管理</span>
          </button>
        ) : null}

        <div className={`snapshot-meta ${noticeType}`}>
          <span className="snapshot-meta-label">SNAPSHOT</span>
          <span className="snapshot-meta-value">{noticeText}</span>
        </div>

        <button className="header-action-btn" onClick={onSaveSnapshot} disabled={snapshotBusy}>
          {snapshotBusy ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
          <span>保存快照</span>
        </button>

        <button
          className="header-action-btn secondary"
          onClick={onLoadSnapshot}
          disabled={snapshotBusy || snapshotLoadDisabled || !hasSnapshot}
        >
          <History size={14} />
          <span>加载快照</span>
        </button>
      </div>
    </motion.header>
  )
}

function formatSnapshotTime(timestamp) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp)
}
