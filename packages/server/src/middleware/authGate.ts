import type { MiddlewareHandler } from "hono"
import { assertAuthConfigured, AuthConfigError, AuthSessionError, verifySession } from "../services/auth"
import { readSessionCookie } from "../services/sessionCookie"

export interface AuthGateOptions {
  env?: NodeJS.ProcessEnv
}

export function requireAuth(options: AuthGateOptions = {}): MiddlewareHandler {
  const env = options.env ?? process.env

  return async (c, next) => {
    try {
      assertAuthConfigured(env)
      verifySession(env, readSessionCookie(c.req.header("cookie")))
      await next()
    } catch (error) {
      if (error instanceof AuthSessionError) {
        return c.json(
          {
            error: {
              code: "UNAUTHENTICATED",
              message: "Authentication is required.",
              details: {},
            },
          },
          401
        )
      }

      if (error instanceof AuthConfigError) {
        return c.json(
          {
            error: {
              code: "AUTH_CONFIG_ERROR",
              message: "Authentication is not configured.",
              details: {},
            },
          },
          500
        )
      }

      throw error
    }
  }
}
