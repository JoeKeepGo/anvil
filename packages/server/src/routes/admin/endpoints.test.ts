import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createEndpointRoutes } from "./endpoints"
import { signAdminSession } from "../../services/admin/session"
import type {
  AdminAuditEntry,
  AdminDataStore,
  AdminPrincipal,
  CreateBootstrapAdminRecord,
} from "../../services/admin/session"
import type { AdminEndpointManagementStore, ManagedEndpoint } from "../../services/admin/endpoints"

const sessionSecret = "test-session-secret-with-enough-entropy"
const endpointTokenKey = "phase4-endpoint-token-key-with-enough-entropy"

const globalAdmin: AdminPrincipal = {
  id: "admin-1",
  email: "admin@example.com",
  name: "Admin User",
  status: "ACTIVE",
  globalRole: "ADMIN",
  teams: [
    {
      id: "team-1",
      name: "Primary Team",
      status: "ACTIVE",
      role: "OWNER",
    },
  ],
}

const teamViewer: AdminPrincipal = {
  id: "viewer-1",
  email: "viewer@example.com",
  name: "Viewer User",
  status: "ACTIVE",
  globalRole: "MEMBER",
  teams: [
    {
      id: "team-1",
      name: "Primary Team",
      status: "ACTIVE",
      role: "VIEWER",
    },
  ],
}

describe("admin endpoint routes", () => {
  test("requires authentication before validating endpoint mutation bodies", async () => {
    const routes = createEndpointRoutes({
      env: {
        ANVIL_SESSION_SECRET: sessionSecret,
        ANVIL_ENDPOINT_TOKEN_KEY: endpointTokenKey,
      },
      sessionStore: new TestSessionStore(globalAdmin),
      endpointStore: new TestEndpointRouteStore(),
    })

    const response = await routes.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })

    assert.equal(response.status, 401)
    assert.deepEqual(await readJson(response), {
      error: {
        code: "UNAUTHENTICATED",
        message: "Authentication is required.",
        details: {},
      },
    })
  })

  test("runs endpoint route contract without leaking token material", async () => {
    const endpointStore = new TestEndpointRouteStore()
    endpointStore.addTeam({ id: "team-1", name: "Primary Team", status: "ACTIVE" })
    const routes = createEndpointRoutes({
      env: {
        ANVIL_SESSION_SECRET: sessionSecret,
        ANVIL_ENDPOINT_TOKEN_KEY: endpointTokenKey,
      },
      sessionStore: new TestSessionStore(globalAdmin),
      endpointStore,
    })
    const cookie = sessionCookie(globalAdmin)

    const created = await routes.request("/", {
      method: "POST",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({
        name: "Primary Agent",
        url: "ws://127.0.0.1:9090/ws",
        token: "endpoint-token-that-must-not-leak",
        teamId: "team-1",
      }),
    })
    const listed = await routes.request("/", { headers: { cookie } })
    const detail = await routes.request("/endpoint-1", { headers: { cookie } })
    const updated = await routes.request("/endpoint-1", {
      method: "PATCH",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({
        name: "Renamed Agent",
        token: "rotated-endpoint-token-that-must-not-leak",
      }),
    })
    const archived = await routes.request("/endpoint-1/archive", {
      method: "POST",
      headers: { cookie },
    })
    const restored = await routes.request("/endpoint-1/restore", {
      method: "POST",
      headers: { cookie },
    })

    assert.equal(created.status, 201)
    assert.equal(listed.status, 200)
    assert.equal(detail.status, 200)
    assert.equal(updated.status, 200)
    assert.equal(archived.status, 200)
    assert.equal(restored.status, 200)
    assert.deepEqual(await readJson(created), {
      endpoint: {
        id: "endpoint-1",
        name: "Primary Agent",
        url: "ws://127.0.0.1:9090/ws",
        status: "ACTIVE",
        team: {
          id: "team-1",
          name: "Primary Team",
          status: "ACTIVE",
        },
        credentialConfigured: true,
      },
    })
    assert.deepEqual(endpointStore.auditEntries.map((entry) => entry.action), [
      "endpoint.create",
      "endpoint.update",
      "endpoint.archive",
      "endpoint.restore",
    ])

    const serialized = JSON.stringify([
      await readJson(listed),
      await readJson(detail),
      await readJson(updated),
      await readJson(archived),
      await readJson(restored),
      endpointStore.auditEntries,
    ])
    assert.equal(serialized.includes("endpoint-token-that-must-not-leak"), false)
    assert.equal(serialized.includes("rotated-endpoint-token-that-must-not-leak"), false)
    assert.equal(serialized.includes(endpointStore.ciphertextFor("endpoint-1", 0)), false)
    assert.equal(serialized.includes(endpointStore.ciphertextFor("endpoint-1", 1)), false)
    assert.equal(serialized.includes("tokenCiphertext"), false)
    assert.equal(serialized.includes(sessionSecret), false)
    assert.equal(serialized.includes("privateConfig"), false)
  })

  test("maps endpoint permission denial to safe forbidden errors", async () => {
    const endpointStore = new TestEndpointRouteStore()
    endpointStore.addTeam({ id: "team-1", name: "Primary Team", status: "ACTIVE" })
    await endpointStore.createEndpointRecord({
      name: "Primary Agent",
      url: "ws://127.0.0.1:9090/ws",
      teamId: "team-1",
    })
    const routes = createEndpointRoutes({
      env: {
        ANVIL_SESSION_SECRET: sessionSecret,
        ANVIL_ENDPOINT_TOKEN_KEY: endpointTokenKey,
      },
      sessionStore: new TestSessionStore(teamViewer),
      endpointStore,
    })

    const response = await routes.request("/endpoint-1", {
      method: "PATCH",
      headers: jsonHeaders(sessionCookie(teamViewer)),
      body: JSON.stringify({ name: "Viewer Rename" }),
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await readJson(response), {
      error: {
        code: "ADMIN_FORBIDDEN",
        message: "Admin permission denied.",
        details: {},
      },
    })
  })
})

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

  async recordAudit(_entry: AdminAuditEntry): Promise<void> {}
}

