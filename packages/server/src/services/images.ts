import {
  AgentConnectionError,
  type AgentRequest,
  type AgentResponse,
  AgentTimeoutError,
} from "./agent"
import type { ResourceVisibilityPolicy } from "./resourceVisibility"

export interface ImagesAgent {
  execute(request: AgentRequest): Promise<AgentResponse>
}

export interface ImageAlias {
  name: string
  description: string
}

export interface ImageSummary {
  fingerprint: string
  aliases: ImageAlias[]
  description: string
  architecture: string | null
  type: string
  sizeBytes: number
  cached: boolean
  public: boolean
  autoUpdate: boolean
  createdAt: string | null
  expiresAt: string | null
  lastUsedAt: string | null
  uploadedAt: string | null
}

type ImagesSuccessBody = {
  images: ImageSummary[]
}

export type ImagesErrorCode =
  | "AGENT_CONFIG_ERROR"
  | "AGENT_UNAVAILABLE"
  | "AGENT_UPSTREAM_ERROR"
  | "MALFORMED_UPSTREAM_RESPONSE"

export type ImagesErrorBody = {
  error: {
    code: ImagesErrorCode
    message: string
    details: Record<string, never>
  }
}

export type ImagesResult = {
  httpStatus: 200 | 500 | 502 | 503
  body: ImagesSuccessBody | ImagesErrorBody
}

export async function getImages(
  agent: ImagesAgent,
  visibility?: ResourceVisibilityPolicy
): Promise<ImagesResult> {
  try {
    const response = await agent.execute({ method: "GET", path: "/1.0/images?recursion=1" })
    const responseError = mapNonSuccessResponse(response)
    if (responseError) {
      return responseError
    }

    const images = readImages(response.body)
    if (!images) {
      return malformedUpstreamResponse()
    }

    const visibleFingerprints =
      visibility === undefined
        ? undefined
        : await visibility.filterVisibleResourceIds(
            "IMAGE",
            images.map((image) => image.fingerprint)
          )

    return {
      httpStatus: 200,
      body: {
        images:
          visibleFingerprints === undefined
            ? images
            : images.filter((image) => visibleFingerprints.has(image.fingerprint)),
      },
    }
  } catch (error) {
    if (error instanceof AgentTimeoutError || error instanceof AgentConnectionError) {
      return agentUnavailable()
    }

    throw error
  }
}

export function imagesAgentConfigError(): ImagesResult {
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

function mapNonSuccessResponse(response: AgentResponse): ImagesResult | undefined {
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

function readImages(body: unknown): ImageSummary[] | undefined {
  const metadata = readMetadata(body)

  if (!Array.isArray(metadata)) {
    return undefined
  }

  const images: ImageSummary[] = []
  for (const item of metadata) {
    const image = readImage(item)
    if (!image) {
      return undefined
    }
    images.push(image)
  }

  return images
}

function readImage(value: unknown): ImageSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }

  const image = value as Record<string, unknown>

  if (typeof image.fingerprint !== "string" || typeof image.type !== "string") {
    return undefined
  }

  const aliases = readAliases(image.aliases)
  const description = readDescription(image.properties)
  const architecture = readOptionalString(image, "architecture")
  const sizeBytes = readOptionalNumber(image, "size", 0)
  const cached = readOptionalBoolean(image, "cached", false)
  const publicImage = readOptionalBoolean(image, "public", false)
  const autoUpdate = readOptionalBoolean(image, "auto_update", false)
  const createdAt = readOptionalString(image, "created_at")
  const expiresAt = readOptionalString(image, "expires_at")
  const lastUsedAt = readOptionalString(image, "last_used_at")
  const uploadedAt = readOptionalString(image, "uploaded_at")

  if (
    aliases === undefined ||
    description === undefined ||
    architecture === undefined ||
    sizeBytes === undefined ||
    cached === undefined ||
    publicImage === undefined ||
    autoUpdate === undefined ||
    createdAt === undefined ||
    expiresAt === undefined ||
    lastUsedAt === undefined ||
    uploadedAt === undefined
  ) {
    return undefined
  }

  return {
    fingerprint: image.fingerprint,
    aliases,
    description,
    architecture,
    type: image.type,
    sizeBytes,
    cached,
    public: publicImage,
    autoUpdate,
    createdAt,
    expiresAt,
    lastUsedAt,
    uploadedAt,
  }
}

function readMetadata(body: unknown): unknown {
  if (!body || typeof body !== "object") {
    return undefined
  }

  return (body as Record<string, unknown>).metadata
}

function readAliases(value: unknown): ImageAlias[] | undefined {
  if (value === undefined || value === null) {
    return []
  }

  if (!Array.isArray(value)) {
    return undefined
  }

  const aliases: ImageAlias[] = []
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return undefined
    }

    const alias = item as Record<string, unknown>
    if (typeof alias.name !== "string" || typeof alias.description !== "string") {
      return undefined
    }

    aliases.push({ name: alias.name, description: alias.description })
  }

  return aliases
}

function readDescription(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return ""
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }

  const properties = value as Record<string, unknown>
  if (!Object.hasOwn(properties, "description") || properties.description === null) {
    return ""
  }

  return typeof properties.description === "string" ? properties.description : undefined
}

function readOptionalString(source: Record<string, unknown>, key: string): string | null | undefined {
  if (!Object.hasOwn(source, key) || source[key] === null) {
    return null
  }

  const value = source[key]
  return typeof value === "string" ? value : undefined
}

function readOptionalNumber(
  source: Record<string, unknown>,
  key: string,
  defaultValue: number
): number | undefined {
  if (!Object.hasOwn(source, key) || source[key] === null) {
    return defaultValue
  }

  const value = source[key]
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
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

function agentUnavailable(): ImagesResult {
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

function malformedUpstreamResponse(): ImagesResult {
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
