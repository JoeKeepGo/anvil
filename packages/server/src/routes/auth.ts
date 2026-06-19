import { Hono } from "hono"
import { z } from "zod"
import {
  authenticateBootstrapUser,
  AuthConfigError,
  AuthCredentialsError,
  AuthSessionError,
  verifySession,
} from "../services/auth"
import { readSessionCookie, serializeSessionCookie } from "../services/sessionCookie"

const loginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

export interface AuthRoutesOptions {
  env?: NodeJS.ProcessEnv
}

export function createAuthRoutes(options: AuthRoutesOptions = {}) {
  const routes = new Hono()
  const env = options.env ?? process.env

  routes.post("/login", async (c) => {
    const requestBody = await readJsonBody(c.req.raw)
    const parsed = loginRequestSchema.safeParse(requestBody)

    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "INVALID_AUTH_REQUEST",
            message: "Email and password are required.",
            details: {},
          },
        },
        400
      )
    }

    try {
      const result = await authenticateBootstrapUser(env, parsed.data.email, parsed.data.password)
      c.header("Set-Cookie", serializeSessionCookie(result.sessionToken))
      return c.json({ user: result.user })
    } catch (error) {
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

      if (error instanceof AuthCredentialsError) {
        return c.json(
          {
            error: {
              code: "INVALID_CREDENTIALS",
              message: "Invalid email or password.",
              details: {},
            },
          },
          401
        )
      }

      throw error
    }
  })

  routes.get("/me", async (c) => {
    try {
      const user = verifySession(env, readSessionCookie(c.req.header("cookie")))
      return c.json({ user })
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
  })

  return routes
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}

export const authRoutes = createAuthRoutes()
