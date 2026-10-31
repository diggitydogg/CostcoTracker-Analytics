// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { THROTTLE, normalizeEnrollmentCode, timingSafeEqual } from '../auth'
import { ACCESS_KEY, createHarness } from './harness'

describe('owner authentication', () => {
  it('serves health without authentication', async () => {
    const h = createHarness()
    expect(await h.call('GET', '/api/health', { origin: null })).toMatchObject({ status: 200, body: { ok: true } })
  })

  it('logs in with the access key and sets a hardened session cookie', async () => {
    const h = createHarness()
    const res = await h.call('POST', '/api/auth/login', { body: { accessKey: ACCESS_KEY } })
    expect(res.status).toBe(200)
    const cookie = res.headers.get('set-cookie')!
    expect(cookie).toMatch(/^__Host-ctsession=[A-Za-z0-9_-]{43};/)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).toContain('Path=/')
    const session = await h.call('GET', '/api/auth/session', { cookie: cookie.split(';')[0] })
    expect(session.body).toEqual({ authenticated: true })
  })

  it('stores only a hash of the session token', async () => {
    const h = createHarness()
    const cookie = await h.login()
    const token = cookie.split('=')[1]!
    const rows = h.db.raw.prepare('SELECT token_sha256 FROM sessions').all() as { token_sha256: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.token_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(rows[0]!.token_sha256).not.toContain(token)
  })

  it('rejects a wrong key and throttles after repeated failures', async () => {
    const h = createHarness()
    for (let i = 0; i < THROTTLE.maxFailures; i++) {
      expect((await h.call('POST', '/api/auth/login', { body: { accessKey: 'wrong' } })).status).toBe(401)
    }
    const blocked = await h.call('POST', '/api/auth/login', { body: { accessKey: ACCESS_KEY } })
    expect(blocked.status).toBe(429)
    h.clock.now = new Date(h.clock.now.getTime() + THROTTLE.windowMs + 1000)
    expect((await h.call('POST', '/api/auth/login', { body: { accessKey: ACCESS_KEY } })).status).toBe(200)
  })

  it('reports an unconfigured server instead of accepting any key', async () => {
    const h = createHarness({ configureKey: false })
    const res = await h.call('POST', '/api/auth/login', { body: { accessKey: ACCESS_KEY } })
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('not_configured')
  })

  it('rejects cross-origin login and cross-origin cookie-authenticated writes', async () => {
    const h = createHarness()
    const evil = await h.call('POST', '/api/auth/login', { body: { accessKey: ACCESS_KEY }, origin: 'https://evil.test' })
    expect(evil.status).toBe(403)
    const cookie = await h.login()
    const res = await h.call('POST', '/api/sync-requests', { cookie, origin: 'https://evil.test' })
    expect(res.status).toBe(403)
    expect((await h.call('POST', '/api/sync-requests', { cookie, origin: null })).status).toBe(403)
  })

  it('requires authentication for owner endpoints', async () => {
    const h = createHarness()
    for (const path of ['/api/devices', '/api/sync/runs', '/api/export/meta', '/api/sync-requests']) {
      expect((await h.call('GET', path)).status).toBe(401)
    }
  })

  it('expires sessions and logs out', async () => {
    const h = createHarness()
    const cookie = await h.login()
    expect((await h.call('GET', '/api/devices', { cookie })).status).toBe(200)
    await h.call('POST', '/api/auth/logout', { cookie })
    expect((await h.call('GET', '/api/devices', { cookie })).status).toBe(401)

    const cookie2 = await h.login()
    h.clock.now = new Date(h.clock.now.getTime() + 31 * 24 * 60 * 60 * 1000)
    expect((await h.call('GET', '/api/devices', { cookie: cookie2 })).status).toBe(401)
  })

  it('slides the session expiry when used', async () => {
    const h = createHarness()
    const cookie = await h.login()
    // Used every 20 days, the session stays alive past the original 30 days.
    for (let i = 0; i < 3; i++) {
      h.clock.now = new Date(h.clock.now.getTime() + 20 * 24 * 60 * 60 * 1000)
      expect((await h.call('GET', '/api/devices', { cookie })).status).toBe(200)
    }
  })

  it('"sign out everywhere" removes all sessions', async () => {
    const h = createHarness()
    const a = await h.login()
    const b = await h.login()
    await h.call('POST', '/api/auth/logout-everywhere', { cookie: a })
    expect((await h.call('GET', '/api/devices', { cookie: b })).status).toBe(401)
  })
})

