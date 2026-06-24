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
    const all = [...this.operations.values()]
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

  async recordAudit(entry: AdminAuditEntry): Promise<void> {
    this.auditEntries.push(entry)
  }
}

class RecordingAgentClient implements VmLifecycleAgentClient {
  requests: AgentRequest[] = []
  nextBody: unknown = { status: "RUNNING" }
  nextThrow?: Error
  async execute(request: AgentRequest): Promise<AgentResponse> {
    this.requests.push(request)
    if (this.nextThrow) {
      const err = this.nextThrow
      this.nextThrow = undefined
      throw err
    }
    return { id: "resp", status: 200, body: this.nextBody }
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("vmLifecycle service", () => {
  test("createVm invokes the agent ONLY after backend policy passes", async () => {
    const store = new FakeStore()
    const agent = new RecordingAgentClient()
    agent.nextBody = { status: "PROVISIONING", summary: "ack" }
    const result = await createVm(store, admin, baseCreate, actionOptions(agent))

    assert.equal(result.vm.status, "PROVISIONING")
    assert.equal(result.operation.action, "CREATE")
    assert.equal(result.operation.status, "SUCCEEDED")
    assert.equal(agent.requests.length, 1)
    assert.equal(agent.requests[0].path, "/agent/v1/vm/lifecycle")
    // Two audit entries: QUEUED then SUCCEEDED.
    assert.equal(store.auditEntries.length, 2)
    assert.equal(store.auditEntries[0].metadata?.status, "QUEUED")
    assert.equal(store.auditEntries[1].metadata?.status, "SUCCEEDED")
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
    agent.nextBody = { status: "PROVISIONING" }
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
    assert.equal(serialized.includes("/agent/v1/vm/lifecycle"), false)
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
    agent.nextBody = { status: "PROVISIONING" }
    const created = await createVm(store, admin, baseCreate, actionOptions(agent))
    const vmId = created.vm.id
    // Bring to STOPPED via stop, then start.
    agent.nextBody = { status: "STOPPED" }
    await performVmAction(store, admin, { vmInstanceId: vmId, action: "STOP" }, actionOptions(agent))
    agent.nextBody = { status: "RUNNING" }
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
    agent.nextBody = { status: "PROVISIONING" }
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
    agent.nextBody = { status: "PROVISIONING" }
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
    agent.nextBody = { status: "PROVISIONING" }
    const created = await createVm(store, admin, baseCreate, actionOptions(agent))
    const vmId = created.vm.id
    agent.nextBody = { status: "DELETED", summary: "agent gc" }
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
    agent.nextBody = { status: "PROVISIONING" }
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

  test("performVmAction DELETE records FAILED op but still soft-deletes when the agent is unavailable", async () => {
    const store = new FakeStore()
    const agent = new RecordingAgentClient()
    agent.nextBody = { status: "PROVISIONING" }
    const created = await createVm(store, admin, baseCreate, actionOptions(agent))
    const vmId = created.vm.id
    agent.nextThrow = new AgentTimeoutError("slow agent")
    await assertRejects(
      performVmAction(store, admin, { vmInstanceId: vmId, action: "DELETE" }, actionOptions(agent)),
      /unavailable/i
    )
    assert.equal(store.vms.get(vmId)!.status, "DELETED")
    const delOp = [...store.operations.values()].find(
      (o) => o.action === "DELETE" && o.vmInstanceId === vmId
    )
    assert.equal(delOp!.status, "FAILED")
    // Failed audit still recorded, and never carries agent payload.
    const serialized = JSON.stringify(store.auditEntries)
    assert.equal(serialized.includes("slow agent"), false)
  })

  test("performVmAction rejects a MEMBER principal without an agent call", async () => {
    const store = new FakeStore()
    const agent = new RecordingAgentClient()
    agent.nextBody = { status: "PROVISIONING" }
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
    assert.equal(agent.requests.length, 1, "only the create agent call should have occurred")
  })

  test("listVms / getVm / listVmOperations deny MEMBERS read access", async () => {
    const store = new FakeStore()
    const agent = new RecordingAgentClient()
    agent.nextBody = { status: "PROVISIONING" }
    await createVm(store, admin, baseCreate, actionOptions(agent))

    await assertRejects(listVms(store, member), /permission denied|authentication/i)
    await assertRejects(listVmOperations(store, member), /permission denied|authentication/i)
  })

  test("audit metadata redacts hostile agent-response fields while preserving action identity", async () => {
    const store = new FakeStore()
    const agent = new RecordingAgentClient()
    agent.nextBody = {
      status: "PROVISIONING",
      summary: "ack",
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