const MOCK_MIN_DURATION_MS = 9000
const MOCK_MAX_DURATION_MS = 14000

export function resolveMockGenerationDurationMs(randomValue = Math.random()) {
  const ratio = Number.isFinite(randomValue)
    ? Math.min(1, Math.max(0, randomValue))
    : 0.5

  return Math.round(MOCK_MIN_DURATION_MS + ((MOCK_MAX_DURATION_MS - MOCK_MIN_DURATION_MS) * ratio))
}

export function buildMockVideoPlan({ providerId, randomValue } = {}) {
  return {
    providerId: providerId || 'mock-video',
    delayMs: resolveMockGenerationDurationMs(randomValue),
    status: 'failed',
    errorMessage: 'Failed to fetch',
  }
}
