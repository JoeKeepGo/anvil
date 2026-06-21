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
  AdminEndpointPermissionDeniedError,
  ArchivedEndpointTeamError,
  DuplicateEndpointNameError,
  EndpointNotFoundError,
  EndpointTeamNotFoundError,
  EndpointTokenKeyError,
  PrismaAdminEndpointManagementStore,
  archiveAdminEndpoint,
  createAdminEndpoint,
  getAdminEndpoint,
  listAdminEndpoints,
  restoreAdminEndpoint,
  updateAdminEndpoint,
  type AdminEndpointManagementStore,
} from "../../services/admin/endpoints"

const endpointStatusSchema = z.enum(["ACTIVE", "ARCHIVED"])

const createEndpointSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  token: z.string().min(1).optional(),
  teamId: z.string().min(1),
  status: endpointStatusSchema.optional(),
})

const updateEndpointSchema = z.object({
  name: z.string().min(1).optional(),
  url: z.string().url().optional(),
  token: z.string().min(1).optional(),
  teamId: z.string().min(1).optional(),
  status: endpointStatusSchema.optional(),
})

export interface EndpointRoutesOptions {
  env?: NodeJS.ProcessEnv
  sessionStore?: AdminDataStore
  endpointStore?: AdminEndpointManagementStore
}

export function createEndpointRoutes(options: EndpointRoutesOptions = {}) {
  const routes = new Hono()
  const env = options.env ?? process.env
  const sessionStore = options.sessionStore ?? new PrismaAdminDataStore(undefined, env)
  const endpointStore =
    options.endpointStore ?? new PrismaAdminEndpointManagementStore(undefined, env)

  routes.get("/", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      return c.json({ endpoints: await listAdminEndpoints(endpointStore, actor) })
    })
  })

  routes.post("/", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      const requestBody = await readJsonBody(c.req.raw)
      const parsed = createEndpointSchema.safeParse(requestBody)
      if (!parsed.success) {
        return invalidRequest(c, "INVALID_ENDPOINT_REQUEST", "Endpoint name, URL, and team are required.")
      }

      return c.json(
        { endpoint: await createAdminEndpoint(endpointStore, actor, parsed.data, env) },
        201
      )
    })
  })

  routes.get("/:endpointId", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      return c.json({ endpoint: await getAdminEndpoint(endpointStore, actor, c.req.param("endpointId")) })
    })
  })

  routes.patch("/:endpointId", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      const requestBody = await readJsonBody(c.req.raw)
      const parsed = updateEndpointSchema.safeParse(requestBody)
      if (!parsed.success) {
        return invalidRequest(c, "INVALID_ENDPOINT_REQUEST", "Endpoint update payload is invalid.")
      }

      return c.json({
        endpoint: await updateAdminEndpoint(
          endpointStore,
          actor,
          c.req.param("endpointId"),
          parsed.data,
          env
        ),
      })
    })
  })

  routes.post("/:endpointId/archive", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      return c.json({
        endpoint: await archiveAdminEndpoint(endpointStore, actor, c.req.param("endpointId")),
      })
    })
  })

  routes.post("/:endpointId/restore", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      return c.json({
        endpoint: await restoreAdminEndpoint(endpointStore, actor, c.req.param("endpointId")),
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
    return mapEndpointRouteError(c, error)
  }
}

function mapEndpointRouteError(c: Context, error: unknown): Response {
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
  if (error instanceof AdminEndpointPermissionDeniedError) {
    return c.json(
      { error: { code: "ADMIN_FORBIDDEN", message: "Admin permission denied.", details: {} } },
      403
    )
  }
  if (error instanceof DuplicateEndpointNameError) {
    return c.json(
      {
        error: {
          code: "ENDPOINT_NAME_EXISTS",
          message: "An endpoint with that name already exists for this team.",
          details: {},
        },
      },
      409
    )
  }
  if (error instanceof EndpointNotFoundError) {
    return c.json(
      { error: { code: "ENDPOINT_NOT_FOUND", message: "Endpoint was not found.", details: {} } },
      404
    )
  }
  if (error instanceof EndpointTeamNotFoundError) {
    return c.json(
      { error: { code: "TEAM_NOT_FOUND", message: "Team was not found.", details: {} } },
      404
    )
  }
  if (error instanceof ArchivedEndpointTeamError) {
    return c.json(
      { error: { code: "TEAM_ARCHIVED", message: "Team is archived.", details: {} } },
      409
    )
  }
  if (error instanceof EndpointTokenKeyError) {
    return c.json(
      {
        error: {
          code: "ENDPOINT_TOKEN_KEY_REQUIRED",
          message: "Endpoint token encryption key is not configured.",
          details: {},
        },
      },
      500
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
