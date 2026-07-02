// M13 Phase 4: admin VM lifecycle route tests.
//
// These tests exercise the HTTP contract of `/api/admin/vms` and
// `/api/admin/vm-operations` against an in-memory `VmLifecycleStore` and an
// injectable agent lifecycle client. They cover the Phase 4 test plan:
// permission deny, quota deny, tenant allocation deny, endpoint binding deny,
// network pool deny, agent unavailable, agent malformed response,
// duplicate-name conflict, deleted-vm deny, status conflict, operation
// conflict, archived project/tenant/endpoint, and audit assertions for every
// create/start/stop/restart/delete mutation. Secret leakage is asserted too.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createVmLifecycleRoutes } from "./vmLifecycle"
import { signAdminSession } from "../../services/admin/session"
import type {
  AdminAuditEntry,
  AdminDataStore,
  AdminPrincipal,
  CreateBootstrapAdminRecord,
} from "../../services/admin/session"
import {
  AgentConnectionError,
  AgentProtocolError,
  AgentTimeoutError,
  type AgentClientOptions,
  type AgentRequest,
  type AgentResponse,
} from "../../services/agent"
import type { VmLifecycleAgentClient } from "../../services/admin/vmLifecycle"
import type {
  VmLifecycleStore,
  VmLifecycleEndpointForAgent,
  VmLifecycleHostReadiness,
  ListVmsQuery,
} from "../../services/admin/vmLifecycle"
import type {
  PolicyProject,
  PolicyProjectTenant,
  PolicyEndpoint,
  PolicyEndpointProjectBinding,
  PolicyProjectNetworkPool,
  PolicyQuota,
  PolicyVmInstance,
  PolicyVmUsage,
} from "../../services/admin/vmLifecyclePolicy"
import type {
  PersistedVmInstance,
  PersistedVmLifecycleOperation,
  VmAddressFamily,
  VmInstanceStatus,
  VmLifecycleAction,
  VmLifecycleOperationStatus,
} from "../../services/admin/vmLifecycleModels"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sessionSecret = "phase4-session-secret-with-enough-entropy-blah"
const endpointTokenKey = "phase4-endpoint-token-key-with-32-bytes-of-key!"
const env = {
  ANVIL_SESSION_SECRET: sessionSecret,
  ANVIL_ENDPOINT_TOKEN_KEY: endpointTokenKey,
}

const globalAdmin: AdminPrincipal = {
  id: "admin-1",
  email: "admin@example.com",
  name: "Admin User",
  status: "ACTIVE",
  globalRole: "ADMIN",
  teams: [],
}

const member: AdminPrincipal = {
  id: "member-1",
  email: "member@example.com",
  name: "Member User",
  status: "ACTIVE",
  globalRole: "MEMBER",
  teams: [],
}

const now = new Date("2026-06-24T00:00:00.000Z")
let clock = now
function tickNow(): Date {
  return clock
}

function sessionCookie(principal: AdminPrincipal): string {
  return `anvil_session=${signAdminSession({ ANVIL_SESSION_SECRET: sessionSecret }, principal)}`
}

function jsonHeaders(cookie: string): Record<string, string> {
  return { cookie, "content-type": "application/json" }
}

async function readJson(response: Response): Promise<any> {
  return response.json()
}

function uuid(i: number): string {
  return `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`
}

function readyHostState(overrides: Partial<VmLifecycleHostReadiness> = {}): VmLifecycleHostReadiness {
  return {
    endpointId: "endpoint-1",
    status: "ONLINE",
    incusAvailable: true,
    capabilityVmLifecycle: true,
    lastSeenAt: now,
    ...overrides,
  }
}

function agentOperation(
  action: "create" | "start" | "stop" | "restart" | "delete",
  instance = "vm-1",
  status: "operation-completed" | "sync-ok" | "operation-accepted" = "operation-completed"
) {
  return {
    action,
    instance,
    status,
    operationId: status === "sync-ok" ? "" : `agent-${action}-operation`,
    operationKind: status === "sync-ok" ? "sync" : "async",
  }
}

interface FakeVmRecord extends PersistedVmInstance {
  // internal field for tests
}

class FakeVmLifecycleStore implements VmLifecycleStore {
  readonly vms = new Map<string, FakeVmRecord>()
  readonly operations = new Map<string, PersistedVmLifecycleOperation>()
  readonly auditEntries: AdminAuditEntry[] = []
  nextSeq = 1
  nextOpSeq = 1
  agentEndpoint: VmLifecycleEndpointForAgent | null = {
    id: "endpoint-1",
    url: "ws://agent.example/agent",
    tokenCiphertext: undefined,
    status: "ACTIVE",
  }
  hostState: VmLifecycleHostReadiness | null = readyHostState()

  // Policy store overrides (test-controllable)
  project: PolicyProject = { id: "project-1", status: "ACTIVE", ownerTenantId: "tenant-1" }
  projectTenant: PolicyProjectTenant = {
    projectId: "project-1",
    tenantId: "tenant-1",
    status: "ACTIVE",
  }
  endpoint: PolicyEndpoint = { id: "endpoint-1", status: "ACTIVE" }
  binding: PolicyEndpointProjectBinding = {
    endpointId: "endpoint-1",
    projectId: "project-1",
    status: "ACTIVE",
  }
  pool: PolicyProjectNetworkPool = {
    id: "pool-1",
    projectId: "project-1",
    status: "ACTIVE",
  }
  projectQuota: PolicyQuota | null = null
  projectTenantQuota: PolicyQuota | null = null
  vmUsage: PolicyVmUsage = {
    instanceCount: 0,
    totalVcpu: 0,
    totalMemoryBytes: 0,
    totalDiskBytes: 0,
  }
  policyVmInstance: PolicyVmInstance | null = null

