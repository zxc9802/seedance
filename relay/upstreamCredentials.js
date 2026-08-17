export const SEEDANCE_25_MODEL_ID = 'doubao-seedance-2-5-260628'

const DEFAULT_CREDENTIALS = [
  ['VIDEO_PROJECT_CODE', 'projectCode'],
  ['VIDEO_ACCESS_KEY', 'X-Access-Key'],
  ['VIDEO_SECRET_KEY', 'X-Secret-Key'],
]

const SEEDANCE_25_CREDENTIALS = [
  ['VIDEO_SEEDANCE_25_PROJECT_CODE', 'projectCode'],
  ['VIDEO_SEEDANCE_25_ACCESS_KEY', 'X-Access-Key'],
  ['VIDEO_SEEDANCE_25_SECRET_KEY', 'X-Secret-Key'],
]

function readEnvValue(env, name) {
  const value = env?.[name]
  return typeof value === 'string' ? value.trim() : ''
}

export function resolveSeedanceUpstreamConfig(env, modelId) {
  const dedicatedValues = SEEDANCE_25_CREDENTIALS.map(([name]) => readEnvValue(env, name))
  const hasDedicatedCredential = dedicatedValues.some(Boolean)
  const credentialFields = String(modelId || '').trim() === SEEDANCE_25_MODEL_ID && hasDedicatedCredential
    ? SEEDANCE_25_CREDENTIALS
    : DEFAULT_CREDENTIALS

  const headers = {}
  const missing = []
  for (const [envName, headerName] of credentialFields) {
    const value = readEnvValue(env, envName)
    headers[headerName] = value
    if (!value) missing.push(envName)
  }

  return { headers, missing }
}
