import { randomUUID } from 'node:crypto'

export async function beginVideoBilling({
  client,
  session,
  model,
  resolution,
  duration,
  requestIdFactory = randomUUID,
}) {
  const requestId = requestIdFactory()
  const result = await client.reserve({
    session,
    requestId,
    model,
    resolution,
    duration,
  })
  return {
    requestId,
    chargeRequired: result.chargeRequired === true,
    requiredPoints: Number(result.requiredPoints || 0),
  }
}

export async function finalizeVideoBilling({ client, session, billing, status }) {
  if (!billing?.requestId) return null
  const normalizedStatus = String(status || '').trim().toLowerCase()
  if (normalizedStatus === 'succeeded') {
    return client.settle({ session, requestId: billing.requestId })
  }
  if (normalizedStatus === 'failed' || normalizedStatus === 'cancelled') {
    return client.release({ session, requestId: billing.requestId })
  }
  return null
}
