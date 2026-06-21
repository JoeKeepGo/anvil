import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createPermissionRoutes } from "./permissions"
import { getPermissionMatrix } from "../../services/admin/permissions"
import { signAdminSession } from "../../services/admin/session"
import type {
  AdminAuditEntry,
  AdminDataStore,
  AdminPrincipal,
  CreateBootstrapAdminRecord,
} from "../../services/admin/session"

const sessionSecret = "test-session-secret-with-enough-entropy"

const globalAdmin: AdminPrincipal = {
  id: "admin-1",
  email: "admin@example.com",
  name: "Admin User",
  status: "ACTIVE",
  globalRole: "ADMIN",
  teams: [],
}

describe("admin permission routes", () => {
  test("requires authentication for the browser-safe permission matrix", async () => {
    const routes = createPermissionRoutes({
      env: { ANVIL_SESSION_SECRET: sessionSecret },
      sessionStore: new TestSessionStore(globalAdmin),
    })

    const response = await routes.request("/matrix")

    assert.equal(response.status, 401)
    assert.deepEqual(await readJson(response), {
      error: {
        code: "UNAUTHENTICATED",
        message: "Authentication is required.",
        details: {},
      },
    })
  })

  test("returns the browser-safe permission matrix without secret material", async () => {
    const routes = createPermissionRoutes({
      env: { ANVIL_SESSION_SECRET: sessionSecret },
      sessionStore: new TestSessionStore(globalAdmin),
    })

    const response = await routes.request("/matrix", {
      headers: { cookie: sessionCookie(globalAdmin) },
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await readJson(response), {
      matrix: getPermissionMatrix(),
    })
    const repeatedResponse = await routes.request("/matrix", {
      headers: { cookie: sessionCookie(globalAdmin) },
    })
    const serialized = JSON.stringify(await readJson(repeatedResponse))
    assert.equal(serialized.includes("password"), false)
    assert.equal(serialized.includes("token"), false)
    assert.equal(serialized.includes("session"), false)
    assert.equal(serialized.includes("privateConfig"), false)
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

function sessionCookie(principal: AdminPrincipal): string {
  return `anvil_session=${signAdminSession({ ANVIL_SESSION_SECRET: sessionSecret }, principal)}`
}

async function readJson(response: Response): Promise<unknown> {
  return response.json()
}
