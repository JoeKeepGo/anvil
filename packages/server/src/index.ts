import { Hono } from "hono"
import type { MiddlewareHandler } from "hono"
import { serve } from "@hono/node-server"
import { cors } from "hono/cors"
import { logger } from "hono/logger"
import { createAuthRoutes } from "./routes/auth"
import { createAdminRoutes } from "./routes/admin"
import { hostRoutes } from "./routes/host"
import { serverRoutes } from "./routes/server"
import { createInstanceRoutes } from "./routes/instances"
import { createImageRoutes } from "./routes/images"
import { createOperationRoutes } from "./routes/operations"
import { settingsRoutes } from "./routes/settings"
import {
  PrismaResourceVisibilityStore,
  type ResourceVisibilityStore,
} from "./services/resourceVisibility"
import { AuthConfigError, AuthSessionError } from "./services/auth"
import {
  assertAdminAuthConfigured,
  DisabledUserError,
  PrismaAdminDataStore,
  resolveCurrentAdminUser,
  type AdminDataStore,
} from "./services/admin/session"
import { readSessionCookie } from "./services/sessionCookie"

export interface AppOptions {
  env?: NodeJS.ProcessEnv
  adminStore?: AdminDataStore
  resourceVisibilityStore?: ResourceVisibilityStore
}

export function createApp(options: AppOptions = {}) {
  const app = new Hono()
  const env = options.env ?? process.env
  const adminStore = options.adminStore ?? new PrismaAdminDataStore()
  const resourceVisibilityStore =
    options.resourceVisibilityStore ?? new PrismaResourceVisibilityStore(undefined, env)
  const productApiAuth = requireDatabaseBackedAuth({ env, store: adminStore })

  app.use("*", cors({ origin: "http://localhost:5173", credentials: true }))
  app.use("*", logger())

  app.get("/api/health", (c) => c.json({ status: "ok" }))
  app.route("/api/auth", createAuthRoutes({ env, store: adminStore }))
  app.route("/api/admin", createAdminRoutes({ env, store: adminStore }))

  app.use("/api/server", productApiAuth)
  app.use("/api/host/*", productApiAuth)
  app.use("/api/instances", productApiAuth)
  app.use("/api/instances/*", productApiAuth)
  app.use("/api/images", productApiAuth)
  app.use("/api/operations", productApiAuth)
  app.use("/api/settings/*", productApiAuth)

  app.route("/api", hostRoutes)
  app.route("/api", serverRoutes)
  app.route(
    "/api",
    createInstanceRoutes({
      env,
      sessionStore: adminStore,
      resourceVisibilityStore,
    })
  )
  app.route(
    "/api",
    createImageRoutes({
      env,
      sessionStore: adminStore,
      resourceVisibilityStore,
    })
  )
  app.route(
    "/api",
    createOperationRoutes({
      env,
      sessionStore: adminStore,
      resourceVisibilityStore,
    })
  )
  app.route("/api", settingsRoutes)

  return app
}

function requireDatabaseBackedAuth(options: {
  env: NodeJS.ProcessEnv
  store: AdminDataStore
}): MiddlewareHandler {
  return async (c, next) => {
    try {
      assertAdminAuthConfigured(options.env)
      await resolveCurrentAdminUser(options.store, options.env, readSessionCookie(c.req.header("cookie")))
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
  }
}

const app = createApp()
const port = parseInt(process.env.PORT || "3000")

if (process.env.NODE_ENV !== "test") {
  serve({ fetch: app.fetch, port })
  console.log(`Anvil API listening on port ${port}`)
}

export { app }

export default app
