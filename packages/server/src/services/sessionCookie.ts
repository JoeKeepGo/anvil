const sessionCookieName = "anvil_session"
const sessionMaxAgeSeconds = 60 * 60 * 8

export function serializeSessionCookie(sessionToken: string): string {
  return [
    `${sessionCookieName}=${encodeURIComponent(sessionToken)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${sessionMaxAgeSeconds}`,
  ].join("; ")
}

export function serializeExpiredSessionCookie(): string {
  return [
    `${sessionCookieName}=`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0",
  ].join("; ")
}

export function readSessionCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) {
    return undefined
  }

  for (const cookie of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = cookie.trim().split("=")
    if (rawName === sessionCookieName) {
      try {
        return decodeURIComponent(rawValue.join("="))
      } catch {
        return undefined
      }
    }
  }

  return undefined
}
