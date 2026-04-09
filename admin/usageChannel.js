export const CHANNEL_LABELS = Object.freeze({
  aggregation: '国达丰',
  zhouzong: '周总',
  veo_fast: '周总',
  image: '周总',
  dreamina: '即梦',
})

function normalizeChannelValue(value) {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase()
}

function resolveUsageChannelByUpstreamUrl(upstreamUrl) {
  const normalizedUrl = normalizeChannelValue(upstreamUrl)
  if (!normalizedUrl) return ''

  if (normalizedUrl.startsWith('http://14.103.147.238:19220/openapi/generate')) {
    return 'aggregation'
  }

  if (
    normalizedUrl.startsWith('http://47.251.43.42:3000/v1beta/models/')
    && normalizedUrl.includes(':generatecontent')
  ) {
    return 'zhouzong'
  }

  return ''
}

export function resolveUsageChannel(channel, providerId = null, upstreamUrl = null) {
  const upstreamResolvedChannel = resolveUsageChannelByUpstreamUrl(upstreamUrl)
  if (upstreamResolvedChannel) {
    return upstreamResolvedChannel
  }

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

export function formatUsageChannelLabel(channel, providerId = null, upstreamUrl = null) {
  const resolvedChannel = resolveUsageChannel(channel, providerId, upstreamUrl)
  return CHANNEL_LABELS[resolvedChannel] || resolvedChannel || ''
}

export function buildUsageChannelSql(
  channelColumn = 'channel',
  providerIdColumn = 'provider_id',
  upstreamUrlColumn = 'upstream_url',
) {
  return `CASE
    WHEN LOWER(COALESCE(${upstreamUrlColumn}, '')) LIKE 'http://14.103.147.238:19220/openapi/generate%' THEN 'aggregation'
    WHEN LOWER(COALESCE(${upstreamUrlColumn}, '')) LIKE 'http://47.251.43.42:3000/v1beta/models/%:generatecontent%' THEN 'zhouzong'
    WHEN ${channelColumn} = 'image' AND ${providerIdColumn} = 'gemini-image-aggregation' THEN 'aggregation'
    WHEN ${channelColumn} = 'image' THEN 'zhouzong'
    WHEN ${channelColumn} = 'veo_fast' THEN 'zhouzong'
    ELSE ${channelColumn}
  END`
}
