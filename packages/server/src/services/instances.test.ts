import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { AgentConnectionError, AgentTimeoutError, type AgentRequest, type AgentResponse } from "./agent"
import { getInstances } from "./instances"

class RecordingAgent {
  readonly calls: AgentRequest[] = []

  constructor(private readonly results: Array<AgentResponse | Error>) {}

  async execute(request: AgentRequest): Promise<AgentResponse> {
    this.calls.push(request)
    const result = this.results.shift()

    if (!result) {
      throw new Error("unexpected agent request")
    }

    if (result instanceof Error) {
      throw result
    }

    return result
  }
}

describe("getInstances", () => {
  test("returns an empty list when Incus metadata is empty", async () => {
    const agent = new RecordingAgent([
      {
        id: "list-response",
        status: 200,
        body: { type: "sync", status: "Success", status_code: 200, metadata: [] },
      },
    ])

    const result = await getInstances(agent)

    assert.deepEqual(agent.calls, [{ method: "GET", path: "/1.0/instances" }])
    assert.equal(result.httpStatus, 200)
    assert.deepEqual(result.body, { instances: [] })
  })

  test("loads instance detail paths and normalizes only verified fields", async () => {
    const agent = new RecordingAgent([
      {
        id: "list-response",
        status: 200,
        body: {
          type: "sync",
          status: "Success",
          status_code: 200,
          metadata: ["/1.0/instances/demo"],
        },
      },
      {
        id: "detail-response",
        status: 200,
        body: {
          type: "sync",
          status: "Success",
          status_code: 200,
          metadata: {
            name: "demo",
            status: "Running",
            type: "container",
            architecture: "x86_64",
            created_at: "2026-01-02T03:04:05Z",
            config: {
              rawSecret: "do-not-return",
            },
          },
        },
      },
    ])

    const result = await getInstances(agent)

    assert.deepEqual(agent.calls, [
      { method: "GET", path: "/1.0/instances" },
      { method: "GET", path: "/1.0/instances/demo" },
    ])
    assert.equal(result.httpStatus, 200)
    assert.deepEqual(result.body, {
      instances: [
        {
          name: "demo",
          status: "Running",
          type: "container",
          architecture: "x86_64",
          createdAt: "2026-01-02T03:04:05Z",
        },
      ],
    })
    assert.equal(JSON.stringify(result.body).includes("rawSecret"), false)
    assert.equal(JSON.stringify(result.body).includes("do-not-return"), false)
  })

  test("maps timeout and connection failures to service unavailable", async () => {
    for (const error of [
      new AgentTimeoutError("agent request timed out"),
      new AgentConnectionError("agent connection failed"),
    ]) {
      const result = await getInstances(new RecordingAgent([error]))

      assert.equal(result.httpStatus, 503)
      assert.deepEqual(result.body, {
        error: {
          code: "AGENT_UNAVAILABLE",
          message: "Agent unavailable",
          details: {},
        },
      })
    }
  })

  test("maps agent non-2xx responses to upstream error without raw body", async () => {
    const result = await getInstances(
      new RecordingAgent([
        {
          id: "list-response",
          status: 500,
          body: { metadata: [], rawSecret: "do-not-return" },
          error: "incus failed",
        },
      ])
    )

    assert.equal(result.httpStatus, 502)
    assert.deepEqual(result.body, {
      error: {
        code: "AGENT_UPSTREAM_ERROR",
        message: "Agent upstream error",
        details: {},
      },
    })
    assert.equal(JSON.stringify(result.body).includes("do-not-return"), false)
  })

  test("rejects an upstream list body whose metadata is not an array", async () => {
    const result = await getInstances(
      new RecordingAgent([
        {
          id: "list-response",
          status: 200,
          body: { type: "sync", status: "Success", status_code: 200, metadata: {} },
        },
      ])
    )

    assert.equal(result.httpStatus, 502)
    assert.deepEqual(result.body, {
      error: {
        code: "MALFORMED_UPSTREAM_RESPONSE",
        message: "Malformed upstream response",
        details: {},
      },
    })
  })

  test("rejects instance detail missing required verified fields", async () => {
    const requestCamelAlias = ["request", "Id"].join("")
    const requestSnakeAlias = ["request", "id"].join("_")
    const instanceNameAlias = ["instance", "name"].join("_")

    const result = await getInstances(
      new RecordingAgent([
        {
          id: "list-response",
          status: 200,
          body: { type: "sync", status: "Success", status_code: 200, metadata: ["/1.0/instances/demo"] },
        },
        {
          id: "detail-response",
          status: 200,
          body: {
            type: "sync",
            status: "Success",
            status_code: 200,
            metadata: {
              id: "demo",
              [instanceNameAlias]: "demo",
              state: "Running",
              kind: "container",
              [requestCamelAlias]: "ignored",
              [requestSnakeAlias]: "ignored",
            },
          },
        },
      ])
    )

    assert.equal(result.httpStatus, 502)
    assert.deepEqual(result.body, {
      error: {
        code: "MALFORMED_UPSTREAM_RESPONSE",
        message: "Malformed upstream response",
        details: {},
      },
    })
  })
})