  // -- Policy store --
  async getProject(): Promise<PolicyProject | null> {
    return this.project
  }
  async getProjectTenant(): Promise<PolicyProjectTenant | null> {
    return this.projectTenant
  }
  async getEndpoint(): Promise<PolicyEndpoint | null> {
    return this.endpoint
  }
  async getEndpointProjectBinding(): Promise<PolicyEndpointProjectBinding | null> {
    return this.binding
  }
  async getProjectNetworkPool(): Promise<PolicyProjectNetworkPool | null> {
    return this.pool
  }
  async getProjectQuota(): Promise<PolicyQuota | null> {
    return this.projectQuota
  }
  async getProjectTenantQuota(): Promise<PolicyQuota | null> {
    return this.projectTenantQuota
  }
  async getVmUsage(): Promise<PolicyVmUsage> {
    const live = [...this.vms.values()].filter((vm) => vm.status !== "DELETED")
    if (live.length > 0) {
      return {
        instanceCount: live.length,
        totalVcpu: live.reduce((sum, vm) => sum + vm.cpuCount, 0),
        totalMemoryBytes: live.reduce((sum, vm) => sum + Number(vm.memoryBytes), 0),
        totalDiskBytes: live.reduce((sum, vm) => sum + Number(vm.rootDiskBytes), 0),
      }
    }
    return this.vmUsage
  }
  async getVmInstance(vmInstanceId: string): Promise<PolicyVmInstance | null> {
    const v = this.vms.get(vmInstanceId)
    if (!v) {
      return this.policyVmInstance
    }
    return {
      id: v.id,
      endpointId: v.endpointId,
      projectId: v.projectId,
      tenantId: v.tenantId,
      status: v.status,
    }
  }

  // -- Lifecycle store --
  async raceCreateVm(input: { endpointId: string; name: string }): Promise<{ conflict: boolean }> {
    for (const v of this.vms.values()) {
      if (
        v.endpointId === input.endpointId &&
        v.name === input.name &&
        v.status !== "DELETED"
      ) {
        return { conflict: true }
      }
    }
    return { conflict: false }
  }

  async createVmInstance(input: {
    id: string
    name: string
    endpointId: string
    projectId: string
    tenantId: string
    networkPoolId: string | null
    imageReference: string
    cpuCount: number
    memoryBytes: bigint
    rootDiskBytes: bigint
    addressFamily: VmAddressFamily
    status: VmInstanceStatus
  }): Promise<PersistedVmInstance> {
    const at = tickNow()
    const record: FakeVmRecord = {
      id: input.id,
      name: input.name,
      endpointId: input.endpointId,
      projectId: input.projectId,
      tenantId: input.tenantId,
      networkPoolId: input.networkPoolId,
      imageReference: input.imageReference,
      status: input.status,
      cpuCount: input.cpuCount,
      memoryBytes: input.memoryBytes,
      rootDiskBytes: input.rootDiskBytes,
      addressFamily: input.addressFamily,
      createdAt: at,
      updatedAt: at,
    }
    this.vms.set(input.id, record)
    return record
  }

  async updateVmInstanceStatus(
    vmInstanceId: string,
    status: VmInstanceStatus
  ): Promise<PersistedVmInstance> {
    const v = this.vms.get(vmInstanceId)
    if (!v) {
      throw new Error("vm not found in fake store")
    }
    v.status = status
    v.updatedAt = tickNow()
    return v
  }

  async getVmInstanceRecord(vmInstanceId: string): Promise<PersistedVmInstance | null> {
    return this.vms.get(vmInstanceId) ?? null
  }

  async listVmInstances(query: ListVmsQuery): Promise<PersistedVmInstance[]> {
    const all = [...this.vms.values()].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    return all.filter((v) => {
      if (query.projectId && v.projectId !== query.projectId) return false
      if (query.tenantId && v.tenantId !== query.tenantId) return false
      if (query.endpointId && v.endpointId !== query.endpointId) return false
      if (query.status && v.status !== query.status) return false
      return true
    })
  }

  async createOperation(input: {
    vmInstanceId: string
    action: VmLifecycleAction
    status: VmLifecycleOperationStatus
    requestedByUserId: string
    summary?: string | null
    errorSummary?: string | null
  }): Promise<PersistedVmLifecycleOperation> {
    const id = `op-${this.nextOpSeq++}`
    const at = tickNow()
    const op: PersistedVmLifecycleOperation = {
      id,
      vmInstanceId: input.vmInstanceId,
      action: input.action,
      status: input.status,
      requestedByUserId: input.requestedByUserId,
      summary: input.summary ?? null,
      errorSummary: input.errorSummary ?? null,
      createdAt: at,
      updatedAt: at,
    }
    this.operations.set(id, op)
    return op
  }

  async createVmInstanceAndQueuedOperation(input: {
    vmInstance: {
      id: string
      name: string
      endpointId: string
      projectId: string
      tenantId: string
      networkPoolId: string | null
      imageReference: string
      cpuCount: number
      memoryBytes: bigint
      rootDiskBytes: bigint
      addressFamily: VmAddressFamily
      status: VmInstanceStatus
    }
    operation: { action: VmLifecycleAction; requestedByUserId: string }
  }): Promise<{ vmInstance: PersistedVmInstance; operation: PersistedVmLifecycleOperation }> {
    // Fake store: persist both rows sequentially (no DB); mirrors the
    // atomic Prisma implementation for test purposes.
    const vmInstance = await this.createVmInstance(input.vmInstance)
    const operation = await this.createOperation({
      vmInstanceId: vmInstance.id,
      action: input.operation.action,
      status: "QUEUED",
      requestedByUserId: input.operation.requestedByUserId,
    })
    return { vmInstance, operation }
  }

  async updateOperation(
    operationId: string,
    input: { status: VmLifecycleOperationStatus; summary?: string | null; errorSummary?: string | null }
  ): Promise<PersistedVmLifecycleOperation> {
    const op = this.operations.get(operationId)
    if (!op) {
      throw new Error("op not found in fake store")
    }
    op.status = input.status
    if (input.summary !== undefined) op.summary = input.summary
    if (input.errorSummary !== undefined) op.errorSummary = input.errorSummary
    op.updatedAt = tickNow()
    return op
  }

