import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createBootstrapRoutes } from "./bootstrap"
import type {
  AdminAuditEntry,
  AdminDataStore,
  AdminPrincipal,
  CreateBootstrapAdminRecord,
} from "../../services/admin/session"

const sessionSecret = "test-session-secret-with-enough-entropy"

async function readJson(response: Response) {
  return (await response.json()) as unknown
}

function assertSessionCookie(response: Response): void {
  const setCookie = response.headers.get("set-cookie") ?? ""
  assert.match(setCookie, /^anvil_session=/)
  assert.match(setCookie, /HttpOnly/i)
  assert.match(setCookie, /SameSite=Lax/i)
  assert.match(setCookie, /Path=\//i)
  assert.match(setCookie, /Max-Age=28800/i)
}

describe("admin bootstrap routes", () => {
  test("GET /bootstrap/status exposes one-time bootstrap availability", async () => {
    const store = new TestAdminStore()
    const routes = createBootstrapRoutes({ store, env: { ANVIL_SESSION_SECRET: sessionSecret } })

    const before = await routes.request("/bootstrap/status")
    await store.createBootstrapAdmin({
      email: "admin@example.com",
      name: "Admin User",
      passwordHash: "hashed-password",
      teamName: "Primary Team",
    })
    const after = await routes.request("/bootstrap/status")

    assert.equal(before.status, 200)
    assert.deepEqual(await readJson(before), {
      bootstrapComplete: false,
      available: true,
    })
    assert.equal(after.status, 200)
    assert.deepEqual(await readJson(after), {
      bootstrapComplete: true,
      available: false,
    })
  })

  test("POST /bootstrap creates the first admin, sets an HTTP-only cookie, and returns safe capabilities", async () => {
    const store = new TestAdminStore()
    const routes = createBootstrapRoutes({ store, env: { ANVIL_SESSION_SECRET: sessionSecret } })

    const response = await routes.request("/bootstrap", {
      method: "POST",
      body: JSON.stringify({
        email: "Admin@Example.com",
        name: "Admin User",
        password: "correct horse battery staple",
        teamName: "Primary Team",
      }),
      headers: { "content-type": "application/json" },
    })
    const body = await readJson(response)

    assert.equal(response.status, 200)
    assert.deepEqual(body, {
      user: {
        id: "user-1",
        email: "admin@example.com",
        name: "Admin User",
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
        globalActions: [
          "users:read",
          "users:write",
          "teams:read",
          "teams:write",
          "endpoints:read",
          "endpoints:write",
          "audit:read",
          "tenants:read",
          "tenants:write",
          "projects:read",
          "projects:write",
          "quotas:read",
          "quotas:write",
          "resources:read",
        ],
        tenants: [],
        projects: [],
        teams: [
          {
            teamId: "team-1",
            actions: ["members:read", "members:write", "endpoints:read", "endpoints:write", "audit:read"],
          },
        ],
      },
    })
    assertSessionCookie(response)
    assert.deepEqual(store.auditEntries.map((entry) => entry.action), ["bootstrap.create"])

    const serialized = JSON.stringify(body)
    assert.equal(serialized.includes("correct horse battery staple"), false)
    assert.equal(serialized.includes("hashed"), false)
    assert.equal(serialized.includes(sessionSecret), false)
    assert.equal(serialized.includes("token"), false)
    assert.equal(serialized.includes("secret"), false)
  })

  test("POST /bootstrap blocks a second bootstrap attempt", async () => {
    const store = new TestAdminStore()
    const routes = createBootstrapRoutes({ store, env: { ANVIL_SESSION_SECRET: sessionSecret } })

    await routes.request("/bootstrap", {
      method: "POST",
      body: JSON.stringify({
        email: "admin@example.com",
        name: "Admin User",
        password: "correct horse battery staple",
        teamName: "Primary Team",
      }),
      headers: { "content-type": "application/json" },
    })
    const second = await routes.request("/bootstrap", {
      method: "POST",
      body: JSON.stringify({
        email: "other@example.com",
        name: "Other User",
        password: "correct horse battery staple",
        teamName: "Other Team",
      }),
      headers: { "content-type": "application/json" },
    })

    assert.equal(second.status, 409)
    assert.deepEqual(await readJson(second), {
      error: {
        code: "BOOTSTRAP_ALREADY_COMPLETED",
        message: "Bootstrap has already been completed.",
        details: {},
      },
    })
    assert.equal(store.userCount(), 1)
    assert.deepEqual(store.auditEntries.map((entry) => entry.action), ["bootstrap.create"])
  })
})

class TestAdminStore implements AdminDataStore {
  private users = new Map<string, AdminPrincipal & { passwordHash: string }>()
  private bootstrapComplete = false
  readonly auditEntries: AdminAuditEntry[] = []

  async isBootstrapComplete(): Promise<boolean> {
    return this.bootstrapComplete
  }

  async createBootstrapAdmin(record: CreateBootstrapAdminRecord): Promise<AdminPrincipal> {
    const user: AdminPrincipal & { passwordHash: string } = {
      id: "user-1",
      email: record.email,
      name: record.name,
      status: "ACTIVE",
      globalRole: "ADMIN",
      teams: [
        {
          id: "team-1",
          name: record.teamName,
          role: "OWNER",
          status: "ACTIVE",
        },
      ],
      passwordHash: record.passwordHash,
    }
    this.users.set(user.id, user)
    this.bootstrapComplete = true
    return user
  }

  async findUserByEmail(): Promise<(AdminPrincipal & { passwordHash: string }) | null> {
    return null
  }

  async findUserById(): Promise<AdminPrincipal | null> {
    return null
  }

  async recordAudit(entry: AdminAuditEntry): Promise<void> {
    this.auditEntries.push(entry)
  }

  userCount(): number {
    return this.users.size
  }
}
