// M13 Phase 4: admin VM lifecycle HTTP routes.
//
// Mounted under `/api/admin` as `/vms` and `/vm-operations`. Routes are thin
// adapters over the `vmLifecycle` service: they parse the request, resolve
// the admin actor, call the service, and map service errors to safe JSON
// responses with stable error codes. All mutation audit happens inside the
// service; the route layer never re-derives audit metadata.

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
  EndpointTokenKeyError,
} from "../../services/admin/endpoints"
import {
  PrismaVmLifecycleStore,
  createVm,
  getVm,
  listVmOperations,
  listVms,
  performVmAction,
  type VmLifecycleActionOptions,
  type VmLifecycleAgentClient,
  type VmLifecycleStore,
} from "../../services/admin/vmLifecycle"
import type {
  VmInstanceStatus,
  VmLifecycleAction,
  VmLifecycleOperationStatus,
  VmAddressFamily,
} from "../../services/admin/vmLifecycleModels"

const addressFamilySchema = z.enum(["IPV4", "IPV6", "DUAL"])
const vmStatusSchema = z.enum(["PROVISIONING", "RUNNING", "STOPPED", "FAILED", "DELETED"])
const operationStatusSchema = z.enum(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"])
const actionSchema = z.enum(["START", "STOP", "RESTART", "DELETE"])

const createVmSchema = z.object({
  name: z.string().min(1),
  endpointId: z.string().min(1),
  projectId: z.string().min(1),
  tenantId: z.string().min(1),
  networkPoolId: z.string().min(1).nullable().optional(),
  imageReference: z.string().min(1),
  cpuCount: z.number().int().min(1),
  memoryBytes: z.number().int().min(1),
  rootDiskBytes: z.number().int().min(1),
  addressFamily: addressFamilySchema.optional(),
})

const listVmsQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  tenantId: z.string().min(1).optional(),
  endpointId: z.string().min(1).optional(),
  status: vmStatusSchema.optional(),
})

const listOperationsQuerySchema = z.object({
  vmInstanceId: z.string().min(1).optional(),
  action: z.enum(["CREATE", "START", "STOP", "RESTART", "DELETE"]).optional(),
  status: operationStatusSchema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
})

export interface VmLifecycleRoutesOptions {
  env?: NodeJS.ProcessEnv
  sessionStore?: AdminDataStore
  vmLifecycleStore?: VmLifecycleStore
  createAgentClient?: (options: AgentClientOptions) => VmLifecycleAgentClient
  now?: () => Date
  stubAgent?: boolean
}

export function createVmLifecycleRoutes(options: VmLifecycleRoutesOptions = {}) {
  const routes = new Hono()
  const env = options.env ?? process.env
  const sessionStore = options.sessionStore ?? new PrismaAdminDataStore(undefined, env)
  const vmLifecycleStore: VmLifecycleStore =
    options.vmLifecycleStore ?? new PrismaVmLifecycleStore(undefined, env)

  const actionOptions: VmLifecycleActionOptions = {
    env,
    createAgentClient: options.createAgentClient ?? ((clientOptions) => new AgentClient(clientOptions)),
    now: options.now,
    stubAgent: options.stubAgent,
  }

  routes.post("/vms", async (c) => {
    return handleVmRoute(c, env, sessionStore, async (actor) => {
      const parsed = createVmSchema.safeParse(await readJsonBody(c.req.raw))
      if (!parsed.success) {
        return invalidRequest(c, "VM_INVALID_REQUEST", "VM create request is invalid.")
      }
      const result = await createVm(vmLifecycleStore, actor, {
        name: parsed.data.name,
        endpointId: parsed.data.endpointId,
        projectId: parsed.data.projectId,
        tenantId: parsed.data.tenantId,
        networkPoolId: parsed.data.networkPoolId ?? null,
        imageReference: parsed.data.imageReference,
        cpuCount: parsed.data.cpuCount,
        memoryBytes: parsed.data.memoryBytes,
        rootDiskBytes: parsed.data.rootDiskBytes,
        addressFamily: (parsed.data.addressFamily ?? "IPV4") as VmAddressFamily,
      }, actionOptions)
      return c.json(result, 201)
    })
  })

  routes.get("/vms", async (c) => {
    return handleVmRoute(c, env, sessionStore, async (actor) => {
      const parsed = listVmsQuerySchema.safeParse(c.req.query())
      if (!parsed.success) {
        return invalidRequest(c, "VM_INVALID_REQUEST", "VM list query is invalid.")
      }
      const vms = await listVms(vmLifecycleStore, actor, {
        projectId: parsed.data.projectId,
        tenantId: parsed.data.tenantId,
        endpointId: parsed.data.endpointId,
        status: parsed.data.status as VmInstanceStatus | undefined,
      })
      return c.json({ vms })
    })
  })

  routes.get("/vms/:vmId", async (c) => {
    return handleVmRoute(c, env, sessionStore, async (actor) => {
      const vm = await getVm(vmLifecycleStore, actor, c.req.param("vmId"))
      return c.json({ vm })
    })
  })

  routes.post("/vms/:vmId/:action", async (c) => {
    return handleVmRoute(c, env, sessionStore, async (actor) => {
      const actionRaw = c.req.param("action").toUpperCase()
      const parsed = actionSchema.safeParse(actionRaw)
      if (!parsed.success) {
        return invalidRequest(c, "VM_INVALID_REQUEST", "Unsupported VM lifecycle action.")
      }
      const result = await performVmAction(
        vmLifecycleStore,
        actor,
        { vmInstanceId: c.req.param("vmId"), action: parsed.data as Exclude<VmLifecycleAction, "CREATE"> },
        actionOptions
      )
      return c.json(result)
    })
  })

  routes.delete("/vms/:vmId", async (c) => {
    return handleVmRoute(c, env, sessionStore, async (actor) => {
      const result = await performVmAction(
        vmLifecycleStore,
        actor,
        { vmInstanceId: c.req.param("vmId"), action: "DELETE" },
        actionOptions
      )
      return c.json(result)
    })
  })

  routes.get("/vm-operations", async (c) => {
    return handleVmRoute(c, env, sessionStore, async (actor) => {
      const parsed = listOperationsQuerySchema.safeParse({
        ...c.req.query(),
        limit: c.req.query("limit") === undefined ? undefined : Number(c.req.query("limit")),
        offset: c.req.query("offset") === undefined ? undefined : Number(c.req.query("offset")),
      })
      if (!parsed.success) {
        return invalidRequest(c, "VM_INVALID_REQUEST", "VM operations query is invalid.")
      }
      const result = await listVmOperations(vmLifecycleStore, actor, {
        vmInstanceId: parsed.data.vmInstanceId,
        action: parsed.data.action as VmLifecycleAction | undefined,
        status: parsed.data.status as VmLifecycleOperationStatus | undefined,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
      })
      return c.json({ operations: result.entries, total: result.total })
    })
  })

  return routes
}

