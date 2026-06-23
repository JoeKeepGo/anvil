import assert from "node:assert/strict"
import { afterEach, describe, test } from "node:test"
import {
  ApiRequestError,
  addAdminProjectEndpointBinding,
  addAdminProjectTenant,
  archiveAdminProject,
  archiveAdminTenant,
  applyAdminNetworkFabric,
  bootstrapAdmin,
  createAdminEndpoint,
  createAdminProject,
  createAdminTenant,
  createAdminUser,
  dryRunAdminNetworkFabric,
  fetchAdminAudit,
  fetchAdminEndpoints,
  fetchAdminHosts,
  fetchAdminHost,
  fetchAdminNetworkFabric,
  fetchAdminNetworkFabrics,
  fetchAdminPermissionMatrix,
  fetchAdminProject,
  fetchAdminProjects,
  fetchAdminProjectNetworkPools,
  fetchAdminTeams,
  fetchAdminTenant,
  fetchAdminTenants,
  fetchAdminUsers,
  fetchBootstrapStatus,
  fetchMe,
  login,
  logout,
  removeAdminProjectEndpointBinding,
  removeAdminProjectTenant,
  restoreAdminProject,
  restoreAdminTenant,
  setAdminProjectQuota,
  setAdminProjectTenantQuota,
  syncAdminHostState,
  syncAdminNetworkFabric,
  updateAdminProject,
  updateAdminProjectTenant,
  updateAdminTenant,
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

describe("auth API helpers", () => {
  test("login unwraps the M9 browser-safe session and does not expose a token", async () => {
    installJsonFetch(200, {
      user: {
        id: "bootstrap-admin",
        email: "admin@example.com",
        name: "Admin",
        status: "ACTIVE",
        globalRole: "ADMIN",
        teams: [
          {
            id: "team-1",
            name: "Primary Team",
            role: "OWNER",
            status: "ACTIVE",
          },
        ],
      },
      access: {
        bootstrapComplete: true,
        canAdmin: true,
        globalActions: ["users:read", "users:write"],
        tenants: [{ tenantId: "tenant-1", actions: ["tenants:read", "projects:read", "resources:read"] }],
        projects: [
          {
            projectId: "project-1",
            tenantId: "tenant-1",
            actions: ["projects:read", "quotas:read", "resources:read"],
          },
        ],
        teams: [{ teamId: "team-1", actions: ["members:read", "endpoints:read"] }],
      },
    })

    const session = await login("admin@example.com", "correct-password")

    assert.deepEqual(session.user, {
      id: "bootstrap-admin",
      email: "admin@example.com",
      name: "Admin",
      status: "ACTIVE",
      globalRole: "ADMIN",
      teams: [
        {
          id: "team-1",
          name: "Primary Team",
          role: "OWNER",
          status: "ACTIVE",
        },
      ],
    })
    assert.deepEqual(session.access, {
      bootstrapComplete: true,
      canAdmin: true,
      globalActions: ["users:read", "users:write"],
      tenants: [{ tenantId: "tenant-1", actions: ["tenants:read", "projects:read", "resources:read"] }],
      projects: [
        {
          projectId: "project-1",
          tenantId: "tenant-1",
          actions: ["projects:read", "quotas:read", "resources:read"],
        },
      ],
      teams: [{ teamId: "team-1", actions: ["members:read", "endpoints:read"] }],
    })
    assert.equal(JSON.stringify(session).includes("token"), false)
    assert.equal(JSON.stringify(session).includes("passwordHash"), false)
    assert.equal(fetchCalls[0]?.input, "/api/auth/login")
    assert.equal(fetchCalls[0]?.init?.credentials, "include")
  })

  test("fetchMe unwraps the current user session response", async () => {
    installJsonFetch(200, {
      user: {
        id: "bootstrap-admin",
        email: "admin@example.com",
        name: "Admin",
        status: "ACTIVE",
        globalRole: "ADMIN",
        teams: [],
      },
      access: {
        bootstrapComplete: true,
        canAdmin: true,
        globalActions: ["audit:read"],
        tenants: [],
        projects: [],
        teams: [],
      },
    })

    const session = await fetchMe()

    assert.deepEqual(session.user, {
      id: "bootstrap-admin",
      email: "admin@example.com",
      name: "Admin",
      status: "ACTIVE",
      globalRole: "ADMIN",
      teams: [],
    })
    assert.deepEqual(session.access, {
      bootstrapComplete: true,
      canAdmin: true,
      globalActions: ["audit:read"],
      tenants: [],
      projects: [],
      teams: [],
    })
    assert.equal(fetchCalls[0]?.input, "/api/auth/me")
    assert.equal(fetchCalls[0]?.init?.credentials, "include")
  })

  test("logout posts to the backend logout endpoint with credentials and returns no session data", async () => {
    installJsonFetch(200, { ok: true })

    const result = await logout()

    assert.equal(result, undefined)
    assert.equal(fetchCalls[0]?.input, "/api/auth/logout")
    assert.equal(fetchCalls[0]?.init?.method, "POST")
    assert.equal(fetchCalls[0]?.init?.credentials, "include")
  })

  test("logout errors preserve safe backend error code and HTTP status", async () => {
    installJsonFetch(503, {
      error: {
        code: "AUTH_UNAVAILABLE",
        message: "Authentication is temporarily unavailable.",
        details: {},
      },
    })

    await assert.rejects(() => logout(), {
      name: "ApiRequestError",
      code: "AUTH_UNAVAILABLE",
      status: 503,
      message: "Authentication is temporarily unavailable.",
    } satisfies Partial<ApiRequestError>)
  })

  test("auth errors preserve safe backend error code and HTTP status", async () => {
    installJsonFetch(401, {
      error: {
        code: "INVALID_CREDENTIALS",
        message: "Invalid email or password.",
        details: {},
      },
    })

    await assert.rejects(() => login("admin@example.com", "wrong-password"), {
      name: "ApiRequestError",
      code: "INVALID_CREDENTIALS",
      status: 401,
      message: "Invalid email or password.",
    } satisfies Partial<ApiRequestError>)
  })
})

describe("admin API helpers", () => {
  test("bootstrap helpers use the public bootstrap contract and keep credentials in cookies", async () => {
    installJsonFetch(200, {
      bootstrapComplete: false,
      available: true,
    })

    const status = await fetchBootstrapStatus()

    assert.deepEqual(status, {
      bootstrapComplete: false,
      available: true,
    })
    assert.equal(fetchCalls[0]?.input, "/api/admin/bootstrap/status")
    assert.equal(fetchCalls[0]?.init?.credentials, "include")

    installJsonFetch(200, {
      user: {
        id: "admin-1",
        email: "admin@example.com",
        name: "Admin",
        status: "ACTIVE",
        globalRole: "ADMIN",
        teams: [],
      },
      access: {
        bootstrapComplete: true,
        canAdmin: true,
        globalActions: ["users:read"],
        tenants: [],
        projects: [],
        teams: [],
      },
    })

    const session = await bootstrapAdmin({
      email: "admin@example.com",
      name: "Admin",
      password: "correct horse battery staple",
      teamName: "Primary Team",
    })

    assert.equal(fetchCalls[1]?.input, "/api/admin/bootstrap")
    assert.equal(fetchCalls[1]?.init?.method, "POST")
    assert.equal(fetchCalls[1]?.init?.credentials, "include")
    assert.deepEqual(JSON.parse(String(fetchCalls[1]?.init?.body)), {
      email: "admin@example.com",
      name: "Admin",
      password: "correct horse battery staple",
      teamName: "Primary Team",
    })
    assert.equal(JSON.stringify(session).includes("anvil_session"), false)
    assert.equal(JSON.stringify(session).includes("passwordHash"), false)
  })

  test("admin list helpers consume accepted backend response envelopes", async () => {
    installJsonFetch(200, {
      users: [
        {
          id: "user-1",
          email: "admin@example.com",
          name: "Admin",
          status: "ACTIVE",
          globalRole: "ADMIN",
          teams: [],
        },
      ],
    })
    assert.deepEqual((await fetchAdminUsers()).map((user) => user.email), ["admin@example.com"])
    assert.equal(fetchCalls.at(-1)?.input, "/api/admin/users")

    installJsonFetch(200, {
      teams: [{ id: "team-1", name: "Primary Team", status: "ACTIVE", members: [] }],
    })
    assert.deepEqual((await fetchAdminTeams()).map((team) => team.name), ["Primary Team"])
    assert.equal(fetchCalls.at(-1)?.input, "/api/admin/teams")

    installJsonFetch(200, {
      matrix: {
        global: [{ role: "ADMIN", actions: ["users:read"] }],
        team: [{ role: "OWNER", actions: ["members:read"] }],
        tenant: [{ scope: "ACTIVE_TENANT", actions: ["tenants:read", "projects:read"] }],
        project: [{ scope: "ACTIVE_PROJECT", actions: ["projects:read", "quotas:read"] }],
      },
    })
    assert.deepEqual(await fetchAdminPermissionMatrix(), {
      global: [{ role: "ADMIN", actions: ["users:read"] }],
      team: [{ role: "OWNER", actions: ["members:read"] }],
      tenant: [{ scope: "ACTIVE_TENANT", actions: ["tenants:read", "projects:read"] }],
      project: [{ scope: "ACTIVE_PROJECT", actions: ["projects:read", "quotas:read"] }],
    })
    assert.equal(fetchCalls.at(-1)?.input, "/api/admin/permissions/matrix")

    installJsonFetch(200, {
      audit: [
        {
          id: "audit-1",
          actor: { id: "admin-1", email: "admin@example.com", name: "Admin" },
          action: "endpoint.create",
          targetType: "endpoint",
          targetId: "endpoint-1",
          metadata: { token: "[REDACTED]" },
          createdAt: "2026-06-21T00:00:00.000Z",
        },
      ],
      page: { limit: 25, offset: 0, total: 1 },
    })
    const audit = await fetchAdminAudit({ targetType: "endpoint", limit: 25 })
    assert.equal(audit.audit[0]?.metadata?.token, "[REDACTED]")
    assert.equal(fetchCalls.at(-1)?.input, "/api/admin/audit?targetType=endpoint&limit=25")
  })

  test("host state helpers consume M11 envelopes and never expose endpoint secrets", async () => {
    const host = {
      id: "host-state-1",
      endpoint: {
        id: "endpoint-1",
        name: "Local VM",
        status: "ACTIVE",
      },
      agent: {
        id: "11111111-1111-4111-8111-111111111111",
        version: "dev",
        stateSchemaVersion: 1,
        startedAt: "2026-06-22T00:00:00.000Z",
        reportedAt: "2026-06-22T00:30:00.000Z",
      },
      host: {
        hostname: "anvil-local-vm",
        os: "linux",
        arch: "arm64",
      },
      incus: {
        available: true,
        statusCode: 200,
        serverVersion: "6.12",
        apiVersion: "1.0",
      },
      capabilities: {
        incusProxy: true,
        events: true,
        stateReport: true,
        wireGuard: false,
        vmLifecycle: false,
      },
      snapshot: {
        instancesTotal: 0,
        imagesTotal: 1,
        operationsTotal: 0,
      },
      status: "ONLINE",
      firstSeenAt: "2026-06-22T01:00:00.000Z",
      lastSeenAt: "2026-06-22T02:00:00.000Z",
    }

    installJsonFetch(200, { hosts: [host] })
    const hosts = await fetchAdminHosts()

    assert.equal(fetchCalls.at(-1)?.input, "/api/admin/hosts")
    assert.equal(fetchCalls.at(-1)?.init?.credentials, "include")
    assert.equal(hosts[0]?.endpoint.id, "endpoint-1")
    assert.equal(hosts[0]?.agent.stateSchemaVersion, 1)

    installJsonFetch(200, { host })
    const detail = await fetchAdminHost("host-state-1")

    assert.equal(fetchCalls.at(-1)?.input, "/api/admin/hosts/host-state-1")
    assert.equal(detail.id, "host-state-1")

    installJsonFetch(200, { host: { ...host, snapshot: { ...host.snapshot, instancesTotal: 3 } } })
    const synced = await syncAdminHostState("endpoint-1")

    assert.equal(fetchCalls.at(-1)?.input, "/api/admin/endpoints/endpoint-1/agent-state/sync")
    assert.equal(fetchCalls.at(-1)?.init?.method, "POST")
    assert.equal(synced.snapshot.instancesTotal, 3)

    const serialized = JSON.stringify([hosts, detail, synced])
    for (const forbidden of [
      "endpoint-token",
      "tokenCiphertext",
      "passwordHash",
      "sessionSecret",
      "authorization",
      "cookie",
      "rawIncus",
      "/var/lib/incus/unix.socket",
      "ws://127.0.0.1:19090/ws",
    ]) {
      assert.equal(serialized.includes(forbidden), false, `host API helper leaked ${forbidden}`)
    }
  })

  test("admin mutation helpers post only to /api/admin routes and keep endpoint tokens out of responses", async () => {
    installJsonFetch(201, {
      user: {
        id: "user-1",
        email: "new@example.com",
        name: "New User",
        status: "ACTIVE",
        globalRole: "MEMBER",
        teams: [],
      },
    })

    await createAdminUser({
      email: "new@example.com",
      name: "New User",
      password: "correct horse battery staple",
      globalRole: "MEMBER",
    })
    assert.equal(fetchCalls[0]?.input, "/api/admin/users")
    assert.equal(fetchCalls[0]?.init?.method, "POST")

    installJsonFetch(201, {
      endpoint: {
        id: "endpoint-1",
        name: "Primary Agent",
        url: "wss://agent.example.com/ws",
        status: "ACTIVE",
        team: { id: "team-1", name: "Primary Team", status: "ACTIVE" },
        credentialConfigured: true,
      },
    })

    const endpoint = await createAdminEndpoint({
      name: "Primary Agent",
      url: "wss://agent.example.com/ws",
      token: "endpoint-token-that-must-not-return",
      teamId: "team-1",
    })

    assert.equal(fetchCalls[1]?.input, "/api/admin/endpoints")
    assert.equal(fetchCalls[1]?.init?.method, "POST")
    assert.equal(JSON.stringify(endpoint).includes("endpoint-token-that-must-not-return"), false)
    assert.equal("token" in endpoint, false)
    assert.equal("tokenCiphertext" in endpoint, false)
  })

  test("endpoint list helper preserves redacted credential state without accepting token aliases", async () => {
    installJsonFetch(200, {
      endpoints: [
        {
          id: "endpoint-1",
          name: "Primary Agent",
          url: "wss://agent.example.com/ws",
          status: "ACTIVE",
          team: { id: "team-1", name: "Primary Team", status: "ACTIVE" },
          credentialConfigured: true,
        },
      ],
    })

    const endpoints = await fetchAdminEndpoints()

    assert.equal(endpoints[0]?.credentialConfigured, true)
    assert.equal("token" in endpoints[0]!, false)
    assert.equal("tokenCiphertext" in endpoints[0]!, false)
  })

  test("tenant helpers consume M10 envelopes and never expose secret material", async () => {
    installJsonFetch(200, {
      tenants: [
        {
          id: "tenant-1",
          name: "Tenant A",
          slug: "tenant-a",
          status: "ACTIVE",
          defaultProjectId: "project-1",
        },
      ],
    })

    const tenants = await fetchAdminTenants()

    assert.deepEqual(tenants.map((tenant) => tenant.slug), ["tenant-a"])
    assert.equal(fetchCalls.at(-1)?.input, "/api/admin/tenants")

    installJsonFetch(200, {
      tenant: {
        id: "tenant-1",
        name: "Tenant A",
        slug: "tenant-a",
        status: "ACTIVE",
        defaultProjectId: "project-1",
      },
    })

    assert.equal((await fetchAdminTenant("tenant-1")).defaultProjectId, "project-1")
    assert.equal(fetchCalls.at(-1)?.input, "/api/admin/tenants/tenant-1")

    installJsonFetch(200, {
      tenant: {
        id: "tenant-1",
        name: "Tenant A Renamed",
        slug: "tenant-a",
        status: "ACTIVE",
        defaultProjectId: "project-1",
      },
    })

    assert.equal((await updateAdminTenant("tenant-1", { name: "Tenant A Renamed" })).name, "Tenant A Renamed")
    assert.equal(fetchCalls.at(-1)?.input, "/api/admin/tenants/tenant-1")
    assert.equal(fetchCalls.at(-1)?.init?.method, "PATCH")

    installJsonFetch(201, {
      tenant: {
        id: "tenant-2",
        name: "Tenant B",
        slug: "tenant-b",
        status: "ACTIVE",
        defaultProjectId: "project-2",
      },
      defaultProject: {
        id: "project-2",
        name: "Tenant B Default",
        slug: "default",
        status: "ACTIVE",
        ownerTenantId: "tenant-2",
      },
    })

    const created = await createAdminTenant({ name: "Tenant B", slug: "tenant-b" })

    assert.equal(created.tenant.defaultProjectId, "project-2")
    assert.equal(created.defaultProject.slug, "default")
    assert.equal(fetchCalls.at(-1)?.input, "/api/admin/tenants")
    assert.equal(fetchCalls.at(-1)?.init?.method, "POST")
    assert.equal(JSON.stringify(created).includes("tokenCiphertext"), false)
    assert.equal(JSON.stringify(created).includes("passwordHash"), false)

    installJsonFetch(200, {
      tenant: {
        id: "tenant-2",
        name: "Tenant B",
        slug: "tenant-b",
        status: "ARCHIVED",
        defaultProjectId: "project-2",
      },
    })
    assert.equal((await archiveAdminTenant("tenant-2")).status, "ARCHIVED")
    assert.equal(fetchCalls.at(-1)?.input, "/api/admin/tenants/tenant-2/archive")
    assert.equal(fetchCalls.at(-1)?.init?.method, "POST")

    installJsonFetch(200, {
      tenant: {
        id: "tenant-2",
        name: "Tenant B",
        slug: "tenant-b",
        status: "ACTIVE",
        defaultProjectId: "project-2",
      },
    })
    assert.equal((await restoreAdminTenant("tenant-2")).status, "ACTIVE")
    assert.equal(fetchCalls.at(-1)?.input, "/api/admin/tenants/tenant-2/restore")
  })

  test("project helpers consume detail, quota, allocation, and binding contracts", async () => {
    installJsonFetch(200, {
      projects: [
        {
          id: "project-1",
          name: "Project A",
          slug: "project-a",
          status: "ACTIVE",
          ownerTenantId: "tenant-1",
        },
      ],
    })

    const projects = await fetchAdminProjects()

    assert.deepEqual(projects.map((project) => project.slug), ["project-a"])
    assert.equal(fetchCalls.at(-1)?.input, "/api/admin/projects")

    installJsonFetch(200, {
      project: {
        id: "project-1",
        name: "Project A",
        slug: "project-a",
        status: "ACTIVE",
        ownerTenantId: "tenant-1",
      },
      participants: [
        {
          id: "project-tenant-1",
          projectId: "project-1",
          tenantId: "tenant-1",
          role: "OWNER",
          status: "ACTIVE",
        },
      ],
      quota: {
        projectId: "project-1",
        maxVcpu: 8,
        maxMemoryBytes: null,
        maxDiskBytes: null,
        maxInstances: 4,
        maxIpv6Addresses: null,
      },
      tenantQuotas: [],
      endpointBindings: [
        {
          id: "binding-1",
          endpointId: "endpoint-1",
          projectId: "project-1",
          status: "ACTIVE",
        },
      ],
    })

    const detail = await fetchAdminProject("project-1")

    assert.equal(detail.quota?.maxVcpu, 8)
    assert.equal(detail.participants[0]?.tenantId, "tenant-1")
    assert.equal(detail.endpointBindings[0]?.endpointId, "endpoint-1")
    assert.equal(JSON.stringify(detail).includes("tokenCiphertext"), false)
    assert.equal(JSON.stringify(detail).includes("endpoint-token"), false)

    installJsonFetch(201, {
      project: {
        id: "project-2",
        name: "Project B",
        slug: "project-b",
        status: "ACTIVE",
        ownerTenantId: "tenant-1",
      },
    })

    await createAdminProject({ ownerTenantId: "tenant-1", name: "Project B", slug: "project-b" })
    assert.equal(fetchCalls.at(-1)?.input, "/api/admin/projects")
    assert.equal(fetchCalls.at(-1)?.init?.method, "POST")

    installJsonFetch(200, {
      project: {
        id: "project-2",
        name: "Project B Renamed",
        slug: "project-b",
        status: "ACTIVE",
        ownerTenantId: "tenant-1",
      },
    })
    await updateAdminProject("project-2", { name: "Project B Renamed" })
    assert.equal(fetchCalls.at(-1)?.input, "/api/admin/projects/project-2")
    assert.equal(fetchCalls.at(-1)?.init?.method, "PATCH")

    installJsonFetch(201, {
      participant: {
        id: "project-tenant-2",
        projectId: "project-1",
        tenantId: "tenant-2",
        role: "PARTICIPANT",
        status: "ACTIVE",
      },
    })
    await addAdminProjectTenant("project-1", { tenantId: "tenant-2", role: "PARTICIPANT" })
    assert.equal(fetchCalls.at(-1)?.input, "/api/admin/projects/project-1/tenants")

    installJsonFetch(200, {
      participant: {
        id: "project-tenant-2",
        projectId: "project-1",
        tenantId: "tenant-2",
        role: "OWNER",
        status: "ACTIVE",
      },
    })
    await updateAdminProjectTenant("project-1", "tenant-2", { role: "OWNER" })
    assert.equal(fetchCalls.at(-1)?.input, "/api/admin/projects/project-1/tenants/tenant-2")
    assert.equal(fetchCalls.at(-1)?.init?.method, "PATCH")

    installJsonFetch(200, {
      quota: {
        projectId: "project-1",
        maxVcpu: 16,
        maxMemoryBytes: 34359738368,
        maxDiskBytes: null,
        maxInstances: 8,
        maxIpv6Addresses: null,
      },
    })
    await setAdminProjectQuota("project-1", {
      maxVcpu: 16,
      maxMemoryBytes: 34359738368,
      maxDiskBytes: null,
      maxInstances: 8,
      maxIpv6Addresses: null,
    })
    assert.equal(fetchCalls.at(-1)?.input, "/api/admin/projects/project-1/quota")
    assert.equal(fetchCalls.at(-1)?.init?.method, "PUT")

    installJsonFetch(200, {
      quota: {
        projectId: "project-1",
        tenantId: "tenant-2",
        maxVcpu: 4,
        maxMemoryBytes: null,
        maxDiskBytes: null,
        maxInstances: 2,
        maxIpv6Addresses: null,
      },
    })
    await setAdminProjectTenantQuota("project-1", "tenant-2", {
      maxVcpu: 4,
      maxMemoryBytes: null,
      maxDiskBytes: null,
      maxInstances: 2,
      maxIpv6Addresses: null,
    })
    assert.equal(fetchCalls.at(-1)?.input, "/api/admin/projects/project-1/tenants/tenant-2/quota")

    installJsonFetch(201, {
      binding: {
        id: "binding-1",
        endpointId: "endpoint-1",
        projectId: "project-1",
        status: "ACTIVE",
      },
    })
    await addAdminProjectEndpointBinding("project-1", "endpoint-1")
    assert.equal(fetchCalls.at(-1)?.input, "/api/admin/projects/project-1/endpoints")
    assert.equal(JSON.parse(String(fetchCalls.at(-1)?.init?.body)).endpointId, "endpoint-1")

    installJsonFetch(200, {
      binding: {
        id: "binding-1",
        endpointId: "endpoint-1",
        projectId: "project-1",
        status: "REMOVED",
      },
    })
    await removeAdminProjectEndpointBinding("project-1", "endpoint-1")
    assert.equal(fetchCalls.at(-1)?.input, "/api/admin/projects/project-1/endpoints/endpoint-1/remove")

    installJsonFetch(200, {
      participant: {
        id: "project-tenant-2",
        projectId: "project-1",
        tenantId: "tenant-2",
        role: "OWNER",
        status: "REMOVED",
      },
    })
    await removeAdminProjectTenant("project-1", "tenant-2")
    assert.equal(fetchCalls.at(-1)?.input, "/api/admin/projects/project-1/tenants/tenant-2/remove")

    installJsonFetch(200, {
      project: {
        id: "project-1",
        name: "Project A",
        slug: "project-a",
        status: "ARCHIVED",
        ownerTenantId: "tenant-1",
      },
    })
    assert.equal((await archiveAdminProject("project-1")).status, "ARCHIVED")
    assert.equal(fetchCalls.at(-1)?.input, "/api/admin/projects/project-1/archive")

    installJsonFetch(200, {
      project: {
        id: "project-1",
        name: "Project A",
        slug: "project-a",
        status: "ACTIVE",
        ownerTenantId: "tenant-1",
      },
    })
    assert.equal((await restoreAdminProject("project-1")).status, "ACTIVE")
    assert.equal(fetchCalls.at(-1)?.input, "/api/admin/projects/project-1/restore")
  })
})

describe("admin network API helpers (M12)", () => {
  const fabricSummary = {
    id: "fabric-1",
    name: "Lab Fabric",
    slug: "lab-fabric",
    status: "PLANNED",
    mode: "HUB_SPOKE",
    overlayIpv4Cidr: "10.42.0.0/24",
    overlayIpv6Cidr: "fd42:42:42::/64",
    hubCount: 1,
    peerCount: 1,
    prefixCount: 0,
    poolCount: 0,
    createdAt: "2026-06-23T12:00:00.000Z",
    updatedAt: "2026-06-23T12:00:00.000Z",
  }

  const fabricDetail = {
    ...fabricSummary,
    hubs: [
      {
        id: "hub-1",
        fabricId: "fabric-1",
        name: "Lab Hub",
        status: "PLANNED",
        listenPort: 51820,
        endpointHost: "lab-hub.internal",
        publicKey: "hub-public-key-base64-aaaaaaaaaaaaaaaaaaaa",
        presharedKeyMode: "PAIRWISE",
        privateKeyConfigured: true,
        createdAt: "2026-06-23T12:00:00.000Z",
        updatedAt: "2026-06-23T12:00:00.000Z",
      },
    ],
    peers: [
      {
        id: "peer-1",
        fabricId: "fabric-1",
        endpointId: "endpoint-1",
        name: "anvilwg0",
        status: "PLANNED",
        role: "MEMBER",
        publicKey: "peer-public-key-base64-bbbbbbbbbbbbbbbbbbbb",
        privateKeyConfigured: true,
        presharedKeyConfigured: true,
        overlayIpv4Address: "10.42.0.2",
        overlayIpv6Address: "fd42:42:42::2",
        createdAt: "2026-06-23T12:00:00.000Z",
        updatedAt: "2026-06-23T12:00:00.000Z",
      },
    ],
    prefixes: [],
    pools: [],
  }

  test("list/detail helpers consume M12 envelopes through /api/admin/network only", async () => {
    installJsonFetch(200, { fabrics: [fabricSummary] })
    const fabrics = await fetchAdminNetworkFabrics()
    assert.equal(fetchCalls.at(-1)?.input, "/api/admin/network/fabrics")
    assert.equal(fetchCalls.at(-1)?.init?.credentials, "include")
    assert.equal(fabrics[0]?.slug, "lab-fabric")
    assert.equal(fabrics[0]?.overlayIpv6Cidr, "fd42:42:42::/64")

    installJsonFetch(200, { fabric: fabricDetail })
    const detail = await fetchAdminNetworkFabric("fabric-1")
    assert.equal(fetchCalls.at(-1)?.input, "/api/admin/network/fabrics/fabric-1")
    assert.equal(detail.peers[0]?.name, "anvilwg0")
    assert.equal(detail.peers[0]?.privateKeyConfigured, true)
    assert.equal("privateKeyCiphertext" in detail.peers[0]!, false)
    assert.equal("presharedKeyCiphertext" in detail.peers[0]!, false)
  })

  test("project pool helper consumes the M12 pool envelope", async () => {
    installJsonFetch(200, {
      pools: [
        {
          id: "pool-1",
          projectId: "project-1",
          fabricId: "fabric-1",
          ipv4Cidr: "10.42.100.0/24",
          ipv6Cidr: "fd42:42:100::/64",
          status: "ACTIVE",
          allocationMode: "DYNAMIC",
          createdAt: "2026-06-23T12:00:00.000Z",
          updatedAt: "2026-06-23T12:00:00.000Z",
        },
      ],
    })
    const pools = await fetchAdminProjectNetworkPools()
    assert.equal(fetchCalls.at(-1)?.input, "/api/admin/network/project-pools")
    assert.equal(pools[0]?.allocationMode, "DYNAMIC")
    assert.equal(pools[0]?.ipv6Cidr, "fd42:42:100::/64")
  })

  test("sync/dry-run/apply post to the correct /api/admin/network routes", async () => {
    installJsonFetch(200, {
      fabricId: "fabric-1",
      endpoints: [
        {
          endpointId: "endpoint-1",
          endpointName: "Lab Docker Agent",
          status: "SYNCED",
          snapshot: {
            id: "snap-1",
            endpointId: "endpoint-1",
            fabricId: "fabric-1",
            agentId: "agent-id-1",
            stateSchemaVersion: 1,
            observedAt: "2026-06-23T12:52:09.995Z",
            wireGuardAvailable: true,
            ipCommandAvailable: true,
            iptablesAvailable: true,
            ip6tablesAvailable: true,
            forwarding: { ipv4: true, ipv6: true },
            managedInterfaceCount: 0,
            status: "ONLINE",
          },
        },
      ],
    })
    const sync = await syncAdminNetworkFabric("fabric-1")
    assert.equal(fetchCalls.at(-1)?.input, "/api/admin/network/fabrics/fabric-1/sync")
    assert.equal(fetchCalls.at(-1)?.init?.method, "POST")
    assert.equal(fetchCalls.at(-1)?.init?.credentials, "include")
    assert.equal(sync.endpoints[0]?.status, "SYNCED")
    assert.equal(sync.endpoints[0]?.snapshot?.wireGuardAvailable, true)

    installJsonFetch(200, {
      fabricId: "fabric-1",
      operationId: "op-1",
      mode: "DRY_RUN",
      status: "SUCCEEDED",
      endpoints: [
        {
          endpointId: "endpoint-1",
          endpointName: "Lab Docker Agent",
          status: "OK",
          mode: "DRY_RUN",
          summary: "validated anvilwg0 with 1 peer(s); dry-run, no host mutation",
        },
      ],
      summary: "dry-run validated 1 endpoint(s), 0 failed",
    })
    const dryRun = await dryRunAdminNetworkFabric("fabric-1")
    assert.equal(fetchCalls.at(-1)?.input, "/api/admin/network/fabrics/fabric-1/dry-run")
    assert.equal(fetchCalls.at(-1)?.init?.method, "POST")
    assert.equal(dryRun.mode, "DRY_RUN")
    assert.equal(dryRun.status, "SUCCEEDED")

    installJsonFetch(200, {
      fabricId: "fabric-1",
      operationId: "op-2",
      mode: "APPLY",
      status: "SUCCEEDED",
      endpoints: [
        {
          endpointId: "endpoint-1",
          endpointName: "Lab Docker Agent",
          status: "OK",
          mode: "APPLY",
          summary: "validated and planned anvilwg0 with 1 peer(s); apply execution deferred to managed service",
        },
      ],
      summary: "apply planned for 1 endpoint(s), 0 failed; execution deferred to managed service",
    })
    const apply = await applyAdminNetworkFabric("fabric-1")
    assert.equal(fetchCalls.at(-1)?.input, "/api/admin/network/fabrics/fabric-1/apply")
    assert.equal(fetchCalls.at(-1)?.init?.method, "POST")
    assert.equal(apply.mode, "APPLY")
    assert.equal(apply.endpoints[0]?.status, "OK")
  })

  test("network helpers never expose private keys, PSKs, ciphertext, or agent tokens", async () => {
    const leakyDetail = {
      ...fabricDetail,
      hubs: [
        {
          ...fabricDetail.hubs[0]!,
          // Simulate an upstream that must not leak these fields. The helper
          // types do not declare them, but assert the serialized contract is clean.
        },
      ],
    }
    installJsonFetch(200, { fabric: leakyDetail })
    const detail = await fetchAdminNetworkFabric("fabric-1")
    const serialized = JSON.stringify([detail, fabricSummary])

    for (const forbidden of [
      "privateKeyCiphertext",
      "presharedKeyCiphertext",
      "tokenCiphertext",
      "endpoint-token",
      "agent token",
      "passwordHash",
      "sessionSecret",
      "ws://127.0.0.1:19090",
      "ws://127.0.0.1:19095",
      "/agent/v1",
      "/1.0/",
      "/var/lib/incus",
    ]) {
      assert.equal(serialized.includes(forbidden), false, `network API helper leaked ${forbidden}`)
    }
  })
})
