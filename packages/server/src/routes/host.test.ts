import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { AgentTimeoutError, type AgentRequest } from "../services/agent"
import { createHostRoutes } from "./host"

async function readJson(response: Response) {
  return (await response.json()) as unknown
}

describe("host routes", () => {
  test("GET /host/health returns safe health and does not expose token", async () => {
    const calls: AgentRequest[] = []
    const route = createHostRoutes({
      env: {
        ANVIL_AGENT_URL: "ws://127.0.0.1:19090/ws",
        ANVIL_AGENT_TOKEN: "secret-token",
      },
      createClient: () => ({
        execute: async (request) => {
          calls.push(request)
          return { id: "response-id", status: 200, body: { ignored: true } }
        },
      }),
    })

    const response = await route.request("/host/health")
    const body = await readJson(response)

    assert.equal(response.status, 200)
    assert.deepEqual(calls, [{ method: "GET", path: "/1.0" }])
    assert.deepEqual(body, {
      status: "ok",
      agent: {
        url: "ws://127.0.0.1:19090/ws",
        connected: true,
      },
      incus: {
        status: 200,
      },
    })
    assert.equal(JSON.stringify(body).includes("secret-token"), false)
  })

  test("GET /host/health maps missing config to 500", async () => {
    const route = createHostRoutes({ env: {} })
    const response = await route.request("/host/health")

    assert.equal(response.status, 500)
    assert.deepEqual(await readJson(response), { status: "error", error: "agent_config_error" })
  })

  test("GET /host/health maps timeout or unreachable agent to 503", async () => {
    const route = createHostRoutes({
      env: { ANVIL_AGENT_URL: "ws://127.0.0.1:19090/ws" },
      createClient: () => ({
        execute: async () => {
          throw new AgentTimeoutError("agent request timed out")
        },
      }),
    })

    const response = await route.request("/host/health")

    assert.equal(response.status, 503)
    assert.deepEqual(await readJson(response), { status: "error", error: "agent_unavailable" })
  })

  test("GET /host/health maps agent non-2xx to 502", async () => {
    const route = createHostRoutes({
      env: { ANVIL_AGENT_URL: "ws://127.0.0.1:19090/ws" },
      createClient: () => ({
        execute: async () => ({ id: "response-id", status: 401, error: "unauthorized" }),
      }),
    })

    const response = await route.request("/host/health")

    assert.equal(response.status, 502)
    assert.deepEqual(await readJson(response), {
      status: "error",
      error: "agent_upstream_error",
      incus: {
        status: 401,
      },
    })
  })
})
