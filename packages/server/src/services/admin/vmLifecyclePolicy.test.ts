import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  evaluateVmActionPolicy,
  evaluateVmCreatePolicy,
  isValidVmLimits,
  type AdminPrincipal,
  type PolicyEndpoint,
  type PolicyEndpointProjectBinding,
  type PolicyProject,
  type PolicyProjectNetworkPool,
  type PolicyProjectTenant,
  type PolicyQuota,
  type PolicyVmInstance,
  type PolicyVmUsage,
  type VmLifecyclePolicyStore,
} from "./vmLifecyclePolicy"
import type { VmInstanceStatus, VmLifecycleAction } from "./vmLifecycleModels"

const adminPrincipal: AdminPrincipal = {
  id: "admin-1",
  email: "admin@example.com",
  name: "Admin User",
  status: "ACTIVE",
  globalRole: "ADMIN",
  teams: [],
}

const memberPrincipal: AdminPrincipal = {
  id: "member-1",
  email: "member@example.com",
  name: "Member User",
  status: "ACTIVE",
  globalRole: "MEMBER",
  teams: [],
}

const baseCreateInput = {
  principal: adminPrincipal,
  endpointId: "endpoint-1",
  projectId: "project-1",
  tenantId: "tenant-1",
  networkPoolId: "pool-1",
  cpuCount: 1,
  memoryBytes: 268_435_456,
  rootDiskBytes: 5_368_709_120,
  addressFamily: "IPV4" as const,
}

const baseActionInput = {
  principal: adminPrincipal,
  action: "START" as VmLifecycleAction,
  vmInstanceId: "vm-1",
  projectId: "project-1",
  tenantId: "tenant-1",
  endpointId: "endpoint-1",
}

function makeStore(overrides: Partial<VmLifecyclePolicyStore> = {}): VmLifecyclePolicyStore {
  const project: PolicyProject = { id: "project-1", status: "ACTIVE", ownerTenantId: "tenant-1" }
  const participation: PolicyProjectTenant = {
    projectId: "project-1",
    tenantId: "tenant-1",
    status: "ACTIVE",
  }
  const endpoint: PolicyEndpoint = { id: "endpoint-1", status: "ACTIVE" }
  const binding: PolicyEndpointProjectBinding = {
    endpointId: "endpoint-1",
    projectId: "project-1",
    status: "ACTIVE",
  }
  const pool: PolicyProjectNetworkPool = {
    id: "pool-1",
    projectId: "project-1",
    status: "ACTIVE",
  }
  const vm: PolicyVmInstance = {
    id: "vm-1",
    endpointId: "endpoint-1",
    projectId: "project-1",
    tenantId: "tenant-1",
    status: "STOPPED",
  }
  const usage: PolicyVmUsage = {
    instanceCount: 0,
    totalVcpu: 0,
    totalMemoryBytes: 0,
    totalDiskBytes: 0,
  }

  return {
    async getProject() {
      return project
    },
    async getProjectTenant() {
      return participation
    },
    async getEndpoint() {
      return endpoint
    },
    async getEndpointProjectBinding() {
      return binding
    },
    async getProjectNetworkPool() {
      return pool
    },
    async getProjectQuota(): Promise<PolicyQuota | null> {
      return null
    },
    async getProjectTenantQuota(): Promise<PolicyQuota | null> {
      return null
    },
    async getVmUsage(): Promise<PolicyVmUsage> {
      return usage
    },
    async getVmInstance() {
      return vm
    },
    ...overrides,
  }
}

