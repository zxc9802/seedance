import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SEEDANCE_25_MODEL_ID,
  resolveSeedanceUpstreamConfig,
} from '../relay/upstreamCredentials.js'

const baseEnv = {
  VIDEO_PROJECT_CODE: 'project-20',
  VIDEO_ACCESS_KEY: 'access-20',
  VIDEO_SECRET_KEY: 'secret-20',
  VIDEO_SEEDANCE_25_PROJECT_CODE: 'project-25',
  VIDEO_SEEDANCE_25_ACCESS_KEY: 'access-25',
  VIDEO_SEEDANCE_25_SECRET_KEY: 'secret-25',
}

test('Seedance 2.0 keeps using the existing video credentials', () => {
  const config = resolveSeedanceUpstreamConfig(baseEnv, 'doubao-seedance-2-0-260128')

  assert.deepEqual(config.missing, [])
  assert.deepEqual(config.headers, {
    projectCode: 'project-20',
    'X-Access-Key': 'access-20',
    'X-Secret-Key': 'secret-20',
  })
})

test('Seedance 2.5 uses its dedicated credentials', () => {
  const config = resolveSeedanceUpstreamConfig(baseEnv, SEEDANCE_25_MODEL_ID)

  assert.deepEqual(config.missing, [])
  assert.deepEqual(config.headers, {
    projectCode: 'project-25',
    'X-Access-Key': 'access-25',
    'X-Secret-Key': 'secret-25',
  })
})

test('Seedance 2.5 falls back to the existing account until no dedicated credential is configured', () => {
  const config = resolveSeedanceUpstreamConfig({
    VIDEO_PROJECT_CODE: 'project-20',
    VIDEO_ACCESS_KEY: 'access-20',
    VIDEO_SECRET_KEY: 'secret-20',
  }, SEEDANCE_25_MODEL_ID)

  assert.deepEqual(config.missing, [])
  assert.equal(config.headers.projectCode, 'project-20')
})

test('a partial Seedance 2.5 credential set fails instead of mixing accounts', () => {
  const config = resolveSeedanceUpstreamConfig({
    ...baseEnv,
    VIDEO_SEEDANCE_25_SECRET_KEY: '',
  }, SEEDANCE_25_MODEL_ID)

  assert.deepEqual(config.missing, ['VIDEO_SEEDANCE_25_SECRET_KEY'])
  assert.equal(config.headers['X-Secret-Key'], '')
  assert.notEqual(config.headers['X-Secret-Key'], baseEnv.VIDEO_SECRET_KEY)
})
