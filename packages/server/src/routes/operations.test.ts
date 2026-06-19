import assert from "node:assert/strict"
import { describe, test } from "node:test"
import bcrypt from "bcryptjs"
import { AgentTimeoutError, type AgentRequest, type AgentResponse } from "../services/agent"
import { createAuthRoutes } from "./auth"
import { createOperationRoutes } from "./operations"

const adminPassword = "correct horse battery staple"

async function readJson(response: Response) {
  return (await response.json()) as unknown
}

async function authEnv(overrides: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> {
  return {
    ANVIL_BOOTSTRAP_ADMIN_EMAIL: "admin@example.com",
    ANVIL_BOOTSTRAP_ADMIN_NAME: "Admin",
    ANVIL_BOOTSTRAP_ADMIN_PASSWORD_HASH: await bcrypt.hash(adminPassword, 10),
    ANVIL_SESSION_SECRET: "test-session-secret-with-enough-entropy",
    ...overrides,
  }
}

async function validSessionCookie(env: NodeJS.ProcessEnv): Promise<string> {
  const authRoutes = createAuthRoutes({ env })
  const login = await authRoutes.request("/login", {
    method: "POST",
    body: JSON.stringify({ email: "admin@example.com", password: adminPassword }),
    headers: { "content-type": "application/json" },
  })
  const setCookie = login.headers.get("set-cookie") ?? ""
  const [cookie] = setCookie.split(";")
  return cookie
}

describe("operation routes", () => {
  test("app protects and mounts GET /api/operations", async () => {
    const originalNodeEnv = process.env.NODE_ENV
    const originalEnv = {
      ANVIL_AGENT_URL: process.env.ANVIL_AGENT_URL,
      ANVIL_BOOTSTRAP_ADMIN_EMAIL: process.env.ANVIL_BOOTSTRAP_ADMIN_EMAIL,
      ANVIL_BOOTSTRAP_ADMIN_NAME: process.env.ANVIL_BOOTSTRAP_ADMIN_NAME,
      ANVIL_BOOTSTRAP_ADMIN_PASSWORD_HASH: process.env.ANVIL_BOOTSTRAP_ADMIN_PASSWORD_HASH,
      ANVIL_SESSION_SECRET: process.env.ANVIL_SESSION_SECRET,
    }

    process.env.NODE_ENV = "test"
    Object.assign(process.env, await authEnv())
    delete process.env.ANVIL_AGENT_URL

    try {
      const { app } = await import("../index")
      const unauthenticated = await app.request("/api/operations")
      const authenticated = await app.request("/api/operations", {
        headers: { cookie: await validSessionCookie(process.env) },
      })

      assert.equal(unauthenticated.status, 401)
      assert.deepEqual(await readJson(unauthenticated), {
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication is required.",
          details: {},
        },
      })

      assert.equal(authenticated.status, 500)
      assert.deepEqual(await readJson(authenticated), {
        error: {
          code: "AGENT_CONFIG_ERROR",
          message: "Agent configuration error",
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

  test("GET /operations returns the normalized operations contract", async () => {
    const calls: AgentRequest[] = []
    const route = createOperationRoutes({
      env: {
        ANVIL_AGENT_URL: "ws://127.0.0.1:19090/ws",
        ANVIL_AGENT_TOKEN: "secret-token",
      },
      createClient: () => ({
        execute: async (request) => {
          calls.push(request)
          return operationResponse({})
        },
      }),
    })

    const response = await route.request("/operations")
    const body = await readJson(response)

    assert.equal(response.status, 200)
    assert.deepEqual(calls, [{ method: "GET", path: "/1.0/operations" }])
    assert.deepEqual(body, { operations: [] })
    assert.equal(JSON.stringify(body).includes("secret-token"), false)
  })

  test("GET /operations maps missing config to documented error shape", async () => {
    const route = createOperationRoutes({ env: {} })
    const response = await route.request("/operations")

    assert.equal(response.status, 500)
    assert.deepEqual(await readJson(response), {
      error: {
        code: "AGENT_CONFIG_ERROR",
        message: "Agent configuration error",
        details: {},
      },
    })
  })

  test("GET /operations maps agent timeout to documented error shape", async () => {
    const route = createOperationRoutes({
      env: { ANVIL_AGENT_URL: "ws://127.0.0.1:19090/ws" },
      createClient: () => ({
        execute: async () => {
          throw new AgentTimeoutError("agent request timed out")
        },
      }),
    })

    const response = await route.request("/operations")

    assert.equal(response.status, 503)
    assert.deepEqual(await readJson(response), {
      error: {
        code: "AGENT_UNAVAILABLE",
        message: "Agent unavailable",
        details: {},
      },
    })
  })

  test("GET /operations maps upstream non-2xx to documented error shape", async () => {
    const route = createOperationRoutes({
      env: { ANVIL_AGENT_URL: "ws://127.0.0.1:19090/ws" },
      createClient: () => ({
        execute: async () => ({
          id: "operations-response",
          status: 500,
          body: { metadata: [], rawSecret: "do-not-return" },
        }),
      }),
    })

    const response = await route.request("/operations")

    assert.equal(response.status, 502)
    assert.deepEqual(await readJson(response), {
      error: {
        code: "AGENT_UPSTREAM_ERROR",
        message: "Agent upstream error",
        details: {},
      },
    })
  })

  test("GET /operations maps malformed upstream responses to documented error shape", async () => {
    const route = createOperationRoutes({
      env: { ANVIL_AGENT_URL: "ws://127.0.0.1:19090/ws" },
      createClient: () => ({
        execute: async () => ({
          id: "operations-response",
          status: 200,
          body: { type: "sync", status: "Success", status_code: 200, metadata: "invalid" },
        }),
      }),
    })

    const response = await route.request("/operations")

    assert.equal(response.status, 502)
    assert.deepEqual(await readJson(response), {
      error: {
        code: "MALFORMED_UPSTREAM_RESPONSE",
        message: "Malformed upstream response",
        details: {},
      },
    })
  })

  test("operation control routes are not mounted", async () => {
    const route = createOperationRoutes({
      env: { ANVIL_AGENT_URL: "ws://127.0.0.1:19090/ws" },
      createClient: () => ({
        execute: async () => {
          throw new Error("unexpected agent request")
        },
      }),
    })

    for (const request of [
      new Request("http://example.test/operations/operation-id", { method: "DELETE" }),
      new Request("http://example.test/operations/operation-id/cancel", { method: "POST" }),
      new Request("http://example.test/operations/operation-id/wait", { method: "POST" }),
      new Request("http://example.test/operations/operation-id/retry", { method: "POST" }),
    ]) {
      const response = await route.fetch(request)
      assert.equal(response.status, 404)
    }
  })
})

function operationResponse(metadata: unknown): AgentResponse {
  return {
    id: "operations-response",
    status: 200,
    body: {
      type: "sync",
      status: "Success",
      status_code: 200,
      metadata,
    },
  }
}
