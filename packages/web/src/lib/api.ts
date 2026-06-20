import type {
  ServerInfo,
  Instance,
  InstanceDetail,
  InstanceDetailResponse,
  InstancesResponse,
  ImageSummary,
  ImagesResponse,
  OperationSummary,
  OperationsResponse,
  AuthResponse,
  AuthUser,
  LogoutResponse,
  ApiError,
} from "../types"

class ApiRequestError extends Error {
  code: string
  details: Record<string, unknown>
  status: number

  constructor(error: ApiError, status: number) {
    super(error.message)
    this.name = "ApiRequestError"
    this.code = error.code
    this.details = error.details
    this.status = status
  }
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    ...options,
  })
  if (!res.ok) {
    let apiError: ApiError
    try {
      const body = await res.json()
      apiError = body.error
    } catch {
      apiError = {
        code: "UNKNOWN",
        message: `Request failed with status ${res.status}`,
        details: {},
      }
    }
    throw new ApiRequestError(apiError, res.status)
  }
  return res.json()
}

// Server
export function fetchServer(): Promise<ServerInfo> {
  return apiFetch<ServerInfo>("/api/server")
}

// Instances
export function fetchInstances(): Promise<Instance[]> {
  return apiFetch<InstancesResponse>("/api/instances").then((response) => response.instances)
}

export function fetchInstance(name: string): Promise<InstanceDetail> {
  return apiFetch<InstanceDetailResponse>(`/api/instances/${encodeURIComponent(name)}`).then(
    (response) => response.instance
  )
}

// Images
export function fetchImages(): Promise<ImageSummary[]> {
  return apiFetch<ImagesResponse>("/api/images").then((response) => response.images)
}

// Operations
export function fetchOperations(): Promise<OperationSummary[]> {
  return apiFetch<OperationsResponse>("/api/operations").then((response) => response.operations)
}

// Auth
export function login(email: string, password: string): Promise<AuthUser> {
  return apiFetch<AuthResponse>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  }).then((response) => response.user)
}

export function fetchMe(): Promise<AuthUser> {
  return apiFetch<AuthResponse>("/api/auth/me").then((response) => response.user)
}

export function logout(): Promise<void> {
  return apiFetch<LogoutResponse>("/api/auth/logout", {
    method: "POST",
  }).then(() => undefined)
}

export { ApiRequestError }