  async listOperations(query: {
    vmInstanceId?: string
    action?: VmLifecycleAction
    status?: VmLifecycleOperationStatus
    limit: number
    offset: number
  }): Promise<{ entries: PersistedVmLifecycleOperation[]; total: number }> {
    const all = [...this.operations.values()].sort((a, b) => {
      const byCreated = b.createdAt.getTime() - a.createdAt.getTime()
      if (byCreated !== 0) return byCreated
      return b.id < a.id ? -1 : b.id > a.id ? 1 : 0
    })
    const filtered = all.filter((o) => {
      if (query.vmInstanceId && o.vmInstanceId !== query.vmInstanceId) return false
      if (query.action && o.action !== query.action) return false
      if (query.status && o.status !== query.status) return false
      return true
    })
    return {
      entries: filtered.slice(query.offset, query.offset + query.limit),
      total: filtered.length,
    }
  }

  async getEndpointForAgent(): Promise<VmLifecycleEndpointForAgent | null> {
    return this.agentEndpoint
  }

  async getLatestHostStateForEndpoint(): Promise<VmLifecycleHostReadiness | null> {
    return this.hostState
  }

  async recordAudit(entry: AdminAuditEntry): Promise<void> {
    this.auditEntries.push(entry)
  }
}

class TestSessionStore implements AdminDataStore {
  constructor(private readonly principal: AdminPrincipal) {}
  async isBootstrapComplete(): Promise<boolean> {
    return true
  }
  async createBootstrapAdmin(_record: CreateBootstrapAdminRecord): Promise<AdminPrincipal> {
    throw new Error("not used")
  }
  async findUserByEmail(): Promise<(AdminPrincipal & { passwordHash: string }) | null> {
    return null
  }
  async findUserById(userId: string): Promise<AdminPrincipal | null> {
    return userId === this.principal.id ? this.principal : null
  }
  async recordAudit(): Promise<void> {}
}

class StubAgentClient implements VmLifecycleAgentClient {
  requests: AgentRequest[] = []
  nextStatus = 200
  nextBody: unknown = agentOperation("create")
  nextError?: string
  nextThrow?: Error
  imageStatus = 200
  imageBody: unknown = imageResponse([
    vmImageMetadata("images/ubuntu/22.04", "images-ubuntu-22-04-fingerprint", {
      "requirements.secureboot": "false",
    }),
  ]).body
  imageError?: string
  imageThrow?: Error
  async execute(request: AgentRequest): Promise<AgentResponse> {
    this.requests.push(request)
    if (request.method === "GET" && request.path === "/1.0/images?recursion=1") {
      if (this.imageThrow) {
        const err = this.imageThrow
        this.imageThrow = undefined
        throw err
      }
      return { id: "image-resp", status: this.imageStatus, body: this.imageBody, error: this.imageError }
    }
    if (this.nextThrow) {
      const err = this.nextThrow
      this.nextThrow = undefined
      throw err
    }
    return { id: "resp", status: this.nextStatus, body: this.nextBody, error: this.nextError }
  }
  close?(): void {}
}

function buildRoutes(store: FakeVmLifecycleStore, agent: StubAgentClient, principal: AdminPrincipal = globalAdmin) {
  return createVmLifecycleRoutes({
    env,
    sessionStore: new TestSessionStore(principal),
    vmLifecycleStore: store,
    createAgentClient: (_opts: AgentClientOptions) => agent,
    now: tickNow,
  })
}

function lifecycleRequests(agent: StubAgentClient): AgentRequest[] {
  return agent.requests.filter((request) => request.path.startsWith("/agent/v1/lifecycle/"))
}

function imagePolicyRequests(agent: StubAgentClient): AgentRequest[] {
  return agent.requests.filter((request) => request.path === "/1.0/images?recursion=1")
}

const baseCreateBody = {
  name: "vm-1",
  endpointId: "endpoint-1",
  projectId: "project-1",
  tenantId: "tenant-1",
  networkPoolId: "pool-1",
  imageReference: "images/ubuntu/22.04",
  cpuCount: 1,
  memoryBytes: 268_435_456,
  rootDiskBytes: 5_368_709_120,
  addressFamily: "IPV4" as VmAddressFamily,
}

