import crypto from 'crypto'

// Signed stateless session tokens — no database needed.
// SESSION_SECRET is REQUIRED in production (docker-compose / .env). The dev
// fallback only kicks in outside production so local previews still work.
const SECRET = (() => {
  const s = process.env.SESSION_SECRET
  if (s && s.length >= 16) return s
  if (process.env.NODE_ENV === 'production') {
    console.error('[session] SESSION_SECRET is not set (min 16 chars) — sessions will NOT survive restarts. Set it in .env!')
    return `cmt-unsafe-${process.pid}-${Date.now()}`
  }
  return 'cmt-dev-secret'
})()

export const SESSION_COOKIE = 'cmt_session'
const SESSION_DAYS = 7

export interface SessionUser {
  username: string
  role: 'admin' | 'user'
}

interface TokenPayload {
  u: string
  r: 'admin' | 'user'
  exp: number
}

function hmac(payload: string): string {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url')
}

export function signSession(user: SessionUser): string {
  const payload = Buffer.from(
    JSON.stringify({ u: user.username, r: user.role, exp: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000 } satisfies TokenPayload),
  ).toString('base64url')
  return `${payload}.${hmac(payload)}`
}

export function verifySessionToken(token: string | undefined | null): SessionUser | null {
  if (!token) return null
  const dot = token.lastIndexOf('.')
  if (dot <= 0) {
    console.warn('[session] Malformed session token (no dot delimiter)')
    return null
  }
  const payload = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expected = hmac(payload)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    console.warn('[session] Session signature mismatch — token was signed with a different SESSION_SECRET or is invalid. Re-login required.')
    return null
  }
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as TokenPayload
    if (typeof data.exp !== 'number' || data.exp < Date.now()) {
      console.warn(`[session] Session expired for user: ${data?.u || 'unknown'}`)
      return null
    }
    if (typeof data.u !== 'string' || (data.r !== 'admin' && data.r !== 'user')) return null
    return { username: data.u, role: data.r }
  } catch {
    console.warn('[session] Failed to parse session token payload')
    return null
  }
}

export function sessionCookieOptions(req?: { headers?: Headers | { get(name: string): string | null } }) {
  const site = (process.env.SITE_ADDRESS || '').trim()
  const cookieSecureEnv = process.env.COOKIE_SECURE

  let isHttps = true
  if (cookieSecureEnv === 'false' || cookieSecureEnv === '0') {
    isHttps = false
  } else if (!site || site === ':80' || site.startsWith('http://')) {
    isHttps = false
  } else if (site.startsWith('https://') || (site && !site.includes(':') && site.includes('.'))) {
    isHttps = true
  }

  if (req?.headers) {
    const forwardedProto = typeof req.headers.get === 'function' ? req.headers.get('x-forwarded-proto') : null
    if (forwardedProto === 'http') isHttps = false
    else if (forwardedProto === 'https') isHttps = true
  }

  return {
    httpOnly: true,
    // SameSite=None requires Secure=true in all modern browsers.
    // Over plain HTTP (e.g. EC2 IP without TLS), SameSite=Lax and Secure=false are required.
    sameSite: isHttps ? ('none' as const) : ('lax' as const),
    secure: isHttps,
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  }
}
