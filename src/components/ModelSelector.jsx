import { ChevronDown } from 'lucide-react'
import { MODEL_TYPES, MODEL_TYPE_ORDER, PROVIDERS } from '../modelConfig'
import './ModelSelector.css'

export default function ModelSelector({ provider, onChange }) {
  const currentProvider = PROVIDERS[provider]
  const currentType = MODEL_TYPES[currentProvider?.typeId]

  return (
    <section className="model-selector">
      <div className="model-selector-head">
        <div className="model-selector-kicker">{'\u6a21\u578b\u9009\u62e9'}</div>
        <div className="model-selector-pill" style={{ '--selector-color': currentProvider?.color || 'var(--accent)' }}>
          <span className="model-selector-pill-dot" />
          <span>{currentType?.label || '\u6a21\u578b'}</span>
        </div>
      </div>

      <div className="model-selector-control">
        <select value={provider} onChange={(event) => onChange(event.target.value)}>
          {MODEL_TYPE_ORDER.map((typeId) => (
            <optgroup key={typeId} label={MODEL_TYPES[typeId].label}>
              {MODEL_TYPES[typeId].providers.map((providerId) => {
                const option = PROVIDERS[providerId]
                return (
                  <option key={providerId} value={providerId}>
                    {option.selectorLabel || option.name}
                  </option>
                )
              })}
            </optgroup>
          ))}
        </select>
        <ChevronDown size={16} className="model-selector-icon" />
      </div>
    </section>
  )
}
