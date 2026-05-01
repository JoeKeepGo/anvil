import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { AgentTimeoutError, type AgentRequest } from "../services/agent"
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
})
