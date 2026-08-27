export class MainAppVideoBillingError extends Error {
  constructor(message, statusCode = 502, code = 'MAIN_APP_VIDEO_BILLING_FAILED') {
    super(message)
    this.name = 'MainAppVideoBillingError'
    this.statusCode = statusCode
    this.code = code
  }
}

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '')
}

function isExternalSession(session) {
  return session?.user?.billingAudience === 'external'
    || session?.user?.groupName === '外部用户'
}

export function createMainAppVideoBillingClient({ fetchImpl = fetch } = {}) {
  async function request(action, input) {
    if (!isExternalSession(input.session)) {
      return {
        chargeRequired: false,
        ...(action === 'reserve' ? { requiredPoints: 0 } : {}),
      }
    }

    const token = String(input.session?.token || '').trim()
    const mainAppUrl = stripTrailingSlash(input.session?.mainAppUrl)
    if (!token || !mainAppUrl) {
      throw new MainAppVideoBillingError(
        'External video billing requires an authenticated main-site session.',
        401,
        'MAIN_APP_VIDEO_BILLING_SESSION_REQUIRED',
      )
    }

    const body = {
      action,
      requestId: input.requestId,
      ...(action === 'reserve' ? {
        model: input.model,
        resolution: input.resolution,
        duration: input.duration,
      } : {}),
    }
    const response = await fetchImpl(`${mainAppUrl}/api/video-sso/billing`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    })
    const contentType = response.headers.get('content-type') || ''
    const payload = contentType.includes('application/json')
      ? await response.json()
      : await response.text()
    if (!response.ok) {
      const message = typeof payload === 'string'
        ? payload
        : payload?.message || payload?.error || 'Main-site video billing failed.'
      throw new MainAppVideoBillingError(
        message,
        response.status,
        typeof payload === 'object' && payload?.code ? payload.code : 'MAIN_APP_VIDEO_BILLING_FAILED',
      )
    }

    return payload?.data || payload
  }

  return {
    reserve(input) {
      return request('reserve', input)
    },
    settle(input) {
      return request('settle', input)
    },
    release(input) {
      return request('release', input)
    },
  }
}