// ---------------------------------------------------------------------------
// Actor resolution + error mapping
// ---------------------------------------------------------------------------

async function resolveActor(
  env: NodeJS.ProcessEnv,
  store: AdminDataStore,
  cookieHeader: string | undefined
): Promise<AdminPrincipal> {
  return (await resolveCurrentAdminUser(store, env, readSessionCookie(cookieHeader))).user
}

async function handleVmRoute(
  c: Context,
  env: NodeJS.ProcessEnv,
  store: AdminDataStore,
  handler: (actor: AdminPrincipal) => Promise<Response>
): Promise<Response> {
  try {
    return await handler(await resolveActor(env, store, c.req.header("cookie")))
  } catch (error) {
    return mapVmRouteError(c, error)
  }
}

function mapVmRouteError(c: Context, error: unknown): Response {
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
  const code = (error as { code?: string } | undefined)?.code
  if (code === "UNAUTHENTICATED") {
    return c.json(
      { error: { code: "UNAUTHENTICATED", message: "Authentication is required.", details: {} } },
      401
    )
  }
  if (code === "FORBIDDEN") {
    return c.json(
      { error: { code: "ADMIN_FORBIDDEN", message: "Admin VM lifecycle permission denied.", details: {} } },
      403
    )
  }
  if (code === "VM_NOT_FOUND") {
    return c.json(
      { error: { code: "VM_NOT_FOUND", message: "VM instance was not found.", details: {} } },
      404
    )
  }
  if (code === "VM_DUPLICATE_NAME") {
    return c.json(
      { error: { code: "VM_DUPLICATE_NAME", message: "A VM with that name already exists.", details: {} } },
      409
    )
  }
  if (code === "VM_OPERATION_CONFLICT" || code === "VM_STATUS_CONFLICT") {
    return c.json(
      { error: { code: "VM_CONFLICT", message: (error as Error).message, details: {} } },
      409
    )
  }
  if (code === "VM_AGENT_UNAVAILABLE") {
    return c.json(
      { error: { code: "VM_AGENT_UNAVAILABLE", message: "Agent lifecycle protocol is unavailable.", details: {} } },
      503
    )
  }
  if (code === "VM_AGENT_MALFORMED") {
    return c.json(
      { error: { code: "VM_AGENT_MALFORMED", message: "Agent lifecycle response is malformed.", details: {} } },
      502
    )
  }
  if (code === "VM_INVALID_REQUEST") {
    return c.json(
      { error: { code: "VM_INVALID_REQUEST", message: (error as Error).message, details: {} } },
      400
    )
  }
  if (error instanceof EndpointTokenKeyError) {
    return c.json(
      { error: { code: "ENDPOINT_TOKEN_KEY_REQUIRED", message: "Endpoint token encryption key is not configured.", details: {} } },
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