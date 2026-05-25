import { useState } from 'react'
import { ChevronDown, History, Image as ImageIcon, Loader2, Video, X } from 'lucide-react'
import './GenerationHistory.css'

export default function GenerationHistory({
  entries = [],
  busy = false,
  loadDisabled = false,
  onLoad,
}) {
  const [open, setOpen] = useState(false)
  const hasHistory = entries.length > 0

  return (
    <section className={`generation-history ${open ? 'open' : ''}`}>
      <button
        type="button"
        className="generation-history-trigger"
        onClick={() => setOpen((value) => !value)}
        disabled={busy}
      >
        <span className="generation-history-trigger-main">
          {busy ? <Loader2 size={14} className="spin" /> : <History size={14} />}
          <span>{'\u5386\u53f2\u8bb0\u5f55'}</span>
        </span>
        <ChevronDown size={14} className="generation-history-chevron" />
      </button>

      {open && (
        <div className="generation-history-backdrop" onClick={() => setOpen(false)}>
          <div className="generation-history-panel" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="generation-history-head">
              <span>{'\u6700\u8fd1 10 \u6761'}</span>
              <button type="button" className="generation-history-close" onClick={() => setOpen(false)} aria-label="关闭历史记录">
                <X size={15} />
              </button>
            </div>
            {hasHistory ? (
              <div className="generation-history-list">
                {entries.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className="generation-history-item"
                    onClick={() => {
                      setOpen(false)
                      onLoad?.(entry.id)
                    }}
                    disabled={loadDisabled || busy}
                  >
                    <span className="generation-history-item-main">
                      <span className="generation-history-time">{formatHistoryTime(entry.savedAt)}</span>
                      <span className="generation-history-prompt">{entry.promptSummary}</span>
                    </span>
                    <span className="generation-history-meta">
                      <span>{entry.provider}</span>
                      {entry.paramsSummary?.aspectRatio && <span>{entry.paramsSummary.aspectRatio}</span>}
                      {entry.paramsSummary?.duration && <span>{entry.paramsSummary.duration}s</span>}
                      <span>
                        <ImageIcon size={11} />
                        {entry.mediaCounts?.images || 0}
                      </span>
                      <span>
                        <Video size={11} />
                        {entry.mediaCounts?.videos || 0}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="generation-history-empty">{'\u6682\u65e0\u5386\u53f2\u8bb0\u5f55'}</div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

function formatHistoryTime(timestamp) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp)
}
