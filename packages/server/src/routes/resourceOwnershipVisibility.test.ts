import assert from "node:assert/strict"
import { describe, test, mock } from "node:test"
import { signAdminSession } from "../services/admin/session"
import type { AgentRequest } from "../services/agent"
import type {
  AdminAuditEntry,
  AdminDataStore,
  AdminPrincipal,
  BrowserAccessSummary,
  CreateBootstrapAdminRecord,
  TenantProjectAccessScopes,
} from "../services/admin/session"
import type {
  ResourceVisibilityRecord,
  ResourceVisibilityStore,
} from "../services/resourceVisibility"
import { createImageRoutes } from "./images"
import { createInstanceRoutes } from "./instances"
import { createOperationRoutes } from "./operations"

const sessionSecret = "test-session-secret-with-enough-entropy"
const agentUrl = "ws://127.0.0.1:19090/ws"
const endpointId = "endpoint-1"

const platformAdmin: AdminPrincipal = {
  id: "admin-1",
  email: "admin@example.com",
  name: "Platform Admin",
  status: "ACTIVE",
  globalRole: "ADMIN",
  teams: [],
}

const tenantUser: AdminPrincipal = {
  id: "tenant-user-1",
  email: "tenant@example.com",
  name: "Tenant User",
  status: "ACTIVE",
  globalRole: "MEMBER",
  teams: [],
}

