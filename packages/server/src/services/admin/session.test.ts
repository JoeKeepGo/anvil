import assert from "node:assert/strict"
import { describe, test } from "node:test"
import bcrypt from "bcryptjs"
import {
  authenticateAdminUser,
  BootstrapRequiredError,
  DisabledUserError,
  InvalidAdminCredentialsError,
  resolveCurrentAdminUser,
  signAdminSession,
} from "./session"
import type {
  AdminAuditEntry,
  AdminDataStore,
  AdminPrincipal,
  CreateBootstrapAdminRecord,
  TenantProjectAccessScopes,
} from "./session"

const adminPassword = "correct horse battery staple"
const sessionSecret = "test-session-secret-with-enough-entropy"

describe("admin database session service", () => {
  test("blocks login before bootstrap is complete", async () => {
    const store = new TestAdminStore({ bootstrapComplete: false })

    await assert.rejects(
      authenticateAdminUser(store, { ANVIL_SESSION_SECRET: sessionSecret }, "admin@example.com", adminPassword),
      BootstrapRequiredError
    )
  })

  test("authenticates active database users and returns browser-safe capability summary", async () => {
    const store = new TestAdminStore()
    const user = await store.addUser({
      id: "user-1",
      email: "Admin@Example.com",
      name: "Admin User",
      password: adminPassword,
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

    const result = await authenticateAdminUser(
      store,
      { ANVIL_SESSION_SECRET: sessionSecret },
      "admin@example.com",
      adminPassword
    )

    assert.deepEqual(result.user, {
      id: user.id,
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
    })
    assert.equal(result.access.canAdmin, true)
    assert.equal(result.access.globalActions.includes("tenants:write"), true)
    assert.equal(result.access.globalActions.includes("projects:write"), true)
    assert.deepEqual(result.access.tenants, [])
    assert.deepEqual(result.access.projects, [])
    assert.equal(result.access.globalActions.includes("users:write"), true)
    assert.equal(result.access.teams[0]?.actions.includes("endpoints:write"), true)
    assert.equal(typeof result.sessionToken, "string")
    assert.equal(result.sessionToken.length > 20, true)

    const serialized = JSON.stringify(result)
    assert.equal(serialized.includes(adminPassword), false)
    assert.equal(serialized.includes(user.passwordHash), false)
    assert.equal(serialized.includes(sessionSecret), false)
    assert.equal(serialized.includes("passwordHash"), false)
    assert.equal(serialized.includes("token"), false)
  })

  test("rejects invalid credentials and disabled users without leaking which field failed", async () => {
    const store = new TestAdminStore()
    await store.addUser({
      id: "user-1",
      email: "admin@example.com",
      name: "Admin User",
      password: adminPassword,
      status: "ACTIVE",
      globalRole: "ADMIN",
      teams: [],
    })
    await store.addUser({
      id: "user-2",
      email: "disabled@example.com",
      name: "Disabled User",
      password: adminPassword,
      status: "DISABLED",
      globalRole: "ADMIN",
      teams: [],
    })

    await assert.rejects(
      authenticateAdminUser(
        store,
        { ANVIL_SESSION_SECRET: sessionSecret },
        "admin@example.com",
        "wrong-password"
      ),
      InvalidAdminCredentialsError
    )
    await assert.rejects(
      authenticateAdminUser(
        store,
        { ANVIL_SESSION_SECRET: sessionSecret },
        "missing@example.com",
        adminPassword
      ),
      InvalidAdminCredentialsError
    )
    await assert.rejects(
      authenticateAdminUser(
        store,
        { ANVIL_SESSION_SECRET: sessionSecret },
        "disabled@example.com",
        adminPassword
      ),
      DisabledUserError
    )
  })

  test("resolves current user from cookie session by reloading database state", async () => {
    const store = new TestAdminStore()
    const user = await store.addUser({
      id: "user-1",
      email: "member@example.com",
      name: "Member User",
      password: adminPassword,
      status: "ACTIVE",
      globalRole: "MEMBER",
      teams: [
        {
          id: "team-1",
          name: "Primary Team",
          role: "VIEWER",
          status: "ACTIVE",
        },
      ],
    })
    const sessionToken = signAdminSession({ ANVIL_SESSION_SECRET: sessionSecret }, user)

    const result = await resolveCurrentAdminUser(store, { ANVIL_SESSION_SECRET: sessionSecret }, sessionToken)

    assert.deepEqual(result, {
      user: {
        id: "user-1",
        email: "member@example.com",
        name: "Member User",
        status: "ACTIVE",
        globalRole: "MEMBER",
        teams: [
          {
            id: "team-1",
            name: "Primary Team",
            role: "VIEWER",
            status: "ACTIVE",
          },
        ],
      },
      access: {
        bootstrapComplete: true,
        canAdmin: true,
        globalActions: [],
        tenants: [],
        projects: [],
        teams: [
          {
            teamId: "team-1",
            actions: ["members:read", "endpoints:read", "audit:read", "hosts:read"],
          },
        ],
      },
    })

    store.disableUser("user-1")
    await assert.rejects(
      resolveCurrentAdminUser(store, { ANVIL_SESSION_SECRET: sessionSecret }, sessionToken),
      DisabledUserError
    )
  })

  test("includes active tenant and project scopes from the backing store", async () => {
    const store = new TestAdminStore()
    const user = await store.addUser({
      id: "user-1",
      email: "tenant-user@example.com",
      name: "Tenant User",
      password: adminPassword,
      status: "ACTIVE",
      globalRole: "MEMBER",
      teams: [],
    })
    store.setTenantProjectScopes(user.id, {
      tenants: [{ tenantId: "tenant-1", status: "ACTIVE" }],
      projects: [{ projectId: "project-1", tenantId: "tenant-1", status: "ACTIVE" }],
    })
    const sessionToken = signAdminSession({ ANVIL_SESSION_SECRET: sessionSecret }, user)

    const login = await authenticateAdminUser(
      store,
      { ANVIL_SESSION_SECRET: sessionSecret },
      "tenant-user@example.com",
      adminPassword
    )
    const current = await resolveCurrentAdminUser(
      store,
      { ANVIL_SESSION_SECRET: sessionSecret },
      sessionToken
    )

    for (const result of [login, current]) {
      assert.deepEqual(result.access.tenants, [
        {
          tenantId: "tenant-1",
          actions: ["tenants:read", "projects:read", "resources:read"],
        },
      ])
      assert.deepEqual(result.access.projects, [
        {
          projectId: "project-1",
          tenantId: "tenant-1",
          actions: ["projects:read", "quotas:read", "resources:read"],
        },
      ])
      assert.equal(result.access.canAdmin, true)
    }
  })
})

type TestUserInput = AdminPrincipal & { password: string }

class TestAdminStore implements AdminDataStore {
  private bootstrapComplete: boolean
  private users = new Map<string, AdminPrincipal & { passwordHash: string }>()
  private scopes = new Map<string, TenantProjectAccessScopes>()

  constructor(options: { bootstrapComplete?: boolean } = {}) {
    this.bootstrapComplete = options.bootstrapComplete ?? true
  }

  async isBootstrapComplete(): Promise<boolean> {
    return this.bootstrapComplete
  }

  async createBootstrapAdmin(record: CreateBootstrapAdminRecord): Promise<AdminPrincipal> {
    const user = await this.addUser({
      id: "user-1",
      email: record.email,
      name: record.name,
      password: "unused because passwordHash is already provided",
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
    })
    this.users.set(user.id, { ...user, passwordHash: record.passwordHash })
    this.bootstrapComplete = true
    return user
  }

  async findUserByEmail(email: string): Promise<(AdminPrincipal & { passwordHash: string }) | null> {
    const normalizedEmail = email.trim().toLowerCase()
    return [...this.users.values()].find((user) => user.email === normalizedEmail) ?? null
  }

  async findUserById(userId: string): Promise<AdminPrincipal | null> {
    return this.users.get(userId) ?? null
  }

  async recordAudit(_entry: AdminAuditEntry): Promise<void> {}

  async getTenantProjectAccessScopes(userId: string): Promise<TenantProjectAccessScopes> {
    return this.scopes.get(userId) ?? { tenants: [], projects: [] }
  }

  async addUser(input: TestUserInput): Promise<AdminPrincipal & { passwordHash: string }> {
    const user: AdminPrincipal & { passwordHash: string } = {
      id: input.id,
      email: input.email.trim().toLowerCase(),
      name: input.name,
      status: input.status,
      globalRole: input.globalRole,
      teams: input.teams,
      passwordHash: await bcrypt.hash(input.password, 10),
    }
    this.users.set(user.id, user)
    return user
  }

  disableUser(userId: string): void {
    const user = this.users.get(userId)
    assert.ok(user)
    this.users.set(userId, { ...user, status: "DISABLED" })
  }

  setTenantProjectScopes(userId: string, scopes: TenantProjectAccessScopes): void {
    this.scopes.set(userId, scopes)
  }
}
