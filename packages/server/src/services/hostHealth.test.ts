import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { AgentConnectionError, AgentTimeoutError, type AgentRequest, type AgentResponse } from "./agent"
import { getHostHealth } from "./hostHealth"

describe("getHostHealth", () => {
  test("calls agent GET /1.0 and returns a safe success response", async () => {
    const calls: AgentRequest[] = []

    const result = await getHostHealth(
      { agent: { url: "ws://127.0.0.1:19090/ws", token: "secret", requestTimeoutMs: 5000 } },
      {
        execute: async (request) => {
          calls.push(request)
          return { id: "response-id", status: 200, body: { ignored: true } }
        },
      }
    )

    assert.deepEqual(calls, [{ method: "GET", path: "/1.0" }])
    assert.equal(result.httpStatus, 200)
    assert.deepEqual(result.body, {
      status: "ok",
      agent: {
        url: "ws://127.0.0.1:19090/ws",
        connected: true,
      },
      incus: {
        status: 200,
      },
    })
    assert.equal(JSON.stringify(result.body).includes("secret"), false)
  })

  test("maps agent timeout and connection errors to 503", async () => {
    for (const error of [
      new AgentTimeoutError("agent request timed out"),
      new AgentConnectionError("agent connection closed"),
    ]) {
      const result = await getHostHealth(
        { agent: { url: "ws://127.0.0.1:19090/ws", requestTimeoutMs: 5000 } },
        {
          execute: async () => {
            throw error
          },
        }
      )

      assert.equal(result.httpStatus, 503)
      assert.deepEqual(result.body, { status: "error", error: "agent_unavailable" })
    }
  })

  test("maps agent non-2xx responses to 502 without exposing raw body", async () => {
    const result = await getHostHealth(
      { agent: { url: "ws://127.0.0.1:19090/ws", requestTimeoutMs: 5000 } },
      {
        execute: async (): Promise<AgentResponse> => ({
          id: "response-id",
          status: 500,
          body: { rawSecret: "do-not-return" },
          error: "incus failed",
        }),
      }
    )

    assert.equal(result.httpStatus, 502)
    assert.deepEqual(result.body, {
      status: "error",
      error: "agent_upstream_error",
      incus: {
        status: 500,
      },
    })
    assert.equal(JSON.stringify(result.body).includes("do-not-return"), false)
  })
})