describe("read-only resource ownership visibility", () => {
  test("app mounted read-only routes enforce tenant ownership after session auth", async () => {
    const originalNodeEnv = process.env.NODE_ENV
    const originalEnv = {
      ANVIL_SESSION_SECRET: process.env.ANVIL_SESSION_SECRET,
      ANVIL_AGENT_URL: process.env.ANVIL_AGENT_URL,
      ANVIL_AGENT_TOKEN: process.env.ANVIL_AGENT_TOKEN,
    }

    process.env.NODE_ENV = "test"
    process.env.ANVIL_SESSION_SECRET = sessionSecret
    process.env.ANVIL_AGENT_URL = agentUrl
    process.env.ANVIL_AGENT_TOKEN = "secret-token"

    const agentModule = await import("../services/agent")
    const agentClientMock = mock.method(agentModule.AgentClient.prototype, "execute", async (request: AgentRequest) => {
      if (request.path === "/1.0/instances") {
        return agentResponse(["/1.0/instances/tenant-a-instance", "/1.0/instances/tenant-b-instance"])
      }
      return instanceDetailResponse(request.path.split("/").at(-1) ?? "")
    })

    try {
      const { createApp } = await import("../index")
      const app = createApp({
        env: process.env,
        adminStore: new TestSessionStore(tenantUser, projectScopes("tenant-a", "project-a")),
        resourceVisibilityStore: new TestResourceVisibilityStore([
          ownership("INSTANCE", "tenant-a-instance", "project-a", "tenant-a"),
          ownership("INSTANCE", "tenant-b-instance", "project-b", "tenant-b"),
        ]),
      })

      const response = await app.request("/api/instances", {
        headers: { cookie: sessionCookie(tenantUser) },
      })

      assert.equal(response.status, 200)
      assert.deepEqual(await readJson(response), {
        instances: [
          {
            name: "tenant-a-instance",
            status: "Running",
            type: "container",
            architecture: "x86_64",
            createdAt: "2026-05-01T15:43:06.975344198Z",
          },
        ],
      })
      assert.equal(agentClientMock.mock.callCount(), 2)
    } finally {
      agentClientMock.mock.restore()
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = originalNodeEnv
      }

      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }
  })

  test("platform admins see owned and unowned legacy instances", async () => {
    const calls: string[] = []
    const route = createInstanceRoutes({
      env: routeEnv(),
      sessionStore: new TestSessionStore(platformAdmin),
      resourceVisibilityStore: new TestResourceVisibilityStore([
        ownership("INSTANCE", "tenant-a-instance", "project-a", "tenant-a"),
        ownership("INSTANCE", "tenant-b-instance", "project-b", "tenant-b"),
      ]),
      createClient: () => ({
        execute: async (request) => {
          calls.push(request.path)
          if (request.path === "/1.0/instances") {
            return agentResponse([
              "/1.0/instances/tenant-a-instance",
              "/1.0/instances/tenant-b-instance",
              "/1.0/instances/legacy-unowned",
            ])
          }
          return instanceDetailResponse(request.path.split("/").at(-1) ?? "")
        },
      }),
    })

    const response = await route.request("/instances", { headers: { cookie: sessionCookie(platformAdmin) } })
    const body = await readJson(response)

    assert.equal(response.status, 200)
    assert.deepEqual((body as { instances: Array<{ name: string }> }).instances.map((item) => item.name), [
      "tenant-a-instance",
      "tenant-b-instance",
      "legacy-unowned",
    ])
    assert.deepEqual(calls, [
      "/1.0/instances",
      "/1.0/instances/tenant-a-instance",
      "/1.0/instances/tenant-b-instance",
      "/1.0/instances/legacy-unowned",
    ])
  })

  test("tenant project users see only owned instances and not unowned legacy instances", async () => {
    const route = createInstanceRoutes({
      env: routeEnv(),
      sessionStore: new TestSessionStore(tenantUser, projectScopes("tenant-a", "project-a")),
      resourceVisibilityStore: new TestResourceVisibilityStore([
        ownership("INSTANCE", "tenant-a-instance", "project-a", "tenant-a"),
        ownership("INSTANCE", "tenant-b-instance", "project-b", "tenant-b"),
      ]),
      createClient: () => ({
        execute: async (request) => {
          if (request.path === "/1.0/instances") {
            return agentResponse([
              "/1.0/instances/tenant-a-instance",
              "/1.0/instances/tenant-b-instance",
              "/1.0/instances/legacy-unowned",
            ])
          }
          return instanceDetailResponse(request.path.split("/").at(-1) ?? "")
        },
      }),
    })

    const response = await route.request("/instances", { headers: { cookie: sessionCookie(tenantUser) } })

    assert.equal(response.status, 200)
    assert.deepEqual(await readJson(response), {
      instances: [
        {
          name: "tenant-a-instance",
          status: "Running",
          type: "container",
          architecture: "x86_64",
          createdAt: "2026-05-01T15:43:06.975344198Z",
        },
      ],
    })
  })

  test("tenant project users cannot read another tenant instance detail or learn hidden upstream data", async () => {
    const calls: string[] = []
    const route = createInstanceRoutes({
      env: routeEnv(),
      sessionStore: new TestSessionStore(tenantUser, projectScopes("tenant-a", "project-a")),
      resourceVisibilityStore: new TestResourceVisibilityStore([
        ownership("INSTANCE", "tenant-b-instance", "project-b", "tenant-b"),
      ]),
      createClient: () => ({
        execute: async (request) => {
          calls.push(request.path)
          return instanceDetailResponse("tenant-b-instance", { rawSecret: "hidden-upstream-body" })
        },
      }),
    })

    const response = await route.request("/instances/tenant-b-instance", {
      headers: { cookie: sessionCookie(tenantUser) },
    })
    const body = await readJson(response)
    const serialized = JSON.stringify(body)

    assert.equal(response.status, 404)
    assert.deepEqual(body, {
      error: {
        code: "INSTANCE_NOT_FOUND",
        message: "Instance not found",
        details: {},
      },
    })
    assert.deepEqual(calls, [])
    assert.equal(serialized.includes("tenant-b-instance"), false)
    assert.equal(serialized.includes("hidden-upstream-body"), false)
    assert.equal(serialized.includes(agentUrl), false)
    assert.equal(serialized.includes("token"), false)
  })

  test("images are filtered by active tenant/project/endpoint ownership", async () => {
    const route = createImageRoutes({
      env: routeEnv(),
      sessionStore: new TestSessionStore(tenantUser, projectScopes("tenant-a", "project-a")),
      resourceVisibilityStore: new TestResourceVisibilityStore([
        ownership("IMAGE", "image-a", "project-a", "tenant-a"),
        ownership("IMAGE", "image-b", "project-b", "tenant-b"),
      ]),
      createClient: () => ({
        execute: async () =>
          agentResponse([
            imageMetadata("image-a", "ubuntu"),
            imageMetadata("image-b", "debian"),
            imageMetadata("legacy-image", "alpine"),
          ]),
      }),
    })

    const response = await route.request("/images", { headers: { cookie: sessionCookie(tenantUser) } })

    assert.equal(response.status, 200)
    assert.deepEqual(await readJson(response), {
      images: [
        {
          fingerprint: "image-a",
          aliases: [{ name: "ubuntu", description: "" }],
          description: "ubuntu image",
          architecture: "x86_64",
          type: "container",
          sizeBytes: 1024,
          cached: false,
          public: false,
          autoUpdate: false,
          createdAt: "2026-05-01T15:43:06Z",
          expiresAt: null,
          lastUsedAt: null,
          uploadedAt: "2026-05-01T15:43:06Z",
        },
      ],
    })
  })

  test("operations are filtered by active tenant/project/endpoint ownership", async () => {
    const route = createOperationRoutes({
      env: routeEnv(),
      sessionStore: new TestSessionStore(tenantUser, projectScopes("tenant-a", "project-a")),
      resourceVisibilityStore: new TestResourceVisibilityStore([
        ownership("OPERATION", "operation-a", "project-a", "tenant-a"),
        ownership("OPERATION", "operation-b", "project-b", "tenant-b"),
      ]),
      createClient: () => ({
        execute: async () =>
          agentResponse([
            operationMetadata("operation-a", "Create instance"),
            operationMetadata("operation-b", "Create other instance"),
            operationMetadata("legacy-operation", "Legacy operation"),
          ]),
      }),
    })

    const response = await route.request("/operations", { headers: { cookie: sessionCookie(tenantUser) } })

    assert.equal(response.status, 200)
    assert.deepEqual(await readJson(response), {
      operations: [
        {
          id: "operation-a",
          class: "task",
          description: "Create instance",
          status: "Running",
          statusCode: 103,
          createdAt: "2026-05-01T15:43:06Z",
          updatedAt: "2026-05-01T15:44:06Z",
          mayCancel: false,
          resources: { instances: ["/1.0/instances/tenant-a-instance"] },
        },
      ],
    })
  })
})

