import {
  AgentConnectionError,
  type AgentRequest,
  type AgentResponse,
  AgentTimeoutError,
} from "./agent"
import type { ResourceVisibilityPolicy } from "./resourceVisibility"

export interface OperationsAgent {
  execute(request: AgentRequest): Promise<AgentResponse>
}

export interface OperationSummary {
  id: string
  class: string
  description: string
  status: string
  statusCode: number
  createdAt: string | null
  updatedAt: string | null
  mayCancel: boolean
  resources: Record<string, string[]>
}

type OperationsSuccessBody = {
  operations: OperationSummary[]
}

export type OperationsErrorCode =
  | "AGENT_CONFIG_ERROR"
  | "AGENT_UNAVAILABLE"
  | "AGENT_UPSTREAM_ERROR"
  | "MALFORMED_UPSTREAM_RESPONSE"

export type OperationsErrorBody = {
  error: {
    code: OperationsErrorCode
    message: string
    details: Record<string, never>
  }
}

export type OperationsResult = {
  httpStatus: 200 | 500 | 502 | 503
  body: OperationsSuccessBody | OperationsErrorBody
}

export async function getOperations(
  agent: OperationsAgent,
  visibility?: ResourceVisibilityPolicy
): Promise<OperationsResult> {
  try {
    const response = await agent.execute({ method: "GET", path: "/1.0/operations" })
    const responseError = mapNonSuccessResponse(response)
    if (responseError) {
      return responseError
    }

    const operations = readOperations(response.body)
    if (!operations) {
      return malformedUpstreamResponse()
    }

    const visibleOperationIds =
      visibility === undefined
        ? undefined
        : await visibility.filterVisibleResourceIds(
            "OPERATION",
            operations.map((operation) => operation.id)
          )

    return {
      httpStatus: 200,
      body: {
        operations:
          visibleOperationIds === undefined
            ? operations
            : operations.filter((operation) => visibleOperationIds.has(operation.id)),
      },
    }
  } catch (error) {
    if (error instanceof AgentTimeoutError || error instanceof AgentConnectionError) {
      return agentUnavailable()
    }

    throw error
  }
}

export function operationsAgentConfigError(): OperationsResult {
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

function mapNonSuccessResponse(response: AgentResponse): OperationsResult | undefined {
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

function readOperations(body: unknown): OperationSummary[] | undefined {
  const metadata = readMetadata(body)

  if (Array.isArray(metadata)) {
    const operations: OperationSummary[] = []
    for (const item of metadata) {
      const operation = readOperation(item)
      if (!operation) {
        return undefined
      }
      operations.push(operation)
    }

    return operations
  }

  if (!metadata || typeof metadata !== "object") {
    return undefined
  }

  return readGroupedOperationUrls(metadata)
}

function readOperation(value: unknown): OperationSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }

  const operation = value as Record<string, unknown>

  if (
    typeof operation.id !== "string" ||
    typeof operation.class !== "string" ||
    typeof operation.description !== "string" ||
    typeof operation.status !== "string" ||
    typeof operation.status_code !== "number"
  ) {
    return undefined
  }

  const createdAt = readOptionalString(operation, "created_at")
  const updatedAt = readOptionalString(operation, "updated_at")
  const mayCancel = readOptionalBoolean(operation, "may_cancel", false)
  const resources = readResources(operation.resources)

  if (
    createdAt === undefined ||
    updatedAt === undefined ||
    mayCancel === undefined ||
    resources === undefined
  ) {
    return undefined
  }

  return {
    id: operation.id,
    class: operation.class,
    description: operation.description,
    status: operation.status,
    statusCode: operation.status_code,
    createdAt,
    updatedAt,
    mayCancel,
    resources,
  }
}

function readGroupedOperationUrls(value: object): OperationSummary[] | undefined {
  for (const operationUrls of Object.values(value)) {
    if (!Array.isArray(operationUrls) || !operationUrls.every(isOperationPath)) {
      return undefined
    }

    if (operationUrls.length > 0) {
      return undefined
    }
  }

  return []
}

function readMetadata(body: unknown): unknown {
  if (!body || typeof body !== "object") {
    return undefined
  }

  return (body as Record<string, unknown>).metadata
}

function readOptionalString(source: Record<string, unknown>, key: string): string | null | undefined {
  if (!Object.hasOwn(source, key) || source[key] === null) {
    return null
  }

  const value = source[key]
  return typeof value === "string" ? value : undefined
}

function readOptionalBoolean(
  source: Record<string, unknown>,
  key: string,
  defaultValue: boolean
): boolean | undefined {
  if (!Object.hasOwn(source, key) || source[key] === null) {
    return defaultValue
  }

  const value = source[key]
  return typeof value === "boolean" ? value : undefined
}

function readResources(value: unknown): Record<string, string[]> | undefined {
  if (value === undefined || value === null) {
    return {}
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }

  const resources: Record<string, string[]> = {}
  for (const [key, resourcePaths] of Object.entries(value)) {
    if (!Array.isArray(resourcePaths) || !resourcePaths.every((item) => typeof item === "string")) {
      return undefined
    }

    resources[key] = resourcePaths
  }

  return resources
}

function isOperationPath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/1.0/operations/")
}

function agentUnavailable(): OperationsResult {
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

function malformedUpstreamResponse(): OperationsResult {
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
