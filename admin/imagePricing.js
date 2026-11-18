import { calculateConfirmedMediaBilling } from '../db/monitorPricing.js'

const USD_TO_CNY = 6.7118
const SUNBURST_IMAGE_USD = 0.0528
const SUNBURST_REFERENCE_USD = 0.0082
const NANO_BANANA_REFERENCE_USD = 0.002
const NANO_BANANA_IMAGE_USD = new Map([
  ['1K', 0.04],
  ['2K', 0.059],
  ['4K', 0.134],
])

function usdToCny(usd) {
  return Number((usd * USD_TO_CNY).toFixed(2))
}

export function getImagePricing() {
  const { costCnyPerUnit } = calculateConfirmedMediaBilling({ providerId: 'gemini-image-aggregation' })
  const sunburst = {
    details: 'GPT Image 2.5 Sunburst · fal · 1024×1024 · High',
    costs: [
      { label: '文生图', cny: usdToCny(SUNBURST_IMAGE_USD) },
      { label: '带 1 张参考图', cny: usdToCny(SUNBURST_IMAGE_USD + SUNBURST_REFERENCE_USD) },
    ],
  }

  return {
    checkedOn: '2026-11-18',
    exchangeRate: USD_TO_CNY,
    models: [
      {
        name: '起芽·闪绘（极速）',
        details: 'Gemini 3.1 Flash Image · 聚合通道',
        costs: [{ label: '项目计价', cny: costCnyPerUnit }],
      },
      { name: '起芽·精绘（均衡）', ...sunburst },
      { name: '起芽·臻绘（旗舰）', ...sunburst },
      {
        name: '起芽·灵绘（全能）',
        details: 'Nano Banana 2.1 · fal · 文生图',
        costs: Array.from(NANO_BANANA_IMAGE_USD, ([label, usd]) => ({ label, cny: usdToCny(usd) })),
      },
    ],
  }
}

export function estimateImageUsageCost(log, imageCount) {
  if (log.status !== 'succeeded' || log.estimated_cost != null) return null

  const sampleCount = Math.max(1, Math.trunc(Number(log.sample_count) || 1))
  if (log.provider_id === 'gemini-image-aggregation') {
    const { upstreamCostCny } = calculateConfirmedMediaBilling({ providerId: log.provider_id, sampleCount })
    return Number(upstreamCostCny.toFixed(2))
  }

  const model = log.model || ''
  const request = log.request_params || {}
  const referenceCount = model.endsWith('/edit')
    ? Math.max(1, Number(request.mediaCounts?.images ?? imageCount) || 0)
    : 0

  // fal publishes sample costs. The Sunburst reference uses its 1024×1024 High rate.
  if (model === 'openai/gpt-image-2.5/sunburst/text-to-image' || model === 'openai/gpt-image-2.5/sunburst/edit') {
    return usdToCny((SUNBURST_IMAGE_USD + SUNBURST_REFERENCE_USD * referenceCount) * sampleCount)
  }

  if (model === 'google/nano-banana-2.1' || model === 'google/nano-banana-2.1/edit') {
    const resolution = String(log.resolution || request.resolution || '').trim().toUpperCase()
    const imageUsd = NANO_BANANA_IMAGE_USD.get(resolution)
    if (imageUsd !== undefined) return usdToCny((imageUsd + NANO_BANANA_REFERENCE_USD * referenceCount) * sampleCount)
  }

  return null
}