interface TestTeam {
  id: string
  name: string
  status: "ACTIVE" | "ARCHIVED"
}

class TestEndpointRouteStore implements AdminEndpointManagementStore {
  private readonly endpoints = new Map<string, ManagedEndpoint & { tokenCiphertext?: string }>()
  private readonly teams = new Map<string, TestTeam>()
  private readonly ciphertextHistory = new Map<string, string[]>()
  private nextEndpointNumber = 1
  readonly auditEntries: AdminAuditEntry[] = []

  async listEndpoints(): Promise<ManagedEndpoint[]> {
    return [...this.endpoints.values()].map(stripTokenCiphertext)
  }

  async getEndpoint(endpointId: string): Promise<ManagedEndpoint | null> {
    const endpoint = this.endpoints.get(endpointId)
    return endpoint ? stripTokenCiphertext(endpoint) : null
  }

  async findEndpointByTeamAndName(teamId: string, name: string): Promise<ManagedEndpoint | null> {
    const normalized = name.trim().toLowerCase()
    const endpoint = [...this.endpoints.values()].find(
      (candidate) => candidate.team.id === teamId && candidate.name.toLowerCase() === normalized
    )
    return endpoint ? stripTokenCiphertext(endpoint) : null
  }

  async createEndpointRecord(input: {
    name: string
    url: string
    teamId: string
    status?: "ACTIVE" | "ARCHIVED"
    tokenCiphertext?: string
  }): Promise<ManagedEndpoint> {
    const team = this.teams.get(input.teamId)
    assert.ok(team)
    const endpoint = {
      id: `endpoint-${this.nextEndpointNumber++}`,
      name: input.name,
      url: input.url,
      status: input.status ?? "ACTIVE",
      team: { ...team },
      credentialConfigured: input.tokenCiphertext !== undefined,
      tokenCiphertext: input.tokenCiphertext,
    }
    this.endpoints.set(endpoint.id, endpoint)
    this.pushCiphertext(endpoint.id, input.tokenCiphertext)
    return stripTokenCiphertext(endpoint)
  }

  async updateEndpointRecord(
    endpointId: string,
    input: {
      name?: string
      url?: string
      teamId?: string
      status?: "ACTIVE" | "ARCHIVED"
      tokenCiphertext?: string
    }
  ): Promise<ManagedEndpoint> {
    const endpoint = this.endpoints.get(endpointId)
    assert.ok(endpoint)
    const team = input.teamId ? this.teams.get(input.teamId) : endpoint.team
    assert.ok(team)
    const updated = {
      ...endpoint,
      name: input.name ?? endpoint.name,
      url: input.url ?? endpoint.url,
      status: input.status ?? endpoint.status,
      team: { ...team },
      credentialConfigured: input.tokenCiphertext !== undefined || endpoint.credentialConfigured,
      tokenCiphertext: input.tokenCiphertext ?? endpoint.tokenCiphertext,
    }
    this.endpoints.set(endpointId, updated)
    this.pushCiphertext(endpointId, input.tokenCiphertext)
    return stripTokenCiphertext(updated)
  }

  async getTeam(teamId: string): Promise<TestTeam | null> {
    return this.teams.get(teamId) ?? null
  }

  async recordAudit(entry: AdminAuditEntry): Promise<void> {
    this.auditEntries.push(entry)
  }

  addTeam(team: TestTeam): void {
    this.teams.set(team.id, team)
  }

  ciphertextFor(endpointId: string, index: number): string {
    const ciphertext = this.ciphertextHistory.get(endpointId)?.[index]
    assert.ok(ciphertext)
    return ciphertext
  }

  private pushCiphertext(endpointId: string, ciphertext: string | undefined): void {
    if (ciphertext === undefined) {
      return
    }
    this.ciphertextHistory.set(endpointId, [...(this.ciphertextHistory.get(endpointId) ?? []), ciphertext])
  }
}

function stripTokenCiphertext(endpoint: ManagedEndpoint & { tokenCiphertext?: string }): ManagedEndpoint {
  return {
    id: endpoint.id,
    name: endpoint.name,
    url: endpoint.url,
    status: endpoint.status,
    team: { ...endpoint.team },
    credentialConfigured: endpoint.credentialConfigured,
  }
}

function sessionCookie(principal: AdminPrincipal): string {
  return `anvil_session=${signAdminSession({ ANVIL_SESSION_SECRET: sessionSecret }, principal)}`
}

function jsonHeaders(cookie: string): HeadersInit {
  return {
    cookie,
    "content-type": "application/json",
  }
}

async function readJson(response: Response): Promise<unknown> {
  return response.json()
}
