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
  DuplicateTenantSlugError,
  PrismaTenantProjectAdminStore,
  TenantNotFoundError,
  TenantProjectPermissionDeniedError,
  archiveAdminTenant,
  createAdminTenantWithDefaultProject,
  getAdminTenant,
  listAdminTenants,
  restoreAdminTenant,
  updateAdminTenant,
  type AdminTenantProjectAdminStore,
} from "../../services/admin/tenantProjectAdmin"

const createTenantSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
})

const updateTenantSchema = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
})

export interface TenantRoutesOptions {
  env?: NodeJS.ProcessEnv
  sessionStore?: AdminDataStore
  tenantProjectStore?: AdminTenantProjectAdminStore
}

export function createTenantRoutes(options: TenantRoutesOptions = {}) {
  const routes = new Hono()
  const env = options.env ?? process.env
  const sessionStore = options.sessionStore ?? new PrismaAdminDataStore(undefined, env)
  const tenantProjectStore =
    options.tenantProjectStore ?? new PrismaTenantProjectAdminStore(undefined, env)

  routes.get("/", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      return c.json({ tenants: await listAdminTenants(tenantProjectStore, actor) })
    })
  })

  routes.post("/", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      const requestBody = await readJsonBody(c.req.raw)
      const parsed = createTenantSchema.safeParse(requestBody)
      if (!parsed.success) {
        return invalidRequest(c, "INVALID_TENANT_REQUEST", "Tenant name and slug are required.")
      }

      const result = await createAdminTenantWithDefaultProject(tenantProjectStore, actor, parsed.data)
      return c.json(result, 201)
    })
  })

  routes.get("/:tenantId", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      return c.json({ tenant: await getAdminTenant(tenantProjectStore, actor, c.req.param("tenantId")) })
    })
  })

  routes.patch("/:tenantId", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      const requestBody = await readJsonBody(c.req.raw)
      const parsed = updateTenantSchema.safeParse(requestBody)
      if (!parsed.success) {
        return invalidRequest(c, "INVALID_TENANT_REQUEST", "Tenant update payload is invalid.")
      }

      return c.json({
        tenant: await updateAdminTenant(tenantProjectStore, actor, c.req.param("tenantId"), parsed.data),
      })
    })
  })

  routes.post("/:tenantId/archive", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      return c.json({
        tenant: await archiveAdminTenant(tenantProjectStore, actor, c.req.param("tenantId")),
      })
    })
  })

  routes.post("/:tenantId/restore", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      return c.json({
        tenant: await restoreAdminTenant(tenantProjectStore, actor, c.req.param("tenantId")),
      })
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
    return mapTenantRouteError(c, error)
  }
}

function mapTenantRouteError(c: Context, error: unknown): Response {
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
  if (error instanceof TenantProjectPermissionDeniedError) {
    return c.json(
      { error: { code: "ADMIN_FORBIDDEN", message: "Admin permission denied.", details: {} } },
      403
    )
  }
  if (error instanceof DuplicateTenantSlugError) {
    return c.json(
      { error: { code: "TENANT_SLUG_EXISTS", message: "A tenant with that slug already exists.", details: {} } },
      409
    )
  }
  if (error instanceof TenantNotFoundError) {
    return c.json(
      { error: { code: "TENANT_NOT_FOUND", message: "Tenant was not found.", details: {} } },
      404
    )
  }
  throw error
}

function invalidRequest(c: Context, code: string, message: string): Response {
  return c.json({ error: { code, message, details: {} } }, 400)
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}
