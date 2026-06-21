import { Hono, type Context } from "hono"
import {
  DisabledUserError,
  PrismaAdminDataStore,
  resolveCurrentAdminUser,
  type AdminDataStore,
  type AdminPrincipal,
} from "../../services/admin/session"
import { AuthConfigError, AuthSessionError } from "../../services/auth"
import { readSessionCookie } from "../../services/sessionCookie"
import { getPermissionMatrix } from "../../services/admin/permissions"

export interface PermissionRoutesOptions {
  env?: NodeJS.ProcessEnv
  sessionStore?: AdminDataStore
}

export function createPermissionRoutes(options: PermissionRoutesOptions = {}) {
  const routes = new Hono()
  const env = options.env ?? process.env
  const sessionStore = options.sessionStore ?? new PrismaAdminDataStore(undefined, env)

  routes.get("/matrix", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async () => {
      return c.json({ matrix: getPermissionMatrix() })
    })
  })

  return routes
}

async function resolveActor(
  env: NodeJS.ProcessEnv,
  store: AdminDataStore,
  cookieHeader: string | undefined
): Promise<AdminPrincipal> {
  return (await resolveCurrentAdminUser(store, env, readSessionCookie(cookieHeader))).user
}

async function handleAdminRoute(
  c: Context,
  env: NodeJS.ProcessEnv,
  store: AdminDataStore,
  handler: (actor: AdminPrincipal) => Promise<Response>
): Promise<Response> {
  try {
    return await handler(await resolveActor(env, store, c.req.header("cookie")))
  } catch (error) {
    return mapPermissionRouteError(c, error)
  }
}

function mapPermissionRouteError(c: Context, error: unknown): Response {
  if (error instanceof AuthSessionError) {
    return c.json(
      { error: { code: "UNAUTHENTICATED", message: "Authentication is required.", details: {} } },
      401
    )
  }
  if (error instanceof AuthConfigError) {
    return c.json(
      { error: { code: "AUTH_CONFIG_ERROR", message: "Authentication is not configured.", details: {} } },
      500
    )
  }
  if (error instanceof DisabledUserError) {
    return c.json(
      { error: { code: "USER_DISABLED", message: "User is disabled.", details: {} } },
      403
    )
  }
  throw error
}
