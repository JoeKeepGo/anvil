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
  ArchivedEndpointForBindingError,
  ArchivedProjectError,
  ArchivedTenantError,
  DefaultProjectInvariantError,
  DuplicateProjectSlugError,
  EndpointNotFoundForBindingError,
  InvalidQuotaValueError,
  PrismaTenantProjectAdminStore,
  ProjectNotFoundError,
  ProjectQuotaExceededError,
  ProjectTenantMismatchError,
  TenantNotFoundError,
  TenantProjectPermissionDeniedError,
  addAdminTenantToProject,
  addEndpointProjectBinding,
  archiveAdminProject,
  createAdminProject,
  getAdminProjectDetail,
  listAdminProjects,
  removeEndpointProjectBinding,
  removeProjectTenantParticipation,
  restoreAdminProject,
  setAdminProjectQuotaPolicy,
  setAdminProjectTenantQuotaAllocation,
  updateAdminProject,
  updateProjectTenantParticipation,
  type AdminTenantProjectAdminStore,
} from "../../services/admin/tenantProjectAdmin"

const projectTenantRoleSchema = z.enum(["OWNER", "PARTICIPANT"])

const quotaSchema = z.object({
  maxVcpu: z.number().int().nullable(),
  maxMemoryBytes: z.number().int().nullable(),
  maxDiskBytes: z.number().int().nullable(),
  maxInstances: z.number().int().nullable(),
  maxIpv6Addresses: z.number().int().nullable(),
})

const createProjectSchema = z.object({
  ownerTenantId: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().min(1),
})

const updateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
})

const projectTenantSchema = z.object({
  tenantId: z.string().min(1),
  role: projectTenantRoleSchema,
})

const updateProjectTenantSchema = z.object({
  role: projectTenantRoleSchema,
})

const endpointBindingSchema = z.object({
  endpointId: z.string().min(1),
})

export interface ProjectRoutesOptions {
  env?: NodeJS.ProcessEnv
  sessionStore?: AdminDataStore
  tenantProjectStore?: AdminTenantProjectAdminStore
}

