import { type ServerConfig } from "../config"
import {
  AgentConnectionError,
  type AgentRequest,
  type AgentResponse,
  AgentTimeoutError,
} from "./agent"

export interface HostHealthAgent {
  execute(request: AgentRequest): Promise<AgentResponse>
}

export type HostHealthResult = {
  httpStatus: 200 | 502 | 503
  body:
    | {
        status: "ok"
        agent: {
          url: string
          connected: true
        }
        incus: {
          status: number
        }
      }
    | {
        status: "error"
        error: "agent_unavailable"
      }
    | {
        status: "error"
        error: "agent_upstream_error"
        incus: {
          status: number
        }
      }
}

export async function getHostHealth(
  config: ServerConfig,
  agent: HostHealthAgent
): Promise<HostHealthResult> {
  try {
    const response = await agent.execute({ method: "GET", path: "/1.0" })

    if (response.status < 200 || response.status >= 300) {
      return {
        httpStatus: 502,
        body: {
          status: "error",
          error: "agent_upstream_error",
          incus: {
            status: response.status,
          },
        },
      }
    }

    return {
      httpStatus: 200,
      body: {
        status: "ok",
        agent: {
          url: config.agent.url,
          connected: true,
        },
        incus: {
          status: response.status,
        },
      },
    }
  } catch (error) {
    if (error instanceof AgentTimeoutError || error instanceof AgentConnectionError) {
      return {
        httpStatus: 503,
        body: { status: "error", error: "agent_unavailable" },
      }
    }

    throw error
  }
}
