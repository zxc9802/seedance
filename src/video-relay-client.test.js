import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRelayGenerationRequest,
  createVideoRelayClient,
  formatRelayTaskAsAggregationPayload,
  normalizeVideoUpstreamProtocol,
} from '../relay/videoRelayClient.js'

const AGGREGATION_REQUEST = {
  providerId: 'veo',
  modelId: 'doubao-seedance-2-0-260128',
  abilityType: 'VIDEO',
  prompt: 'A cinematic product reveal',
  payload: {
    params: {
      mode: 'image_to_video',
      resolution: '720p',
      scale: '9:16',
      duration: 5,
      generateAudio: true,
    },
    resources: ['https://seedance.example/uploads/reference.png'],
  },
}

test('video upstream protocol defaults to aggregation and accepts relay explicitly', () => {
  assert.equal(normalizeVideoUpstreamProtocol(undefined), 'aggregation')
  assert.equal(normalizeVideoUpstreamProtocol(' aggregation '), 'aggregation')
  assert.equal(normalizeVideoUpstreamProtocol('relay'), 'relay')
  assert.throws(
    () => normalizeVideoUpstreamProtocol('unknown'),
    /VIDEO_UPSTREAM_PROTOCOL must be aggregation or relay/,
  )
})

test('relay request preserves the workbench Seedance model, parameters and references', () => {
  assert.deepEqual(buildRelayGenerationRequest(AGGREGATION_REQUEST), {
    model: 'doubao-seedance-2-0-260128',
    prompt: 'A cinematic product reveal',
    mode: 'i2v',
    aspect_ratio: '9:16',
    resolution: '720p',
    duration: 5,
    generate_audio: true,
    references: {
      images: ['https://seedance.example/uploads/reference.png'],
      videos: [],
      audios: [],
    },
  })
})

test('relay client submits with Bearer auth and an idempotency key', async () => {
  const calls = []
  const client = createVideoRelayClient({
    baseUrl: 'https://relay.example/',
    apiKey: 'relay-secret',
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return Response.json({
        id: '11111111-1111-4111-8111-111111111111',
        status: 'processing',
        request_id: 'order-1',
      }, { status: 202 })
    },
  })

  const task = await client.submit(AGGREGATION_REQUEST, {
    idempotencyKey: 'order-1',
  })

  assert.equal(task.id, '11111111-1111-4111-8111-111111111111')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://relay.example/v1/videos/generations')
  assert.equal(calls[0].options.method, 'POST')
  assert.deepEqual(calls[0].options.headers, {
    Authorization: 'Bearer relay-secret',
    'Content-Type': 'application/json',
    'Idempotency-Key': 'order-1',
  })
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    model: 'doubao-seedance-2-0-260128',
    prompt: 'A cinematic product reveal',
    mode: 'i2v',
    aspect_ratio: '9:16',
    resolution: '720p',
    duration: 5,
    generate_audio: true,
    references: {
      images: ['https://seedance.example/uploads/reference.png'],
      videos: [],
      audios: [],
    },
  })
})

test('relay client polls with GET and maps a completed task to the existing workbench contract', async () => {
  const calls = []
  const client = createVideoRelayClient({
    baseUrl: 'https://relay.example',
    apiKey: 'relay-secret',
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return Response.json({
        id: '22222222-2222-4222-8222-222222222222',
        status: 'completed',
        output: {
          video_url: 'https://media.example/result.mp4',
        },
      })
    },
  })

  const task = await client.query('22222222-2222-4222-8222-222222222222')

  assert.equal(calls.length, 1)
  assert.equal(
    calls[0].url,
    'https://relay.example/v1/videos/generations/22222222-2222-4222-8222-222222222222',
  )
  assert.deepEqual(calls[0].options, {
    method: 'GET',
    headers: {
      Authorization: 'Bearer relay-secret',
      Accept: 'application/json',
    },
  })
  assert.deepEqual(formatRelayTaskAsAggregationPayload(task), {
    success: true,
    data: {
      taskId: '22222222-2222-4222-8222-222222222222',
      status: 2,
      message: 'https://media.example/result.mp4',
    },
  })
})

test('relay errors retain their HTTP status and provider message', async () => {
  const client = createVideoRelayClient({
    baseUrl: 'https://relay.example',
    apiKey: 'relay-secret',
    fetchImpl: async () => Response.json({
      error: {
        code: 'INSUFFICIENT_CREDITS',
        message: 'Relay balance is insufficient',
      },
    }, { status: 402 }),
  })

  await assert.rejects(
    client.submit(AGGREGATION_REQUEST, { idempotencyKey: 'order-2' }),
    (error) => (
      error.statusCode === 402
      && error.code === 'INSUFFICIENT_CREDITS'
      && error.message === 'Relay balance is insufficient'
    ),
  )
})