describe("evaluateVmCreatePolicy", () => {
  test("allows a create within project and tenant quota/allocation with bound endpoint and active pool", async () => {
    const decision = await evaluateVmCreatePolicy(makeStore(), baseCreateInput)
    assert.deepEqual(decision, { allowed: true })
  })

  test("denies UNAUTHENTICATED when no principal is supplied", async () => {
    const decision = await evaluateVmCreatePolicy(makeStore(), {
      ...baseCreateInput,
      principal: null,
    })
    assert.deepEqual(decision, { allowed: false, reason: "UNAUTHENTICATED" })
  })

  test("denies UNAUTHENTICATED when the principal is disabled", async () => {
    const decision = await evaluateVmCreatePolicy(makeStore(), {
      ...baseCreateInput,
      principal: { ...adminPrincipal, status: "DISABLED" },
    })
    assert.deepEqual(decision, { allowed: false, reason: "UNAUTHENTICATED" })
  })

  test("denies FORBIDDEN when the principal lacks vm:create", async () => {
    const decision = await evaluateVmCreatePolicy(makeStore(), {
      ...baseCreateInput,
      principal: memberPrincipal,
    })
    assert.deepEqual(decision, { allowed: false, reason: "FORBIDDEN" })
  })

  test("denies INVALID_LIMITS for non-positive or oversized limits before any read", async () => {
    let reads = 0
    const store = makeStore({
      async getProject() {
        reads += 1
        return { id: "project-1", status: "ACTIVE", ownerTenantId: "tenant-1" }
      },
    })

    const zeroMemory = await evaluateVmCreatePolicy(store, {
      ...baseCreateInput,
      memoryBytes: 0,
    })
    assert.deepEqual(zeroMemory, { allowed: false, reason: "INVALID_LIMITS" })

    const negativeCpu = await evaluateVmCreatePolicy(store, {
      ...baseCreateInput,
      cpuCount: -1,
    })
    assert.deepEqual(negativeCpu, { allowed: false, reason: "INVALID_LIMITS" })

    const oversizedDisk = await evaluateVmCreatePolicy(store, {
      ...baseCreateInput,
      rootDiskBytes: 99_007_199_254_740_991,
    })
    assert.deepEqual(oversizedDisk, { allowed: false, reason: "INVALID_LIMITS" })

    assert.equal(reads, 0, "INVALID_LIMITS must short-circuit before store reads")
  })

  test("denies PROJECT_NOT_FOUND when the project is missing or archived", async () => {
    const missing = await evaluateVmCreatePolicy(
      makeStore({ async getProject() {
        return null
      } }),
      baseCreateInput
    )
    assert.deepEqual(missing, { allowed: false, reason: "PROJECT_NOT_FOUND" })

    const archived = await evaluateVmCreatePolicy(
      makeStore({
        async getProject() {
          return { id: "project-1", status: "ARCHIVED", ownerTenantId: "tenant-1" }
        },
      }),
      baseCreateInput
    )
    assert.deepEqual(archived, { allowed: false, reason: "PROJECT_NOT_FOUND" })
  })

  test("denies TENANT_NOT_IN_PROJECT when the tenant is missing or removed", async () => {
    const missing = await evaluateVmCreatePolicy(
      makeStore({ async getProjectTenant() {
        return null
      } }),
      baseCreateInput
    )
    assert.deepEqual(missing, { allowed: false, reason: "TENANT_NOT_IN_PROJECT" })

    const removed = await evaluateVmCreatePolicy(
      makeStore({
        async getProjectTenant() {
          return { projectId: "project-1", tenantId: "tenant-1", status: "REMOVED" }
        },
      }),
      baseCreateInput
    )
    assert.deepEqual(removed, { allowed: false, reason: "TENANT_NOT_IN_PROJECT" })
  })

  test("denies ENDPOINT_NOT_BOUND when endpoint is archived or binding is missing/inactive", async () => {
    const archivedEndpoint = await evaluateVmCreatePolicy(
      makeStore({
        async getEndpoint() {
          return { id: "endpoint-1", status: "ARCHIVED" }
        },
      }),
      baseCreateInput
    )
    assert.deepEqual(archivedEndpoint, { allowed: false, reason: "ENDPOINT_NOT_BOUND" })

    const missingBinding = await evaluateVmCreatePolicy(
      makeStore({ async getEndpointProjectBinding() {
        return null
      } }),
      baseCreateInput
    )
    assert.deepEqual(missingBinding, { allowed: false, reason: "ENDPOINT_NOT_BOUND" })

    const removedBinding = await evaluateVmCreatePolicy(
      makeStore({
        async getEndpointProjectBinding() {
          return { endpointId: "endpoint-1", projectId: "project-1", status: "REMOVED" }
        },
      }),
      baseCreateInput
    )
    assert.deepEqual(removedBinding, { allowed: false, reason: "ENDPOINT_NOT_BOUND" })
  })

  test("denies NETWORK_POOL_UNAVAILABLE when pool is missing, archived, or belongs to another project", async () => {
    const missingPoolId = await evaluateVmCreatePolicy(makeStore(), {
      ...baseCreateInput,
      networkPoolId: null,
    })
    assert.deepEqual(missingPoolId, { allowed: false, reason: "NETWORK_POOL_UNAVAILABLE" })

    const missing = await evaluateVmCreatePolicy(
      makeStore({ async getProjectNetworkPool() {
        return null
      } }),
      baseCreateInput
    )
    assert.deepEqual(missing, { allowed: false, reason: "NETWORK_POOL_UNAVAILABLE" })

    const archived = await evaluateVmCreatePolicy(
      makeStore({
        async getProjectNetworkPool() {
          return { id: "pool-1", projectId: "project-1", status: "ARCHIVED" }
        },
      }),
      baseCreateInput
    )
    assert.deepEqual(archived, { allowed: false, reason: "NETWORK_POOL_UNAVAILABLE" })

    const otherProject = await evaluateVmCreatePolicy(
      makeStore({
        async getProjectNetworkPool() {
          return { id: "pool-1", projectId: "project-other", status: "ACTIVE" }
        },
      }),
      baseCreateInput
    )
    assert.deepEqual(otherProject, { allowed: false, reason: "NETWORK_POOL_UNAVAILABLE" })
  })

  test("denies QUOTA_EXCEEDED when the create would exceed the project quota", async () => {
    const store = makeStore({
      async getProjectQuota(): Promise<PolicyQuota | null> {
        return { maxVcpu: 2, maxMemoryBytes: null, maxDiskBytes: null, maxInstances: null }
      },
      async getVmUsage(): Promise<PolicyVmUsage> {
        return { instanceCount: 0, totalVcpu: 2, totalMemoryBytes: 0, totalDiskBytes: 0 }
      },
    })
    const decision = await evaluateVmCreatePolicy(store, {
      ...baseCreateInput,
      cpuCount: 1,
    })
    assert.deepEqual(decision, { allowed: false, reason: "QUOTA_EXCEEDED" })
  })

  test("denies QUOTA_EXCEEDED when the create would exceed the project maxInstances", async () => {
    const store = makeStore({
      async getProjectQuota(): Promise<PolicyQuota | null> {
        return { maxVcpu: null, maxMemoryBytes: null, maxDiskBytes: null, maxInstances: 1 }
      },
      async getVmUsage(projectId: string): Promise<PolicyVmUsage> {
        // project-level usage hits the instance ceiling; tenant-level must not run.
        if (projectId === "project-1") {
          return { instanceCount: 1, totalVcpu: 0, totalMemoryBytes: 0, totalDiskBytes: 0 }
        }
        return { instanceCount: 0, totalVcpu: 0, totalMemoryBytes: 0, totalDiskBytes: 0 }
      },
    })
    const decision = await evaluateVmCreatePolicy(store, baseCreateInput)
    assert.deepEqual(decision, { allowed: false, reason: "QUOTA_EXCEEDED" })
  })

  test("denies TENANT_ALLOCATION_EXCEEDED when the create would exceed the tenant allocation but not the project quota", async () => {
    const store = makeStore({
      async getProjectQuota(): Promise<PolicyQuota | null> {
        return { maxVcpu: 10, maxMemoryBytes: null, maxDiskBytes: null, maxInstances: null }
      },
      async getProjectTenantQuota(): Promise<PolicyQuota | null> {
        return { maxVcpu: 1, maxMemoryBytes: null, maxDiskBytes: null, maxInstances: null }
      },
      async getVmUsage(projectId: string, tenantId?: string): Promise<PolicyVmUsage> {
        if (tenantId === "tenant-1") {
          return { instanceCount: 0, totalVcpu: 1, totalMemoryBytes: 0, totalDiskBytes: 0 }
        }
        return { instanceCount: 0, totalVcpu: 1, totalMemoryBytes: 0, totalDiskBytes: 0 }
      },
    })
    const decision = await evaluateVmCreatePolicy(store, baseCreateInput)
    assert.deepEqual(decision, { allowed: false, reason: "TENANT_ALLOCATION_EXCEEDED" })
  })

  test("allows create when quotas are null (unbounded) and the request is otherwise valid", async () => {
    const decision = await evaluateVmCreatePolicy(makeStore(), baseCreateInput)
    assert.deepEqual(decision, { allowed: true })
  })

  test("evaluates checks in dependency order: FORBIDDEN precedes INVALID_LIMITS", async () => {
    let reads = 0
    const store = makeStore({
      async getProject() {
        reads += 1
        return { id: "project-1", status: "ACTIVE", ownerTenantId: "tenant-1" }
      },
    })
    const decision = await evaluateVmCreatePolicy(store, {
      ...baseCreateInput,
      principal: memberPrincipal,
      cpuCount: -1,
    })
    assert.deepEqual(decision, { allowed: false, reason: "FORBIDDEN" })
    assert.equal(reads, 0, "FORBIDDEN must short-circuit before limit validation reads")
  })
})

