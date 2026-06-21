import { Hono } from "hono"
import { z } from "zod"
import {
  BootstrapAlreadyCompletedError,
  createBootstrapAdmin,
  getBootstrapStatus,
} from "../../services/admin/bootstrap"
import type { AdminDataStore } from "../../services/admin/session"
import { AuthConfigError, signSessionForPrincipal } from "../../services/auth"
import { serializeSessionCookie } from "../../services/sessionCookie"

const bootstrapRequestSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  password: z.string().min(12),
  teamName: z.string().min(1),
})

export interface BootstrapRoutesOptions {
  store: AdminDataStore
  env?: NodeJS.ProcessEnv
}

export function createBootstrapRoutes(options: BootstrapRoutesOptions) {
  const routes = new Hono()
  const env = options.env ?? process.env

  routes.get("/bootstrap/status", async (c) => {
    try {
      if (!env.ANVIL_SESSION_SECRET || env.ANVIL_SESSION_SECRET.trim() === "") {
        throw new AuthConfigError()
      }

      return c.json(await getBootstrapStatus(options.store))
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

      throw error
    }
  })

  routes.post("/bootstrap", async (c) => {
    const requestBody = await readJsonBody(c.req.raw)
    const parsed = bootstrapRequestSchema.safeParse(requestBody)

    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "INVALID_BOOTSTRAP_REQUEST",
            message: "Email, name, password, and team name are required.",
            details: {},
          },
        },
        400
      )
    }

    try {
      const result = await createBootstrapAdmin(options.store, parsed.data)
      c.header("Set-Cookie", serializeSessionCookie(signSessionForPrincipal(env, result.user)))
      return c.json(result)
    } catch (error) {
      if (error instanceof BootstrapAlreadyCompletedError) {
        return c.json(
          {
            error: {
              code: "BOOTSTRAP_ALREADY_COMPLETED",
              message: "Bootstrap has already been completed.",
              details: {},
            },
          },
          409
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
