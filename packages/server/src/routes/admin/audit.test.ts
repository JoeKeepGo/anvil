import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createAuditRoutes } from "./audit"
import { signAdminSession } from "../../services/admin/session"
import type {
  AdminAuditEntry,
  AdminDataStore,
  AdminPrincipal,
  CreateBootstrapAdminRecord,
} from "../../services/admin/session"
import type { AdminAuditQueryStore, BrowserAuditEntry } from "../../services/admin/audit"

const sessionSecret = "test-session-secret-with-enough-entropy"

const globalAdmin: AdminPrincipal = {
  id: "admin-1",
  email: "admin@example.com",
  name: "Admin User",
  status: "ACTIVE",
  globalRole: "ADMIN",
  teams: [],
}

const teamOwner: AdminPrincipal = {
  id: "owner-1",
  email: "owner@example.com",
  name: "Owner User",
  status: "ACTIVE",
  globalRole: "MEMBER",
  teams: [
    {
      id: "team-1",
      name: "Primary Team",
      status: "ACTIVE",
      role: "OWNER",
    },
  ],
}

const memberWithoutAudit: AdminPrincipal = {
  id: "member-1",
  email: "member@example.com",
  name: "Member User",
  status: "ACTIVE",
  globalRole: "MEMBER",
  teams: [],
}

describe("admin audit routes", () => {
  test("requires authentication for audit reads", async () => {
    const routes = createAuditRoutes({
      env: { ANVIL_SESSION_SECRET: sessionSecret },
      sessionStore: new TestSessionStore(globalAdmin),
      auditStore: new TestAuditRouteStore(),
    })

    const response = await routes.request("/")

    assert.equal(response.status, 401)
    assert.deepEqual(await readJson(response), {
      error: {
        code: "UNAUTHENTICATED",
        message: "Authentication is required.",
        details: {},
      },
    })
  })

  test("lists filtered audit entries without leaking secret metadata", async () => {
    const auditStore = new TestAuditRouteStore()
    auditStore.addAuditEntry({
      id: "audit-1",
      actor: { id: "admin-1", email: "admin@example.com", name: "Admin User" },
      action: "endpoint.create",
      targetType: "endpoint",
      targetId: "endpoint-1",
      teamId: "team-1",
      metadata: { token: "endpoint-token-that-must-not-leak" },
      createdAt: "2026-06-21T00:00:00.000Z",
    })
    const routes = createAuditRoutes({
      env: { ANVIL_SESSION_SECRET: sessionSecret },
      sessionStore: new TestSessionStore(globalAdmin),
      auditStore,
    })

    const response = await routes.request("/?targetType=endpoint&limit=1", {
      headers: { cookie: sessionCookie(globalAdmin) },
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await readJson(response), {
      audit: [
        {
          id: "audit-1",
          actor: { id: "admin-1", email: "admin@example.com", name: "Admin User" },
          action: "endpoint.create",
          targetType: "endpoint",
          targetId: "endpoint-1",
          teamId: "team-1",
          metadata: { token: "[REDACTED]" },
          createdAt: "2026-06-21T00:00:00.000Z",
        },
      ],
      page: {
        limit: 1,
        offset: 0,
        total: 1,
      },
    })
    assert.equal(JSON.stringify(await readJson(await routes.request("/?limit=1", {
      headers: { cookie: sessionCookie(globalAdmin) },
    }))).includes("endpoint-token-that-must-not-leak"), false)
  })

  test("applies scoped audit visibility and denies users without audit capability", async () => {
    const auditStore = new TestAuditRouteStore()
    auditStore.addAuditEntry({
      id: "audit-1",
      actor: { id: "owner-1", email: "owner@example.com", name: "Owner User" },
      action: "endpoint.update",
      targetType: "endpoint",
      targetId: "endpoint-1",
      teamId: "team-1",
      createdAt: "2026-06-21T00:00:00.000Z",
    })
    auditStore.addAuditEntry({
      id: "audit-2",
      actor: { id: "other-1", email: "other@example.com", name: "Other User" },
      action: "endpoint.update",
      targetType: "endpoint",
      targetId: "endpoint-2",
      teamId: "team-2",
      createdAt: "2026-06-21T00:01:00.000Z",
    })

    const scopedRoutes = createAuditRoutes({
      env: { ANVIL_SESSION_SECRET: sessionSecret },
      sessionStore: new TestSessionStore(teamOwner),
      auditStore,
    })
    const scopedResponse = await scopedRoutes.request("/", {
      headers: { cookie: sessionCookie(teamOwner) },
    })

    assert.equal(scopedResponse.status, 200)
    assert.deepEqual((await readJson(scopedResponse) as { audit: BrowserAuditEntry[] }).audit.map((entry) => entry.id), [
      "audit-1",
    ])

    const deniedRoutes = createAuditRoutes({
      env: { ANVIL_SESSION_SECRET: sessionSecret },
      sessionStore: new TestSessionStore(memberWithoutAudit),
      auditStore,
    })
    const denied = await deniedRoutes.request("/", {
      headers: { cookie: sessionCookie(memberWithoutAudit) },
    })

    assert.equal(denied.status, 403)
    assert.deepEqual(await readJson(denied), {
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

class TestAuditRouteStore implements AdminAuditQueryStore {
  private readonly entries: BrowserAuditEntry[] = []

  async listAuditEntries(query: Parameters<AdminAuditQueryStore["listAuditEntries"]>[0]) {
    const filtered = this.entries.filter((entry) => {
      if (query.targetType && entry.targetType !== query.targetType) {
        return false
      }
      if (query.teamIds && !query.teamIds.includes(entry.teamId ?? "")) {
        return false
      }
      return true
    })
    return {
      entries: filtered.slice(query.offset, query.offset + query.limit),
      total: filtered.length,
    }
  }

  addAuditEntry(entry: BrowserAuditEntry): void {
    this.entries.push(entry)
  }
}

function sessionCookie(principal: AdminPrincipal): string {
  return `anvil_session=${signAdminSession({ ANVIL_SESSION_SECRET: sessionSecret }, principal)}`
}

async function readJson(response: Response): Promise<unknown> {
  return response.json()
}
