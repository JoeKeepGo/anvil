import {
  AgentConnectionError,
  type AgentRequest,
  type AgentResponse,
  AgentTimeoutError,
} from "./agent"
import type { ResourceVisibilityPolicy } from "./resourceVisibility"

export interface InstancesAgent {
  execute(request: AgentRequest): Promise<AgentResponse>
}

export interface InstanceSummary {
  name: string
  status: string
  type: string
  architecture: string | null
  createdAt: string | null
}

type InstancesSuccessBody = {
  instances: InstanceSummary[]
}

export type InstancesErrorCode =
  | "AGENT_CONFIG_ERROR"
  | "AGENT_UNAVAILABLE"
  | "AGENT_UPSTREAM_ERROR"
  | "MALFORMED_UPSTREAM_RESPONSE"

export type InstancesErrorBody = {
  error: {
    code: InstancesErrorCode
    message: string
    details: Record<string, never>
  }
}

export type InstancesResult = {
  httpStatus: 200 | 500 | 502 | 503
  body: InstancesSuccessBody | InstancesErrorBody
}

export async function getInstances(
  agent: InstancesAgent,
  visibility?: ResourceVisibilityPolicy
): Promise<InstancesResult> {
  try {
    const listResponse = await agent.execute({ method: "GET", path: "/1.0/instances" })
    const listError = mapNonSuccessResponse(listResponse)
    if (listError) {
      return listError
    }

    const instancePaths = readInstancePathList(listResponse.body)
    if (!instancePaths) {
      return malformedUpstreamResponse()
    }

    const visibleNames =
      visibility === undefined
        ? undefined
        : await visibility.filterVisibleResourceIds("INSTANCE", instanceNamesFromPaths(instancePaths))
    const visibleInstancePaths =
      visibleNames === undefined
        ? instancePaths
        : instancePaths.filter((path) => visibleNames.has(instanceNameFromPath(path)))

    const instances: InstanceSummary[] = []

    for (const path of visibleInstancePaths) {
      const detailResponse = await agent.execute({ method: "GET", path })
      const detailError = mapNonSuccessResponse(detailResponse)
      if (detailError) {
        return detailError
      }

      const instance = readInstanceDetail(detailResponse.body)
      if (!instance) {
        return malformedUpstreamResponse()
      }

      instances.push(instance)
    }

    return {
      httpStatus: 200,
      body: { instances },
    }
  } catch (error) {
    if (error instanceof AgentTimeoutError || error instanceof AgentConnectionError) {
      return agentUnavailable()
    }

    throw error
  }
}

function mapNonSuccessResponse(response: AgentResponse): InstancesResult | undefined {
  if (response.status >= 200 && response.status < 300) {
    return undefined
  }

  return {
    httpStatus: 502,
    body: {
      error: {
        code: "AGENT_UPSTREAM_ERROR",
        message: "Agent upstream error",
        details: {},
      },
    },
  }
}

function readInstancePathList(body: unknown): string[] | undefined {
  const metadata = readMetadata(body)

  if (!Array.isArray(metadata)) {
    return undefined
  }

  if (!metadata.every(isInstancePath)) {
    return undefined
  }

  return metadata
}

function readInstanceDetail(body: unknown): InstanceSummary | undefined {
  const metadata = readMetadata(body)

  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined
  }

  const instance = metadata as Record<string, unknown>

  if (
    typeof instance.name !== "string" ||
    typeof instance.status !== "string" ||
    typeof instance.type !== "string"
  ) {
    return undefined
  }

  const architecture = readOptionalString(instance, "architecture")
  const createdAt = readOptionalString(instance, "created_at")

  if (architecture === undefined || createdAt === undefined) {
    return undefined
  }

  return {
    name: instance.name,
    status: instance.status,
    type: instance.type,
    architecture,
    createdAt,
  }
}

function readMetadata(body: unknown): unknown {
  if (!body || typeof body !== "object") {
    return undefined
  }

  return (body as Record<string, unknown>).metadata
}

function readOptionalString(source: Record<string, unknown>, key: string): string | null | undefined {
  if (!Object.hasOwn(source, key)) {
    return null
  }

  const value = source[key]
  return typeof value === "string" ? value : undefined
}

function isInstancePath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/1.0/instances/")
}

function instanceNameFromPath(path: string): string {
  const encodedName = path.slice("/1.0/instances/".length)
  try {
    return decodeURIComponent(encodedName)
  } catch {
    return encodedName
  }
}

function instanceNamesFromPaths(paths: string[]): string[] {
  return paths.map(instanceNameFromPath)
}

function agentUnavailable(): InstancesResult {
  return {
    httpStatus: 503,
    body: {
      error: {
        code: "AGENT_UNAVAILABLE",
        message: "Agent unavailable",
        details: {},
      },
    },
  }
}

export function agentConfigError(): InstancesResult {
  return {
    httpStatus: 500,
    body: {
      error: {
        code: "AGENT_CONFIG_ERROR",
        message: "Agent configuration error",
        details: {},
      },
    },
  }
}

function malformedUpstreamResponse(): InstancesResult {
  return {
    httpStatus: 502,
    body: {
      error: {
        code: "MALFORMED_UPSTREAM_RESPONSE",
        message: "Malformed upstream response",
        details: {},
      },
    },
  }
}
