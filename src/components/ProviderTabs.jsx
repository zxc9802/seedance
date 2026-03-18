import { motion } from 'framer-motion'
import { PROVIDERS, PROVIDER_ORDER } from '../modelConfig'
import './ProviderTabs.css'

export default function ProviderTabs({ provider, onChange }) {
  return (
    <div className="provider-tabs">
      {PROVIDER_ORDER.map(id => {
        const p = PROVIDERS[id]
        const active = provider === id
        return (
          <button
            key={id}
            className={`provider-tab ${active ? 'active' : ''}`}
            onClick={() => onChange(id)}
            style={{ '--tab-color': p.color }}
          >
            <span className="tab-dot" />
            <span className="tab-name">{p.name}</span>
            <span className="tab-vendor">{p.vendor}</span>
            {active && (
              <motion.div
                className="tab-indicator"
                layoutId="tab-indicator"
                transition={{ type: 'spring', stiffness: 500, damping: 35 }}
              />
            )}
          </button>
        )
      })}
    </div>
  )
}