export function createProjectRoutes(options: ProjectRoutesOptions = {}) {
  const routes = new Hono()
  const env = options.env ?? process.env
  const sessionStore = options.sessionStore ?? new PrismaAdminDataStore(undefined, env)
  const tenantProjectStore =
    options.tenantProjectStore ?? new PrismaTenantProjectAdminStore(undefined, env)

  routes.get("/", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      return c.json({ projects: await listAdminProjects(tenantProjectStore, actor) })
    })
  })

  routes.post("/", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      const requestBody = await readJsonBody(c.req.raw)
      const parsed = createProjectSchema.safeParse(requestBody)
      if (!parsed.success) {
        return invalidRequest(c, "INVALID_PROJECT_REQUEST", "Project owner, name, and slug are required.")
      }

      return c.json({ project: await createAdminProject(tenantProjectStore, actor, parsed.data) }, 201)
    })
  })

  routes.get("/:projectId", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      return c.json(await getAdminProjectDetail(tenantProjectStore, actor, c.req.param("projectId")))
    })
  })

  routes.patch("/:projectId", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      const requestBody = await readJsonBody(c.req.raw)
      const parsed = updateProjectSchema.safeParse(requestBody)
      if (!parsed.success) {
        return invalidRequest(c, "INVALID_PROJECT_REQUEST", "Project update payload is invalid.")
      }

      return c.json({
        project: await updateAdminProject(
          tenantProjectStore,
          actor,
          c.req.param("projectId"),
          parsed.data
        ),
      })
    })
  })

  routes.post("/:projectId/archive", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      return c.json({
        project: await archiveAdminProject(tenantProjectStore, actor, c.req.param("projectId")),
      })
    })
  })

  routes.post("/:projectId/restore", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      return c.json({
        project: await restoreAdminProject(tenantProjectStore, actor, c.req.param("projectId")),
      })
    })
  })

  routes.post("/:projectId/tenants", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      const requestBody = await readJsonBody(c.req.raw)
      const parsed = projectTenantSchema.safeParse(requestBody)
      if (!parsed.success) {
        return invalidRequest(c, "INVALID_PROJECT_TENANT_REQUEST", "Tenant ID and role are required.")
      }

      return c.json(
        {
          participant: await addAdminTenantToProject(tenantProjectStore, actor, {
            projectId: c.req.param("projectId"),
            tenantId: parsed.data.tenantId,
            role: parsed.data.role,
          }),
        },
        201
      )
    })
  })

  routes.patch("/:projectId/tenants/:tenantId", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      const requestBody = await readJsonBody(c.req.raw)
      const parsed = updateProjectTenantSchema.safeParse(requestBody)
      if (!parsed.success) {
        return invalidRequest(c, "INVALID_PROJECT_TENANT_REQUEST", "Tenant role is required.")
      }

      return c.json({
        participant: await updateProjectTenantParticipation(tenantProjectStore, actor, {
          projectId: c.req.param("projectId"),
          tenantId: c.req.param("tenantId"),
          role: parsed.data.role,
        }),
      })
    })
  })

  routes.post("/:projectId/tenants/:tenantId/remove", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      return c.json({
        participant: await removeProjectTenantParticipation(
          tenantProjectStore,
          actor,
          c.req.param("projectId"),
          c.req.param("tenantId")
        ),
      })
    })
  })

  routes.put("/:projectId/quota", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      const requestBody = await readJsonBody(c.req.raw)
      const parsed = quotaSchema.safeParse(requestBody)
      if (!parsed.success) {
        return invalidRequest(c, "INVALID_PROJECT_QUOTA_REQUEST", "Project quota payload is invalid.")
      }

      return c.json({
        quota: await setAdminProjectQuotaPolicy(
          tenantProjectStore,
          actor,
          c.req.param("projectId"),
          parsed.data
        ),
      })
    })
  })

  routes.put("/:projectId/tenants/:tenantId/quota", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      const requestBody = await readJsonBody(c.req.raw)
      const parsed = quotaSchema.safeParse(requestBody)
      if (!parsed.success) {
        return invalidRequest(c, "INVALID_PROJECT_TENANT_QUOTA_REQUEST", "Tenant quota payload is invalid.")
      }

      return c.json({
        quota: await setAdminProjectTenantQuotaAllocation(
          tenantProjectStore,
          actor,
          c.req.param("projectId"),
          c.req.param("tenantId"),
          parsed.data
        ),
      })
    })
  })

  routes.post("/:projectId/endpoints", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      const requestBody = await readJsonBody(c.req.raw)
      const parsed = endpointBindingSchema.safeParse(requestBody)
      if (!parsed.success) {
        return invalidRequest(c, "INVALID_ENDPOINT_BINDING_REQUEST", "Endpoint ID is required.")
      }

      return c.json(
        {
          binding: await addEndpointProjectBinding(tenantProjectStore, actor, {
            projectId: c.req.param("projectId"),
            endpointId: parsed.data.endpointId,
          }),
        },
        201
      )
    })
  })

  routes.post("/:projectId/endpoints/:endpointId/remove", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      return c.json({
        binding: await removeEndpointProjectBinding(tenantProjectStore, actor, {
          projectId: c.req.param("projectId"),
          endpointId: c.req.param("endpointId"),
        }),
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
    return mapProjectRouteError(c, error)
  }
}

function mapProjectRouteError(c: Context, error: unknown): Response {
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
    return c.json({ error: { code: "USER_DISABLED", message: "User is disabled.", details: {} } }, 403)
  }
  if (error instanceof TenantProjectPermissionDeniedError) {
    return c.json(
      { error: { code: "ADMIN_FORBIDDEN", message: "Admin permission denied.", details: {} } },
      403
    )
  }
  if (error instanceof DuplicateProjectSlugError) {
    return c.json(
      {
        error: {
          code: "PROJECT_SLUG_EXISTS",
          message: "A project with that slug already exists for this tenant.",
          details: {},
        },
      },
      409
    )
  }
  if (error instanceof TenantNotFoundError) {
    return c.json({ error: { code: "TENANT_NOT_FOUND", message: "Tenant was not found.", details: {} } }, 404)
  }
  if (error instanceof ProjectNotFoundError) {
    return c.json({ error: { code: "PROJECT_NOT_FOUND", message: "Project was not found.", details: {} } }, 404)
  }
  if (error instanceof ArchivedTenantError) {
    return c.json({ error: { code: "TENANT_ARCHIVED", message: "Tenant is archived.", details: {} } }, 409)
  }
  if (error instanceof ArchivedProjectError) {
    return c.json({ error: { code: "PROJECT_ARCHIVED", message: "Project is archived.", details: {} } }, 409)
  }
  if (error instanceof DefaultProjectInvariantError) {
    return c.json(
      {
        error: {
          code: "DEFAULT_PROJECT_INVARIANT",
          message: "Active tenant default projects must remain active with an active owner participation.",
          details: {},
        },
      },
      409
    )
  }
  if (error instanceof InvalidQuotaValueError) {
    return c.json(
      { error: { code: "INVALID_QUOTA_VALUE", message: "Quota values must be null or positive integers.", details: {} } },
      400
    )
  }
  if (error instanceof ProjectQuotaExceededError) {
    return c.json(
      {
        error: {
          code: "PROJECT_QUOTA_EXCEEDED",
          message: "Tenant allocation cannot exceed the project quota policy.",
          details: {},
        },
      },
      409
    )
  }
  if (error instanceof ProjectTenantMismatchError) {
    return c.json(
      { error: { code: "PROJECT_TENANT_MISMATCH", message: "Tenant does not participate in the project.", details: {} } },
      409
    )
  }
  if (error instanceof EndpointNotFoundForBindingError) {
    return c.json(
      { error: { code: "ENDPOINT_NOT_FOUND", message: "Endpoint was not found for project binding.", details: {} } },
      404
    )
  }
  if (error instanceof ArchivedEndpointForBindingError) {
    return c.json({ error: { code: "ENDPOINT_ARCHIVED", message: "Endpoint is archived.", details: {} } }, 409)
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
