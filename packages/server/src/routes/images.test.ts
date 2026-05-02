import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { AgentTimeoutError, type AgentRequest, type AgentResponse } from "../services/agent"
import { createImageRoutes } from "./images"

async function readJson(response: Response) {
  return (await response.json()) as unknown
}

describe("image routes", () => {
  test("app mounts GET /api/images", async () => {
    const originalNodeEnv = process.env.NODE_ENV
    const originalAgentUrl = process.env.ANVIL_AGENT_URL

    process.env.NODE_ENV = "test"
    delete process.env.ANVIL_AGENT_URL

    try {
      const { app } = await import("../index")
      const response = await app.request("/api/images")

      assert.equal(response.status, 500)
      assert.deepEqual(await readJson(response), {
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

      if (originalAgentUrl === undefined) {
        delete process.env.ANVIL_AGENT_URL
      } else {
        process.env.ANVIL_AGENT_URL = originalAgentUrl
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
