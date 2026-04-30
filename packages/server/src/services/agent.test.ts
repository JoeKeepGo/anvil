import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import { afterEach, describe, test } from "node:test"
import { WebSocketServer, type WebSocket } from "ws"
import {
  AgentClient,
  AgentConnectionError,
  AgentProtocolError,
  AgentTimeoutError,
} from "./agent"

const clients: AgentClient[] = []

afterEach(() => {
  for (const client of clients.splice(0)) {
    client.close()
  }
})

async function withAgentServer(
  handler: (socket: WebSocket, request: { headers: Record<string, string | string[] | undefined> }) => void,
  run: (url: string) => Promise<void>
) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  await once(server, "listening")

  server.on("connection", (socket, request) => {
    handler(socket, { headers: request.headers })
  })

  const address = server.address() as AddressInfo
  try {
    await run(`ws://127.0.0.1:${address.port}/ws`)
  } finally {
    for (const client of server.clients) {
      client.close()
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
}

function createClient(url: string, token?: string, requestTimeoutMs = 250) {
  const client = new AgentClient({ url, token, requestTimeoutMs })
  clients.push(client)
  return client
}

describe("AgentClient", () => {
  test("sends the M1 request shape with id, method, path, and optional body", async () => {
    await withAgentServer(
      (socket) => {
        socket.on("message", (message) => {
          const request = JSON.parse(message.toString()) as Record<string, unknown>
          assert.equal(typeof request.id, "string")
          assert.equal(request.method, "GET")
          assert.equal(request.path, "/1.0")
          assert.equal(Object.hasOwn(request, "body"), false)
          socket.send(JSON.stringify({ id: request.id, status: 200, body: { ok: true } }))
        })
      },
      async (url) => {
        const response = await createClient(url).execute({ method: "GET", path: "/1.0" })
        assert.equal(response.status, 200)
        assert.deepEqual(response.body, { ok: true })
      }
    )
  })

  test("includes body only when provided", async () => {
    await withAgentServer(
      (socket) => {
        socket.on("message", (message) => {
          const request = JSON.parse(message.toString()) as Record<string, unknown>
          assert.deepEqual(request.body, { name: "demo" })
          socket.send(JSON.stringify({ id: request.id, status: 202 }))
        })
      },
      async (url) => {
        const response = await createClient(url).execute({
          method: "POST",
          path: "/1.0/instances",
          body: { name: "demo" },
        })
        assert.equal(response.status, 202)
      }
    )
  })

  test("resolves only the response with the exact matching id", async () => {
    await withAgentServer(
      (socket) => {
        socket.on("message", (message) => {
          const request = JSON.parse(message.toString()) as { id: string }
          const aliasIdField = ["request", "Id"].join("")
          socket.send(JSON.stringify({ type: "logging", data: null }))
          socket.send(JSON.stringify({ id: "other-id", status: 500, error: "wrong request" }))
          socket.send(JSON.stringify({ [aliasIdField]: request.id, status: 500, error: "alias" }))
          socket.send(JSON.stringify({ id: request.id, status: 200, body: ["matched"] }))
        })
      },
      async (url) => {
        const response = await createClient(url).execute({ method: "GET", path: "/1.0" })
        assert.equal(response.id.length > 0, true)
        assert.equal(response.status, 200)
        assert.deepEqual(response.body, ["matched"])
      }
    )
  })

  test("times out when no matching response arrives", async () => {
    await withAgentServer(
      (socket) => {
        socket.on("message", () => {
          socket.send(JSON.stringify({ type: "logging", data: null }))
          socket.send(JSON.stringify({ id: "unmatched", status: 200 }))
        })
      },
      async (url) => {
        await assert.rejects(
          createClient(url, undefined, 20).execute({ method: "GET", path: "/1.0" }),
          AgentTimeoutError
        )
      }
    )
  })

  test("rejects when the socket closes before a matching response", async () => {
    await withAgentServer(
      (socket) => {
        socket.on("message", () => socket.close())
      },
      async (url) => {
        await assert.rejects(
          createClient(url).execute({ method: "GET", path: "/1.0" }),
          AgentConnectionError
        )
      }
    )
  })

  test("rejects pending requests and closes the socket on invalid JSON frames", async () => {
    await withAgentServer(
      (socket) => {
        socket.on("message", () => socket.send("{not-json"))
      },
      async (url) => {
        await assert.rejects(
          createClient(url).execute({ method: "GET", path: "/1.0" }),
          AgentProtocolError
        )
      }
    )
  })

  test("sends bearer auth only when a token is configured", async () => {
    const seenAuth: Array<string | string[] | undefined> = []

    await withAgentServer(
      (socket, request) => {
        seenAuth.push(request.headers.authorization)
        socket.on("message", (message) => {
          const agentRequest = JSON.parse(message.toString()) as { id: string }
          socket.send(JSON.stringify({ id: agentRequest.id, status: 200 }))
        })
      },
      async (url) => {
        await createClient(url, "secret-token").execute({ method: "GET", path: "/1.0" })
      }
    )

    await withAgentServer(
      (socket, request) => {
        seenAuth.push(request.headers.authorization)
        socket.on("message", (message) => {
          const agentRequest = JSON.parse(message.toString()) as { id: string }
          socket.send(JSON.stringify({ id: agentRequest.id, status: 200 }))
        })
      },
      async (url) => {
        await createClient(url).execute({ method: "GET", path: "/1.0" })
      }
    )

    assert.deepEqual(seenAuth, ["Bearer secret-token", undefined])
  })
})
