import { motion } from 'framer-motion'
import { CircleDollarSign, Film, History, Loader2, Save, ShieldCheck } from 'lucide-react'
import GenerationHistory from './GenerationHistory'
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
  historyEntries = [],
  historyBusy = false,
  historyLoadDisabled = false,
  onLoadHistory,
}) {
  const noticeType = snapshotNotice?.type || 'neutral'
  const noticeText = snapshotNotice?.text || `\u6700\u8fd1\u4fdd\u5b58 ${lastSavedAt ? formatSnapshotTime(lastSavedAt) : '\u672a\u4fdd\u5b58'}`

  return (
    <motion.header
      className="header"
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
    >
      <div className="header-left">
        <div className="logo-mark"><Film size={17} strokeWidth={1.5} /></div>
        <span className="logo-name">{'\u89c6\u9891\u5de5\u4f5c\u53f0'}</span>
        <GenerationHistory
          entries={historyEntries}
          busy={historyBusy}
          loadDisabled={historyLoadDisabled}
          onLoad={onLoadHistory}
        />
      </div>

      <div className="header-actions">
        <div className="pricing-info">
          <button className="header-action-btn pricing-info-trigger" type="button">
            <CircleDollarSign size={14} />
            <span>价格说明</span>
          </button>
          <div className="pricing-info-panel" role="tooltip">
            <div className="pricing-info-title">积分价格说明</div>
            <div className="pricing-info-grid">
              <section>
                <h3>seedance企业稳定版 seedance2.0</h3>
                <p>文生视频: 480P: 2积分/秒, 720P: 4积分/秒, 1080P: 10积分/秒</p>
                <p>图生视频/融合参考/首尾帧: 480P: 3.5积分/秒, 720P: 7积分/秒, 1080P: 17.5积分/秒</p>
              </section>
              <section>
                <h3>seedance企业稳定版 seedance2.0 fast</h3>
                <p>文生视频: 480P: 1积分/秒, 720P: 3积分/秒</p>
                <p>图生视频/融合参考/首尾帧: 480P: 2.5积分/秒, 720P: 5.5积分/秒</p>
              </section>
              <section>
                <h3>nanobanana企业稳定版</h3>
                <p>图片生成: 3.5积分/张</p>
              </section>
            </div>
          </div>
        </div>

        {showAdminEntry ? (
          <button className="header-action-btn admin-entry-btn" onClick={onOpenAdmin}>
            <ShieldCheck size={14} />
            <span>后台管理</span>
          </button>
        ) : null}

        <div className={`snapshot-meta ${noticeType}`}>
          <span className="snapshot-meta-label">Snapshot</span>
          <span className="snapshot-meta-value">{noticeText}</span>
        </div>

        <button className="header-action-btn" onClick={onSaveSnapshot} disabled={snapshotBusy}>
          {snapshotBusy ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
          <span>{'\u4fdd\u5b58\u5feb\u7167'}</span>
        </button>

        <button
          className="header-action-btn secondary"
          onClick={onLoadSnapshot}
          disabled={snapshotBusy || snapshotLoadDisabled || !hasSnapshot}
        >
          <History size={14} />
          <span>{'\u52a0\u8f7d\u5feb\u7167'}</span>
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
