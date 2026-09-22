import { type NextRequest, NextResponse } from 'next/server'
import { SESSION_COOKIE, sessionCookieOptions } from '@/lib/session'

export async function POST(request: NextRequest) {
  const res = NextResponse.json({ ok: true })
  const opts = sessionCookieOptions(request)
  res.cookies.set(SESSION_COOKIE, '', {
    ...opts,
    maxAge: 0,
  })
  return res
}
