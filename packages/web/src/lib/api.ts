import type { ServerInfo, Instance, InstancePost, Image, Operation, ApiError } from "../types"

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
  return apiFetch<Instance[]>("/api/instances")
}

export function fetchInstance(name: string): Promise<Instance> {
  return apiFetch<Instance>(`/api/instances/${encodeURIComponent(name)}`)
}

export function startInstance(name: string): Promise<{ operation: Operation }> {
  return apiFetch(`/api/instances/${encodeURIComponent(name)}/start`, { method: "POST" })
}

export function stopInstance(name: string): Promise<{ operation: Operation }> {
  return apiFetch(`/api/instances/${encodeURIComponent(name)}/stop`, { method: "POST" })
}

export function restartInstance(name: string): Promise<{ operation: Operation }> {
  return apiFetch(`/api/instances/${encodeURIComponent(name)}/restart`, { method: "POST" })
}

export function deleteInstance(name: string): Promise<{ operation: Operation }> {
  return apiFetch(`/api/instances/${encodeURIComponent(name)}`, { method: "DELETE" })
}

export function createInstance(data: InstancePost): Promise<{ operation: Operation }> {
  return apiFetch("/api/instances", {
    method: "POST",
    body: JSON.stringify(data),
  })
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
