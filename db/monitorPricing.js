export const MONITOR_CREDITS_PER_CNY = 100
export const EXTERNAL_SALE_MULTIPLIER = 1.8
export const MONITOR_PRICE_VERSION = '2026-07-27'

const FAST_MODEL_IDS = new Set([
  'doubao-seedance-2-0-fast-260128',
  'seedance2.0fast',
  'seedance2.0fast_vip',
])

function ceilCredits(value) {
  return Math.ceil(Number(value.toFixed(8)))
}

export function calculateConfirmedMediaBilling({
  providerId,
  model,
  duration,
  sampleCount,
  billingAudience = 'external',
}) {
  const normalizedProvider = String(providerId || '').trim().toLowerCase()
  const normalizedModel = String(model || '').trim().toLowerCase()
  const audience = billingAudience === 'internal' ? 'internal' : 'external'
  const saleMultiplier = audience === 'external' ? EXTERNAL_SALE_MULTIPLIER : 1

  let billingUnit = null
  let billableUnits = 0
  let costCnyPerUnit = 0

  if (normalizedProvider === 'seedance1') {
    billingUnit = 'second'
    billableUnits = Math.max(0, Number(duration) || 0) * Math.max(1, Math.trunc(Number(sampleCount) || 1))
    costCnyPerUnit = FAST_MODEL_IDS.has(normalizedModel) ? 0.5 : 1
  } else if (normalizedProvider === 'gemini-image-aggregation') {
    billingUnit = 'image'
    billableUnits = Math.max(1, Math.trunc(Number(sampleCount) || 1))
    costCnyPerUnit = 0.2
  } else {
    return null
  }

  const upstreamCostCny = costCnyPerUnit * billableUnits
  const salePriceCny = audience === 'external'
    ? Number((upstreamCostCny * saleMultiplier).toFixed(8))
    : 0
  return {
    billingAudience: audience,
    billingUnit,
    billableUnits,
    costCnyPerUnit,
    upstreamCostCny,
    saleMultiplier,
    salePriceCny,
    costCredits: ceilCredits(upstreamCostCny * MONITOR_CREDITS_PER_CNY),
    chargedCredits: ceilCredits(salePriceCny * MONITOR_CREDITS_PER_CNY),
    priceVersion: MONITOR_PRICE_VERSION,
  }
}
