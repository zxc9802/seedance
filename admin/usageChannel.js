export const CHANNEL_LABELS = Object.freeze({
  aggregation: '国达丰',
  zhouzong: '周总',
  veo_fast: '周总',
  image: '周总',
})

function normalizeChannelValue(value) {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase()
}

export function resolveUsageChannel(channel, providerId = null) {
  const normalizedChannel = normalizeChannelValue(channel)
  const normalizedProviderId = normalizeChannelValue(providerId)

  if (normalizedChannel === 'image') {
    return normalizedProviderId === 'gemini-image-aggregation' ? 'aggregation' : 'zhouzong'
  }

  if (normalizedChannel === 'veo_fast') {
    return 'zhouzong'
  }

  return normalizedChannel
}

export function formatUsageChannelLabel(channel, providerId = null) {
  const resolvedChannel = resolveUsageChannel(channel, providerId)
  return CHANNEL_LABELS[resolvedChannel] || resolvedChannel || ''
}

export function buildUsageChannelSql(channelColumn = 'channel', providerIdColumn = 'provider_id') {
  return `CASE
    WHEN ${channelColumn} = 'image' AND ${providerIdColumn} = 'gemini-image-aggregation' THEN 'aggregation'
    WHEN ${channelColumn} = 'image' THEN 'zhouzong'
    WHEN ${channelColumn} = 'veo_fast' THEN 'zhouzong'
    ELSE ${channelColumn}
  END`
}
