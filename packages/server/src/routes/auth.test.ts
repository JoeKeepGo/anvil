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
})
