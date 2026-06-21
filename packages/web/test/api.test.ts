import assert from "node:assert/strict"
import { afterEach, describe, test } from "node:test"
import {
  ApiRequestError,
  bootstrapAdmin,
  createAdminEndpoint,
  createAdminUser,
  fetchAdminAudit,
  fetchAdminEndpoints,
  fetchAdminPermissionMatrix,
  fetchAdminTeams,
  fetchAdminUsers,
  fetchBootstrapStatus,
  fetchMe,
  login,
  logout,
} from "../src/lib/api.ts"

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
  test("login unwraps the M9 browser-safe session and does not expose a token", async () => {
    installJsonFetch(200, {
      user: {
        id: "bootstrap-admin",
        email: "admin@example.com",
        name: "Admin",
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
        globalActions: ["users:read", "users:write"],
        teams: [{ teamId: "team-1", actions: ["members:read", "endpoints:read"] }],
      },
    })

    const session = await login("admin@example.com", "correct-password")

    assert.deepEqual(session.user, {
      id: "bootstrap-admin",
      email: "admin@example.com",
      name: "Admin",
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
    assert.deepEqual(session.access, {
      bootstrapComplete: true,
      canAdmin: true,
      globalActions: ["users:read", "users:write"],
      teams: [{ teamId: "team-1", actions: ["members:read", "endpoints:read"] }],
    })
    assert.equal(JSON.stringify(session).includes("token"), false)
    assert.equal(JSON.stringify(session).includes("passwordHash"), false)
    assert.equal(fetchCalls[0]?.input, "/api/auth/login")
    assert.equal(fetchCalls[0]?.init?.credentials, "include")
  })

  test("fetchMe unwraps the current user session response", async () => {
    installJsonFetch(200, {
      user: {
        id: "bootstrap-admin",
        email: "admin@example.com",
        name: "Admin",
        status: "ACTIVE",
        globalRole: "ADMIN",
        teams: [],
      },
      access: {
        bootstrapComplete: true,
        canAdmin: true,
        globalActions: ["audit:read"],
        teams: [],
      },
    })

    const session = await fetchMe()

    assert.deepEqual(session.user, {
      id: "bootstrap-admin",
      email: "admin@example.com",
      name: "Admin",
      status: "ACTIVE",
      globalRole: "ADMIN",
      teams: [],
    })
    assert.deepEqual(session.access, {
      bootstrapComplete: true,
      canAdmin: true,
      globalActions: ["audit:read"],
      teams: [],
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

describe("admin API helpers", () => {
  test("bootstrap helpers use the public bootstrap contract and keep credentials in cookies", async () => {
    installJsonFetch(200, {
      bootstrapComplete: false,
      available: true,
    })

    const status = await fetchBootstrapStatus()

    assert.deepEqual(status, {
      bootstrapComplete: false,
      available: true,
    })
    assert.equal(fetchCalls[0]?.input, "/api/admin/bootstrap/status")
    assert.equal(fetchCalls[0]?.init?.credentials, "include")

    installJsonFetch(200, {
      user: {
        id: "admin-1",
        email: "admin@example.com",
        name: "Admin",
        status: "ACTIVE",
        globalRole: "ADMIN",
        teams: [],
      },
      access: {
        bootstrapComplete: true,
        canAdmin: true,
        globalActions: ["users:read"],
        teams: [],
      },
    })

    const session = await bootstrapAdmin({
      email: "admin@example.com",
      name: "Admin",
      password: "correct horse battery staple",
      teamName: "Primary Team",
    })

    assert.equal(fetchCalls[1]?.input, "/api/admin/bootstrap")
    assert.equal(fetchCalls[1]?.init?.method, "POST")
    assert.equal(fetchCalls[1]?.init?.credentials, "include")
    assert.deepEqual(JSON.parse(String(fetchCalls[1]?.init?.body)), {
      email: "admin@example.com",
      name: "Admin",
      password: "correct horse battery staple",
      teamName: "Primary Team",
    })
    assert.equal(JSON.stringify(session).includes("anvil_session"), false)
    assert.equal(JSON.stringify(session).includes("passwordHash"), false)
  })

  test("admin list helpers consume accepted backend response envelopes", async () => {
    installJsonFetch(200, {
      users: [
        {
          id: "user-1",
          email: "admin@example.com",
          name: "Admin",
          status: "ACTIVE",
          globalRole: "ADMIN",
          teams: [],
        },
      ],
    })
    assert.deepEqual((await fetchAdminUsers()).map((user) => user.email), ["admin@example.com"])
    assert.equal(fetchCalls.at(-1)?.input, "/api/admin/users")

    installJsonFetch(200, {
      teams: [{ id: "team-1", name: "Primary Team", status: "ACTIVE", members: [] }],
    })
    assert.deepEqual((await fetchAdminTeams()).map((team) => team.name), ["Primary Team"])
    assert.equal(fetchCalls.at(-1)?.input, "/api/admin/teams")

    installJsonFetch(200, {
      matrix: {
        global: [{ role: "ADMIN", actions: ["users:read"] }],
        team: [{ role: "OWNER", actions: ["members:read"] }],
      },
    })
    assert.deepEqual(await fetchAdminPermissionMatrix(), {
      global: [{ role: "ADMIN", actions: ["users:read"] }],
      team: [{ role: "OWNER", actions: ["members:read"] }],
    })
    assert.equal(fetchCalls.at(-1)?.input, "/api/admin/permissions/matrix")

    installJsonFetch(200, {
      audit: [
        {
          id: "audit-1",
          actor: { id: "admin-1", email: "admin@example.com", name: "Admin" },
          action: "endpoint.create",
          targetType: "endpoint",
          targetId: "endpoint-1",
          metadata: { token: "[REDACTED]" },
          createdAt: "2026-06-21T00:00:00.000Z",
        },
      ],
      page: { limit: 25, offset: 0, total: 1 },
    })
    const audit = await fetchAdminAudit({ targetType: "endpoint", limit: 25 })
    assert.equal(audit.audit[0]?.metadata?.token, "[REDACTED]")
    assert.equal(fetchCalls.at(-1)?.input, "/api/admin/audit?targetType=endpoint&limit=25")
  })

  test("admin mutation helpers post only to /api/admin routes and keep endpoint tokens out of responses", async () => {
    installJsonFetch(201, {
      user: {
        id: "user-1",
        email: "new@example.com",
        name: "New User",
        status: "ACTIVE",
        globalRole: "MEMBER",
        teams: [],
      },
    })

    await createAdminUser({
      email: "new@example.com",
      name: "New User",
      password: "correct horse battery staple",
      globalRole: "MEMBER",
    })
    assert.equal(fetchCalls[0]?.input, "/api/admin/users")
    assert.equal(fetchCalls[0]?.init?.method, "POST")

    installJsonFetch(201, {
      endpoint: {
        id: "endpoint-1",
        name: "Primary Agent",
        url: "wss://agent.example.com/ws",
        status: "ACTIVE",
        team: { id: "team-1", name: "Primary Team", status: "ACTIVE" },
        credentialConfigured: true,
      },
    })

    const endpoint = await createAdminEndpoint({
      name: "Primary Agent",
      url: "wss://agent.example.com/ws",
      token: "endpoint-token-that-must-not-return",
      teamId: "team-1",
    })

    assert.equal(fetchCalls[1]?.input, "/api/admin/endpoints")
    assert.equal(fetchCalls[1]?.init?.method, "POST")
    assert.equal(JSON.stringify(endpoint).includes("endpoint-token-that-must-not-return"), false)
    assert.equal("token" in endpoint, false)
    assert.equal("tokenCiphertext" in endpoint, false)
  })

  test("endpoint list helper preserves redacted credential state without accepting token aliases", async () => {
    installJsonFetch(200, {
      endpoints: [
        {
          id: "endpoint-1",
          name: "Primary Agent",
          url: "wss://agent.example.com/ws",
          status: "ACTIVE",
          team: { id: "team-1", name: "Primary Team", status: "ACTIVE" },
          credentialConfigured: true,
        },
      ],
    })

    const endpoints = await fetchAdminEndpoints()

    assert.equal(endpoints[0]?.credentialConfigured, true)
    assert.equal("token" in endpoints[0]!, false)
    assert.equal("tokenCiphertext" in endpoints[0]!, false)
  })
})
