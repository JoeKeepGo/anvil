import type {
  ServerInfo,
  Instance,
  InstanceDetail,
  InstanceDetailResponse,
  InstancesResponse,
  Image,
  Operation,
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
export function fetchImages(): Promise<Image[]> {
  return apiFetch<Image[]>("/api/images")
}

// Operations
export function fetchOperations(): Promise<Operation[]> {
  return apiFetch<Operation[]>("/api/operations")
}

export function fetchOperation(id: string): Promise<Operation> {
  return apiFetch<Operation>(`/api/operations/${encodeURIComponent(id)}`)
}

// Auth
export function login(email: string, password: string): Promise<{ token: string }> {
  return apiFetch("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  })
}

export function fetchMe(): Promise<{ id: string; email: string; name: string }> {
  return apiFetch("/api/auth/me")
}

export { ApiRequestError }
