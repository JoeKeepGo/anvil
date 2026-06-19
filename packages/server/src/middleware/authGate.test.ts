import assert from "node:assert/strict"
import { describe, test } from "node:test"
import bcrypt from "bcryptjs"
import { Hono } from "hono"
import { createAuthRoutes } from "../routes/auth"
import { requireAuth } from "./authGate"

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

async function validSessionCookie(env: NodeJS.ProcessEnv): Promise<string> {
  const authRoutes = createAuthRoutes({ env })
  const login = await authRoutes.request("/login", {
    method: "POST",
    body: JSON.stringify({ email: "admin@example.com", password: adminPassword }),
    headers: { "content-type": "application/json" },
  })

  return sessionCookie(login)
}

describe("auth gate middleware", () => {
  test("allows a protected route with a valid session cookie", async () => {
    const env = await authEnv()
    const app = new Hono()
    app.use("/api/protected", requireAuth({ env }))
    app.get("/api/protected", (c) => c.json({ ok: true }))

    const response = await app.request("/api/protected", {
      headers: { cookie: await validSessionCookie(env) },
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await readJson(response), { ok: true })
  })

  test("rejects missing or malformed session cookies before protected handlers run", async () => {
    const env = await authEnv()
    const app = new Hono()
    let handlerCalls = 0
    app.use("/api/protected", requireAuth({ env }))
    app.get("/api/protected", (c) => {
      handlerCalls += 1
      return c.json({ ok: true })
    })

    const missing = await app.request("/api/protected")
    const tampered = await app.request("/api/protected", {
      headers: { cookie: "anvil_session=tampered" },
    })
    const malformed = await app.request("/api/protected", {
      headers: { cookie: "anvil_session=%E0%A4%A" },
    })

    for (const response of [missing, tampered, malformed]) {
      assert.equal(response.status, 401)
      assert.deepEqual(await readJson(response), {
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication is required.",
          details: {},
        },
      })
    }
    assert.equal(handlerCalls, 0)
  })

  test("maps missing auth configuration to a safe config error before session checks", async () => {
    const app = new Hono()
    app.use("/api/protected", requireAuth({ env: {} }))
    app.get("/api/protected", (c) => c.json({ ok: true }))

    const missingCookie = await app.request("/api/protected")
    const invalidCookie = await app.request("/api/protected", {
      headers: { cookie: "anvil_session=anything" },
    })

    for (const response of [missingCookie, invalidCookie]) {
      assert.equal(response.status, 500)
      assert.deepEqual(await readJson(response), {
        error: {
          code: "AUTH_CONFIG_ERROR",
          message: "Authentication is not configured.",
          details: {},
        },
      })
    }
  })
})
