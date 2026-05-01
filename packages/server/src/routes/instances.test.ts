import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { AgentTimeoutError, type AgentRequest, type AgentResponse } from "../services/agent"
import { createInstanceRoutes } from "./instances"

async function readJson(response: Response) {
  return (await response.json()) as unknown
}

describe("instance routes", () => {
  test("GET /instances calls the instances service path and returns the normalized contract", async () => {
    const calls: AgentRequest[] = []
    const route = createInstanceRoutes({
      env: {
        ANVIL_AGENT_URL: "ws://127.0.0.1:19090/ws",
        ANVIL_AGENT_TOKEN: "secret-token",
      },
      createClient: () => ({
        execute: async (request) => {
          calls.push(request)
          return {
            id: "list-response",
            status: 200,
            body: { type: "sync", status: "Success", status_code: 200, metadata: [] },
          }
        },
      }),
    })

    const response = await route.request("/instances")
    const body = await readJson(response)

    assert.equal(response.status, 200)
    assert.deepEqual(calls, [{ method: "GET", path: "/1.0/instances" }])
    assert.deepEqual(body, { instances: [] })
    assert.equal(JSON.stringify(body).includes("secret-token"), false)
  })

  test("GET /instances maps missing config to documented error shape", async () => {
    const route = createInstanceRoutes({ env: {} })
    const response = await route.request("/instances")

    assert.equal(response.status, 500)
    assert.deepEqual(await readJson(response), {
      error: {
        code: "AGENT_CONFIG_ERROR",
        message: "Agent configuration error",
        details: {},
      },
    })
  })

  test("GET /instances maps agent timeout to documented error shape", async () => {
    const route = createInstanceRoutes({
      env: { ANVIL_AGENT_URL: "ws://127.0.0.1:19090/ws" },
      createClient: () => ({
        execute: async () => {
          throw new AgentTimeoutError("agent request timed out")
        },
      }),
    })

    const response = await route.request("/instances")

    assert.equal(response.status, 503)
    assert.deepEqual(await readJson(response), {
      error: {
        code: "AGENT_UNAVAILABLE",
        message: "Agent unavailable",
        details: {},
      },
    })
  })

  test("GET /instances maps malformed upstream responses to documented error shape", async () => {
    const route = createInstanceRoutes({
      env: { ANVIL_AGENT_URL: "ws://127.0.0.1:19090/ws" },
      createClient: () => ({
        execute: async () => ({
          id: "list-response",
          status: 200,
          body: { type: "sync", status: "Success", status_code: 200, metadata: "invalid" },
        }),
      }),
    })

    const response = await route.request("/instances")

    assert.equal(response.status, 502)
    assert.deepEqual(await readJson(response), {
      error: {
        code: "MALFORMED_UPSTREAM_RESPONSE",
        message: "Malformed upstream response",
        details: {},
      },
    })
  })

  test("GET /instances/:name calls the detail service path and returns the Phase 1 contract", async () => {
    const calls: AgentRequest[] = []
    const route = createInstanceRoutes({
      env: {
        ANVIL_AGENT_URL: "ws://127.0.0.1:19090/ws",
        ANVIL_AGENT_TOKEN: "secret-token",
      },
      createClient: () => ({
        execute: async (request) => {
          calls.push(request)
          return detailResponse({
            name: "demo",
            status: "Running",
            type: "container",
            architecture: "x86_64",
            created_at: "2026-05-01T15:43:06.975344198Z",
            description: "",
            ephemeral: false,
            stateful: false,
            profiles: ["default"],
            config: {
              "limits.memory": "256MiB",
              "limits.cpu": "2",
            },
            devices: {
              root: {
                pool: "default",
                size: "5GiB",
                type: "disk",
              },
            },
          })
        },
      }),
    })

    const response = await route.request("/instances/demo")
    const body = await readJson(response)

    assert.equal(response.status, 200)
    assert.deepEqual(calls, [{ method: "GET", path: "/1.0/instances/demo" }])
    assert.deepEqual(body, {
      instance: {
        name: "demo",
        status: "Running",
        type: "container",
        architecture: "x86_64",
        createdAt: "2026-05-01T15:43:06.975344198Z",
        description: "",
        ephemeral: false,
        stateful: false,
        profiles: ["default"],
        limits: {
          memory: "256MiB",
          cpu: "2",
        },
        rootDisk: {
          pool: "default",
          size: "5GiB",
          type: "disk",
        },
      },
    })
    assert.equal(JSON.stringify(body).includes("secret-token"), false)
  })

  test("GET /instances/:name maps missing config to documented error shape", async () => {
    const route = createInstanceRoutes({ env: {} })
    const response = await route.request("/instances/demo")

    assert.equal(response.status, 500)
    assert.deepEqual(await readJson(response), {
      error: {
        code: "AGENT_CONFIG_ERROR",
        message: "Agent configuration error",
        details: {},
      },
    })
  })

  test("GET /instances/:name maps not found to documented error shape", async () => {
    const route = createInstanceRoutes({
      env: { ANVIL_AGENT_URL: "ws://127.0.0.1:19090/ws" },
      createClient: () => ({
        execute: async () => ({
          id: "detail-response",
          status: 404,
          body: { type: "error", error: "not found", error_code: 404 },
        }),
      }),
    })

    const response = await route.request("/instances/missing")

    assert.equal(response.status, 404)
    assert.deepEqual(await readJson(response), {
      error: {
        code: "INSTANCE_NOT_FOUND",
        message: "Instance not found",
        details: {},
      },
    })
  })

  test("GET /instances/:name rejects unsafe names without an agent call", async () => {
    const calls: AgentRequest[] = []
    const route = createInstanceRoutes({
      env: { ANVIL_AGENT_URL: "ws://127.0.0.1:19090/ws" },
      createClient: () => ({
        execute: async (request) => {
          calls.push(request)
          throw new Error("should not call agent")
        },
      }),
    })

    const response = await route.request("/instances/a%2Fb")

    assert.equal(response.status, 400)
    assert.deepEqual(calls, [])
    assert.deepEqual(await readJson(response), {
      error: {
        code: "INVALID_INSTANCE_NAME",
        message: "Invalid instance name",
        details: {},
      },
    })
  })

  test("GET /instances/:name maps agent timeout to documented error shape", async () => {
    const route = createInstanceRoutes({
      env: { ANVIL_AGENT_URL: "ws://127.0.0.1:19090/ws" },
      createClient: () => ({
        execute: async () => {
          throw new AgentTimeoutError("agent request timed out")
        },
      }),
    })

    const response = await route.request("/instances/demo")

    assert.equal(response.status, 503)
    assert.deepEqual(await readJson(response), {
      error: {
        code: "AGENT_UNAVAILABLE",
        message: "Agent unavailable",
        details: {},
      },
    })
  })

  test("GET /instances/:name maps malformed upstream responses to documented error shape", async () => {
    const route = createInstanceRoutes({
      env: { ANVIL_AGENT_URL: "ws://127.0.0.1:19090/ws" },
      createClient: () => ({
        execute: async () => ({
          id: "detail-response",
          status: 200,
          body: { type: "sync", status: "Success", status_code: 200, metadata: "invalid" },
        }),
      }),
    })

    const response = await route.request("/instances/demo")

    assert.equal(response.status, 502)
    assert.deepEqual(await readJson(response), {
      error: {
        code: "MALFORMED_UPSTREAM_RESPONSE",
        message: "Malformed upstream response",
        details: {},
      },
    })
  })
})

function detailResponse(metadata: Record<string, unknown>): AgentResponse {
  return {
    id: "detail-response",
    status: 200,
    body: {
      type: "sync",
      status: "Success",
      status_code: 200,
      metadata,
    },
  }
}
