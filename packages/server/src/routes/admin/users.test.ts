import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createUserRoutes } from "./users"
import { signAdminSession } from "../../services/admin/session"
import type {
  AdminAuditEntry,
  AdminDataStore,
  AdminPrincipal,
  CreateBootstrapAdminRecord,
} from "../../services/admin/session"
import type { AdminUserManagementStore, ManagedUser } from "../../services/admin/users"

const sessionSecret = "test-session-secret-with-enough-entropy"

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

describe("admin user routes", () => {
  test("requires an authenticated admin session", async () => {
    const routes = createUserRoutes({
      env: { ANVIL_SESSION_SECRET: sessionSecret },
      sessionStore: new TestSessionStore(adminPrincipal),
      userStore: new TestUserRouteStore(),
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

    const invalidMutation = await routes.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })

    assert.equal(invalidMutation.status, 401)
    assert.deepEqual(await readJson(invalidMutation), {
      error: {
        code: "UNAUTHENTICATED",
        message: "Authentication is required.",
        details: {},
      },
    })
  })

  test("runs the user management route contract without leaking secrets", async () => {
    const userStore = new TestUserRouteStore()
    userStore.addTeam({ id: "team-1", name: "Primary Team", status: "ACTIVE" })
    await userStore.createUserRecord({
      email: "other-admin@example.com",
      name: "Other Admin",
      passwordHash: "hash",
      globalRole: "ADMIN",
      memberships: [],
    })
    const routes = createUserRoutes({
      env: { ANVIL_SESSION_SECRET: sessionSecret },
      sessionStore: new TestSessionStore(adminPrincipal),
      userStore,
    })
    const cookie = sessionCookie(adminPrincipal)

    const created = await routes.request("/", {
      method: "POST",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({
        email: "New.User@Example.com",
        name: "New User",
        password: "correct horse battery staple",
        globalRole: "MEMBER",
        memberships: [{ teamId: "team-1", role: "VIEWER" }],
      }),
    })
    const listed = await routes.request("/", { headers: { cookie } })
    const detail = await routes.request("/user-2", { headers: { cookie } })
    const updated = await routes.request("/user-2", {
      method: "PATCH",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ name: "Renamed User", globalRole: "ADMIN" }),
    })
    const disabled = await routes.request("/user-2/disable", {
      method: "POST",
      headers: { cookie },
    })
    const restored = await routes.request("/user-2/restore", {
      method: "POST",
      headers: { cookie },
    })
    const reset = await routes.request("/user-2/reset-password", {
      method: "POST",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ password: "new correct horse battery staple" }),
    })

    assert.equal(created.status, 201)
    assert.equal(listed.status, 200)
    assert.equal(detail.status, 200)
    assert.equal(updated.status, 200)
    assert.equal(disabled.status, 200)
    assert.equal(restored.status, 200)
    assert.equal(reset.status, 200)

    assert.deepEqual(await readJson(created), {
      user: {
        id: "user-2",
        email: "new.user@example.com",
        name: "New User",
        status: "ACTIVE",
        globalRole: "MEMBER",
        teams: [
          {
            id: "team-1",
            name: "Primary Team",
            status: "ACTIVE",
            role: "VIEWER",
            membershipStatus: "ACTIVE",
          },
        ],
      },
    })
    const listedBody = await readJson(listed)
    assert.deepEqual((listedBody as { users: Array<{ email: string }> }).users.map((user) => user.email), [
      "other-admin@example.com",
      "new.user@example.com",
    ])
    assert.deepEqual(await readJson(reset), { ok: true })
    assert.deepEqual(userStore.auditEntries.map((entry) => entry.action), [
      "user.create",
      "user.update",
      "user.disable",
      "user.restore",
      "user.resetPassword",
    ])

    const serialized = JSON.stringify([
      await readJson(detail),
      await readJson(updated),
      await readJson(disabled),
      await readJson(restored),
    ])
    assert.equal(serialized.includes("correct horse battery staple"), false)
    assert.equal(serialized.includes(userStore.passwordHashFor("user-2")), false)
    assert.equal(serialized.includes("passwordHash"), false)
    assert.equal(serialized.includes(sessionSecret), false)
    assert.equal(serialized.includes("token"), false)
    assert.equal(serialized.includes("privateConfig"), false)
  })

  test("maps denied user writes to safe forbidden errors", async () => {
    const routes = createUserRoutes({
      env: { ANVIL_SESSION_SECRET: sessionSecret },
      sessionStore: new TestSessionStore(memberPrincipal),
      userStore: new TestUserRouteStore(),
    })

    const response = await routes.request("/", {
      method: "POST",
      headers: jsonHeaders(sessionCookie(memberPrincipal)),
      body: JSON.stringify({
        email: "new@example.com",
        name: "New User",
        password: "correct horse battery staple",
        globalRole: "MEMBER",
      }),
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

class TestUserRouteStore implements AdminUserManagementStore {
  private users = new Map<string, ManagedUser & { passwordHash: string }>()
  private teams = new Map<string, TestTeam>()
  private nextUserNumber = 1
  readonly auditEntries: AdminAuditEntry[] = []

  async listUsers(): Promise<ManagedUser[]> {
    return [...this.users.values()].map(stripPasswordHash)
  }

  async getUser(userId: string): Promise<ManagedUser | null> {
    const user = this.users.get(userId)
    return user ? stripPasswordHash(user) : null
  }

  async findUserByEmail(email: string): Promise<ManagedUser | null> {
    const normalized = email.trim().toLowerCase()
    const user = [...this.users.values()].find((candidate) => candidate.email === normalized)
    return user ? stripPasswordHash(user) : null
  }

  async createUserRecord(input: {
    email: string
    name: string
    passwordHash: string
    globalRole: "ADMIN" | "MEMBER"
    memberships: Array<{ teamId: string; role: "OWNER" | "MAINTAINER" | "VIEWER" }>
  }): Promise<ManagedUser> {
    const userId = `user-${this.nextUserNumber++}`
    const user: ManagedUser & { passwordHash: string } = {
      id: userId,
      email: input.email,
      name: input.name,
      status: "ACTIVE",
      globalRole: input.globalRole,
      teams: input.memberships.map((membership) => {
        const team = this.teams.get(membership.teamId)
        assert.ok(team)
        return {
          id: team.id,
          name: team.name,
          status: team.status,
          role: membership.role,
          membershipStatus: "ACTIVE",
        }
      }),
      passwordHash: input.passwordHash,
    }
    this.users.set(user.id, user)
    return stripPasswordHash(user)
  }

  async updateUserRecord(
    userId: string,
    input: {
      email?: string
      name?: string
      status?: "ACTIVE" | "DISABLED"
      globalRole?: "ADMIN" | "MEMBER"
      passwordHash?: string
    }
  ): Promise<ManagedUser> {
    const user = this.users.get(userId)
    assert.ok(user)
    const updated = {
      ...user,
      email: input.email ?? user.email,
      name: input.name ?? user.name,
      status: input.status ?? user.status,
      globalRole: input.globalRole ?? user.globalRole,
      passwordHash: input.passwordHash ?? user.passwordHash,
    }
    this.users.set(userId, updated)
    return stripPasswordHash(updated)
  }

  async getTeam(teamId: string): Promise<TestTeam | null> {
    return this.teams.get(teamId) ?? null
  }

  async countActiveAdminsExcluding(userId: string): Promise<number> {
    return [...this.users.values()].filter(
      (user) => user.id !== userId && user.status === "ACTIVE" && user.globalRole === "ADMIN"
    ).length
  }

  async recordAudit(entry: AdminAuditEntry): Promise<void> {
    this.auditEntries.push(entry)
  }

  addTeam(team: TestTeam): void {
    this.teams.set(team.id, team)
  }

  passwordHashFor(userId: string): string {
    const user = this.users.get(userId)
    assert.ok(user)
    return user.passwordHash
  }
}

function stripPasswordHash(user: ManagedUser & { passwordHash: string }): ManagedUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    status: user.status,
    globalRole: user.globalRole,
    teams: user.teams.map((team) => ({ ...team })),
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
