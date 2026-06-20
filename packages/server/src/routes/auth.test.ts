import assert from "node:assert/strict"
import { describe, test } from "node:test"
import bcrypt from "bcryptjs"
import { createAuthRoutes } from "./auth"

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
  test("app mounts POST /api/auth/login", async () => {
    const originalNodeEnv = process.env.NODE_ENV
    const originalSessionSecret = process.env.ANVIL_SESSION_SECRET

    process.env.NODE_ENV = "test"
    delete process.env.ANVIL_SESSION_SECRET

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
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = originalNodeEnv
      }

      if (originalSessionSecret === undefined) {
        delete process.env.ANVIL_SESSION_SECRET
      } else {
        process.env.ANVIL_SESSION_SECRET = originalSessionSecret
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
})
