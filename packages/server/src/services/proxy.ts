// WebSocket client pool for Anvil Agent connections.
// Each Anvil Agent instance (Go, deployed per Incus machine) exposes a WebSocket endpoint
// at ws://host:9090/ws that relays Incus REST API calls and pushes lifecycle events.
//
// This module:
// 1. Maintains persistent WebSocket connections to each configured proxy
// 2. Maps request IDs to pending Promises for request/response correlation
// 3. Forwards Incus lifecycle events to registered handlers
//
// Protocol:
//   Request:  {"id": "uuid", "method": "GET", "path": "/1.0/instances"}
//   Response: {"id": "uuid", "status": 200, "body": {...}}
//   Event:    {"type": "lifecycle", "data": {...}}

interface ProxyRequest {
  id: string
  method: string
  path: string
  body?: unknown
}

interface ProxyResponse {
  id: string
  status: number
  body?: unknown
  error?: string
}

interface ProxyConnection {
  ws: WebSocket
  url: string
  pending: Map<string, { resolve: (value: ProxyResponse) => void; reject: (error: Error) => void }>
}

const connections = new Map<string, ProxyConnection>()

// TODO: Implement connect, execute, and event handling
// See docs/TECHNICAL_DESIGN.md Section 5 for full design

export async function execute(
  endpointId: string,
  method: string,
  path: string,
  body?: unknown
): Promise<ProxyResponse> {
  throw new Error("Proxy client not yet implemented")
}