describe("evaluateVmActionPolicy", () => {
  test("allows an action against an owned, non-deleted VM", async () => {
    const decision = await evaluateVmActionPolicy(makeStore(), baseActionInput)
    assert.deepEqual(decision, { allowed: true })
  })

  test("maps each action to its vm:* permission and denies FORBIDDEN for members", async () => {
    for (const action of ["START", "STOP", "RESTART", "DELETE"] as VmLifecycleAction[]) {
      const decision = await evaluateVmActionPolicy(makeStore(), {
        ...baseActionInput,
        action,
        principal: memberPrincipal,
      })
      assert.deepEqual(decision, { allowed: false, reason: "FORBIDDEN" })
    }
  })

  test("denies UNAUTHENTICATED when no principal is supplied", async () => {
    const decision = await evaluateVmActionPolicy(makeStore(), {
      ...baseActionInput,
      principal: null,
    })
    assert.deepEqual(decision, { allowed: false, reason: "UNAUTHENTICATED" })
  })

  test("denies VM_NOT_FOUND when the VM does not exist or does not match tenant/project/endpoint", async () => {
    const missing = await evaluateVmActionPolicy(
      makeStore({ async getVmInstance() {
        return null
      } }),
      baseActionInput
    )
    assert.deepEqual(missing, { allowed: false, reason: "VM_NOT_FOUND" })

    const wrongTenant = await evaluateVmActionPolicy(
      makeStore({
        async getVmInstance() {
          return {
            id: "vm-1",
            endpointId: "endpoint-1",
            projectId: "project-1",
            tenantId: "tenant-other",
            status: "STOPPED",
          }
        },
      }),
      baseActionInput
    )
    assert.deepEqual(wrongTenant, { allowed: false, reason: "VM_NOT_FOUND" })

    const wrongProject = await evaluateVmActionPolicy(
      makeStore({
        async getVmInstance() {
          return {
            id: "vm-1",
            endpointId: "endpoint-1",
            projectId: "project-other",
            tenantId: "tenant-1",
            status: "STOPPED",
          }
        },
      }),
      baseActionInput
    )
    assert.deepEqual(wrongProject, { allowed: false, reason: "VM_NOT_FOUND" })
  })

  test("denies VM_NOT_FOUND for non-delete actions against a deleted VM", async () => {
    const start = await evaluateVmActionPolicy(
      makeStore({
        async getVmInstance() {
          return {
            id: "vm-1",
            endpointId: "endpoint-1",
            projectId: "project-1",
            tenantId: "tenant-1",
            status: "DELETED" as VmInstanceStatus,
          }
        },
      }),
      { ...baseActionInput, action: "START" }
    )
    assert.deepEqual(start, { allowed: false, reason: "VM_NOT_FOUND" })
  })

  test("denies PROJECT_NOT_FOUND, TENANT_NOT_IN_PROJECT, and ENDPOINT_NOT_BOUND using the shared guards", async () => {
    const projectNotFound = await evaluateVmActionPolicy(
      makeStore({ async getProject() {
        return null
      } }),
      baseActionInput
    )
    assert.deepEqual(projectNotFound, { allowed: false, reason: "PROJECT_NOT_FOUND" })

    const tenantNotInProject = await evaluateVmActionPolicy(
      makeStore({ async getProjectTenant() {
        return null
      } }),
      baseActionInput
    )
    assert.deepEqual(tenantNotInProject, { allowed: false, reason: "TENANT_NOT_IN_PROJECT" })

    const endpointNotBound = await evaluateVmActionPolicy(
      makeStore({ async getEndpointProjectBinding() {
        return null
      } }),
      baseActionInput
    )
    assert.deepEqual(endpointNotBound, { allowed: false, reason: "ENDPOINT_NOT_BOUND" })
  })
})

describe("isValidVmLimits", () => {
  test("accepts positive safe integers within bounds", () => {
    assert.equal(
      isValidVmLimits({ cpuCount: 1, memoryBytes: 268_435_456, rootDiskBytes: 5_368_709_120 }),
      true
    )
  })

  test("rejects zero, negative, non-integer, and oversized values", () => {
    assert.equal(
      isValidVmLimits({ cpuCount: 0, memoryBytes: 1, rootDiskBytes: 1 }),
      false
    )
    assert.equal(
      isValidVmLimits({ cpuCount: -1, memoryBytes: 1, rootDiskBytes: 1 }),
      false
    )
    assert.equal(
      isValidVmLimits({ cpuCount: 1.5, memoryBytes: 1, rootDiskBytes: 1 }),
      false
    )
    assert.equal(
      isValidVmLimits({ cpuCount: 1, memoryBytes: 0, rootDiskBytes: 1 }),
      false
    )
    assert.equal(
      isValidVmLimits({ cpuCount: 1, memoryBytes: 1, rootDiskBytes: 99_007_199_254_740_991 }),
      false
    )
  })
})