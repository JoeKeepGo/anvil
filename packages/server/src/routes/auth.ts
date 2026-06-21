import { Hono } from "hono"
import { z } from "zod"
import {
  authenticateBootstrapUser,
  AuthConfigError,
  AuthCredentialsError,
  AuthSessionError,
  verifySession,
} from "../services/auth"
import {
  authenticateAdminUser,
  BootstrapRequiredError,
  DisabledUserError,
  InvalidAdminCredentialsError,
  resolveCurrentAdminUser,
  type AdminDataStore,
} from "../services/admin/session"
import {
  readSessionCookie,
  serializeExpiredSessionCookie,
  serializeSessionCookie,
} from "../services/sessionCookie"

const loginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

export interface AuthRoutesOptions {
  env?: NodeJS.ProcessEnv
  store?: AdminDataStore
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
      if (options.store) {
        const result = await authenticateAdminUser(
          options.store,
          env,
          parsed.data.email,
          parsed.data.password
        )
        c.header("Set-Cookie", serializeSessionCookie(result.sessionToken))
        return c.json({ user: result.user, access: result.access })
      }

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

      if (error instanceof InvalidAdminCredentialsError) {
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

      if (error instanceof BootstrapRequiredError) {
        return c.json(
          {
            error: {
              code: "BOOTSTRAP_REQUIRED",
              message: "Bootstrap must be completed before login.",
              details: {},
            },
          },
          403
        )
      }

      if (error instanceof DisabledUserError) {
        return c.json(
          {
            error: {
              code: "USER_DISABLED",
              message: "User is disabled.",
              details: {},
            },
          },
          403
        )
      }

      throw error
    }
  })

  routes.get("/me", async (c) => {
    try {
      if (options.store) {
        const result = await resolveCurrentAdminUser(
          options.store,
          env,
          readSessionCookie(c.req.header("cookie"))
        )
        return c.json({ user: result.user, access: result.access })
      }

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

      if (error instanceof DisabledUserError) {
        return c.json(
          {
            error: {
              code: "USER_DISABLED",
              message: "User is disabled.",
              details: {},
            },
          },
          403
        )
      }

      throw error
    }
  })

  routes.post("/logout", (c) => {
    c.header("Set-Cookie", serializeExpiredSessionCookie())
    return c.json({ ok: true })
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
