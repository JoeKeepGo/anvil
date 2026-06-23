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
import { AgentClient, type AgentClientOptions } from "../../services/agent"
import {
  NetworkAgentUnavailableError,
  NetworkDuplicateFabricSlugError,
  NetworkDuplicatePeerAddressError,
  NetworkFabricArchivedError,
  NetworkFabricHasActiveChildrenError,
  NetworkFabricNotFoundError,
  NetworkInvariantError,
  NetworkMalformedAgentResponseError,
  NetworkPermissionDeniedError,
  NetworkPoolNotFoundError,
  NetworkSecretKeyError,
  PrismaNetworkAdminStore,
  applyFabric,
  archiveFabric,
  createFabric,
  createHub,
  createPeer,
  createPool,
  createPrefix,
  getFabric,
  listFabrics,
  listProjectPools,
  restoreFabric,
  syncFabric,
  updateFabric,
  updatePool,
  type NetworkActionOptions,
  type NetworkAdminStore,
  type NetworkAgentClient,
} from "../../services/admin/network"
import { EndpointTokenKeyError } from "../../services/admin/endpoints"

const fabricStatusSchema = z.enum(["PLANNED", "ACTIVE", "ARCHIVED"])
const fabricModeSchema = z.enum(["HUB_SPOKE", "MESH"])
const presharedKeyModeSchema = z.enum(["DISABLED", "PAIRWISE", "FABRIC"])
const peerRoleSchema = z.enum(["MEMBER", "RELAY"])
const prefixKindSchema = z.enum(["SUBNET", "ROUTE", "RESERVED"])
const allocationModeSchema = z.enum(["STATIC", "DYNAMIC", "RESERVED"])
const poolStatusSchema = z.enum(["ACTIVE", "ARCHIVED"])

const createFabricSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  mode: fabricModeSchema.optional(),
  overlayIpv4Cidr: z.string().min(1),
  overlayIpv6Cidr: z.string().min(1),
})

const updateFabricSchema = z.object({
  name: z.string().min(1).optional(),
  mode: fabricModeSchema.optional(),
  overlayIpv4Cidr: z.string().min(1).optional(),
  overlayIpv6Cidr: z.string().min(1).optional(),
})

const createHubSchema = z.object({
  name: z.string().min(1),
  listenPort: z.number().int().min(1).max(65535),
  endpointHost: z.string().min(1),
  presharedKeyMode: presharedKeyModeSchema.optional(),
})

const createPeerSchema = z.object({
  endpointId: z.string().min(1).optional(),
  name: z.string().min(1),
  role: peerRoleSchema.optional(),
  overlayIpv4Address: z.string().min(1).optional(),
  overlayIpv6Address: z.string().min(1).optional(),
  generatePresharedKey: z.boolean().optional(),
})

const createPrefixSchema = z.object({
  kind: prefixKindSchema,
  cidr: z.string().min(1),
  ownerPeerId: z.string().min(1).optional(),
})

const createPoolSchema = z.object({
  projectId: z.string().min(1),
  fabricId: z.string().min(1),
  ipv4Cidr: z.string().min(1).optional(),
  ipv6Cidr: z.string().min(1).optional(),
  allocationMode: allocationModeSchema.optional(),
})

const updatePoolSchema = z.object({
  ipv4Cidr: z.string().min(1).optional(),
  ipv6Cidr: z.string().min(1).optional(),
  status: poolStatusSchema.optional(),
  allocationMode: allocationModeSchema.optional(),
})

export interface NetworkRoutesOptions {
  env?: NodeJS.ProcessEnv
  sessionStore?: AdminDataStore
  networkStore?: NetworkAdminStore
  createAgentClient?: (options: AgentClientOptions) => NetworkAgentClient
  now?: () => Date
}