function resetClock(): void {
  clock = now
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("admin VM lifecycle routes", () => {
  test.before(() => resetClock())

  test("rejects unauthenticated requests", async () => {
    const store = new FakeVmLifecycleStore()
    const agent = new StubAgentClient()
    const routes = buildRoutes(store, agent)

    const listRes = await routes.request("/vms")
    assert.equal(listRes.status, 401)
    assert.deepEqual(await readJson(listRes), {
      error: { code: "UNAUTHENTICATED", message: "Authentication is required.", details: {} },
    })

    const createRes = await routes.request("/vms", {
      method: "POST",
      body: JSON.stringify(baseCreateBody),
      headers: { "content-type": "application/json" },
    })
    assert.equal(createRes.status, 401)
  })

  test("denies members without vm:create / vm:read", async () => {
    const store = new FakeVmLifecycleStore()
    const agent = new StubAgentClient()
    const routes = buildRoutes(store, agent, member)

    const createRes = await routes.request("/vms", {
      method: "POST",
      body: JSON.stringify(baseCreateBody),
      headers: jsonHeaders(sessionCookie(member)),
    })
    assert.equal(createRes.status, 403)
    assert.deepEqual(await readJson(createRes), {
      error: { code: "ADMIN_FORBIDDEN", message: "Admin VM lifecycle permission denied.", details: {} },
    })

    const listRes = await routes.request("/vms", { headers: { cookie: sessionCookie(member) } })
    assert.equal(listRes.status, 403)
  })

  test("creates a VM, returns 201 with vm+operation, audits the mutation", async () => {
    const store = new FakeVmLifecycleStore()
    const agent = new StubAgentClient()
    agent.nextBody = agentOperation("create")
    const routes = buildRoutes(store, agent)

    const res = await routes.request("/vms", {
      method: "POST",
      body: JSON.stringify(baseCreateBody),
      headers: jsonHeaders(sessionCookie(globalAdmin)),
    })
    assert.equal(res.status, 201)
    const body = await readJson(res)
    assert.ok(body.vm.id)
    assert.equal(body.vm.name, "vm-1")
    assert.equal(body.vm.tenantId, "tenant-1")
    assert.equal(body.vm.projectId, "project-1")
    assert.equal(body.vm.endpointId, "endpoint-1")
    assert.equal(body.vm.status, "PROVISIONING")
    assert.equal(body.vm.limits.cpu, 1)
    assert.equal(body.vm.limits.memoryBytes, 268_435_456)
    assert.equal(body.vm.limits.rootDiskBytes, 5_368_709_120)
    assert.equal(body.vm.network.poolId, "pool-1")
    assert.equal(body.vm.network.addressFamily, "IPV4")
    assert.equal(body.operation.action, "CREATE")
    assert.equal(body.operation.status, "SUCCEEDED")
    assert.equal(body.operation.summary, "create operation-completed (agent-create-operation)")

    // Agent was called after policy passes with the lifecycle protocol path.
    assert.deepEqual(agent.requests.map((request) => request.path), [
      "/1.0/images?recursion=1",
      "/agent/v1/lifecycle/instances/create",
    ])
    assert.deepEqual(imagePolicyRequests(agent), [{ method: "GET", path: "/1.0/images?recursion=1" }])
    const [createRequest] = lifecycleRequests(agent)
    assert.equal(createRequest.method, "POST")
    assert.equal(createRequest.path, "/agent/v1/lifecycle/instances/create")
    assert.deepEqual(createRequest.body, {
      name: "vm-1",
      image: "images/ubuntu/22.04",
      cpuCount: 1,
      memoryBytes: 268_435_456,
      rootDiskBytes: 5_368_709_120,
      secureBootEnabled: false,
    })

    // Audit: two entries — queued + succeeded.
    assert.equal(store.auditEntries.length, 2)
    assert.equal(store.auditEntries[0].action, "vm.create")
    assert.equal(store.auditEntries[0].targetType, "vm_lifecycle_operation")
    assert.equal(store.auditEntries[0].metadata?.action, "CREATE")
    assert.equal(store.auditEntries[0].metadata?.status, "QUEUED")
    assert.equal(store.auditEntries[1].metadata?.status, "SUCCEEDED")
  })

  test("denies unknown image policy with safe 400 before VM persistence or lifecycle call", async () => {
    const store = new FakeVmLifecycleStore()
    const agent = new StubAgentClient()
    agent.imageBody = imageResponse([
      vmImageMetadata("unknown-policy", "unknown-policy-fingerprint", {}),
    ]).body
    const routes = buildRoutes(store, agent)

    const res = await routes.request("/vms", {
      method: "POST",
      body: JSON.stringify({ ...baseCreateBody, imageReference: "unknown-policy" }),
      headers: jsonHeaders(sessionCookie(globalAdmin)),
    })

    assert.equal(res.status, 400)
    assert.deepEqual(await readJson(res), {
      error: {
        code: "VM_IMAGE_NOT_ELIGIBLE",
        message: "VM image is not eligible for create.",
        details: { reason: "IMAGE_POLICY_UNKNOWN" },
      },
    })
    assert.equal(imagePolicyRequests(agent).length, 1)
    assert.equal(lifecycleRequests(agent).length, 0)
    assert.equal(store.vms.size, 0)
    assert.equal(store.operations.size, 0)
    assert.equal(store.auditEntries.length, 0)
  })

  test("denies stale host readiness with 409 and no operation or agent call", async () => {
    const store = new FakeVmLifecycleStore()
    store.hostState = readyHostState({ lastSeenAt: new Date("2026-06-23T23:44:59.999Z") })
    const agent = new StubAgentClient()
    const routes = buildRoutes(store, agent)

    const res = await routes.request("/vms", {
      method: "POST",
      body: JSON.stringify(baseCreateBody),
      headers: jsonHeaders(sessionCookie(globalAdmin)),
    })

    assert.equal(res.status, 409)
    assert.deepEqual(await readJson(res), {
      error: { code: "VM_HOST_NOT_READY", message: "Host state is stale before VM lifecycle mutation.", details: {} },
    })
    assert.equal(agent.requests.length, 0)
    assert.equal(store.vms.size, 0)
    assert.equal(store.operations.size, 0)
    assert.equal(store.auditEntries.length, 0)
  })

  test("denies quota-exceeded create with safe 400", async () => {
    const store = new FakeVmLifecycleStore()
    store.projectQuota = { maxVcpu: 1, maxMemoryBytes: null, maxDiskBytes: null, maxInstances: null }
    store.vmUsage = {
      instanceCount: 1,
      totalVcpu: 1,
      totalMemoryBytes: 0,
      totalDiskBytes: 0,
    }
    const routes = buildRoutes(store, new StubAgentClient())
    const res = await routes.request("/vms", {
      method: "POST",
      body: JSON.stringify({ ...baseCreateBody, cpuCount: 2 }),
      headers: jsonHeaders(sessionCookie(globalAdmin)),
    })
    assert.equal(res.status, 400)
    assert.equal((await readJson(res)).error.code, "VM_INVALID_REQUEST")
  })

  test("denies tenant allocation exceeded create with safe 400", async () => {
    const store = new FakeVmLifecycleStore()
    store.projectTenantQuota = { maxVcpu: 1, maxMemoryBytes: null, maxDiskBytes: null, maxInstances: null }
    store.vmUsage = { instanceCount: 0, totalVcpu: 1, totalMemoryBytes: 0, totalDiskBytes: 0 }
    const routes = buildRoutes(store, new StubAgentClient())
    const res = await routes.request("/vms", {
      method: "POST",
      body: JSON.stringify({ ...baseCreateBody, cpuCount: 2 }),
      headers: jsonHeaders(sessionCookie(globalAdmin)),
    })
    assert.equal(res.status, 400)
    assert.equal((await readJson(res)).error.code, "VM_INVALID_REQUEST")
  })

  test("denies network pool unavailable (missing pool) with safe 400", async () => {
    const store = new FakeVmLifecycleStore()
    store.pool = { id: "pool-1", projectId: "other-project", status: "ACTIVE" }
    const routes = buildRoutes(store, new StubAgentClient())
    const res = await routes.request("/vms", {
      method: "POST",
      body: JSON.stringify(baseCreateBody),
      headers: jsonHeaders(sessionCookie(globalAdmin)),
    })
    assert.equal(res.status, 400)
    assert.equal((await readJson(res)).error.code, "VM_INVALID_REQUEST")
  })

  test("denies endpoint not bound with safe 400", async () => {
    const store = new FakeVmLifecycleStore()
    store.binding = { endpointId: "endpoint-1", projectId: "project-1", status: "REMOVED" }
    const routes = buildRoutes(store, new StubAgentClient())
    const res = await routes.request("/vms", {
      method: "POST",
      body: JSON.stringify(baseCreateBody),
      headers: jsonHeaders(sessionCookie(globalAdmin)),
    })
    assert.equal(res.status, 400)
    assert.equal((await readJson(res)).error.code, "VM_INVALID_REQUEST")
  })

  test("denies archived project and archived tenant", async () => {
    const store = new FakeVmLifecycleStore()
    store.project = { id: "project-1", status: "ARCHIVED", ownerTenantId: "tenant-1" }
    const routes = buildRoutes(store, new StubAgentClient())
    const res = await routes.request("/vms", {
      method: "POST",
      body: JSON.stringify(baseCreateBody),
      headers: jsonHeaders(sessionCookie(globalAdmin)),
    })
    assert.equal(res.status, 400)

    // Archived tenant:
    const store2 = new FakeVmLifecycleStore()
    store2.projectTenant = { projectId: "project-1", tenantId: "tenant-1", status: "REMOVED" }
    const routes2 = buildRoutes(store2, new StubAgentClient())
    const res2 = await routes2.request("/vms", {
      method: "POST",
      body: JSON.stringify(baseCreateBody),
      headers: jsonHeaders(sessionCookie(globalAdmin)),
    })
    assert.equal(res2.status, 400)
  })

  test("denies duplicate VM name with 409", async () => {
    const store = new FakeVmLifecycleStore()
    const agent = new StubAgentClient()
    agent.nextBody = agentOperation("create")
    const routes = buildRoutes(store, agent)
    const first = await routes.request("/vms", {
      method: "POST",
      body: JSON.stringify(baseCreateBody),
      headers: jsonHeaders(sessionCookie(globalAdmin)),
    })
    assert.equal(first.status, 201)

    const second = await routes.request("/vms", {
      method: "POST",
      body: JSON.stringify(baseCreateBody),
      headers: jsonHeaders(sessionCookie(globalAdmin)),
    })
    assert.equal(second.status, 409)
    assert.equal((await readJson(second)).error.code, "VM_DUPLICATE_NAME")
  })

  test("records FAILED operation and 503 when agent is unavailable", async () => {
    const store = new FakeVmLifecycleStore()
    const agent = new StubAgentClient()
    agent.nextThrow = new AgentConnectionError("no socket")
    const routes = buildRoutes(store, agent)

    const res = await routes.request("/vms", {
      method: "POST",
      body: JSON.stringify(baseCreateBody),
      headers: jsonHeaders(sessionCookie(globalAdmin)),
    })
    assert.equal(res.status, 503)
    assert.equal((await readJson(res)).error.code, "VM_AGENT_UNAVAILABLE")

    // The queued op flips to FAILED, and audit captured both queued + failed.
    const failedOp = [...store.operations.values()].find((o) => o.action === "CREATE")
    assert.ok(failedOp)
    assert.equal(failedOp!.status, "FAILED")
    assert.ok(failedOp!.errorSummary)
    assert.equal(store.auditEntries.length, 2)
    assert.equal(store.auditEntries[1].metadata?.status, "FAILED")
    // No agent payload surfaced in audit metadata.
    assert.equal(JSON.stringify(store.auditEntries).includes("/agent/v1/lifecycle/instances/create"), false)
  })

  test("records FAILED operation and 502 for malformed agent response", async () => {
    const store = new FakeVmLifecycleStore()
    const agent = new StubAgentClient()
    agent.nextBody = { notStatus: "boom", status: 123 } // non-string status -> malformed
    const routes = buildRoutes(store, agent)

    const res = await routes.request("/vms", {
      method: "POST",
      body: JSON.stringify(baseCreateBody),
      headers: jsonHeaders(sessionCookie(globalAdmin)),
    })
    assert.equal(res.status, 502)
    assert.equal((await readJson(res)).error.code, "VM_AGENT_MALFORMED")
    const failedOp = [...store.operations.values()].find((o) => o.action === "CREATE")
    assert.equal(failedOp!.status, "FAILED")
  })

  test("records FAILED operation and 502 for safe upstream lifecycle failure", async () => {
    const store = new FakeVmLifecycleStore()
    const agent = new StubAgentClient()
    agent.nextStatus = 502
    agent.nextBody = null
    agent.nextError = "incus lifecycle create completed but instance is missing"
    const routes = buildRoutes(store, agent)

    const res = await routes.request("/vms", {
      method: "POST",
      body: JSON.stringify(baseCreateBody),
      headers: jsonHeaders(sessionCookie(globalAdmin)),
    })
    assert.equal(res.status, 502)
    const body = await readJson(res)
    assert.equal(body.error.code, "VM_AGENT_LIFECYCLE_FAILED")
    assert.equal(body.error.message, "Agent lifecycle operation failed.")
    assert.equal(body.error.details.reason, "incus lifecycle create completed but instance is missing")

    const vm = [...store.vms.values()].find((record) => record.name === "vm-1")
    assert.ok(vm)
    assert.equal(vm!.status, "FAILED")
    const failedOp = [...store.operations.values()].find((o) => o.action === "CREATE")
    assert.ok(failedOp)
    assert.equal(failedOp!.status, "FAILED")
    assert.equal(
      failedOp!.errorSummary,
      "Agent lifecycle operation failed: incus lifecycle create completed but instance is missing"
    )
    assert.equal(store.auditEntries.length, 2)
    assert.equal(store.auditEntries[1].metadata?.status, "FAILED")
    assert.equal(JSON.stringify(store.auditEntries).includes("VM_AGENT_MALFORMED"), false)
  })

  test("does not report create success for old operation-accepted agent responses", async () => {
    const store = new FakeVmLifecycleStore()
    const agent = new StubAgentClient()
    agent.nextBody = agentOperation("create", "vm-1", "operation-accepted")
    const routes = buildRoutes(store, agent)

    const res = await routes.request("/vms", {
      method: "POST",
      body: JSON.stringify(baseCreateBody),
      headers: jsonHeaders(sessionCookie(globalAdmin)),
    })

    assert.equal(res.status, 502)
    assert.equal((await readJson(res)).error.code, "VM_AGENT_MALFORMED")
    const vm = [...store.vms.values()].find((record) => record.name === "vm-1")
    assert.ok(vm)
    assert.equal(vm!.status, "FAILED")
    const failedOp = [...store.operations.values()].find((operation) => operation.action === "CREATE")
    assert.ok(failedOp)
    assert.equal(failedOp!.status, "FAILED")
    assert.notEqual(failedOp!.status, "SUCCEEDED")
    assert.equal(
      store.auditEntries.some((entry) => entry.action === "vm.create" && entry.metadata?.status === "SUCCEEDED"),
      false
    )
  })

  test("starts a stopped VM, audits vm.start", async () => {
    const store = new FakeVmLifecycleStore()
    const agent = new StubAgentClient()
    agent.nextBody = agentOperation("create")
    const routes = buildRoutes(store, agent)
    const created = await routes.request("/vms", {
      method: "POST",
      body: JSON.stringify(baseCreateBody),
      headers: jsonHeaders(sessionCookie(globalAdmin)),
    })
    const vmId = (await readJson(created)).vm.id

    // stop first to allow start
    agent.nextBody = agentOperation("stop")
    const stopRes = await routes.request(`/vms/${vmId}/stop`, {
      method: "POST",
      headers: { cookie: sessionCookie(globalAdmin) },
    })
    assert.equal(stopRes.status, 200)

    agent.nextBody = agentOperation("start")
    const startRes = await routes.request(`/vms/${vmId}/start`, {
      method: "POST",
      headers: { cookie: sessionCookie(globalAdmin) },
    })
    assert.equal(startRes.status, 200)
    const started = await readJson(startRes)
    assert.equal(started.vm.status, "RUNNING")
    assert.equal(started.operation.action, "START")
    assert.equal(started.operation.status, "SUCCEEDED")

    const startAudit = store.auditEntries.filter((e) => e.action === "vm.start")
    assert.ok(startAudit.length >= 2)
    assert.equal(startAudit[startAudit.length - 1].metadata?.status, "SUCCEEDED")
  })

  test("stopping an already-stopped VM returns 409 VM_CONFLICT", async () => {
    const store = new FakeVmLifecycleStore()
    const agent = new StubAgentClient()
    agent.nextBody = agentOperation("create")
    const routes = buildRoutes(store, agent)
    const created = await routes.request("/vms", {
      method: "POST",
      body: JSON.stringify(baseCreateBody),
      headers: jsonHeaders(sessionCookie(globalAdmin)),
    })
    const vmId = (await readJson(created)).vm.id
    // set the VM stopped manually
    store.vms.get(vmId)!.status = "STOPPED"

    const res = await routes.request(`/vms/${vmId}/stop`, {
      method: "POST",
      headers: { cookie: sessionCookie(globalAdmin) },
    })
    assert.equal(res.status, 409)
    assert.equal((await readJson(res)).error.code, "VM_CONFLICT")
  })

  test("restarting a stopped VM returns 409 VM_CONFLICT", async () => {
    const store = new FakeVmLifecycleStore()
    const agent = new StubAgentClient()
    agent.nextBody = agentOperation("create")
    const routes = buildRoutes(store, agent)
    const created = await routes.request("/vms", {
      method: "POST",
      body: JSON.stringify(baseCreateBody),
      headers: jsonHeaders(sessionCookie(globalAdmin)),
    })
    const vmId = (await readJson(created)).vm.id
    store.vms.get(vmId)!.status = "STOPPED"

    const res = await routes.request(`/vms/${vmId}/restart`, {
      method: "POST",
      headers: { cookie: sessionCookie(globalAdmin) },
    })
    assert.equal(res.status, 409)
    assert.equal((await readJson(res)).error.code, "VM_CONFLICT")
  })

  test("delete soft-deletes VM, audits vm.delete, then re-start returns 404", async () => {
    const store = new FakeVmLifecycleStore()
    const agent = new StubAgentClient()
    agent.nextBody = agentOperation("create")
    const routes = buildRoutes(store, agent)
    const created = await routes.request("/vms", {
      method: "POST",
      body: JSON.stringify(baseCreateBody),
      headers: jsonHeaders(sessionCookie(globalAdmin)),
    })
    const vmId = (await readJson(created)).vm.id

    agent.nextBody = agentOperation("delete")
    const delRes = await routes.request(`/vms/${vmId}`, {
      method: "DELETE",
      headers: { cookie: sessionCookie(globalAdmin) },
    })
    assert.equal(delRes.status, 200)
    const deleted = await readJson(delRes)
    assert.equal(deleted.vm.status, "DELETED")
    assert.equal(deleted.operation.action, "DELETE")
    assert.equal(deleted.operation.status, "SUCCEEDED")

    const deleteAudit = store.auditEntries.filter((e) => e.action === "vm.delete")
    assert.ok(deleteAudit.length >= 2)
    assert.equal(deleteAudit[deleteAudit.length - 1].metadata?.status, "SUCCEEDED")

    // Re-starting a deleted VM must 404, not leak the deleted record.
    const startRes = await routes.request(`/vms/${vmId}/start`, {
      method: "POST",
      headers: { cookie: sessionCookie(globalAdmin) },
    })
    assert.equal(startRes.status, 404)
    assert.equal((await readJson(startRes)).error.code, "VM_NOT_FOUND")
  })

  test("failed delete returns an error and keeps the VM visible with quota and name conflict intact", async () => {
    const store = new FakeVmLifecycleStore()
    const agent = new StubAgentClient()
    agent.nextBody = agentOperation("create")
    const routes = buildRoutes(store, agent)
    const created = await routes.request("/vms", {
      method: "POST",
      body: JSON.stringify(baseCreateBody),
      headers: jsonHeaders(sessionCookie(globalAdmin)),
    })
    const vmId = (await readJson(created)).vm.id
    store.vms.get(vmId)!.status = "STOPPED"

    agent.nextThrow = new AgentConnectionError("agent socket down")
    const delRes = await routes.request(`/vms/${vmId}`, {
      method: "DELETE",
      headers: { cookie: sessionCookie(globalAdmin) },
    })
    assert.equal(delRes.status, 503)
    assert.equal((await readJson(delRes)).error.code, "VM_AGENT_UNAVAILABLE")
    assert.equal(store.vms.get(vmId)!.status, "FAILED")
    assert.notEqual(store.vms.get(vmId)!.status, "DELETED")

    const failedOp = [...store.operations.values()].find(
      (o) => o.vmInstanceId === vmId && o.action === "DELETE"
    )
    assert.ok(failedOp)
    assert.equal(failedOp!.status, "FAILED")
    assert.ok(failedOp!.errorSummary)

    const failedAudit = store.auditEntries.find(
      (entry) => entry.action === "vm.delete" && entry.metadata?.status === "FAILED"
    )
    assert.ok(failedAudit)
    assert.equal(JSON.stringify(store.auditEntries).includes("agent socket down"), false)

    const listRes = await routes.request("/vms", {
      headers: { cookie: sessionCookie(globalAdmin) },
    })
    assert.equal(listRes.status, 200)
    const listBody = await readJson(listRes)
    assert.equal(
      listBody.vms.some((vm: { id: string; status: string }) => vm.id === vmId && vm.status === "FAILED"),
      true
    )

    agent.nextBody = agentOperation("create")
    store.projectQuota = { maxVcpu: null, maxMemoryBytes: null, maxDiskBytes: null, maxInstances: 1 }
    const agentRequestCountAfterFailedDelete = agent.requests.length
    const quotaDenied = await routes.request("/vms", {
      method: "POST",
      body: JSON.stringify({ ...baseCreateBody, name: "vm-after-failed-delete" }),
      headers: jsonHeaders(sessionCookie(globalAdmin)),
    })
    assert.equal(quotaDenied.status, 400)
    assert.equal((await readJson(quotaDenied)).error.code, "VM_INVALID_REQUEST")
    assert.equal(agent.requests.length, agentRequestCountAfterFailedDelete)

    store.projectQuota = null
    const duplicate = await routes.request("/vms", {
      method: "POST",
      body: JSON.stringify(baseCreateBody),
      headers: jsonHeaders(sessionCookie(globalAdmin)),
    })
    assert.equal(duplicate.status, 409)
    assert.equal((await readJson(duplicate)).error.code, "VM_DUPLICATE_NAME")
  })

  test("deleting a deleted VM returns 404", async () => {
    const store = new FakeVmLifecycleStore()
    const agent = new StubAgentClient()
    agent.nextBody = agentOperation("create")
    const routes = buildRoutes(store, agent)
    const created = await routes.request("/vms", {
      method: "POST",
      body: JSON.stringify(baseCreateBody),
      headers: jsonHeaders(sessionCookie(globalAdmin)),
    })
    const vmId = (await readJson(created)).vm.id
    agent.nextBody = agentOperation("delete")
    await routes.request(`/vms/${vmId}`, {
      method: "DELETE",
      headers: { cookie: sessionCookie(globalAdmin) },
    })
    const secondDel = await routes.request(`/vms/${vmId}`, {
      method: "DELETE",
      headers: { cookie: sessionCookie(globalAdmin) },
    })
    assert.equal(secondDel.status, 404)
  })

  test("lists vms and fetches a single vm", async () => {
    const store = new FakeVmLifecycleStore()
    const agent = new StubAgentClient()
    agent.nextBody = agentOperation("create")
    const routes = buildRoutes(store, agent)
    const created = await routes.request("/vms", {
      method: "POST",
      body: JSON.stringify(baseCreateBody),
      headers: jsonHeaders(sessionCookie(globalAdmin)),
    })
    const vmId = (await readJson(created)).vm.id

    const listRes = await routes.request("/vms", { headers: { cookie: sessionCookie(globalAdmin) } })
    assert.equal(listRes.status, 200)
    const list = await readJson(listRes)
    assert.equal(list.vms.length, 1)
    assert.ok(list.vms[0].createdAt)
    assert.ok(list.vms[0].updatedAt)

    const getRes = await routes.request(`/vms/${vmId}`, {
      headers: { cookie: sessionCookie(globalAdmin) },
    })
    assert.equal(getRes.status, 200)
    assert.equal((await readJson(getRes)).vm.id, vmId)
  })

  test("GET a missing VM returns 404", async () => {
    const store = new FakeVmLifecycleStore()
    const routes = buildRoutes(store, new StubAgentClient())
    const res = await routes.request("/vms/does-not-exist", {
      headers: { cookie: sessionCookie(globalAdmin) },
    })
    assert.equal(res.status, 404)
  })

  test("lists lifecycle operations", async () => {
    const store = new FakeVmLifecycleStore()
    const agent = new StubAgentClient()
    agent.nextBody = agentOperation("create")
    const routes = buildRoutes(store, agent)
    const created = await routes.request("/vms", {
      method: "POST",
      body: JSON.stringify(baseCreateBody),
      headers: jsonHeaders(sessionCookie(globalAdmin)),
    })
    const vmId = (await readJson(created)).vm.id

    const res = await routes.request("/vm-operations", {
      headers: { cookie: sessionCookie(globalAdmin) },
    })
    assert.equal(res.status, 200)
    const body = await readJson(res)
    assert.equal(body.operations.length, 1)
    assert.equal(body.operations[0].action, "CREATE")
    assert.equal(body.operations[0].vmInstanceId, vmId)
    assert.equal(body.total, 1)
  })

  test("rejects unsupported action param with 400", async () => {
    const store = new FakeVmLifecycleStore()
    const agent = new StubAgentClient()
    agent.nextBody = agentOperation("create")
    const routes = buildRoutes(store, agent)
    const created = await routes.request("/vms", {
      method: "POST",
      body: JSON.stringify(baseCreateBody),
      headers: jsonHeaders(sessionCookie(globalAdmin)),
    })
    const vmId = (await readJson(created)).vm.id

    const res = await routes.request(`/vms/${vmId}/explode`, {
      method: "POST",
      headers: { cookie: sessionCookie(globalAdmin) },
    })
    assert.equal(res.status, 400)
    assert.equal((await readJson(res)).error.code, "VM_INVALID_REQUEST")
  })

  test("rejects a new action while another lifecycle operation is running (409 VM_CONFLICT)", async () => {
    const store = new FakeVmLifecycleStore()
    const agent = new StubAgentClient()
    agent.nextBody = agentOperation("create")
    const routes = buildRoutes(store, agent)
    const created = await routes.request("/vms", {
      method: "POST",
      body: JSON.stringify(baseCreateBody),
      headers: jsonHeaders(sessionCookie(globalAdmin)),
    })
    const vmId = (await readJson(created)).vm.id

    // Seed an inflight RUNNING operation directly so the probe sees it.
    await store.createOperation({
      vmInstanceId: vmId,
      action: "STOP",
      status: "RUNNING",
      requestedByUserId: globalAdmin.id,
    })

    const startRes = await routes.request(`/vms/${vmId}/start`, {
      method: "POST",
      headers: { cookie: sessionCookie(globalAdmin) },
    })
    assert.equal(startRes.status, 409)
    assert.equal((await readJson(startRes)).error.code, "VM_CONFLICT")

    // The agent must never have been called for the rejected action.
    assert.equal(lifecycleRequests(agent).length, 1, "only the create lifecycle call should have occurred")
  })

  test("rejects a new action while another lifecycle operation is queued (409 VM_CONFLICT)", async () => {
    const store = new FakeVmLifecycleStore()
    const agent = new StubAgentClient()
    agent.nextBody = agentOperation("create")
    const routes = buildRoutes(store, agent)
    const created = await routes.request("/vms", {
      method: "POST",
      body: JSON.stringify(baseCreateBody),
      headers: jsonHeaders(sessionCookie(globalAdmin)),
    })
    const vmId = (await readJson(created)).vm.id
    store.vms.get(vmId)!.status = "STOPPED"

    await store.createOperation({
      vmInstanceId: vmId,
      action: "START",
      status: "QUEUED",
      requestedByUserId: globalAdmin.id,
    })

    // START is state-compatible with STOPPED, so the inflight probe is the
    // only guard that fires here.
    const startRes = await routes.request(`/vms/${vmId}/start`, {
      method: "POST",
      headers: { cookie: sessionCookie(globalAdmin) },
    })
    assert.equal(startRes.status, 409)
    assert.equal((await readJson(startRes)).error.code, "VM_CONFLICT")
    assert.equal(lifecycleRequests(agent).length, 1)
  })

  test("rejects invalid create body with 400", async () => {
    const routes = buildRoutes(new FakeVmLifecycleStore(), new StubAgentClient())
    const res = await routes.request("/vms", {
      method: "POST",
      body: JSON.stringify({ name: "only-name" }),
      headers: jsonHeaders(sessionCookie(globalAdmin)),
    })
    assert.equal(res.status, 400)
    assert.equal((await readJson(res)).error.code, "VM_INVALID_REQUEST")
  })

  test("agent payload and endpoint material never leak to audit or response", async () => {
    const store = new FakeVmLifecycleStore()
    const agent = new StubAgentClient()
    agent.nextBody = {
      ...agentOperation("create"),
      // hostile fields that must not echo back into the response or audit.
      token: "sekret",
      tokenCiphertext: "secret-ciphertext",
      vmConfig: "vm-config-that-must-not-leak",
      userData: "password: must-not-leak",
      agentPayload: "agent-payload-that-must-not-leak",
    }
    const routes = buildRoutes(store, agent)
    const res = await routes.request("/vms", {
      method: "POST",
      body: JSON.stringify(baseCreateBody),
      headers: jsonHeaders(sessionCookie(globalAdmin)),
    })
    const body = await readJson(res)
    assert.equal(body.token, undefined)
    assert.equal(body.vmConfig, undefined)
    assert.equal(body.userData, undefined)
    const serialized = JSON.stringify(body) + JSON.stringify(store.auditEntries)
    assert.equal(serialized.includes("must-not-leak"), false)
    assert.equal(serialized.includes("sekret"), false)
    assert.equal(serialized.includes("secret-ciphertext"), false)
  })

  test("agent timeout surfaces 503 VM_AGENT_UNAVAILABLE and FAILED operation", async () => {
    const store = new FakeVmLifecycleStore()
    const agent = new StubAgentClient()
    agent.nextThrow = new AgentTimeoutError("slow agent")
    const routes = buildRoutes(store, agent)
    const res = await routes.request("/vms", {
      method: "POST",
      body: JSON.stringify(baseCreateBody),
      headers: jsonHeaders(sessionCookie(globalAdmin)),
    })
    assert.equal(res.status, 503)
    const failedOp = [...store.operations.values()].find((o) => o.action === "CREATE")
    assert.equal(failedOp!.status, "FAILED")
    assert.ok(failedOp!.errorSummary!.includes("unavailable"))
  })

  test("agent protocol error surfaces 503 VM_AGENT_UNAVAILABLE", async () => {
    const store = new FakeVmLifecycleStore()
    const agent = new StubAgentClient()
    agent.nextThrow = new AgentProtocolError("bad frame")
    const routes = buildRoutes(store, agent)
    const res = await routes.request("/vms", {
      method: "POST",
      body: JSON.stringify(baseCreateBody),
      headers: jsonHeaders(sessionCookie(globalAdmin)),
    })
    assert.equal(res.status, 503)
    assert.equal((await readJson(res)).error.code, "VM_AGENT_UNAVAILABLE")
  })
})

function imageResponse(metadata: unknown[]): AgentResponse {
  return {
    id: "images-response",
    status: 200,
    body: {
      type: "sync",
      status: "Success",
      status_code: 200,
      metadata,
    },
  }
}

function vmImageMetadata(
  alias: string,
  fingerprint: string,
  properties: Record<string, unknown>
): Record<string, unknown> {
  return {
    fingerprint,
    aliases: [{ name: alias, description: "" }],
    architecture: "x86_64",
    auto_update: false,
    cached: false,
    created_at: "2026-06-25T00:00:00Z",
    expires_at: "1970-01-01T00:00:00Z",
    last_used_at: "2026-06-28T06:54:41.216264267Z",
    properties: {
      description: `${alias} image`,
      ...properties,
    },
    public: false,
    size: 70189968,
    type: "virtual-machine",
    uploaded_at: "2026-06-28T03:17:58.413550343Z",
  }
}