class TestSessionStore implements AdminDataStore {
  constructor(
    private readonly principal: AdminPrincipal,
    private readonly scopes: TenantProjectAccessScopes = { tenants: [], projects: [] }
  ) {}

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

  async getTenantProjectAccessScopes(userId: string): Promise<TenantProjectAccessScopes> {
    return userId === this.principal.id ? this.scopes : { tenants: [], projects: [] }
  }

  async recordAudit(_entry: AdminAuditEntry): Promise<void> {}
}

class TestResourceVisibilityStore implements ResourceVisibilityStore {
  constructor(private readonly ownerships: ResourceVisibilityRecord[]) {}

  async findVisibleResourceOwnerships(input: {
    agentUrl: string
    resourceType: ResourceVisibilityRecord["resourceType"]
    resourceIds: string[]
    projectTenantScopes: Array<{ projectId: string; tenantId: string }>
  }): Promise<ResourceVisibilityRecord[]> {
    return this.ownerships.filter(
      (ownership) =>
        ownership.agentUrl === input.agentUrl &&
        ownership.resourceType === input.resourceType &&
        input.resourceIds.includes(ownership.resourceId) &&
        input.projectTenantScopes.some(
          (scope) => scope.projectId === ownership.projectId && scope.tenantId === ownership.tenantId
        )
    )
  }
}

function projectScopes(tenantId: string, projectId: string): TenantProjectAccessScopes {
  return {
    tenants: [{ tenantId, status: "ACTIVE" }],
    projects: [{ projectId, tenantId, status: "ACTIVE" }],
  }
}

function ownership(
  resourceType: ResourceVisibilityRecord["resourceType"],
  resourceId: string,
  projectId: string,
  tenantId: string
): ResourceVisibilityRecord {
  return {
    resourceType,
    resourceId,
    endpointId,
    agentUrl,
    projectId,
    tenantId,
  }
}

function sessionCookie(principal: AdminPrincipal): string {
  return `anvil_session=${signAdminSession({ ANVIL_SESSION_SECRET: sessionSecret }, principal)}`
}

function routeEnv(): NodeJS.ProcessEnv {
  return {
    ANVIL_SESSION_SECRET: sessionSecret,
    ANVIL_AGENT_URL: agentUrl,
    ANVIL_AGENT_TOKEN: "secret-token",
  }
}

function agentResponse(metadata: unknown) {
  return {
    id: "agent-response",
    status: 200,
    body: {
      type: "sync",
      status: "Success",
      status_code: 200,
      metadata,
    },
  }
}

function instanceDetailResponse(name: string, extra: Record<string, unknown> = {}) {
  return agentResponse({
    name,
    status: "Running",
    type: "container",
    architecture: "x86_64",
    created_at: "2026-05-01T15:43:06.975344198Z",
    description: "",
    ephemeral: false,
    stateful: false,
    profiles: ["default"],
    config: {},
    devices: {},
    ...extra,
  })
}

function imageMetadata(fingerprint: string, alias: string) {
  return {
    fingerprint,
    aliases: [{ name: alias, description: "" }],
    properties: { description: `${alias} image` },
    architecture: "x86_64",
    type: "container",
    size: 1024,
    cached: false,
    public: false,
    auto_update: false,
    created_at: "2026-05-01T15:43:06Z",
    expires_at: null,
    last_used_at: null,
    uploaded_at: "2026-05-01T15:43:06Z",
  }
}

function operationMetadata(id: string, description: string) {
  return {
    id,
    class: "task",
    description,
    status: "Running",
    status_code: 103,
    created_at: "2026-05-01T15:43:06Z",
    updated_at: "2026-05-01T15:44:06Z",
    may_cancel: false,
    resources: { instances: ["/1.0/instances/tenant-a-instance"] },
  }
}

async function readJson(response: Response): Promise<unknown> {
  return response.json()
}
