import { Hono, type Context } from "hono"
import { z } from "zod"
import {
  DisabledUserError,
  PrismaAdminDataStore,
  resolveCurrentAdminUser,
  type AdminDataStore,
  type AdminPrincipal,
} from "../../services/admin/session"
import { AuthConfigError, AuthSessionError } from "../../services/auth"
import { readSessionCookie } from "../../services/sessionCookie"
import {
  AdminAuditPermissionDeniedError,
  PrismaAdminAuditQueryStore,
  listAdminAuditEntries,
  type AdminAuditQueryStore,
} from "../../services/admin/audit"

const auditQuerySchema = z.object({
  actorUserId: z.string().min(1).optional(),
  targetType: z.string().min(1).optional(),
  targetId: z.string().min(1).optional(),
  teamId: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

export interface AuditRoutesOptions {
  env?: NodeJS.ProcessEnv
  sessionStore?: AdminDataStore
  auditStore?: AdminAuditQueryStore
}

export function createAuditRoutes(options: AuditRoutesOptions = {}) {
  const routes = new Hono()
  const env = options.env ?? process.env
  const sessionStore = options.sessionStore ?? new PrismaAdminDataStore(undefined, env)
  const auditStore = options.auditStore ?? new PrismaAdminAuditQueryStore(undefined, env)

  routes.get("/", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      const parsed = auditQuerySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams))
      if (!parsed.success) {
        return c.json(
          { error: { code: "INVALID_AUDIT_QUERY", message: "Audit query is invalid.", details: {} } },
          400
        )
      }

      return c.json(await listAdminAuditEntries(auditStore, actor, parsed.data))
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
    return mapAuditRouteError(c, error)
  }
}

function mapAuditRouteError(c: Context, error: unknown): Response {
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
  if (error instanceof AdminAuditPermissionDeniedError) {
    return c.json(
      { error: { code: "ADMIN_FORBIDDEN", message: "Admin permission denied.", details: {} } },
      403
    )
  }
  throw error
}
