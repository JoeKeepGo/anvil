import assert from "node:assert/strict"
import { describe, test } from "node:test"
import bcrypt from "bcryptjs"
import { createAuthRoutes } from "./auth"
import { globalAdminActions, teamOwnerActions } from "../services/admin/permissions"
import type {
  AdminAuditEntry,
  AdminDataStore,
  AdminPrincipal,
  CreateBootstrapAdminRecord,
} from "../services/admin/session"

const adminPassword = "correct horse battery staple"
const sessionSecret = "test-session-secret-with-enough-entropy"

async function authEnv(overrides: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> {
  return {
    ANVIL_BOOTSTRAP_ADMIN_EMAIL: "admin@example.com",
    ANVIL_BOOTSTRAP_ADMIN_NAME: "Admin",
    ANVIL_BOOTSTRAP_ADMIN_PASSWORD_HASH: await bcrypt.hash(adminPassword, 10),
    ANVIL_SESSION_SECRET: sessionSecret,
    ...overrides,
  }
}

async function readJson(response: Response) {
  return (await response.json()) as unknown
}

function sessionCookie(response: Response): string {
  const setCookie = response.headers.get("set-cookie") ?? ""
  const [cookie] = setCookie.split(";")
  return cookie
}

function assertExpiredSessionCookie(response: Response): string {
  const setCookie = response.headers.get("set-cookie") ?? ""

  assert.match(setCookie, /^anvil_session=/)
  assert.match(setCookie, /HttpOnly/i)
  assert.match(setCookie, /SameSite=Lax/i)
  assert.match(setCookie, /Path=\//i)
  assert.match(setCookie, /Max-Age=0/i)

  return sessionCookie(response)
}

describe("auth routes", () => {
  test("app mounts database-backed auth and admin bootstrap routes", async () => {
    const originalNodeEnv = process.env.NODE_ENV
    const originalEnv = {
      ANVIL_SESSION_SECRET: process.env.ANVIL_SESSION_SECRET,
      DATABASE_URL: process.env.DATABASE_URL,
    }

    process.env.NODE_ENV = "test"
    delete process.env.ANVIL_SESSION_SECRET
    delete process.env.DATABASE_URL

    try {
      const { app } = await import("../index")
      const response = await app.request("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "admin@example.com", password: adminPassword }),
        headers: { "content-type": "application/json" },
      })

      assert.equal(response.status, 500)
      assert.deepEqual(await readJson(response), {
        error: {
          code: "AUTH_CONFIG_ERROR",
          message: "Authentication is not configured.",
          details: {},
        },
      })

      const bootstrapStatus = await app.request("/api/admin/bootstrap/status")
      assert.equal(bootstrapStatus.status, 500)
      assert.deepEqual(await readJson(bootstrapStatus), {
        error: {
          code: "AUTH_CONFIG_ERROR",
          message: "Authentication is not configured.",
          details: {},
        },
      })
    } finally {
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

  test("POST /login validates request body", async () => {
    const routes = createAuthRoutes({ env: await authEnv() })

    const response = await routes.request("/login", {
      method: "POST",
      body: JSON.stringify({ email: "admin@example.com" }),
      headers: { "content-type": "application/json" },
    })

    assert.equal(response.status, 400)
    assert.deepEqual(await readJson(response), {
      error: {
        code: "INVALID_AUTH_REQUEST",
        message: "Email and password are required.",
        details: {},
      },
    })
  })

  test("POST /login returns a user and sets an HTTP-only session cookie", async () => {
    const routes = createAuthRoutes({ env: await authEnv() })

    const response = await routes.request("/login", {
      method: "POST",
      body: JSON.stringify({ email: "admin@example.com", password: adminPassword }),
      headers: { "content-type": "application/json" },
    })
    const body = await readJson(response)
    const setCookie = response.headers.get("set-cookie") ?? ""

    assert.equal(response.status, 200)
    assert.deepEqual(body, {
      user: {
        id: "bootstrap-admin",
        email: "admin@example.com",
        name: "Admin",
        role: "ADMIN",
      },
    })
    assert.match(setCookie, /^anvil_session=/)
    assert.match(setCookie, /HttpOnly/i)
    assert.match(setCookie, /SameSite=Lax/i)
    assert.match(setCookie, /Path=\//i)
    assert.match(setCookie, /Max-Age=28800/i)
    assert.equal(JSON.stringify(body).includes(adminPassword), false)
    assert.equal(JSON.stringify(body).includes(sessionSecret), false)
    assert.equal(JSON.stringify(body).includes("anvil_session"), false)
  })

  test("POST /login uses database users and returns browser-safe capabilities when a store is provided", async () => {
    const store = new TestAdminStore()
    const admin = await store.addUser({
      id: "user-1",
      email: "admin@example.com",
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
    const routes = createAuthRoutes({ env: { ANVIL_SESSION_SECRET: sessionSecret }, store })

    const response = await routes.request("/login", {
      method: "POST",
      body: JSON.stringify({ email: "Admin@Example.com", password: adminPassword }),
      headers: { "content-type": "application/json" },
    })
    const body = await readJson(response)
    const setCookie = response.headers.get("set-cookie") ?? ""

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
        globalActions: globalAdminActions,
        tenants: [],
        projects: [],
        teams: [
          {
            teamId: "team-1",
            actions: teamOwnerActions,
          },
        ],
      },
    })
    assert.match(setCookie, /^anvil_session=/)
    assert.match(setCookie, /HttpOnly/i)
    assert.match(setCookie, /SameSite=Lax/i)
    assert.match(setCookie, /Path=\//i)
    assert.match(setCookie, /Max-Age=28800/i)

    const serialized = JSON.stringify(body)
    assert.equal(serialized.includes(adminPassword), false)
    assert.equal(serialized.includes(admin.passwordHash), false)
    assert.equal(serialized.includes(sessionSecret), false)
    assert.equal(serialized.includes("passwordHash"), false)
    assert.equal(serialized.includes("token"), false)
    assert.equal(serialized.includes("private"), false)
  })

  test("POST /login blocks database login before bootstrap and disabled users safely", async () => {
    const incompleteStore = new TestAdminStore({ bootstrapComplete: false })
    const incompleteRoutes = createAuthRoutes({
      env: { ANVIL_SESSION_SECRET: sessionSecret },
      store: incompleteStore,
    })
    const incomplete = await incompleteRoutes.request("/login", {
      method: "POST",
      body: JSON.stringify({ email: "admin@example.com", password: adminPassword }),
      headers: { "content-type": "application/json" },
    })

    assert.equal(incomplete.status, 403)
    assert.deepEqual(await readJson(incomplete), {
      error: {
        code: "BOOTSTRAP_REQUIRED",
        message: "Bootstrap must be completed before login.",
        details: {},
      },
    })

    const store = new TestAdminStore()
    await store.addUser({
      id: "user-1",
      email: "disabled@example.com",
      name: "Disabled User",
      password: adminPassword,
      status: "DISABLED",
      globalRole: "ADMIN",
      teams: [],
    })
    const routes = createAuthRoutes({ env: { ANVIL_SESSION_SECRET: sessionSecret }, store })
    const disabled = await routes.request("/login", {
      method: "POST",
      body: JSON.stringify({ email: "disabled@example.com", password: adminPassword }),
      headers: { "content-type": "application/json" },
    })

    assert.equal(disabled.status, 403)
    assert.deepEqual(await readJson(disabled), {
      error: {
        code: "USER_DISABLED",
        message: "User is disabled.",
        details: {},
      },
    })
  })

  test("POST /login maps auth config and credential failures to safe errors", async () => {
    const missingConfig = createAuthRoutes({ env: {} })
    const missingConfigResponse = await missingConfig.request("/login", {
      method: "POST",
      body: JSON.stringify({ email: "admin@example.com", password: adminPassword }),
      headers: { "content-type": "application/json" },
    })

    assert.equal(missingConfigResponse.status, 500)
    assert.deepEqual(await readJson(missingConfigResponse), {
      error: {
        code: "AUTH_CONFIG_ERROR",
        message: "Authentication is not configured.",
        details: {},
      },
    })

    const routes = createAuthRoutes({ env: await authEnv() })
    const invalidResponse = await routes.request("/login", {
      method: "POST",
      body: JSON.stringify({ email: "admin@example.com", password: "wrong-password" }),
      headers: { "content-type": "application/json" },
    })

    assert.equal(invalidResponse.status, 401)
    assert.deepEqual(await readJson(invalidResponse), {
      error: {
        code: "INVALID_CREDENTIALS",
        message: "Invalid email or password.",
        details: {},
      },
    })
  })

  test("GET /me returns current user for a valid cookie", async () => {
    const routes = createAuthRoutes({ env: await authEnv() })
    const login = await routes.request("/login", {
      method: "POST",
      body: JSON.stringify({ email: "admin@example.com", password: adminPassword }),
      headers: { "content-type": "application/json" },
    })

    const response = await routes.request("/me", {
      headers: { cookie: sessionCookie(login) },
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await readJson(response), {
      user: {
        id: "bootstrap-admin",
        email: "admin@example.com",
        name: "Admin",
        role: "ADMIN",
      },
    })
  })

  test("GET /me reloads database user state and returns safe capabilities when a store is provided", async () => {
    const store = new TestAdminStore()
    await store.addUser({
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
    const routes = createAuthRoutes({ env: { ANVIL_SESSION_SECRET: sessionSecret }, store })
    const login = await routes.request("/login", {
      method: "POST",
      body: JSON.stringify({ email: "member@example.com", password: adminPassword }),
      headers: { "content-type": "application/json" },
    })

    const response = await routes.request("/me", {
      headers: { cookie: sessionCookie(login) },
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await readJson(response), {
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
    const disabled = await routes.request("/me", {
      headers: { cookie: sessionCookie(login) },
    })

    assert.equal(disabled.status, 403)
    assert.deepEqual(await readJson(disabled), {
      error: {
        code: "USER_DISABLED",
        message: "User is disabled.",
        details: {},
      },
    })
  })

  test("POST /logout returns safe success and clears the session cookie without requiring a cookie", async () => {
    const routes = createAuthRoutes({ env: await authEnv() })

    const response = await routes.request("/logout", { method: "POST" })
    const body = await readJson(response)

    assert.equal(response.status, 200)
    assert.deepEqual(body, { ok: true })
    assertExpiredSessionCookie(response)

    const serializedBody = JSON.stringify(body)
    assert.equal(serializedBody.includes("anvil_session"), false)
    assert.equal(serializedBody.includes(adminPassword), false)
    assert.equal(serializedBody.includes(sessionSecret), false)
    assert.equal(serializedBody.includes("password"), false)
    assert.equal(serializedBody.includes("secret"), false)
    assert.equal(serializedBody.includes("authorization"), false)
  })

  test("POST /logout is idempotent for valid, invalid, and malformed cookies", async () => {
    const routes = createAuthRoutes({ env: await authEnv() })
    const login = await routes.request("/login", {
      method: "POST",
      body: JSON.stringify({ email: "admin@example.com", password: adminPassword }),
      headers: { "content-type": "application/json" },
    })

    const valid = await routes.request("/logout", {
      method: "POST",
      headers: { cookie: sessionCookie(login) },
    })
    const invalid = await routes.request("/logout", {
      method: "POST",
      headers: { cookie: "anvil_session=tampered" },
    })
    const malformed = await routes.request("/logout", {
      method: "POST",
      headers: { cookie: "anvil_session=%E0%A4%A" },
    })

    for (const response of [valid, invalid, malformed]) {
      assert.equal(response.status, 200)
      assert.deepEqual(await readJson(response), { ok: true })
      assertExpiredSessionCookie(response)
    }
  })

  test("GET /me rejects the expired cookie returned by logout after a valid login", async () => {
    const routes = createAuthRoutes({ env: await authEnv() })
    const login = await routes.request("/login", {
      method: "POST",
      body: JSON.stringify({ email: "admin@example.com", password: adminPassword }),
      headers: { "content-type": "application/json" },
    })

    const logout = await routes.request("/logout", {
      method: "POST",
      headers: { cookie: sessionCookie(login) },
    })
    const response = await routes.request("/me", {
      headers: { cookie: assertExpiredSessionCookie(logout) },
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

  test("GET /me rejects missing or invalid session cookies", async () => {
    const routes = createAuthRoutes({ env: await authEnv() })

    const missing = await routes.request("/me")
    const invalid = await routes.request("/me", {
      headers: { cookie: "anvil_session=tampered" },
    })
    const malformed = await routes.request("/me", {
      headers: { cookie: "anvil_session=%E0%A4%A" },
    })

    for (const response of [missing, invalid, malformed]) {
      assert.equal(response.status, 401)
      assert.deepEqual(await readJson(response), {
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication is required.",
          details: {},
        },
      })
    }
  })

  test("app leaves health and auth endpoints public while mapping missing auth config safely", async () => {
    const originalNodeEnv = process.env.NODE_ENV
    const originalAuthEnv = {
      ANVIL_BOOTSTRAP_ADMIN_EMAIL: process.env.ANVIL_BOOTSTRAP_ADMIN_EMAIL,
      ANVIL_BOOTSTRAP_ADMIN_NAME: process.env.ANVIL_BOOTSTRAP_ADMIN_NAME,
      ANVIL_BOOTSTRAP_ADMIN_PASSWORD_HASH: process.env.ANVIL_BOOTSTRAP_ADMIN_PASSWORD_HASH,
      ANVIL_SESSION_SECRET: process.env.ANVIL_SESSION_SECRET,
    }

    process.env.NODE_ENV = "test"
    delete process.env.ANVIL_BOOTSTRAP_ADMIN_EMAIL
    delete process.env.ANVIL_BOOTSTRAP_ADMIN_NAME
    delete process.env.ANVIL_BOOTSTRAP_ADMIN_PASSWORD_HASH
    delete process.env.ANVIL_SESSION_SECRET

    try {
      const { app } = await import("../index")

      const health = await app.request("/api/health")
      const authMe = await app.request("/api/auth/me")
      const authLogout = await app.request("/api/auth/logout", { method: "POST" })
      const server = await app.request("/api/server")
      const hostHealth = await app.request("/api/host/health")
      const instances = await app.request("/api/instances")
      const instanceDetail = await app.request("/api/instances/nonexistent")
      const images = await app.request("/api/images")
      const operations = await app.request("/api/operations")
      const settings = await app.request("/api/settings/agent-endpoints")

      assert.equal(health.status, 200)
      assert.deepEqual(await readJson(health), { status: "ok" })

      assert.equal(authMe.status, 401)
      assert.deepEqual(await readJson(authMe), {
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication is required.",
          details: {},
        },
      })

      assert.equal(authLogout.status, 200)
      assert.deepEqual(await readJson(authLogout), { ok: true })
      assertExpiredSessionCookie(authLogout)

      for (const response of [
        server,
        hostHealth,
        instances,
        instanceDetail,
        images,
        operations,
        settings,
      ]) {
        assert.equal(response.status, 500)
        assert.deepEqual(await readJson(response), {
          error: {
            code: "AUTH_CONFIG_ERROR",
            message: "Authentication is not configured.",
            details: {},
          },
        })
      }
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = originalNodeEnv
      }

      for (const [key, value] of Object.entries(originalAuthEnv)) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }
  })

  test("app protects browser-facing product APIs with configured auth", async () => {
    const originalNodeEnv = process.env.NODE_ENV
    const originalAuthEnv = {
      ANVIL_BOOTSTRAP_ADMIN_EMAIL: process.env.ANVIL_BOOTSTRAP_ADMIN_EMAIL,
      ANVIL_BOOTSTRAP_ADMIN_NAME: process.env.ANVIL_BOOTSTRAP_ADMIN_NAME,
      ANVIL_BOOTSTRAP_ADMIN_PASSWORD_HASH: process.env.ANVIL_BOOTSTRAP_ADMIN_PASSWORD_HASH,
      ANVIL_SESSION_SECRET: process.env.ANVIL_SESSION_SECRET,
    }

    process.env.NODE_ENV = "test"
    Object.assign(process.env, await authEnv())

    try {
      const { app } = await import("../index")

      const server = await app.request("/api/server")
      const hostHealth = await app.request("/api/host/health")
      const instances = await app.request("/api/instances")
      const instanceDetail = await app.request("/api/instances/nonexistent")
      const images = await app.request("/api/images")
      const operations = await app.request("/api/operations")
      const settings = await app.request("/api/settings/agent-endpoints")
      const instanceCreate = await app.request("/api/instances", { method: "POST" })
      const instanceStart = await app.request("/api/instances/example/start", { method: "POST" })
      const settingsPost = await app.request("/api/settings/agent-endpoints", { method: "POST" })

      for (const response of [
        server,
        hostHealth,
        instances,
        instanceDetail,
        images,
        operations,
        settings,
        instanceCreate,
        instanceStart,
        settingsPost,
      ]) {
        assert.equal(response.status, 401)
        assert.deepEqual(await readJson(response), {
          error: {
            code: "UNAUTHENTICATED",
            message: "Authentication is required.",
            details: {},
          },
        })
      }
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = originalNodeEnv
      }

      for (const [key, value] of Object.entries(originalAuthEnv)) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }
  })

  test("app reloads database users before product API handlers and rejects disabled or stale sessions", async () => {
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
    const { createApp } = await import("../index")
    const app = createApp({
      env: { ANVIL_SESSION_SECRET: sessionSecret },
      adminStore: store,
    })

    const login = await app.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "admin@example.com", password: adminPassword }),
      headers: { "content-type": "application/json" },
    })
    const cookie = sessionCookie(login)
    const allowed = await app.request("/api/server", { headers: { cookie } })

    assert.equal(login.status, 200)
    assert.equal(allowed.status, 200)
    assert.deepEqual(await readJson(allowed), {
      version: "0.1.0",
      api_version: "1.0",
      environment: {
        server_name: "Anvil",
        kernel: "",
        os_name: "",
      },
    })

    store.disableUser("user-1")
    const disabled = await app.request("/api/server", { headers: { cookie } })

    assert.equal(disabled.status, 403)
    assert.deepEqual(await readJson(disabled), {
      error: {
        code: "USER_DISABLED",
        message: "User is disabled.",
        details: {},
      },
    })

    store.enableUser("user-1")
    store.renameUser("user-1", "Renamed Admin")
    const stale = await app.request("/api/server", { headers: { cookie } })

    assert.equal(stale.status, 401)
    assert.deepEqual(await readJson(stale), {
      error: {
        code: "UNAUTHENTICATED",
        message: "Authentication is required.",
        details: {},
      },
    })
  })
})

type TestUserInput = AdminPrincipal & { password: string }

class TestAdminStore implements AdminDataStore {
  private bootstrapComplete: boolean
  private users = new Map<string, AdminPrincipal & { passwordHash: string }>()

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
      password: "unused",
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

  enableUser(userId: string): void {
    const user = this.users.get(userId)
    assert.ok(user)
    this.users.set(userId, { ...user, status: "ACTIVE" })
  }

  renameUser(userId: string, name: string): void {
    const user = this.users.get(userId)
    assert.ok(user)
    this.users.set(userId, { ...user, name })
  }
}
