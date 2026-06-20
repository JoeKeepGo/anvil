import assert from "node:assert/strict"
import { afterEach, describe, test } from "node:test"
import { ApiRequestError, fetchMe, login, logout } from "../src/lib/api.ts"

type FetchCall = {
  input: string | URL | Request
  init?: RequestInit
}

const originalFetch = globalThis.fetch
const fetchCalls: FetchCall[] = []

function installJsonFetch(status: number, body: unknown) {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ input, init })

    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      })
    )
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = originalFetch
  fetchCalls.length = 0
})

describe("auth API helpers", () => {
  test("login unwraps the browser-safe user and does not expose a token", async () => {
    installJsonFetch(200, {
      user: {
        id: "bootstrap-admin",
        email: "admin@example.com",
        name: "Admin",
        role: "ADMIN",
      },
    })

    const user = await login("admin@example.com", "correct-password")

    assert.deepEqual(user, {
      id: "bootstrap-admin",
      email: "admin@example.com",
      name: "Admin",
      role: "ADMIN",
    })
    assert.equal("token" in user, false)
    assert.equal(fetchCalls[0]?.input, "/api/auth/login")
    assert.equal(fetchCalls[0]?.init?.credentials, "include")
  })

  test("fetchMe unwraps the current user response", async () => {
    installJsonFetch(200, {
      user: {
        id: "bootstrap-admin",
        email: "admin@example.com",
        name: "Admin",
        role: "ADMIN",
      },
    })

    const user = await fetchMe()

    assert.deepEqual(user, {
      id: "bootstrap-admin",
      email: "admin@example.com",
      name: "Admin",
      role: "ADMIN",
    })
    assert.equal(fetchCalls[0]?.input, "/api/auth/me")
    assert.equal(fetchCalls[0]?.init?.credentials, "include")
  })

  test("logout posts to the backend logout endpoint with credentials and returns no session data", async () => {
    installJsonFetch(200, { ok: true })

    const result = await logout()

    assert.equal(result, undefined)
    assert.equal(fetchCalls[0]?.input, "/api/auth/logout")
    assert.equal(fetchCalls[0]?.init?.method, "POST")
    assert.equal(fetchCalls[0]?.init?.credentials, "include")
  })

  test("logout errors preserve safe backend error code and HTTP status", async () => {
    installJsonFetch(503, {
      error: {
        code: "AUTH_UNAVAILABLE",
        message: "Authentication is temporarily unavailable.",
        details: {},
      },
    })

    await assert.rejects(() => logout(), {
      name: "ApiRequestError",
      code: "AUTH_UNAVAILABLE",
      status: 503,
      message: "Authentication is temporarily unavailable.",
    } satisfies Partial<ApiRequestError>)
  })

  test("auth errors preserve safe backend error code and HTTP status", async () => {
    installJsonFetch(401, {
      error: {
        code: "INVALID_CREDENTIALS",
        message: "Invalid email or password.",
        details: {},
      },
    })

    await assert.rejects(() => login("admin@example.com", "wrong-password"), {
      name: "ApiRequestError",
      code: "INVALID_CREDENTIALS",
      status: 401,
      message: "Invalid email or password.",
    } satisfies Partial<ApiRequestError>)
  })
})
