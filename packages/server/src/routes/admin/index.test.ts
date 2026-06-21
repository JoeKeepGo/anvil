import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createAdminRoutes } from "./index"
import type {
  AdminDataStore,
  AdminPrincipal,
  CreateBootstrapAdminRecord,
} from "../../services/admin/session"

describe("admin router scaffold", () => {
  test("mounts Phase 3 users and teams prefixes as authenticated admin routes", async () => {
    const routes = createAdminRoutes({
      store: new TestAdminStore(),
      env: { ANVIL_SESSION_SECRET: "test-session-secret-with-enough-entropy" },
    })

    for (const path of ["/users", "/teams"]) {
      const response = await routes.request(path)

      assert.equal(response.status, 401, `${path} should be mounted as a protected Phase 3 route`)
      assert.deepEqual(await response.json(), {
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication is required.",
          details: {},
        },
      })
    }
  })

  test("keeps Phase 4 prefixes mounted with explicit not-implemented responses", async () => {
    const routes = createAdminRoutes({
      store: new TestAdminStore(),
      env: { ANVIL_SESSION_SECRET: "test-session-secret-with-enough-entropy" },
    })

    for (const path of ["/endpoints", "/permissions/matrix", "/audit"]) {
      const response = await routes.request(path)

      assert.equal(response.status, 501, `${path} should be mounted as an explicit scaffold route`)
      assert.deepEqual(await response.json(), {
        error: {
          code: "ADMIN_ROUTE_NOT_IMPLEMENTED",
          message: "This admin route is not implemented yet.",
          details: {},
        },
      })
    }
  })

  test("keeps bootstrap routes mounted while adding downstream scaffold prefixes", async () => {
    const routes = createAdminRoutes({
      store: new TestAdminStore(),
      env: { ANVIL_SESSION_SECRET: "test-session-secret-with-enough-entropy" },
    })

    const response = await routes.request("/bootstrap/status")

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      bootstrapComplete: false,
      available: true,
    })
  })
})

class TestAdminStore implements AdminDataStore {
  async isBootstrapComplete(): Promise<boolean> {
    return false
  }

  async createBootstrapAdmin(_record: CreateBootstrapAdminRecord): Promise<AdminPrincipal> {
    throw new Error("not needed")
  }

  async findUserByEmail(): Promise<(AdminPrincipal & { passwordHash: string }) | null> {
    return null
  }

  async findUserById(): Promise<AdminPrincipal | null> {
    return null
  }

  async recordAudit(): Promise<void> {}
}
