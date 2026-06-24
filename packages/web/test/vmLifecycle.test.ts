import assert from "node:assert/strict"
import { afterEach, describe, test } from "node:test"
import {
  ApiRequestError,
  createAdminVm,
  deleteAdminVm,
  fetchAdminVm,
  fetchAdminVmOperations,
  fetchAdminVms,
  performVmAction,
  fetchAdminProjects,
  fetchAdminTenants,
  fetchAdminEndpoints,
  fetchAdminProjectNetworkPools,
} from "../src/lib/api.ts"

type FetchCall = {
  input: string | URL | Request
  init?: RequestInit
}

const originalFetch = globalThis.fetch
const fetchCalls: FetchCall[] = []

function installJsonFetch(status: number, body: unknown) {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ input, init })
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      })
    )
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = originalFetch
  fetchCalls.length = 0
})

describe("VM lifecycle API helpers (M13)", () => {
  const browserVm = {
    id: "vm-1",
    name: "test-vm",
    endpointId: "endpoint-1",
    projectId: "project-1",
    tenantId: "tenant-1",
    imageReference: "ubuntu/24.04",
    status: "STOPPED",
    limits: { cpu: 1, memoryBytes: 268435456, rootDiskBytes: 5368709120 },
    network: { poolId: "pool-1", addressFamily: "IPV4" },
    createdAt: "2026-06-24T00:00:00.000Z",
    updatedAt: "2026-06-24T00:00:00.000Z",
  }

  const browserOp = {
    id: "op-1",
    vmInstanceId: "vm-1",
    action: "CREATE",
    status: "SUCCEEDED",
    requestedByUserId: "admin-1",
    summary: "VM provisioned",
    errorSummary: null,
    createdAt: "2026-06-24T00:00:00.000Z",
    updatedAt: "2026-06-24T00:00:00.000Z",
  }

  test("fetchAdminVms lists VMs from /api/admin/vms", async () => {
    installJsonFetch(200, { vms: [browserVm] })
    const vms = await fetchAdminVms()
    assert.equal(fetchCalls[0]?.input, "/api/admin/vms")
    assert.equal(fetchCalls[0]?.init?.credentials, "include")
    assert.equal(vms[0]?.name, "test-vm")
    assert.equal(vms[0]?.limits.cpu, 1)
  })

  test("fetchAdminVms passes query parameters", async () => {
    installJsonFetch(200, { vms: [browserVm] })
    const vms = await fetchAdminVms({ projectId: "project-1", status: "STOPPED" })
    const url = String(fetchCalls[0]?.input)
    assert.match(url, /projectId=project-1/)
    assert.match(url, /status=STOPPED/)
    assert.equal(vms.length, 1)
  })

  test("fetchAdminVm fetches a single VM from /api/admin/vms/:vmId", async () => {
    installJsonFetch(200, { vm: browserVm })
    const vm = await fetchAdminVm("vm-1")
    assert.equal(fetchCalls[0]?.input, "/api/admin/vms/vm-1")
    assert.equal(vm.id, "vm-1")
    assert.equal(vm.network.addressFamily, "IPV4")
  })

  test("createAdminVm posts to /api/admin/vms with body and returns create result", async () => {
    const createResult = { vm: browserVm, operation: browserOp }
    installJsonFetch(201, createResult)

    const result = await createAdminVm({
      name: "test-vm",
      endpointId: "endpoint-1",
      projectId: "project-1",
      tenantId: "tenant-1",
      networkPoolId: "pool-1",
      imageReference: "ubuntu/24.04",
      cpuCount: 1,
      memoryBytes: 268435456,
      rootDiskBytes: 5368709120,
      addressFamily: "IPV4",
    })

    assert.equal(fetchCalls[0]?.input, "/api/admin/vms")
    assert.equal(fetchCalls[0]?.init?.method, "POST")
    assert.equal(fetchCalls[0]?.init?.credentials, "include")
    assert.deepEqual(JSON.parse(String(fetchCalls[0]?.init?.body)), {
      name: "test-vm",
      endpointId: "endpoint-1",
      projectId: "project-1",
      tenantId: "tenant-1",
      networkPoolId: "pool-1",
      imageReference: "ubuntu/24.04",
      cpuCount: 1,
      memoryBytes: 268435456,
      rootDiskBytes: 5368709120,
      addressFamily: "IPV4",
    })
    assert.equal(result.vm.name, "test-vm")
    assert.equal(result.operation.action, "CREATE")
  })

  test("createAdminVm without optional fields uses defaults", async () => {
    const createResult = { vm: browserVm, operation: browserOp }
    installJsonFetch(201, createResult)

    await createAdminVm({
      name: "test-vm",
      endpointId: "endpoint-1",
      projectId: "project-1",
      tenantId: "tenant-1",
      networkPoolId: null,
      imageReference: "ubuntu/24.04",
      cpuCount: 2,
      memoryBytes: 536870912,
      rootDiskBytes: 10737418240,
    })

    const body = JSON.parse(String(fetchCalls[0]?.init?.body))
    assert.equal(body.networkPoolId, null)
    assert.equal(body.addressFamily, undefined) // not sent when omitted
  })

  test("performVmAction posts to /api/admin/vms/:vmId/:action for start/stop/restart", async () => {
    const actionResult = {
      vm: browserVm,
      operation: { ...browserOp, action: "START", id: "op-2" },
    }
    installJsonFetch(200, actionResult)

    const result = await performVmAction("vm-1", "START")
    assert.equal(fetchCalls[0]?.input, "/api/admin/vms/vm-1/start")
    assert.equal(fetchCalls[0]?.init?.method, "POST")
    assert.equal(result.operation.action, "START")

    installJsonFetch(200, actionResult)
    await performVmAction("vm-1", "STOP")
    assert.equal(fetchCalls[1]?.input, "/api/admin/vms/vm-1/stop")

    installJsonFetch(200, actionResult)
    await performVmAction("vm-1", "RESTART")
    assert.equal(fetchCalls[2]?.input, "/api/admin/vms/vm-1/restart")
  })

  test("deleteAdminVm sends DELETE to /api/admin/vms/:vmId", async () => {
    const deleteResult = {
      vm: { ...browserVm, status: "DELETED" },
      operation: { ...browserOp, action: "DELETE", id: "op-3" },
    }
    installJsonFetch(200, deleteResult)

    const result = await deleteAdminVm("vm-1")
    assert.equal(fetchCalls[0]?.input, "/api/admin/vms/vm-1")
    assert.equal(fetchCalls[0]?.init?.method, "DELETE")
    assert.equal(result.vm.status, "DELETED")
  })

  test("fetchAdminVmOperations fetches from /api/admin/vm-operations", async () => {
    installJsonFetch(200, { operations: [browserOp], total: 1 })
    const result = await fetchAdminVmOperations()
    assert.equal(fetchCalls[0]?.input, "/api/admin/vm-operations")
    assert.equal(result.operations[0]?.action, "CREATE")
    assert.equal(result.total, 1)
  })

  test("fetchAdminVmOperations passes vmInstanceId filter", async () => {
    installJsonFetch(200, { operations: [browserOp], total: 1 })
    await fetchAdminVmOperations("vm-1")
    assert.match(String(fetchCalls[0]?.input), /vmInstanceId=vm-1/)
  })

  test("VM lifecycle helpers never expose agent tokens, endpoint secrets, or Incus URLs", async () => {
    // Simulate the server returning valid VM data while verifying the client
    // contract is clean.
    installJsonFetch(200, { vms: [browserVm] })
    const vms = await fetchAdminVms()
    const serialized = JSON.stringify(vms)

    for (const forbidden of [
      "tokenCiphertext",
      "endpoint-token",
      "passwordHash",
      "sessionSecret",
      "authorization",
      "cookie",
      "rawIncus",
      "/var/lib/incus/unix.socket",
      "ws://127.0.0.1:19090/ws",
      "/1.0/",
      "anvil_session",
      "privateKeyCiphertext",
      "presharedKeyCiphertext",
      "agent token",
    ]) {
      assert.equal(serialized.includes(forbidden), false, `VM API helper leaked ${forbidden}`)
    }
  })

  test("VM lifecycle API helpers use credentials: include for cookie-based auth", async () => {
    installJsonFetch(200, { vms: [browserVm] })
    await fetchAdminVms()
    assert.equal(fetchCalls[0]?.init?.credentials, "include")

    installJsonFetch(200, { vm: browserVm })
    await fetchAdminVm("vm-1")
    assert.equal(fetchCalls[1]?.init?.credentials, "include")

    installJsonFetch(201, { vm: browserVm, operation: browserOp })
    await createAdminVm({
      name: "test-vm",
      endpointId: "endpoint-1",
      projectId: "project-1",
      tenantId: "tenant-1",
      networkPoolId: null,
      imageReference: "ubuntu/24.04",
      cpuCount: 1,
      memoryBytes: 268435456,
      rootDiskBytes: 5368709120,
    })
    assert.equal(fetchCalls[2]?.init?.credentials, "include")

    installJsonFetch(200, {
      vm: browserVm,
      operation: { ...browserOp, action: "START" },
    })
    await performVmAction("vm-1", "START")
    assert.equal(fetchCalls[3]?.init?.credentials, "include")

    installJsonFetch(200, {
      vm: { ...browserVm, status: "DELETED" },
      operation: { ...browserOp, action: "DELETE" },
    })
    await deleteAdminVm("vm-1")
    assert.equal(fetchCalls[4]?.init?.credentials, "include")
  })

  test("VM error responses preserve safe error codes and HTTP status", async () => {
    installJsonFetch(403, {
      error: { code: "ADMIN_FORBIDDEN", message: "Admin VM lifecycle permission denied.", details: {} },
    })
    await assert.rejects(() => fetchAdminVms(), {
      name: "ApiRequestError",
      code: "ADMIN_FORBIDDEN",
      status: 403,
    } satisfies Partial<ApiRequestError>)

    installJsonFetch(409, {
      error: { code: "VM_DUPLICATE_NAME", message: "A VM with that name already exists.", details: {} },
    })
    await assert.rejects(
      () =>
        createAdminVm({
          name: "dup-vm",
          endpointId: "endpoint-1",
          projectId: "project-1",
          tenantId: "tenant-1",
          networkPoolId: null,
          imageReference: "ubuntu/24.04",
          cpuCount: 1,
          memoryBytes: 268435456,
          rootDiskBytes: 5368709120,
        }),
      {
        name: "ApiRequestError",
        code: "VM_DUPLICATE_NAME",
        status: 409,
      } satisfies Partial<ApiRequestError>
    )

    installJsonFetch(503, {
      error: { code: "VM_AGENT_UNAVAILABLE", message: "Agent lifecycle protocol is unavailable.", details: {} },
    })
    await assert.rejects(() => performVmAction("vm-1", "START"), {
      name: "ApiRequestError",
      code: "VM_AGENT_UNAVAILABLE",
      status: 503,
    } satisfies Partial<ApiRequestError>)

    installJsonFetch(502, {
      error: { code: "VM_AGENT_MALFORMED", message: "Agent lifecycle response is malformed.", details: {} },
    })
    await assert.rejects(() => deleteAdminVm("vm-1"), {
      name: "ApiRequestError",
      code: "VM_AGENT_MALFORMED",
      status: 502,
    } satisfies Partial<ApiRequestError>)

    installJsonFetch(404, {
      error: { code: "VM_NOT_FOUND", message: "VM instance was not found.", details: {} },
    })
    await assert.rejects(() => fetchAdminVm("nonexistent"), {
      name: "ApiRequestError",
      code: "VM_NOT_FOUND",
      status: 404,
    } satisfies Partial<ApiRequestError>)

    installJsonFetch(409, {
      error: {
        code: "VM_CONFLICT",
        message: "VM is already running.",
        details: {},
      },
    })
    await assert.rejects(() => performVmAction("vm-1", "START"), {
      name: "ApiRequestError",
      code: "VM_CONFLICT",
      status: 409,
    } satisfies Partial<ApiRequestError>)
  })

  test("VM lifecycle helpers reference data APIs also use /api/admin routes", async () => {
    installJsonFetch(200, {
      tenants: [{ id: "tenant-1", name: "Tenant A", slug: "tenant-a", status: "ACTIVE", defaultProjectId: "project-1" }],
    })
    await fetchAdminTenants()
    assert.equal(fetchCalls[0]?.input, "/api/admin/tenants")

    installJsonFetch(200, {
      projects: [{ id: "project-1", name: "Project A", slug: "project-a", status: "ACTIVE", ownerTenantId: "tenant-1" }],
    })
    await fetchAdminProjects()
    assert.equal(fetchCalls[1]?.input, "/api/admin/projects")

    installJsonFetch(200, {
      endpoints: [{ id: "endpoint-1", name: "Primary Agent", url: "wss://agent.example.com/ws", status: "ACTIVE", team: { id: "team-1", name: "Team", status: "ACTIVE" }, credentialConfigured: true }],
    })
    await fetchAdminEndpoints()
    assert.equal(fetchCalls[2]?.input, "/api/admin/endpoints")

    installJsonFetch(200, {
      pools: [{ id: "pool-1", projectId: "project-1", fabricId: "fabric-1", ipv4Cidr: "10.42.100.0/24", ipv6Cidr: null, status: "ACTIVE", allocationMode: "DYNAMIC", createdAt: "2026-06-24T00:00:00.000Z", updatedAt: "2026-06-24T00:00:00.000Z" }],
    })
    await fetchAdminProjectNetworkPools()
    assert.equal(fetchCalls[3]?.input, "/api/admin/network/project-pools")
  })
})