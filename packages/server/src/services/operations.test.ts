import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { AgentConnectionError, AgentTimeoutError, type AgentRequest, type AgentResponse } from "./agent"
import { getOperations } from "./operations"

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

describe("getOperations", () => {
  test("normalizes empty operation metadata object to an empty list", async () => {
    const agent = new RecordingAgent([operationResponse({})])

    const result = await getOperations(agent)

    assert.deepEqual(agent.calls, [{ method: "GET", path: "/1.0/operations" }])
    assert.equal(result.httpStatus, 200)
    assert.deepEqual(result.body, { operations: [] })
  })

  test("normalizes grouped empty operation URLs to an empty list", async () => {
    const result = await getOperations(
      new RecordingAgent([
        operationResponse({
          running: [],
          success: [],
          failure: [],
        }),
      ])
    )

    assert.equal(result.httpStatus, 200)
    assert.deepEqual(result.body, { operations: [] })
  })

  test("normalizes populated operation metadata using only official Operation fields", async () => {
    const result = await getOperations(
      new RecordingAgent([
        operationResponse([
          {
            id: "e9f5a4d7-3c4a-4a7f-91fa-78178dca07d2",
            class: "task",
            description: "Creating instance",
            status: "Running",
            status_code: 103,
            created_at: "2026-05-02T01:00:00Z",
            updated_at: "2026-05-02T01:01:00Z",
            may_cancel: true,
            resources: {
              instances: ["/1.0/instances/demo"],
              images: ["/1.0/images/abc123"],
            },
            metadata: {
              command: "do-not-return",
            },
            err: "do-not-return",
            location: "do-not-return",
          },
        ]),
      ])
    )

    assert.equal(result.httpStatus, 200)
    assert.deepEqual(result.body, {
      operations: [
        {
          id: "e9f5a4d7-3c4a-4a7f-91fa-78178dca07d2",
          class: "task",
          description: "Creating instance",
          status: "Running",
          statusCode: 103,
          createdAt: "2026-05-02T01:00:00Z",
          updatedAt: "2026-05-02T01:01:00Z",
          mayCancel: true,
          resources: {
            instances: ["/1.0/instances/demo"],
            images: ["/1.0/images/abc123"],
          },
        },
      ],
    })
    assert.equal(JSON.stringify(result.body).includes("metadata"), false)
    assert.equal(JSON.stringify(result.body).includes("err"), false)
    assert.equal(JSON.stringify(result.body).includes("location"), false)
    assert.equal(JSON.stringify(result.body).includes("do-not-return"), false)
  })

  test("normalizes absent and null optional operation fields", async () => {
    const result = await getOperations(
      new RecordingAgent([
        operationResponse([
          {
            id: "minimal",
            class: "task",
            description: "No-op",
            status: "Success",
            status_code: 200,
            created_at: null,
            updated_at: null,
            may_cancel: null,
            resources: null,
          },
        ]),
      ])
    )

    assert.equal(result.httpStatus, 200)
    assert.deepEqual(result.body, {
      operations: [
        {
          id: "minimal",
          class: "task",
          description: "No-op",
          status: "Success",
          statusCode: 200,
          createdAt: null,
          updatedAt: null,
          mayCancel: false,
          resources: {},
        },
      ],
    })
  })

  test("maps timeout and connection failures to service unavailable", async () => {
    for (const error of [
      new AgentTimeoutError("agent request timed out"),
      new AgentConnectionError("agent connection failed"),
    ]) {
      const result = await getOperations(new RecordingAgent([error]))

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

  test("maps upstream non-2xx responses without raw body", async () => {
    const result = await getOperations(
      new RecordingAgent([
        {
          id: "operations-response",
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

  test("rejects malformed upstream operation metadata", async () => {
    for (const metadata of ["invalid", 42, { running: [42] }, [{ id: "missing-required-fields" }]]) {
      const result = await getOperations(
        new RecordingAgent([
          {
            id: "operations-response",
            status: 200,
            body: { type: "sync", status: "Success", status_code: 200, metadata },
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
    }
  })

  test("rejects missing required verified fields and does not use aliases", async () => {
    const requestCamelAlias = ["request", "Id"].join("")
    const requestSnakeAlias = ["request", "id"].join("_")

    const result = await getOperations(
      new RecordingAgent([
        operationResponse([
          {
            uuid: "operation-id",
            kind: "task",
            summary: "Creating instance",
            state: "Running",
            code: 103,
            [requestCamelAlias]: "ignored",
            [requestSnakeAlias]: "ignored",
          },
        ]),
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

  test("rejects optional fields when present with the wrong type", async () => {
    for (const operation of [
      { created_at: 42 },
      { updated_at: 42 },
      { may_cancel: "yes" },
      { resources: { instances: [42] } },
      { resources: [] },
    ]) {
      const result = await getOperations(
        new RecordingAgent([
          operationResponse([
            {
              id: "operation-id",
              class: "task",
              description: "Creating instance",
              status: "Running",
              status_code: 103,
              ...operation,
            },
          ]),
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
