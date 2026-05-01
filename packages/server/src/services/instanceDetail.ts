import {
  AgentConnectionError,
  type AgentRequest,
  type AgentResponse,
  AgentTimeoutError,
} from "./agent"

export interface InstanceDetailAgent {
  execute(request: AgentRequest): Promise<AgentResponse>
}

export interface InstanceDetail {
  name: string
  status: string
  type: string
  architecture: string | null
  createdAt: string | null
  description: string
  ephemeral: boolean
  stateful: boolean
  profiles: string[]
  limits: {
    memory: string | null
    cpu: string | null
  }
  rootDisk: {
    pool: string | null
    size: string | null
    type: string
  } | null
}

type InstanceDetailSuccessBody = {
  instance: InstanceDetail
}

export type InstanceDetailErrorCode =
  | "INVALID_INSTANCE_NAME"
  | "INSTANCE_NOT_FOUND"
  | "AGENT_CONFIG_ERROR"
  | "AGENT_UNAVAILABLE"
  | "AGENT_UPSTREAM_ERROR"
  | "MALFORMED_UPSTREAM_RESPONSE"

export type InstanceDetailErrorBody = {
  error: {
    code: InstanceDetailErrorCode
    message: string
    details: Record<string, never>
  }
}

export type InstanceDetailResult = {
  httpStatus: 200 | 400 | 404 | 500 | 502 | 503
  body: InstanceDetailSuccessBody | InstanceDetailErrorBody
}

export async function getInstanceDetail(
  agent: InstanceDetailAgent,
  name: string
): Promise<InstanceDetailResult> {
  if (!isSafeInstanceName(name)) {
    return invalidInstanceName()
  }

  try {
    const response = await agent.execute({
      method: "GET",
      path: `/1.0/instances/${encodeURIComponent(name)}`,
    })
    const responseError = mapNonSuccessResponse(response)
    if (responseError) {
      return responseError
    }

    const instance = readInstanceDetail(response.body)
    if (!instance) {
      return malformedUpstreamResponse()
    }

    return {
      httpStatus: 200,
      body: { instance },
    }
  } catch (error) {
    if (error instanceof AgentTimeoutError || error instanceof AgentConnectionError) {
      return agentUnavailable()
    }

    throw error
  }
}

export function instanceDetailAgentConfigError(): InstanceDetailResult {
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

function isSafeInstanceName(name: string): boolean {
  if (name.length === 0 || name === "." || name === "..") {
    return false
  }

  if (name.includes("/") || name.includes("?")) {
    return false
  }

  for (const char of name) {
    const code = char.charCodeAt(0)
    if (code < 0x20 || code === 0x7f) {
      return false
    }
  }

  return true
}

function mapNonSuccessResponse(response: AgentResponse): InstanceDetailResult | undefined {
  if (response.status >= 200 && response.status < 300) {
    return undefined
  }

  if (response.status === 404) {
    return {
      httpStatus: 404,
      body: {
        error: {
          code: "INSTANCE_NOT_FOUND",
          message: "Instance not found",
          details: {},
        },
      },
    }
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

function readInstanceDetail(body: unknown): InstanceDetail | undefined {
  const metadata = readMetadata(body)

  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined
  }

  const instance = metadata as Record<string, unknown>

  if (
    typeof instance.name !== "string" ||
    typeof instance.status !== "string" ||
    typeof instance.type !== "string" ||
    typeof instance.description !== "string" ||
    typeof instance.ephemeral !== "boolean" ||
    typeof instance.stateful !== "boolean" ||
    !isStringArray(instance.profiles)
  ) {
    return undefined
  }

  const architecture = readOptionalString(instance, "architecture")
  const createdAt = readOptionalString(instance, "created_at")
  const limits = readLimits(instance.config)
  const rootDisk = readRootDisk(instance.devices)

  if (
    architecture === undefined ||
    createdAt === undefined ||
    limits === undefined ||
    rootDisk === undefined
  ) {
    return undefined
  }

  return {
    name: instance.name,
    status: instance.status,
    type: instance.type,
    architecture,
    createdAt,
    description: instance.description,
    ephemeral: instance.ephemeral,
    stateful: instance.stateful,
    profiles: instance.profiles,
    limits,
    rootDisk,
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

function readLimits(value: unknown): InstanceDetail["limits"] | undefined {
  if (value === undefined) {
    return { memory: null, cpu: null }
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }

  const config = value as Record<string, unknown>
  const memory = readOptionalString(config, "limits.memory")
  const cpu = readOptionalString(config, "limits.cpu")

  if (memory === undefined || cpu === undefined) {
    return undefined
  }

  return { memory, cpu }
}

function readRootDisk(value: unknown): InstanceDetail["rootDisk"] | undefined {
  if (value === undefined) {
    return null
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }

  const devices = value as Record<string, unknown>
  const root = devices.root
  if (root === undefined) {
    return null
  }

  if (!root || typeof root !== "object" || Array.isArray(root)) {
    return undefined
  }

  const rootDevice = root as Record<string, unknown>
  const pool = readOptionalString(rootDevice, "pool")
  const size = readOptionalString(rootDevice, "size")

  if (pool === undefined || size === undefined || typeof rootDevice.type !== "string") {
    return undefined
  }

  return {
    pool,
    size,
    type: rootDevice.type,
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function invalidInstanceName(): InstanceDetailResult {
  return {
    httpStatus: 400,
    body: {
      error: {
        code: "INVALID_INSTANCE_NAME",
        message: "Invalid instance name",
        details: {},
      },
    },
  }
}

function agentUnavailable(): InstanceDetailResult {
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

function malformedUpstreamResponse(): InstanceDetailResult {
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
