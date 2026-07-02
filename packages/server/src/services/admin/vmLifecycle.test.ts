// M13 Phase 4: VM lifecycle orchestration service tests.
//
// These exercise the service layer directly (no HTTP), focusing on the
// ordering guarantee the spec calls out: backend policy must pass before any
// agent call, every mutation audits both the queued and the final operation,
// and the agent lifecycle boundary maps failures to FAILED operations without
// leaking agent material into audit metadata.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  createVm,
  listVmOperations,
  listVms,
  performVmAction,
  type VmLifecycleActionOptions,
  type VmLifecycleAgentClient,
  type VmLifecycleEndpointForAgent,
  type VmLifecycleHostReadiness,
  type VmLifecycleStore,
} from "./vmLifecycle"
import {
  AgentConnectionError,
  AgentTimeoutError,
  type AgentClientOptions,
  type AgentRequest,
  type AgentResponse,
} from "../agent"
import type {
  AdminAuditEntry,
  AdminPrincipal,
} from "./session"
import type {
  PolicyEndpoint,
  PolicyEndpointProjectBinding,
  PolicyProject,
  PolicyProjectNetworkPool,
  PolicyProjectTenant,
  PolicyQuota,
  PolicyVmInstance,
  PolicyVmUsage,
  VmLifecyclePolicyStore,
} from "./vmLifecyclePolicy"
import type {
  PersistedVmInstance,
  PersistedVmLifecycleOperation,
  VmAddressFamily,
  VmInstanceStatus,
  VmLifecycleAction,
  VmLifecycleOperationStatus,
} from "./vmLifecycleModels"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const admin: AdminPrincipal = {
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
function tickNow(): Date {
  return now
}

const baseCreate = {
  name: "vm-1",
  endpointId: "endpoint-1",
  projectId: "project-1",
  tenantId: "tenant-1",
  networkPoolId: "pool-1" as string | null,
  imageReference: "images/ubuntu/22.04",
  cpuCount: 1,
  memoryBytes: 268_435_456,
  rootDiskBytes: 5_368_709_120,
  addressFamily: "IPV4" as VmAddressFamily,
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

class FakeStore implements VmLifecycleStore {
  readonly vms = new Map<string, PersistedVmInstance>()
  readonly operations = new Map<string, PersistedVmLifecycleOperation>()
  readonly auditEntries: AdminAuditEntry[] = []
  nextOp = 1

  // Policy store knobs (overridable)
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
  pool: PolicyProjectNetworkPool = { id: "pool-1", projectId: "project-1", status: "ACTIVE" }
  projectQuota: PolicyQuota | null = null
  projectTenantQuota: PolicyQuota | null = null
  vmUsage: PolicyVmUsage = {
    instanceCount: 0,
    totalVcpu: 0,
    totalMemoryBytes: 0,
    totalDiskBytes: 0,
  }
  agentEndpoint: VmLifecycleEndpointForAgent | null = {
    id: "endpoint-1",
    url: "ws://agent.example/agent",
    status: "ACTIVE",
  }
  hostState: VmLifecycleHostReadiness | null = readyHostState()

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
    return v
      ? {
          id: v.id,
          endpointId: v.endpointId,
          projectId: v.projectId,
          tenantId: v.tenantId,
          status: v.status,
        }
      : null
  }

  async raceCreateVm(input: { endpointId: string; name: string }): Promise<{ conflict: boolean }> {
    for (const v of this.vms.values()) {
      if (v.endpointId === input.endpointId && v.name === input.name && v.status !== "DELETED") {
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
    const record: PersistedVmInstance = {
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
      createdAt: now,
      updatedAt: now,
    }
    this.vms.set(input.id, record)
    return record
  }

  async updateVmInstanceStatus(
    vmInstanceId: string,
    status: VmInstanceStatus
  ): Promise<PersistedVmInstance> {
    const v = this.vms.get(vmInstanceId)!
    v.status = status
    v.updatedAt = now
    return v
  }

  async getVmInstanceRecord(vmInstanceId: string): Promise<PersistedVmInstance | null> {
    return this.vms.get(vmInstanceId) ?? null
  }

  async listVmInstances(): Promise<PersistedVmInstance[]> {
    return [...this.vms.values()]
  }

  async createOperation(input: {
    vmInstanceId: string
    action: VmLifecycleAction
    status: VmLifecycleOperationStatus
    requestedByUserId: string
    summary?: string | null
    errorSummary?: string | null
  }): Promise<PersistedVmLifecycleOperation> {
    const id = `op-${this.nextOp++}`
    const op: PersistedVmLifecycleOperation = {
      id,
      vmInstanceId: input.vmInstanceId,
      action: input.action,
      status: input.status,
      requestedByUserId: input.requestedByUserId,
      summary: input.summary ?? null,
      errorSummary: input.errorSummary ?? null,
      createdAt: now,
      updatedAt: now,
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
    const op = this.operations.get(operationId)!
    op.status = input.status
    if (input.summary !== undefined) op.summary = input.summary
    if (input.errorSummary !== undefined) op.errorSummary = input.errorSummary
    op.updatedAt = now
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

class RecordingAgentClient implements VmLifecycleAgentClient {
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

function actionOptions(agent: RecordingAgentClient): VmLifecycleActionOptions {
  return {
    env: {},
    createAgentClient: (_opts: AgentClientOptions) => agent,
    now: tickNow,
  }
}

function lifecycleRequests(agent: RecordingAgentClient): AgentRequest[] {
  return agent.requests.filter((request) => request.path.startsWith("/agent/v1/lifecycle/"))
}

function imagePolicyRequests(agent: RecordingAgentClient): AgentRequest[] {
  return agent.requests.filter((request) => request.path === "/1.0/images?recursion=1")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("vmLifecycle service", () => {
  test("createVm invokes the agent ONLY after backend policy passes", async () => {
    const store = new FakeStore()
    const agent = new RecordingAgentClient()
    agent.nextBody = agentOperation("create")
    const result = await createVm(store, admin, baseCreate, actionOptions(agent))

    assert.equal(result.vm.status, "PROVISIONING")
    assert.equal(result.operation.action, "CREATE")
    assert.equal(result.operation.status, "SUCCEEDED")
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
    // Two audit entries: QUEUED then SUCCEEDED.
    assert.equal(store.auditEntries.length, 2)
    assert.equal(store.auditEntries[0].metadata?.status, "QUEUED")
    assert.equal(store.auditEntries[1].metadata?.status, "SUCCEEDED")
  })

  test("createVm sends secureBootEnabled true when image metadata requires secure boot", async () => {
    const store = new FakeStore()
    const agent = new RecordingAgentClient()
    agent.imageBody = imageResponse([
      vmImageMetadata("secureboot-required", "secureboot-required-fingerprint", {
        "requirements.secureboot": "true",
      }),
    ]).body
    agent.nextBody = agentOperation("create")

    await createVm(
      store,
      admin,
      { ...baseCreate, imageReference: "secureboot-required" },
      actionOptions(agent)
    )

    assert.deepEqual(imagePolicyRequests(agent), [{ method: "GET", path: "/1.0/images?recursion=1" }])
    assert.equal(lifecycleRequests(agent).length, 1)
    assert.equal((lifecycleRequests(agent)[0].body as { secureBootEnabled?: unknown }).secureBootEnabled, true)
  })

  test("createVm blocks unknown image policy before VM persistence or lifecycle agent call", async () => {
    const store = new FakeStore()
    const agent = new RecordingAgentClient()
    agent.imageBody = imageResponse([
      vmImageMetadata("unknown-policy", "unknown-policy-fingerprint", {}),
    ]).body

    let caught: unknown
    try {
      await createVm(
        store,
        admin,
        { ...baseCreate, imageReference: "unknown-policy" },
        actionOptions(agent)
      )
    } catch (error) {
      caught = error
    }

    assert.equal((caught as { code?: string }).code, "VM_IMAGE_NOT_ELIGIBLE")
    assert.equal((caught as { reason?: string }).reason, "IMAGE_POLICY_UNKNOWN")
    assert.equal(imagePolicyRequests(agent).length, 1)
    assert.equal(lifecycleRequests(agent).length, 0)
    assert.equal(store.vms.size, 0)
    assert.equal(store.operations.size, 0)
    assert.equal(store.auditEntries.length, 0)
  })

  test("createVm blocks malformed secure boot image metadata before lifecycle agent call", async () => {
    const store = new FakeStore()
    const agent = new RecordingAgentClient()
    agent.imageBody = imageResponse([
      vmImageMetadata("malformed-policy", "malformed-policy-fingerprint", {
        "requirements.secureboot": true,
      }),
    ]).body

    let caught: unknown
    try {
      await createVm(
        store,
        admin,
        { ...baseCreate, imageReference: "malformed-policy" },
        actionOptions(agent)
      )
    } catch (error) {
      caught = error
    }

    assert.equal((caught as { code?: string }).code, "VM_IMAGE_NOT_ELIGIBLE")
    assert.equal((caught as { reason?: string }).reason, "IMAGE_POLICY_UNKNOWN")
    assert.equal(lifecycleRequests(agent).length, 0)
    assert.equal(store.vms.size, 0)
    assert.equal(store.operations.size, 0)
  })

  test("createVm blocks non-VM images before lifecycle agent call", async () => {
    const store = new FakeStore()
    const agent = new RecordingAgentClient()
    agent.imageBody = imageResponse([
      {
        ...vmImageMetadata("container-image", "container-image-fingerprint", {
          "requirements.secureboot": "false",
        }),
        type: "container",
      },
    ]).body

    let caught: unknown
    try {
      await createVm(
        store,
        admin,
        { ...baseCreate, imageReference: "container-image" },
        actionOptions(agent)
      )
    } catch (error) {
      caught = error
    }

    assert.equal((caught as { code?: string }).code, "VM_IMAGE_NOT_ELIGIBLE")
    assert.equal((caught as { reason?: string }).reason, "IMAGE_NOT_VM")
    assert.equal(lifecycleRequests(agent).length, 0)
    assert.equal(store.vms.size, 0)
    assert.equal(store.operations.size, 0)
  })

  test("createVm blocks missing or invisible images before lifecycle agent call", async () => {
    const store = new FakeStore()
    const agent = new RecordingAgentClient()
    agent.imageBody = imageResponse([
      vmImageMetadata("visible-image", "visible-image-fingerprint", {
        "requirements.secureboot": "false",
      }),
    ]).body

    let caught: unknown
    try {
      await createVm(
        store,
        admin,
        { ...baseCreate, imageReference: "not-visible" },
        actionOptions(agent)
      )
    } catch (error) {
      caught = error
    }

    assert.equal((caught as { code?: string }).code, "VM_IMAGE_NOT_ELIGIBLE")
    assert.equal((caught as { reason?: string }).reason, "IMAGE_NOT_FOUND")
    assert.equal(lifecycleRequests(agent).length, 0)
    assert.equal(store.vms.size, 0)
    assert.equal(store.operations.size, 0)
  })

  test("createVm blocks malformed image catalog responses before lifecycle agent call", async () => {
    const store = new FakeStore()
    const agent = new RecordingAgentClient()
    agent.imageBody = { metadata: "invalid", rawSecret: "do-not-return" }

    let caught: unknown
    try {
      await createVm(store, admin, baseCreate, actionOptions(agent))
    } catch (error) {
      caught = error
    }

    assert.equal((caught as { code?: string }).code, "VM_IMAGE_POLICY_UNAVAILABLE")
    assert.equal(JSON.stringify(caught).includes("do-not-return"), false)
    assert.equal(lifecycleRequests(agent).length, 0)
    assert.equal(store.vms.size, 0)
    assert.equal(store.operations.size, 0)
  })

  test("createVm does not mark operation SUCCEEDED for old operation-accepted agent responses", async () => {
    const store = new FakeStore()
    const agent = new RecordingAgentClient()
    agent.nextBody = agentOperation("create", "vm-1", "operation-accepted")

    await assertRejects(
      createVm(store, admin, baseCreate, actionOptions(agent)),
      /malformed|not terminal|Agent lifecycle response is malformed/i
    )

    const vm = [...store.vms.values()].find((record) => record.name === "vm-1")
    assert.ok(vm)
    assert.equal(vm!.status, "FAILED")
    const createOp = [...store.operations.values()].find((operation) => operation.action === "CREATE")
    assert.ok(createOp)
    assert.equal(createOp!.status, "FAILED")
    assert.notEqual(createOp!.status, "SUCCEEDED")
    assert.ok(createOp!.errorSummary)
    assert.equal(
      store.auditEntries.some((entry) => entry.action === "vm.create" && entry.metadata?.status === "SUCCEEDED"),
      false
    )
  })

  test("createVm records safe upstream lifecycle failures without marking them malformed", async () => {
    const store = new FakeStore()
    const agent = new RecordingAgentClient()
    agent.nextStatus = 502
    agent.nextBody = null
    agent.nextError = "incus lifecycle create completed but instance is missing"

    let caught: unknown
    try {
      await createVm(store, admin, baseCreate, actionOptions(agent))
    } catch (error) {
      caught = error
    }

    assert.equal((caught as { code?: string }).code, "VM_AGENT_LIFECYCLE_FAILED")
    assert.match(caught instanceof Error ? caught.message : String(caught), /instance is missing/)
    assert.doesNotMatch(caught instanceof Error ? caught.message : String(caught), /malformed/i)

    const vm = [...store.vms.values()].find((record) => record.name === "vm-1")
    assert.ok(vm)
    assert.equal(vm!.status, "FAILED")
    const failedOp = [...store.operations.values()].find((operation) => operation.action === "CREATE")
    assert.ok(failedOp)
    assert.equal(failedOp!.status, "FAILED")
    assert.equal(
      failedOp!.errorSummary,
      "Agent lifecycle operation failed: incus lifecycle create completed but instance is missing"
    )
    assert.equal(store.auditEntries.length, 2)
    assert.equal(store.auditEntries[1].metadata?.status, "FAILED")
    assert.equal(JSON.stringify(store.auditEntries).includes("malformed"), false)
  })

  test("lifecycle actions use accepted Phase 3 agent paths and payloads", async () => {
    const store = new FakeStore()
    const agent = new RecordingAgentClient()
    agent.nextBody = agentOperation("create")
    const created = await createVm(store, admin, baseCreate, actionOptions(agent))
    const vmId = created.vm.id

    agent.nextBody = agentOperation("stop")
    await performVmAction(store, admin, { vmInstanceId: vmId, action: "STOP" }, actionOptions(agent))
    agent.nextBody = agentOperation("start")
    await performVmAction(store, admin, { vmInstanceId: vmId, action: "START" }, actionOptions(agent))
    agent.nextBody = agentOperation("restart")
    await performVmAction(store, admin, { vmInstanceId: vmId, action: "RESTART" }, actionOptions(agent))
    agent.nextBody = agentOperation("delete")
    await performVmAction(store, admin, { vmInstanceId: vmId, action: "DELETE" }, actionOptions(agent))

    const encodedName = encodeURIComponent("vm-1")
    assert.equal(imagePolicyRequests(agent).length, 1)
    const lifecycle = lifecycleRequests(agent)
    assert.equal(lifecycle.length, 5)
    assert.equal(lifecycle[0].path, "/agent/v1/lifecycle/instances/create")
    assert.equal(lifecycle[1].path, `/agent/v1/lifecycle/instances/${encodedName}/stop`)
    assert.equal(lifecycle[1].body, undefined)
    assert.equal(lifecycle[2].path, `/agent/v1/lifecycle/instances/${encodedName}/start`)
    assert.equal(lifecycle[2].body, undefined)
    assert.equal(lifecycle[3].path, `/agent/v1/lifecycle/instances/${encodedName}/restart`)
    assert.equal(lifecycle[3].body, undefined)
    assert.equal(lifecycle[4].path, `/agent/v1/lifecycle/instances/${encodedName}/delete`)
    assert.deepEqual(lifecycle[4].body, { confirm: true })
  })

  test("agent operation statuses are accepted without treating them as VM runtime statuses", async () => {
    const store = new FakeStore()
    const agent = new RecordingAgentClient()
    agent.nextBody = agentOperation("create", "vm-1", "sync-ok")
    const created = await createVm(store, admin, baseCreate, actionOptions(agent))

    assert.equal(created.vm.status, "PROVISIONING")
    assert.equal(created.operation.status, "SUCCEEDED")
    assert.match(created.operation.summary ?? "", /sync-ok/)
  })

  for (const scenario of [
    {
      name: "missing HostState",
      hostState: null,
      message: /host state is required/i,
    },
    {
      name: "stale HostState",
      hostState: readyHostState({ lastSeenAt: new Date("2026-06-23T23:44:59.999Z") }),
      message: /host state is stale/i,
    },
    {
      name: "offline HostState",
      hostState: readyHostState({ status: "OFFLINE" }),
      message: /host is not online/i,
    },
    {
      name: "Incus unavailable HostState",
      hostState: readyHostState({ incusAvailable: false }),
      message: /incus is unavailable/i,
    },
    {
      name: "vmLifecycle false HostState",
      hostState: readyHostState({ capabilityVmLifecycle: false }),
      message: /vm lifecycle capability/i,
    },
  ]) {
    test(`createVm denies ${scenario.name} before operation creation or agent call`, async () => {
      const store = new FakeStore()
      store.hostState = scenario.hostState
      const agent = new RecordingAgentClient()

      await assertRejects(createVm(store, admin, baseCreate, actionOptions(agent)), scenario.message)

      assert.equal(agent.requests.length, 0)
      assert.equal(store.vms.size, 0)
      assert.equal(store.operations.size, 0)
      assert.equal(store.auditEntries.length, 0)
    })
  }

  test("performVmAction denies stale HostState before operation creation or agent call", async () => {
    const store = new FakeStore()
    const vm = await store.createVmInstance({
      id: "vm-existing",
      name: "vm-1",
      endpointId: "endpoint-1",
      projectId: "project-1",
      tenantId: "tenant-1",
      networkPoolId: "pool-1",
      imageReference: "images/ubuntu/22.04",
      cpuCount: 1,
      memoryBytes: BigInt(268_435_456),
      rootDiskBytes: BigInt(5_368_709_120),
      addressFamily: "IPV4",
      status: "STOPPED",
    })
    store.hostState = readyHostState({ lastSeenAt: new Date("2026-06-23T23:44:59.999Z") })
    const agent = new RecordingAgentClient()

    await assertRejects(
      performVmAction(store, admin, { vmInstanceId: vm.id, action: "START" }, actionOptions(agent)),
      /host state is stale/i
    )

    assert.equal(agent.requests.length, 0)
    assert.equal(store.operations.size, 0)
    assert.equal(store.auditEntries.length, 0)
  })

  test("createVm denies a MEMBER principal without ever calling the agent", async () => {
    const store = new FakeStore()
    const agent = new RecordingAgentClient()
    await assertRejects(
      createVm(store, member, baseCreate, actionOptions(agent)),
      /permission denied/i
    )
    assert.equal(agent.requests.length, 0, "agent must not be called on a policy denial")
    assert.equal(store.vms.size, 0, "no VM record must be persisted on a policy denial")
    assert.equal(store.operations.size, 0, "no operation must be persisted on a policy denial")
    assert.equal(store.auditEntries.length, 0)
  })

  test("createVm denies when the project is archived without calling the agent", async () => {
    const store = new FakeStore()
    store.project = { id: "project-1", status: "ARCHIVED", ownerTenantId: "tenant-1" }
    const agent = new RecordingAgentClient()
    await assertRejects(
      createVm(store, admin, baseCreate, actionOptions(agent)),
      /denied|invalid/i
    )
    assert.equal(agent.requests.length, 0)
  })

  test("createVm denies when quota is exceeded without calling the agent", async () => {
    const store = new FakeStore()
    store.projectQuota = {
      maxVcpu: 1,
      maxMemoryBytes: null,
      maxDiskBytes: null,
      maxInstances: null,
    }
    store.vmUsage = {
      instanceCount: 1,
      totalVcpu: 1,
      totalMemoryBytes: 0,
      totalDiskBytes: 0,
    }
    const agent = new RecordingAgentClient()
    await assertRejects(
      createVm(store, admin, { ...baseCreate, cpuCount: 2 }, actionOptions(agent)),
      /denied|invalid/i
    )
    assert.equal(agent.requests.length, 0)
  })

  test("createVm denies when the network pool is unavailable without calling the agent", async () => {
    const store = new FakeStore()
    store.pool = { id: "pool-1", projectId: "other-project", status: "ACTIVE" }
    const agent = new RecordingAgentClient()
    await assertRejects(
      createVm(store, admin, baseCreate, actionOptions(agent)),
      /denied|invalid/i
    )
    assert.equal(agent.requests.length, 0)
  })

  test("createVm denies when the endpoint binding is inactive without calling the agent", async () => {
    const store = new FakeStore()
    store.binding = { endpointId: "endpoint-1", projectId: "project-1", status: "REMOVED" }
    const agent = new RecordingAgentClient()
    await assertRejects(
      createVm(store, admin, baseCreate, actionOptions(agent)),
      /denied|invalid/i
    )
    assert.equal(agent.requests.length, 0)
  })

  test("createVm with a duplicate name fails before any agent call", async () => {
    const store = new FakeStore()
    const agent = new RecordingAgentClient()
    agent.nextBody = agentOperation("create")
    await createVm(store, admin, baseCreate, actionOptions(agent))
    const agent2 = new RecordingAgentClient()
    await assertRejects(
      createVm(store, admin, baseCreate, actionOptions(agent2)),
      /already exists/i
    )
    assert.equal(agent2.requests.length, 0)
  })

  test("createVm records FAILED operation + audit when the agent is unavailable", async () => {
    const store = new FakeStore()
    const agent = new RecordingAgentClient()
    agent.nextThrow = new AgentConnectionError("socket refused")
    await assertRejects(
      createVm(store, admin, baseCreate, actionOptions(agent)),
      /unavailable/i
    )
    const failedOp = [...store.operations.values()].find((o) => o.action === "CREATE")
    assert.ok(failedOp)
    assert.equal(failedOp!.status, "FAILED")
    assert.ok(failedOp!.errorSummary!.length > 0)
    // Audit: QUEUED then FAILED.
    assert.equal(store.auditEntries.length, 2)
    assert.equal(store.auditEntries[1].metadata?.status, "FAILED")
    // No agent payload ever surfaces in audit metadata.
    const serialized = JSON.stringify(store.auditEntries)
    assert.equal(serialized.includes("/agent/v1/lifecycle/instances/create"), false)
    assert.equal(serialized.includes("socket refused"), false)
  })

  test("createVm records FAILED operation when the agent returns a malformed body", async () => {
    const store = new FakeStore()
    const agent = new RecordingAgentClient()
    agent.nextBody = { status: 123 } // non-string status -> malformed
    await assertRejects(
      createVm(store, admin, baseCreate, actionOptions(agent)),
      /malformed/i
    )
    const failedOp = [...store.operations.values()].find((o) => o.action === "CREATE")
    assert.equal(failedOp!.status, "FAILED")
  })

  test("performVmAction START transitions to RUNNING and audits vm.start", async () => {
    const store = new FakeStore()
    const agent = new RecordingAgentClient()
    agent.nextBody = agentOperation("create")
    const created = await createVm(store, admin, baseCreate, actionOptions(agent))
    const vmId = created.vm.id
    // Bring to STOPPED via stop, then start.
    agent.nextBody = agentOperation("stop")
    await performVmAction(store, admin, { vmInstanceId: vmId, action: "STOP" }, actionOptions(agent))
    agent.nextBody = agentOperation("start")
    const started = await performVmAction(
      store,
      admin,
      { vmInstanceId: vmId, action: "START" },
      actionOptions(agent)
    )
    assert.equal(started.vm.status, "RUNNING")
    assert.equal(started.operation.action, "START")
    assert.equal(started.operation.status, "SUCCEEDED")
    const startAudit = store.auditEntries.filter((e) => e.action === "vm.start")
    assert.ok(startAudit.length >= 2)
    assert.equal(startAudit[startAudit.length - 1].metadata?.status, "SUCCEEDED")
  })

  test("performVmAction RESTART on a STOPPED VM rejects with a status conflict", async () => {
    const store = new FakeStore()
    const agent = new RecordingAgentClient()
    agent.nextBody = agentOperation("create")
    const created = await createVm(store, admin, baseCreate, actionOptions(agent))
    store.vms.get(created.vm.id)!.status = "STOPPED"
    await assertRejects(
      performVmAction(
        store,
        admin,
        { vmInstanceId: created.vm.id, action: "RESTART" },
        actionOptions(agent)
      ),
      /running to restart|running/i
    )
  })

  test("performVmAction STOP on a STOPPED VM rejects with a status conflict", async () => {
    const store = new FakeStore()
    const agent = new RecordingAgentClient()
    agent.nextBody = agentOperation("create")
    const created = await createVm(store, admin, baseCreate, actionOptions(agent))
    store.vms.get(created.vm.id)!.status = "STOPPED"
    await assertRejects(
      performVmAction(
        store,
        admin,
        { vmInstanceId: created.vm.id, action: "STOP" },
        actionOptions(agent)
      ),
      /already stopped|running/i
    )
  })

  test("performVmAction DELETE soft-deletes and then START returns VM_NOT_FOUND", async () => {
    const store = new FakeStore()
    const agent = new RecordingAgentClient()
    agent.nextBody = agentOperation("create")
    const created = await createVm(store, admin, baseCreate, actionOptions(agent))
    const vmId = created.vm.id
    agent.nextBody = agentOperation("delete")
    const deleted = await performVmAction(
      store,
      admin,
      { vmInstanceId: vmId, action: "DELETE" },
      actionOptions(agent)
    )
    assert.equal(deleted.vm.status, "DELETED")
    assert.equal(deleted.operation.status, "SUCCEEDED")
    await assertRejects(
      performVmAction(store, admin, { vmInstanceId: vmId, action: "START" }, actionOptions(agent)),
      /not found/i
    )
  })

  test("performVmAction on a missing VM throws VM_NOT_FOUND before any agent call", async () => {
    const store = new FakeStore()
    const agent = new RecordingAgentClient()
    await assertRejects(
      performVmAction(
        store,
        admin,
        { vmInstanceId: "missing", action: "START" },
        actionOptions(agent)
      ),
      /not found/i
    )
    assert.equal(agent.requests.length, 0)
  })

  test("performVmAction on a deleted VM rejects START without calling the agent", async () => {
    const store = new FakeStore()
    const agent = new RecordingAgentClient()
    agent.nextBody = agentOperation("create")
    const created = await createVm(store, admin, baseCreate, actionOptions(agent))
    store.vms.get(created.vm.id)!.status = "DELETED"
    await assertRejects(
      performVmAction(
        store,
        admin,
        { vmInstanceId: created.vm.id, action: "START" },
        actionOptions(new RecordingAgentClient())
      ),
      /not found/i
    )
  })

  test("performVmAction rejects a new action while a RUNNING operation is inflight and never calls the agent", async () => {
    const store = new FakeStore()
    const agent = new RecordingAgentClient()
    agent.nextBody = agentOperation("create")
    const created = await createVm(store, admin, baseCreate, actionOptions(agent))
    const vmId = created.vm.id
    // Seed an inflight RUNNING operation so the inflight probe sees it.
    await store.createOperation({
      vmInstanceId: vmId,
      action: "STOP",
      status: "RUNNING",
      requestedByUserId: admin.id,
    })
    const secondAgent = new RecordingAgentClient()
    await assertRejects(
      performVmAction(
        store,
        admin,
        { vmInstanceId: vmId, action: "START" },
        actionOptions(secondAgent)
      ),
      /operation is already running|conflict/i
    )
    assert.equal(secondAgent.requests.length, 0, "agent must not be called while an operation is inflight")
  })

  test("performVmAction rejects a new action while a QUEUED operation is inflight", async () => {
    const store = new FakeStore()
    const agent = new RecordingAgentClient()
    agent.nextBody = agentOperation("create")
    const created = await createVm(store, admin, baseCreate, actionOptions(agent))
    const vmId = created.vm.id
    store.vms.get(vmId)!.status = "STOPPED"
    await store.createOperation({
      vmInstanceId: vmId,
      action: "START",
      status: "QUEUED",
      requestedByUserId: admin.id,
    })
    const secondAgent = new RecordingAgentClient()
    // START is state-compatible with STOPPED, so the inflight probe is the
    // only guard that fires here.
    await assertRejects(
      performVmAction(
        store,
        admin,
        { vmInstanceId: vmId, action: "START" },
        actionOptions(secondAgent)
      ),
      /operation is already running|conflict/i
    )
    assert.equal(secondAgent.requests.length, 0)
  })

  test("performVmAction DELETE keeps the VM visible and quota-counted when the agent is unavailable", async () => {
    const store = new FakeStore()
    const agent = new RecordingAgentClient()
    agent.nextBody = agentOperation("create")
    const created = await createVm(store, admin, baseCreate, actionOptions(agent))
    const vmId = created.vm.id
    const originalStatus = store.vms.get(vmId)!.status
    agent.nextThrow = new AgentTimeoutError("slow agent")
    await assertRejects(
      performVmAction(store, admin, { vmInstanceId: vmId, action: "DELETE" }, actionOptions(agent)),
      /unavailable/i
    )
    assert.equal(store.vms.get(vmId)!.status, "FAILED")
    assert.notEqual(store.vms.get(vmId)!.status, "DELETED")
    assert.notEqual(store.vms.get(vmId)!.status, originalStatus)

    const listed = await listVms(store, admin)
    assert.equal(listed.some((vm) => vm.id === vmId && vm.status === "FAILED"), true)
    assert.deepEqual(await store.raceCreateVm({ endpointId: "endpoint-1", name: baseCreate.name }), {
      conflict: true,
    })
    assert.deepEqual(await store.getVmUsage(), {
      instanceCount: 1,
      totalVcpu: baseCreate.cpuCount,
      totalMemoryBytes: baseCreate.memoryBytes,
      totalDiskBytes: baseCreate.rootDiskBytes,
    })
    store.projectQuota = {
      maxVcpu: null,
      maxMemoryBytes: null,
      maxDiskBytes: null,
      maxInstances: 1,
    }
    const agentRequestCountAfterFailedDelete = agent.requests.length
    await assertRejects(
      createVm(
        store,
        admin,
        { ...baseCreate, name: "vm-after-failed-delete" },
        actionOptions(agent)
      ),
      /denied|invalid/i
    )
    assert.equal(agent.requests.length, agentRequestCountAfterFailedDelete)
    const delOp = [...store.operations.values()].find(
      (o) => o.action === "DELETE" && o.vmInstanceId === vmId
    )
    assert.equal(delOp!.status, "FAILED")
    assert.ok(delOp!.errorSummary)
    // Failed audit still recorded, and never carries agent payload.
    const serialized = JSON.stringify(store.auditEntries)
    assert.equal(serialized.includes("slow agent"), false)
    const failedDeleteAudit = store.auditEntries.find(
      (entry) => entry.action === "vm.delete" && entry.metadata?.status === "FAILED"
    )
    assert.ok(failedDeleteAudit)
  })

  test("performVmAction rejects a MEMBER principal without an agent call", async () => {
    const store = new FakeStore()
    const agent = new RecordingAgentClient()
    agent.nextBody = agentOperation("create")
    const created = await createVm(store, admin, baseCreate, actionOptions(agent))
    await assertRejects(
      performVmAction(
        store,
        member,
        { vmInstanceId: created.vm.id, action: "START" },
        actionOptions(agent)
      ),
      /permission denied/i
    )
    assert.equal(lifecycleRequests(agent).length, 1, "only the create lifecycle call should have occurred")
  })

  test("listVms / getVm / listVmOperations deny MEMBERS read access", async () => {
    const store = new FakeStore()
    const agent = new RecordingAgentClient()
    agent.nextBody = agentOperation("create")
    await createVm(store, admin, baseCreate, actionOptions(agent))

    await assertRejects(listVms(store, member), /permission denied|authentication/i)
    await assertRejects(listVmOperations(store, member), /permission denied|authentication/i)
  })

  test("audit metadata redacts hostile agent-response fields while preserving action identity", async () => {
    const store = new FakeStore()
    const agent = new RecordingAgentClient()
    agent.nextBody = {
      ...agentOperation("create"),
      vmConfig: "vm-config-that-must-not-leak",
      userData: "password: must-not-leak",
      agentPayload: "agent-payload-that-must-not-leak",
      incusResponse: "incus-response-that-must-not-leak",
      sshPrivateKey: "ssh-private-key-that-must-not-leak",
    }
    await createVm(store, admin, baseCreate, actionOptions(agent))
    const serialized = JSON.stringify(store.auditEntries)
    assert.equal(serialized.includes("must-not-leak"), false)
    assert.equal(store.auditEntries[1].metadata?.action, "CREATE")
    assert.equal(store.auditEntries[1].metadata?.status, "SUCCEEDED")
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

async function assertRejects(promise: Promise<unknown>, messageRegex: RegExp): Promise<void> {
  try {
    await promise
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    assert.ok(messageRegex.test(message), `expected error message to match ${messageRegex}, got: ${message}`)
    return
  }
  assert.fail("expected promise to reject")
}
