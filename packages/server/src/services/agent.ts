import { randomUUID } from "node:crypto"
import WebSocket from "ws"

export interface AgentClientOptions {
  url: string
  token?: string
  requestTimeoutMs: number
}

export interface AgentRequest {
  method: string
  path: string
  body?: unknown
}

export interface AgentResponse {
  id: string
  status: number
  body?: unknown
  error?: string
}

interface PendingRequest {
  resolve: (response: AgentResponse) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

export class AgentTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AgentTimeoutError"
  }
}

export class AgentConnectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AgentConnectionError"
  }
}

export class AgentProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AgentProtocolError"
  }
}

export class AgentClient {
  private socket?: WebSocket
  private connectPromise?: Promise<WebSocket>
  private readonly pending = new Map<string, PendingRequest>()

  constructor(private readonly options: AgentClientOptions) {}

  async execute(request: AgentRequest): Promise<AgentResponse> {
    const socket = await this.connect()
    const id = randomUUID()
    const payload: { id: string; method: string; path: string; body?: unknown } = {
      id,
      method: request.method,
      path: request.path,
    }

    if (request.body !== undefined) {
      payload.body = request.body
    }

    return new Promise<AgentResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new AgentTimeoutError(`Agent request timed out after ${this.options.requestTimeoutMs}ms`))
      }, this.options.requestTimeoutMs)

      this.pending.set(id, { resolve, reject, timeout })

      socket.send(JSON.stringify(payload), (error) => {
        if (!error) {
          return
        }

        this.rejectPending(id, new AgentConnectionError(error.message))
      })
    })
  }

  close(): void {
    this.rejectAll(new AgentConnectionError("Agent connection closed"))
    this.socket?.close()
    this.socket = undefined
    this.connectPromise = undefined
  }

  private async connect(): Promise<WebSocket> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return this.socket
    }

    if (this.connectPromise) {
      return this.connectPromise
    }

    this.connectPromise = new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(this.options.url, {
        headers: this.options.token ? { Authorization: `Bearer ${this.options.token}` } : undefined,
      })

      socket.once("open", () => {
        this.socket = socket
        resolve(socket)
      })

      socket.once("error", (error) => {
        reject(new AgentConnectionError(error.message))
      })

      socket.on("message", (message) => this.handleMessage(message))

      socket.on("close", () => {
        if (this.socket === socket) {
          this.socket = undefined
        }
        this.connectPromise = undefined
        this.rejectAll(new AgentConnectionError("Agent connection closed before response"))
      })
    })

    try {
      return await this.connectPromise
    } catch (error) {
      this.connectPromise = undefined
      throw error
    }
  }

  private handleMessage(message: WebSocket.RawData): void {
    let frame: unknown

    try {
      frame = JSON.parse(message.toString())
    } catch {
      this.rejectAll(new AgentProtocolError("Agent returned invalid JSON"))
      this.socket?.close()
      return
    }

    if (!isAgentResponse(frame)) {
      return
    }

    const pending = this.pending.get(frame.id)
    if (!pending) {
      return
    }

    clearTimeout(pending.timeout)
    this.pending.delete(frame.id)
    pending.resolve(frame)
  }

  private rejectPending(id: string, error: Error): void {
    const pending = this.pending.get(id)
    if (!pending) {
      return
    }

    clearTimeout(pending.timeout)
    this.pending.delete(id)
    pending.reject(error)
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout)
      pending.reject(error)
      this.pending.delete(id)
    }
  }
}

function isAgentResponse(frame: unknown): frame is AgentResponse {
  if (!frame || typeof frame !== "object") {
    return false
  }

  const candidate = frame as Record<string, unknown>
  return typeof candidate.id === "string" && typeof candidate.status === "number"
}