export function createNetworkRoutes(options: NetworkRoutesOptions = {}) {
  const routes = new Hono()
  const env = options.env ?? process.env
  const sessionStore = options.sessionStore ?? new PrismaAdminDataStore(undefined, env)
  const networkStore = options.networkStore ?? new PrismaNetworkAdminStore(undefined, env)

  const actionOptions: NetworkActionOptions = {
    env,
    createAgentClient: options.createAgentClient ?? ((clientOptions) => new AgentClient(clientOptions)),
    now: options.now,
  }

  routes.get("/fabrics", async (c) => {
    return handleNetworkRoute(c, env, sessionStore, async (actor) => {
      return c.json({ fabrics: await listFabrics(networkStore, actor) })
    })
  })

  routes.get("/fabrics/:fabricId", async (c) => {
    return handleNetworkRoute(c, env, sessionStore, async (actor) => {
      return c.json({ fabric: await getFabric(networkStore, actor, c.req.param("fabricId")) })
    })
  })

  routes.post("/fabrics", async (c) => {
    return handleNetworkRoute(c, env, sessionStore, async (actor) => {
      const parsed = createFabricSchema.safeParse(await readJsonBody(c.req.raw))
      if (!parsed.success) {
        return invalidRequest(c, "INVALID_NETWORK_REQUEST", "Fabric name, slug, and overlay CIDRs are required.")
      }
      return c.json({ fabric: await createFabric(networkStore, actor, parsed.data) }, 201)
    })
  })

  routes.patch("/fabrics/:fabricId", async (c) => {
    return handleNetworkRoute(c, env, sessionStore, async (actor) => {
      const parsed = updateFabricSchema.safeParse(await readJsonBody(c.req.raw))
      if (!parsed.success) {
        return invalidRequest(c, "INVALID_NETWORK_REQUEST", "Fabric update payload is invalid.")
      }
      return c.json({ fabric: await updateFabric(networkStore, actor, c.req.param("fabricId"), parsed.data) })
    })
  })

  routes.post("/fabrics/:fabricId/archive", async (c) => {
    return handleNetworkRoute(c, env, sessionStore, async (actor) => {
      return c.json({ fabric: await archiveFabric(networkStore, actor, c.req.param("fabricId")) })
    })
  })

  routes.post("/fabrics/:fabricId/restore", async (c) => {
    return handleNetworkRoute(c, env, sessionStore, async (actor) => {
      return c.json({ fabric: await restoreFabric(networkStore, actor, c.req.param("fabricId")) })
    })
  })

  routes.post("/fabrics/:fabricId/hubs", async (c) => {
    return handleNetworkRoute(c, env, sessionStore, async (actor) => {
      const parsed = createHubSchema.safeParse(await readJsonBody(c.req.raw))
      if (!parsed.success) {
        return invalidRequest(c, "INVALID_NETWORK_REQUEST", "Hub name, listenPort, and endpointHost are required.")
      }
      return c.json({ hub: await createHub(networkStore, actor, { fabricId: c.req.param("fabricId"), ...parsed.data }, env) }, 201)
    })
  })

  routes.post("/fabrics/:fabricId/peers", async (c) => {
    return handleNetworkRoute(c, env, sessionStore, async (actor) => {
      const parsed = createPeerSchema.safeParse(await readJsonBody(c.req.raw))
      if (!parsed.success) {
        return invalidRequest(c, "INVALID_NETWORK_REQUEST", "Peer name is required.")
      }
      return c.json({ peer: await createPeer(networkStore, actor, { fabricId: c.req.param("fabricId"), ...parsed.data }, env) }, 201)
    })
  })

  routes.post("/fabrics/:fabricId/prefixes", async (c) => {
    return handleNetworkRoute(c, env, sessionStore, async (actor) => {
      const parsed = createPrefixSchema.safeParse(await readJsonBody(c.req.raw))
      if (!parsed.success) {
        return invalidRequest(c, "INVALID_NETWORK_REQUEST", "Prefix kind and CIDR are required.")
      }
      return c.json({ prefix: await createPrefix(networkStore, actor, { fabricId: c.req.param("fabricId"), ...parsed.data }) }, 201)
    })
  })

  routes.post("/fabrics/:fabricId/sync", async (c) => {
    return handleNetworkRoute(c, env, sessionStore, async (actor) => {
      return c.json({ sync: await syncFabric(networkStore, actor, c.req.param("fabricId"), actionOptions) })
    })
  })

  routes.post("/fabrics/:fabricId/dry-run", async (c) => {
    return handleNetworkRoute(c, env, sessionStore, async (actor) => {
      return c.json({ apply: await applyFabric(networkStore, actor, c.req.param("fabricId"), "DRY_RUN", actionOptions) })
    })
  })

  routes.post("/fabrics/:fabricId/apply", async (c) => {
    return handleNetworkRoute(c, env, sessionStore, async (actor) => {
      return c.json({ apply: await applyFabric(networkStore, actor, c.req.param("fabricId"), "APPLY", actionOptions) })
    })
  })

  routes.get("/project-pools", async (c) => {
    return handleNetworkRoute(c, env, sessionStore, async (actor) => {
      return c.json({ pools: await listProjectPools(networkStore, actor) })
    })
  })

  routes.post("/project-pools", async (c) => {
    return handleNetworkRoute(c, env, sessionStore, async (actor) => {
      const parsed = createPoolSchema.safeParse(await readJsonBody(c.req.raw))
      if (!parsed.success) {
        return invalidRequest(c, "INVALID_NETWORK_REQUEST", "Project id, fabric id, and pool CIDRs are required.")
      }
      return c.json({ pool: await createPool(networkStore, actor, parsed.data) }, 201)
    })
  })

  routes.patch("/project-pools/:poolId", async (c) => {
    return handleNetworkRoute(c, env, sessionStore, async (actor) => {
      const parsed = updatePoolSchema.safeParse(await readJsonBody(c.req.raw))
      if (!parsed.success) {
        return invalidRequest(c, "INVALID_NETWORK_REQUEST", "Project pool update payload is invalid.")
      }
      return c.json({ pool: await updatePool(networkStore, actor, c.req.param("poolId"), parsed.data) })
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

async function handleNetworkRoute(
  c: Context,
  env: NodeJS.ProcessEnv,
  store: AdminDataStore,
  handler: (actor: AdminPrincipal) => Promise<Response>
): Promise<Response> {
  try {
    return await handler(await resolveActor(env, store, c.req.header("cookie")))
  } catch (error) {
    return mapNetworkRouteError(c, error)
  }
}

function mapNetworkRouteError(c: Context, error: unknown): Response {
  if (error instanceof AuthSessionError) {
    return c.json({ error: { code: "UNAUTHENTICATED", message: "Authentication is required.", details: {} } }, 401)
  }
  if (error instanceof AuthConfigError) {
    return c.json({ error: { code: "AUTH_CONFIG_ERROR", message: "Authentication is not configured.", details: {} } }, 500)
  }
  if (error instanceof DisabledUserError) {
    return c.json({ error: { code: "USER_DISABLED", message: "User is disabled.", details: {} } }, 403)
  }
  if (error instanceof NetworkPermissionDeniedError) {
    return c.json({ error: { code: "ADMIN_FORBIDDEN", message: "Admin network permission denied.", details: {} } }, 403)
  }
  if (error instanceof NetworkFabricNotFoundError || error instanceof NetworkPoolNotFoundError) {
    return c.json({ error: { code: "NETWORK_NOT_FOUND", message: "Network resource was not found.", details: {} } }, 404)
  }
  if (error instanceof NetworkDuplicateFabricSlugError) {
    return c.json({ error: { code: "FABRIC_SLUG_EXISTS", message: "A fabric with that slug already exists.", details: {} } }, 409)
  }
  if (
    error instanceof NetworkFabricArchivedError ||
    error instanceof NetworkFabricHasActiveChildrenError ||
    error instanceof NetworkDuplicatePeerAddressError
  ) {
    return c.json({ error: { code: "NETWORK_CONFLICT", message: "Network resource state conflict.", details: {} } }, 409)
  }
  if (error instanceof NetworkInvariantError) {
    return c.json({ error: { code: "NETWORK_INVALID", message: "Network request failed validation.", details: {} } }, 400)
  }
  if (error instanceof NetworkMalformedAgentResponseError) {
    return c.json({ error: { code: "NETWORK_SYNC_FAILED", message: "Unable to sync network state.", details: {} } }, 502)
  }
  if (error instanceof NetworkAgentUnavailableError) {
    return c.json({ error: { code: "NETWORK_SYNC_FAILED", message: "Unable to reach network agent.", details: {} } }, 503)
  }
  if (error instanceof EndpointTokenKeyError) {
    return c.json({ error: { code: "ENDPOINT_TOKEN_KEY_REQUIRED", message: "Endpoint token encryption key is not configured.", details: {} } }, 500)
  }
  if (error instanceof NetworkSecretKeyError) {
    return c.json({ error: { code: "NETWORK_SECRET_KEY_REQUIRED", message: "Network secret encryption key is not configured.", details: {} } }, 500)
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
