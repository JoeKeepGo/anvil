export interface AgentResponse {
  id: string
  status: number
  body?: unknown
  error?: string
}

export async function execute(
  endpointId: string,
  method: string,
  path: string,
  body?: unknown
): Promise<AgentResponse> {
  throw new Error("Agent client not yet implemented")
}
