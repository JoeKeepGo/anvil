import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { AgentConnectionError, AgentTimeoutError, type AgentRequest, type AgentResponse } from "./agent"
import { getImages } from "./images"

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

describe("getImages", () => {
  test("returns an empty list when Incus image metadata is empty", async () => {
    const agent = new RecordingAgent([imageResponse([])])

    const result = await getImages(agent)

    assert.deepEqual(agent.calls, [{ method: "GET", path: "/1.0/images?recursion=1" }])
    assert.equal(result.httpStatus, 200)
    assert.deepEqual(result.body, { images: [] })
  })

  test("normalizes populated image metadata using only Phase 1 verified fields", async () => {
    const agent = new RecordingAgent([
      imageResponse([
        {
          fingerprint: "76eb6e6d521d2a53a003d50313fb231982d49e7303a949393f6bb43b92d12a69",
          aliases: [{ name: "debian-bookworm", description: "Debian bookworm" }],
          architecture: "x86_64",
          auto_update: true,
          cached: true,
          created_at: "2026-05-01T00:00:00Z",
          expires_at: "1970-01-01T00:00:00Z",
          filename: "incus.tar.xz",
          last_used_at: "2026-05-01T15:43:07.015642534Z",
          profiles: ["default"],
          project: "default",
          properties: {
            description: "Debian bookworm amd64 (20260501_05:24)",
            os: "Debian",
            secret: "do-not-return",
          },
          public: false,
          size: 111354548,
          type: "container",
          update_source: {
            server: "https://images.example.invalid",
          },
          uploaded_at: "2026-05-01T15:43:06.962275814Z",
        },
      ]),
    ])

    const result = await getImages(agent)

    assert.equal(result.httpStatus, 200)
    assert.deepEqual(result.body, {
      images: [
        {
          fingerprint: "76eb6e6d521d2a53a003d50313fb231982d49e7303a949393f6bb43b92d12a69",
          aliases: [{ name: "debian-bookworm", description: "Debian bookworm" }],
          description: "Debian bookworm amd64 (20260501_05:24)",
          architecture: "x86_64",
          type: "container",
          sizeBytes: 111354548,
          cached: true,
          public: false,
          autoUpdate: true,
          createdAt: "2026-05-01T00:00:00Z",
          expiresAt: "1970-01-01T00:00:00Z",
          lastUsedAt: "2026-05-01T15:43:07.015642534Z",
          uploadedAt: "2026-05-01T15:43:06.962275814Z",
        },
      ],
    })
    assert.equal(JSON.stringify(result.body).includes("do-not-return"), false)
    assert.equal(JSON.stringify(result.body).includes("properties"), false)
    assert.equal(JSON.stringify(result.body).includes("profiles"), false)
    assert.equal(JSON.stringify(result.body).includes("project"), false)
    assert.equal(JSON.stringify(result.body).includes("update_source"), false)
    assert.equal(JSON.stringify(result.body).includes("filename"), false)
  })

  test("normalizes empty aliases and absent optional fields", async () => {
    const result = await getImages(
      new RecordingAgent([
        imageResponse([
          {
            fingerprint: "abc123",
            aliases: [],
            cached: false,
            public: false,
            auto_update: false,
            size: 0,
            type: "container",
          },
        ]),
      ])
    )

    assert.equal(result.httpStatus, 200)
    assert.deepEqual(result.body, {
      images: [
        {
          fingerprint: "abc123",
          aliases: [],
          description: "",
          architecture: null,
          type: "container",
          sizeBytes: 0,
          cached: false,
          public: false,
          autoUpdate: false,
          createdAt: null,
          expiresAt: null,
          lastUsedAt: null,
          uploadedAt: null,
        },
      ],
    })
  })

  test("normalizes null optional fields to safe defaults or null", async () => {
    const result = await getImages(
      new RecordingAgent([
        imageResponse([
          {
            fingerprint: "abc123",
            aliases: null,
            architecture: null,
            auto_update: null,
            cached: null,
            created_at: null,
            expires_at: null,
            last_used_at: null,
            properties: {
              description: null,
            },
            public: null,
            size: null,
            type: "container",
            uploaded_at: null,
          },
        ]),
      ])
    )

    assert.equal(result.httpStatus, 200)
    assert.deepEqual(result.body, {
      images: [
        {
          fingerprint: "abc123",
          aliases: [],
          description: "",
          architecture: null,
          type: "container",
          sizeBytes: 0,
          cached: false,
          public: false,
          autoUpdate: false,
          createdAt: null,
          expiresAt: null,
          lastUsedAt: null,
          uploadedAt: null,
        },
      ],
    })
  })

  test("maps timeout and connection failures to service unavailable", async () => {
    for (const error of [
      new AgentTimeoutError("agent request timed out"),
      new AgentConnectionError("agent connection failed"),
    ]) {
      const result = await getImages(new RecordingAgent([error]))

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
    const result = await getImages(
      new RecordingAgent([
        {
          id: "images-response",
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

  test("rejects malformed upstream image metadata", async () => {
    for (const metadata of [{}, "invalid", [42]]) {
      const result = await getImages(
        new RecordingAgent([
          {
            id: "images-response",
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

  test("rejects image metadata missing required verified fields and does not use aliases", async () => {
    const requestCamelAlias = ["request", "Id"].join("")
    const requestSnakeAlias = ["request", "id"].join("_")

    const result = await getImages(
      new RecordingAgent([
        imageResponse([
          {
            id: "abc123",
            fingerprint_id: "abc123",
            aliases: [],
            kind: "container",
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
    for (const image of [
      { aliases: [{ name: "alias-only" }] },
      { aliases: ["debian"] },
      { architecture: 42 },
      { properties: { description: 42 } },
      { created_at: 42 },
      { expires_at: 42 },
      { last_used_at: 42 },
      { uploaded_at: 42 },
    ]) {
      const result = await getImages(
        new RecordingAgent([
          imageResponse([
            {
              fingerprint: "abc123",
              cached: false,
              public: false,
              auto_update: false,
              size: 0,
              type: "container",
              ...image,
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
