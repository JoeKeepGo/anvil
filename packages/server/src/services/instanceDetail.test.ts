import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { AgentConnectionError, AgentTimeoutError, type AgentRequest, type AgentResponse } from "./agent"
import { getInstanceDetail } from "./instanceDetail"

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

describe("getInstanceDetail", () => {
  test("loads one instance detail and normalizes only the Phase 1 verified contract", async () => {
    const agent = new RecordingAgent([
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
            created_at: "2026-05-01T15:43:06.975344198Z",
            description: "test container",
            ephemeral: false,
            stateful: false,
            profiles: ["default"],
            status_code: 103,
            project: "default",
            location: "none",
            config: {
              "limits.memory": "256MiB",
              "limits.cpu": "2",
              rawSecret: "do-not-return",
            },
            devices: {
              root: {
                pool: "default",
                size: "5GiB",
                type: "disk",
                path: "/",
              },
              eth0: {
                host_name: "do-not-return",
              },
            },
            expanded_config: {
              "volatile.uuid": "do-not-return",
            },
            expanded_devices: {
              eth0: {
                host_name: "do-not-return",
              },
            },
          },
        },
      },
    ])

    const result = await getInstanceDetail(agent, "demo")

    assert.deepEqual(agent.calls, [{ method: "GET", path: "/1.0/instances/demo" }])
    assert.equal(result.httpStatus, 200)
    assert.deepEqual(result.body, {
      instance: {
        name: "demo",
        status: "Running",
        type: "container",
        architecture: "x86_64",
        createdAt: "2026-05-01T15:43:06.975344198Z",
        description: "test container",
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
    assert.equal(JSON.stringify(result.body).includes("rawSecret"), false)
    assert.equal(JSON.stringify(result.body).includes("expanded_config"), false)
    assert.equal(JSON.stringify(result.body).includes("expanded_devices"), false)
    assert.equal(JSON.stringify(result.body).includes("host_name"), false)
    assert.equal(JSON.stringify(result.body).includes("do-not-return"), false)
  })

  test("normalizes absent optional fields to null", async () => {
    const agent = new RecordingAgent([
      {
        id: "detail-response",
        status: 200,
        body: {
          type: "sync",
          status: "Success",
          status_code: 200,
          metadata: {
            name: "minimal",
            status: "Stopped",
            type: "container",
            description: "",
            ephemeral: false,
            stateful: false,
            profiles: [],
            config: {},
            devices: {
              root: {
                type: "disk",
              },
            },
          },
        },
      },
    ])

    const result = await getInstanceDetail(agent, "minimal")

    assert.equal(result.httpStatus, 200)
    assert.deepEqual(result.body, {
      instance: {
        name: "minimal",
        status: "Stopped",
        type: "container",
        architecture: null,
        createdAt: null,
        description: "",
        ephemeral: false,
        stateful: false,
        profiles: [],
        limits: {
          memory: null,
          cpu: null,
        },
        rootDisk: {
          pool: null,
          size: null,
          type: "disk",
        },
      },
    })
  })

  test("returns null rootDisk when no root disk device is present", async () => {
    const agent = new RecordingAgent([
      {
        id: "detail-response",
        status: 200,
        body: {
          type: "sync",
          status: "Success",
          status_code: 200,
          metadata: {
            name: "diskless",
            status: "Stopped",
            type: "container",
            description: "",
            ephemeral: false,
            stateful: false,
            profiles: [],
          },
        },
      },
    ])

    const result = await getInstanceDetail(agent, "diskless")

    assert.equal(result.httpStatus, 200)
    assert.equal("instance" in result.body && result.body.instance.rootDisk, null)
  })

  test("maps upstream 404 to instance not found without raw upstream body", async () => {
    const result = await getInstanceDetail(
      new RecordingAgent([
        {
          id: "detail-response",
          status: 404,
          body: { type: "error", error: "not found", error_code: 404, rawSecret: "do-not-return" },
        },
      ]),
      "missing"
    )

    assert.equal(result.httpStatus, 404)
    assert.deepEqual(result.body, {
      error: {
        code: "INSTANCE_NOT_FOUND",
        message: "Instance not found",
        details: {},
      },
    })
    assert.equal(JSON.stringify(result.body).includes("do-not-return"), false)
  })

  test("rejects unsafe names before calling the agent", async () => {
    for (const name of ["", ".", "..", "a/b", "name?project=default", "bad\u0000name"]) {
      const agent = new RecordingAgent([])
      const result = await getInstanceDetail(agent, name)

      assert.equal(result.httpStatus, 400)
      assert.deepEqual(result.body, {
        error: {
          code: "INVALID_INSTANCE_NAME",
          message: "Invalid instance name",
          details: {},
        },
      })
      assert.deepEqual(agent.calls, [])
    }
  })

  test("encodes safe names as a single Incus path segment", async () => {
    const agent = new RecordingAgent([
      {
        id: "detail-response",
        status: 404,
        body: { type: "error", error: "not found", error_code: 404 },
      },
    ])

    await getInstanceDetail(agent, "demo name")

    assert.deepEqual(agent.calls, [{ method: "GET", path: "/1.0/instances/demo%20name" }])
  })

  test("maps timeout and connection failures to service unavailable", async () => {
    for (const error of [
      new AgentTimeoutError("agent request timed out"),
      new AgentConnectionError("agent connection failed"),
    ]) {
      const result = await getInstanceDetail(new RecordingAgent([error]), "demo")

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
    const result = await getInstanceDetail(
      new RecordingAgent([
        {
          id: "detail-response",
          status: 500,
          body: { metadata: {}, rawSecret: "do-not-return" },
          error: "incus failed",
        },
      ]),
      "demo"
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

  test("rejects a detail body whose metadata is not an object", async () => {
    const result = await getInstanceDetail(
      new RecordingAgent([
        {
          id: "detail-response",
          status: 200,
          body: { type: "sync", status: "Success", status_code: 200, metadata: [] },
        },
      ]),
      "demo"
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

    const result = await getInstanceDetail(
      new RecordingAgent([
        {
          id: "detail-response",
          status: 200,
          body: {
            type: "sync",
            status: "Success",
            status_code: 200,
            metadata: {
              id: "demo",
              state: "Running",
              kind: "container",
              description: "",
              ephemeral: false,
              stateful: false,
              profiles: [],
              [requestCamelAlias]: "ignored",
              [requestSnakeAlias]: "ignored",
            },
          },
        },
      ]),
      "demo"
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

  test("rejects optional fields that are present with the wrong type", async () => {
    for (const metadata of [
      { architecture: 42 },
      { created_at: 42 },
      { config: { "limits.memory": 256 } },
      { config: { "limits.cpu": 2 } },
      { devices: { root: { pool: 1, type: "disk" } } },
      { devices: { root: { size: 1, type: "disk" } } },
      { devices: { root: { type: 1 } } },
    ]) {
      const result = await getInstanceDetail(
        new RecordingAgent([
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
                description: "",
                ephemeral: false,
                stateful: false,
                profiles: [],
                ...metadata,
              },
            },
          },
        ]),
        "demo"
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