describe('device enrollment', () => {
  it('enrolls with a one-time code and returns a token and the instance ID key', async () => {
    const h = createHarness()
    const device = await h.enroll()
    expect(device.deviceId).toMatch(/^dev_/)
    expect(device.deviceToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(device.idKey).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const config = await h.call('GET', '/api/device/config', { bearer: device.deviceToken, origin: null })
    expect(config.body).toMatchObject({ deviceId: device.deviceId, idKey: device.idKey, formatVersion: 1 })
  })

  it('issues the same ID key to every device (reinstall-safe IDs)', async () => {
    const h = createHarness()
    expect((await h.enroll('A')).idKey).toBe((await h.enroll('B')).idKey)
  })

  it('accepts codes typed in lower case without the dash, but only once', async () => {
    const h = createHarness()
    const cookie = await h.login()
    const { code } = (await h.call('POST', '/api/devices/enrollment-codes', { cookie })).body
    const typed = (code as string).toLowerCase().replace('-', ' ')
    const first = await h.call('POST', '/api/device/enroll', { body: { code: typed, deviceName: 'Phone' }, origin: null })
    expect(first.status).toBe(201)
    const second = await h.call('POST', '/api/device/enroll', { body: { code, deviceName: 'Phone 2' }, origin: null })
    expect(second.status).toBe(401)
  })

  it('rejects an expired code', async () => {
    const h = createHarness()
    const cookie = await h.login()
    const { code } = (await h.call('POST', '/api/devices/enrollment-codes', { cookie })).body
    h.clock.now = new Date(h.clock.now.getTime() + 11 * 60 * 1000)
    expect((await h.call('POST', '/api/device/enroll', { body: { code, deviceName: 'P' }, origin: null })).status).toBe(401)
  })

  it('throttles enrollment guessing', async () => {
    const h = createHarness()
    for (let i = 0; i < THROTTLE.maxFailures; i++) {
      await h.call('POST', '/api/device/enroll', { body: { code: 'AAAAA-AAAAA', deviceName: 'x' }, origin: null })
    }
    const res = await h.call('POST', '/api/device/enroll', { body: { code: 'AAAAA-AAAAA', deviceName: 'x' }, origin: null })
    expect(res.status).toBe(429)
  })

  it('limits device tokens to device and sync endpoints', async () => {
    const h = createHarness()
    const { deviceToken } = await h.enroll()
    for (const path of ['/api/devices', '/api/export/meta', '/api/sync/runs', '/api/sync-requests']) {
      expect((await h.call('GET', path, { bearer: deviceToken, origin: null })).status).toBe(403)
    }
  })

  it('stops accepting a revoked device immediately', async () => {
    const h = createHarness()
    const { deviceId, deviceToken } = await h.enroll()
    const cookie = await h.login()
    expect((await h.call('DELETE', `/api/devices/${deviceId}`, { cookie })).status).toBe(200)
    expect((await h.call('GET', '/api/device/config', { bearer: deviceToken, origin: null })).status).toBe(401)
    const list = await h.call('GET', '/api/devices', { cookie })
    expect(list.body.devices[0].revoked_at).not.toBeNull()
    expect(JSON.stringify(list.body)).not.toContain('token')
  })

  it('treats a malformed bearer header as unauthenticated', async () => {
    const h = createHarness()
    expect((await h.call('GET', '/api/device/config', { bearer: 'short', origin: null })).status).toBe(401)
  })
})

describe('auth helpers', () => {
  it('compares digests in constant time', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true)
    expect(timingSafeEqual('abc', 'abd')).toBe(false)
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
  })

  it('normalizes Crockford aliases', () => {
    expect(normalizeEnrollmentCode('ol1i0-abcde')).toBe('01110ABCDE')
  })
})
