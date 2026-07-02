import assert from "node:assert/strict"
import { describe, test } from "node:test"
import bcrypt from "bcryptjs"
import { AgentTimeoutError, type AgentRequest, type AgentResponse } from "../services/agent"
import type {
  AdminAuditEntry,
  AdminDataStore,
  AdminPrincipal,
  CreateBootstrapAdminRecord,
} from "../services/admin/session"
import { createImageRoutes } from "./images"

const adminPassword = "correct horse battery staple"
const sessionSecret = "test-session-secret-with-enough-entropy"

async function readJson(response: Response) {
  return (await response.json()) as unknown
}

async function validSessionCookie(app: { request: HonoRequest }): Promise<string> {
  const login = await app.request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "admin@example.com", password: adminPassword }),
    headers: { "content-type": "application/json" },
  })
  const setCookie = login.headers.get("set-cookie") ?? ""
  const [cookie] = setCookie.split(";")
  return cookie
}

describe("image routes", () => {
  test("app protects and mounts GET /api/images", async () => {
    const originalNodeEnv = process.env.NODE_ENV
    const originalEnv = {
      ANVIL_AGENT_URL: process.env.ANVIL_AGENT_URL,
      ANVIL_SESSION_SECRET: process.env.ANVIL_SESSION_SECRET,
    }

    process.env.NODE_ENV = "test"
    process.env.ANVIL_SESSION_SECRET = sessionSecret
    delete process.env.ANVIL_AGENT_URL

    try {
      const { createApp } = await import("../index")
      const app = createApp({
        env: process.env,
        adminStore: await TestAdminStore.withAdminUser(),
      })
      const unauthenticated = await app.request("/api/images")
      const authenticated = await app.request("/api/images", {
        headers: { cookie: await validSessionCookie(app) },
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

  test("GET /images is mounted and returns the normalized images contract", async () => {
    const calls: AgentRequest[] = []
    const route = createImageRoutes({
      env: {
        ANVIL_AGENT_URL: "ws://127.0.0.1:19090/ws",
        ANVIL_AGENT_TOKEN: "secret-token",
      },
      createClient: () => ({
        execute: async (request) => {
          calls.push(request)
          return imageResponse([])
        },
      }),
    })

    const response = await route.request("/images")
    const body = await readJson(response)

    assert.equal(response.status, 200)
    assert.deepEqual(calls, [{ method: "GET", path: "/1.0/images?recursion=1" }])
    assert.deepEqual(body, { images: [] })
    assert.equal(JSON.stringify(body).includes("secret-token"), false)
  })

  test("GET /images returns browser-safe image runtime policy fields", async () => {
    const route = createImageRoutes({
      env: { ANVIL_AGENT_URL: "ws://127.0.0.1:19090/ws" },
      createClient: () => ({
        execute: async () =>
          imageResponse([
            {
              fingerprint: "image-fingerprint",
              aliases: [{ name: "anvil-m13-smoke-image", description: "" }],
              architecture: "x86_64",
              auto_update: false,
              cached: false,
              created_at: "2026-06-25T00:00:00Z",
              expires_at: "1970-01-01T00:00:00Z",
              last_used_at: "2026-06-28T06:54:41.216264267Z",
              properties: {
                description: "Alpine 3.22 amd64 (20260625_13:14)",
                "requirements.secureboot": "false",
                secret: "do-not-return",
              },
              public: false,
              size: 70189968,
              type: "virtual-machine",
              uploaded_at: "2026-06-28T03:17:58.413550343Z",
            },
          ]),
      }),
    })

    const response = await route.request("/images")
    const body = await readJson(response)

    assert.equal(response.status, 200)
    assert.deepEqual(body, {
      images: [
        {
          fingerprint: "image-fingerprint",
          aliases: [{ name: "anvil-m13-smoke-image", description: "" }],
          description: "Alpine 3.22 amd64 (20260625_13:14)",
          architecture: "x86_64",
          type: "virtual-machine",
          sizeBytes: 70189968,
          cached: false,
          public: false,
          autoUpdate: false,
          createdAt: "2026-06-25T00:00:00Z",
          expiresAt: "1970-01-01T00:00:00Z",
          lastUsedAt: "2026-06-28T06:54:41.216264267Z",
          uploadedAt: "2026-06-28T03:17:58.413550343Z",
          runtimePolicy: {
            secureBoot: { requirement: "UNSUPPORTED", source: "incus-image-property" },
            createEligible: true,
            createBlockedReason: null,
          },
        },
      ],
    })
    assert.equal(JSON.stringify(body).includes("do-not-return"), false)
    assert.equal(JSON.stringify(body).includes("properties"), false)
  })

  test("GET /images maps missing config to documented error shape", async () => {
    const route = createImageRoutes({ env: {} })
    const response = await route.request("/images")

    assert.equal(response.status, 500)
    assert.deepEqual(await readJson(response), {
      error: {
        code: "AGENT_CONFIG_ERROR",
        message: "Agent configuration error",
        details: {},
      },
    })
  })

  test("GET /images maps agent timeout to documented error shape", async () => {
    const route = createImageRoutes({
      env: { ANVIL_AGENT_URL: "ws://127.0.0.1:19090/ws" },
      createClient: () => ({
        execute: async () => {
          throw new AgentTimeoutError("agent request timed out")
        },
      }),
    })

    const response = await route.request("/images")

    assert.equal(response.status, 503)
    assert.deepEqual(await readJson(response), {
      error: {
        code: "AGENT_UNAVAILABLE",
        message: "Agent unavailable",
        details: {},
      },
    })
  })

  test("GET /images maps upstream non-2xx to documented error shape", async () => {
    const route = createImageRoutes({
      env: { ANVIL_AGENT_URL: "ws://127.0.0.1:19090/ws" },
      createClient: () => ({
        execute: async () => ({
          id: "images-response",
          status: 500,
          body: { metadata: [], rawSecret: "do-not-return" },
        }),
      }),
    })

    const response = await route.request("/images")

    assert.equal(response.status, 502)
    assert.deepEqual(await readJson(response), {
      error: {
        code: "AGENT_UPSTREAM_ERROR",
        message: "Agent upstream error",
        details: {},
      },
    })
  })

  test("GET /images maps malformed upstream responses to documented error shape", async () => {
    const route = createImageRoutes({
      env: { ANVIL_AGENT_URL: "ws://127.0.0.1:19090/ws" },
      createClient: () => ({
        execute: async () => ({
          id: "images-response",
          status: 200,
          body: { type: "sync", status: "Success", status_code: 200, metadata: "invalid" },
        }),
      }),
    })

    const response = await route.request("/images")

    assert.equal(response.status, 502)
    assert.deepEqual(await readJson(response), {
      error: {
        code: "MALFORMED_UPSTREAM_RESPONSE",
        message: "Malformed upstream response",
        details: {},
      },
    })
  })

  test("image mutation routes are not mounted", async () => {
    const route = createImageRoutes({
      env: { ANVIL_AGENT_URL: "ws://127.0.0.1:19090/ws" },
      createClient: () => ({
        execute: async () => {
          throw new Error("unexpected agent request")
        },
      }),
    })

    for (const request of [
      new Request("http://example.test/images", { method: "POST" }),
      new Request("http://example.test/images/abc123", { method: "DELETE" }),
      new Request("http://example.test/images/abc123", { method: "PATCH" }),
      new Request("http://example.test/images/abc123/aliases", { method: "POST" }),
    ]) {
      const response = await route.fetch(request)
      assert.equal(response.status, 404)
    }
  })
})

type HonoRequest = (path: string, init?: RequestInit) => Response | Promise<Response>

class TestAdminStore implements AdminDataStore {
  private readonly user: AdminPrincipal & { passwordHash: string }

  private constructor(user: AdminPrincipal & { passwordHash: string }) {
    this.user = user
  }

  static async withAdminUser(): Promise<TestAdminStore> {
    return new TestAdminStore({
      id: "user-1",
      email: "admin@example.com",
      name: "Admin User",
      status: "ACTIVE",
      globalRole: "ADMIN",
      teams: [],
      passwordHash: await bcrypt.hash(adminPassword, 10),
    })
  }

  async isBootstrapComplete(): Promise<boolean> {
    return true
  }

  async createBootstrapAdmin(_record: CreateBootstrapAdminRecord): Promise<AdminPrincipal> {
    throw new Error("not used")
  }

  async findUserByEmail(email: string): Promise<(AdminPrincipal & { passwordHash: string }) | null> {
    return email.trim().toLowerCase() === this.user.email ? this.user : null
  }

  async findUserById(userId: string): Promise<AdminPrincipal | null> {
    return userId === this.user.id ? this.user : null
  }

  async recordAudit(_entry: AdminAuditEntry): Promise<void> {}
}

function imageResponse(metadata: unknown[]): AgentResponse {
  return {
    id: "images-response",
    status: 200,
    body: {
      type: "sync",
      status: "Success",
      status_code: 200,
      metadata,
    },
  }
}
