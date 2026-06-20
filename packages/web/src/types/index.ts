export interface ServerInfo {
  version: string
  api_version: string
  environment: {
    server_name: string
    kernel: string
    os_name: string
  }
}

export interface Instance {
  name: string
  type: string
  status: string
  architecture: string | null
  createdAt: string | null
}

export interface InstancesResponse {
  instances: Instance[]
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

export interface InstanceDetailResponse {
  instance: InstanceDetail
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

export interface ImageAlias {
  name: string
  description: string
}

export interface ImagesResponse {
  images: ImageSummary[]
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
  resources: Record<string, unknown>
}

export interface OperationsResponse {
  operations: OperationSummary[]
}

export type AuthRole = "ADMIN" | "MEMBER"

export interface AuthUser {
  id: string
  email: string
  name: string
  role: AuthRole
}

export interface AuthResponse {
  user: AuthUser
}

export interface LogoutResponse {
  ok: true
}

export interface ApiError {
  code: string
  message: string
  details: Record<string, unknown>
}
