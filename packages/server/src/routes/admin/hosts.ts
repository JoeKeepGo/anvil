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
import {
  EndpointTokenKeyError,
  HostStateAgentConflictError,
  HostStateAgentUnavailableError,
  HostStateEndpointArchivedError,
  HostStateEndpointNotFoundError,
  HostStateMalformedReportError,
  HostStateNotFoundError,
  HostStatePermissionDeniedError,
  PrismaHostStateStore,
  getHostState,
  listHostStates,
  syncEndpointHostState,
  toBrowserHostState,
  type HostStateAgentClient,
  type HostStateStore,
} from "../../services/admin/hostState"
import { AgentClient, type AgentClientOptions } from "../../services/agent"

export interface HostRoutesOptions {
  env?: NodeJS.ProcessEnv
  sessionStore?: AdminDataStore
  hostStateStore?: HostStateStore
}

export interface EndpointAgentStateSyncRoutesOptions extends HostRoutesOptions {
  createAgentClient?: (options: AgentClientOptions) => HostStateAgentClient
  now?: () => Date
}

export function createHostRoutes(options: HostRoutesOptions = {}) {
  const routes = new Hono()
  const env = options.env ?? process.env
  const sessionStore = options.sessionStore ?? new PrismaAdminDataStore(undefined, env)
  const hostStateStore = options.hostStateStore ?? new PrismaHostStateStore(undefined, env)

  routes.get("/", async (c) => {
    return handleHostAdminRoute(c, env, sessionStore, async (actor) => {
      const hosts = await listHostStates(hostStateStore, actor)
      return c.json({ hosts: hosts.map(toBrowserHostState) })
    })
  })

  routes.get("/:hostId", async (c) => {
    return handleHostAdminRoute(c, env, sessionStore, async (actor) => {
      const host = await getHostState(hostStateStore, actor, c.req.param("hostId"))
      return c.json({ host: toBrowserHostState(host) })
    })
  })

  return routes
}

export function createEndpointAgentStateSyncRoutes(options: EndpointAgentStateSyncRoutesOptions = {}) {
  const routes = new Hono()
  const env = options.env ?? process.env
  const sessionStore = options.sessionStore ?? new PrismaAdminDataStore(undefined, env)
  const hostStateStore = options.hostStateStore ?? new PrismaHostStateStore(undefined, env)
  const createAgentClient = options.createAgentClient ?? ((clientOptions) => new AgentClient(clientOptions))

  routes.post("/:endpointId/agent-state/sync", async (c) => {
    return handleHostAdminRoute(c, env, sessionStore, async (actor) => {
      const host = await syncEndpointHostState(hostStateStore, actor, c.req.param("endpointId"), {
        env,
        createAgentClient,
        now: options.now,
      })
      return c.json({ host: toBrowserHostState(host) })
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

async function handleHostAdminRoute(
  c: Context,
  env: NodeJS.ProcessEnv,
  store: AdminDataStore,
  handler: (actor: AdminPrincipal) => Promise<Response>
): Promise<Response> {
  try {
    return await handler(await resolveActor(env, store, c.req.header("cookie")))
  } catch (error) {
    return mapHostRouteError(c, error)
  }
}

function mapHostRouteError(c: Context, error: unknown): Response {
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
  if (error instanceof HostStatePermissionDeniedError) {
    return c.json(
      { error: { code: "ADMIN_FORBIDDEN", message: "Admin permission denied.", details: {} } },
      403
    )
  }
  if (error instanceof HostStateNotFoundError) {
    return c.json(
      { error: { code: "HOST_STATE_NOT_FOUND", message: "Host state was not found.", details: {} } },
      404
    )
  }
  if (error instanceof HostStateEndpointNotFoundError) {
    return c.json(
      { error: { code: "ENDPOINT_NOT_FOUND", message: "Endpoint was not found.", details: {} } },
      404
    )
  }
  if (error instanceof HostStateEndpointArchivedError) {
    return c.json(
      { error: { code: "ENDPOINT_ARCHIVED", message: "Endpoint is archived.", details: {} } },
      409
    )
  }
  if (error instanceof HostStateAgentConflictError) {
    return c.json(
      {
        error: {
          code: "HOST_STATE_AGENT_CONFLICT",
          message: "Endpoint agent identity changed.",
          details: {},
        },
      },
      409
    )
  }
  if (error instanceof HostStateMalformedReportError) {
    return c.json(
      { error: { code: "HOST_STATE_SYNC_FAILED", message: "Unable to sync host state.", details: {} } },
      502
    )
  }
  if (error instanceof HostStateAgentUnavailableError) {
    return c.json(
      { error: { code: "HOST_STATE_SYNC_FAILED", message: "Unable to sync host state.", details: {} } },
      503
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
