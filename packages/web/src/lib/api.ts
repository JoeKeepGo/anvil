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
  AuthSession,
  LogoutResponse,
  ApiError,
  AuditQuery,
  AuditResponse,
  BootstrapAdminInput,
  BootstrapStatus,
  CreateAdminEndpointInput,
  CreateAdminProjectInput,
  CreateAdminTenantInput,
  CreateAdminTenantResponse,
  CreateAdminUserInput,
  AdminHostState,
  AdminProjectDetail,
  AdminNetworkApplyResponse,
  AdminNetworkFabric,
  AdminNetworkFabricDetail,
  AdminNetworkFabricResponse,
  AdminNetworkFabricsResponse,
  AdminNetworkSyncResponse,
  AdminProjectNetworkPool,
  AdminProjectNetworkPoolsResponse,
  ManagedEndpoint,
  ManagedEndpointProjectBinding,
  ManagedProject,
  ManagedProjectTenant,
  ManagedTenant,
  ManagedTeam,
  ManagedUser,
  PermissionMatrix,
  ProjectQuotaPolicy,
  ProjectTenantQuotaAllocation,
  QuotaInput,
  TenantQuotaInput,
  UpdateAdminEndpointInput,
  UpdateAdminProjectInput,
  UpdateAdminTenantInput,
  UpdateAdminUserInput,
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
export function login(email: string, password: string): Promise<AuthSession> {
  return apiFetch<AuthResponse>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  })
}

export function fetchMe(): Promise<AuthSession> {
  return apiFetch<AuthResponse>("/api/auth/me")
}

export function logout(): Promise<void> {
  return apiFetch<LogoutResponse>("/api/auth/logout", {
    method: "POST",
  }).then(() => undefined)
}

// Admin bootstrap
export function fetchBootstrapStatus(): Promise<BootstrapStatus> {
  return apiFetch<BootstrapStatus>("/api/admin/bootstrap/status")
}

export function bootstrapAdmin(input: BootstrapAdminInput): Promise<AuthSession> {
  return apiFetch<AuthResponse>("/api/admin/bootstrap", {
    method: "POST",
    body: JSON.stringify(input),
  })
}

// Admin users
export function fetchAdminUsers(): Promise<ManagedUser[]> {
  return apiFetch<{ users: ManagedUser[] }>("/api/admin/users").then((response) => response.users)
}

export function fetchAdminUser(userId: string): Promise<ManagedUser> {
  return apiFetch<{ user: ManagedUser }>(`/api/admin/users/${encodeURIComponent(userId)}`).then(
    (response) => response.user
  )
}

export function createAdminUser(input: CreateAdminUserInput): Promise<ManagedUser> {
  return apiFetch<{ user: ManagedUser }>("/api/admin/users", {
    method: "POST",
    body: JSON.stringify(input),
  }).then((response) => response.user)
}

export function updateAdminUser(userId: string, input: UpdateAdminUserInput): Promise<ManagedUser> {
  return apiFetch<{ user: ManagedUser }>(`/api/admin/users/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  }).then((response) => response.user)
}

export function disableAdminUser(userId: string): Promise<ManagedUser> {
  return apiFetch<{ user: ManagedUser }>(`/api/admin/users/${encodeURIComponent(userId)}/disable`, {
    method: "POST",
  }).then((response) => response.user)
}

export function restoreAdminUser(userId: string): Promise<ManagedUser> {
  return apiFetch<{ user: ManagedUser }>(`/api/admin/users/${encodeURIComponent(userId)}/restore`, {
    method: "POST",
  }).then((response) => response.user)
}

export function resetAdminUserPassword(userId: string, password: string): Promise<void> {
  return apiFetch<{ ok: true }>(`/api/admin/users/${encodeURIComponent(userId)}/reset-password`, {
    method: "POST",
    body: JSON.stringify({ password }),
  }).then(() => undefined)
}

// Admin teams
export function fetchAdminTeams(): Promise<ManagedTeam[]> {
  return apiFetch<{ teams: ManagedTeam[] }>("/api/admin/teams").then((response) => response.teams)
}

export function createAdminTeam(input: { name: string }): Promise<ManagedTeam> {
  return apiFetch<{ team: ManagedTeam }>("/api/admin/teams", {
    method: "POST",
    body: JSON.stringify(input),
  }).then((response) => response.team)
}

export function updateAdminTeam(teamId: string, input: { name: string }): Promise<ManagedTeam> {
  return apiFetch<{ team: ManagedTeam }>(`/api/admin/teams/${encodeURIComponent(teamId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  }).then((response) => response.team)
}

export function archiveAdminTeam(teamId: string): Promise<ManagedTeam> {
  return apiFetch<{ team: ManagedTeam }>(`/api/admin/teams/${encodeURIComponent(teamId)}/archive`, {
    method: "POST",
  }).then((response) => response.team)
}

export function restoreAdminTeam(teamId: string): Promise<ManagedTeam> {
  return apiFetch<{ team: ManagedTeam }>(`/api/admin/teams/${encodeURIComponent(teamId)}/restore`, {
    method: "POST",
  }).then((response) => response.team)
}

// Admin endpoints
export function fetchAdminEndpoints(): Promise<ManagedEndpoint[]> {
  return apiFetch<{ endpoints: ManagedEndpoint[] }>("/api/admin/endpoints").then(
    (response) => response.endpoints
  )
}

export function createAdminEndpoint(input: CreateAdminEndpointInput): Promise<ManagedEndpoint> {
  return apiFetch<{ endpoint: ManagedEndpoint }>("/api/admin/endpoints", {
    method: "POST",
    body: JSON.stringify(input),
  }).then((response) => response.endpoint)
}

export function updateAdminEndpoint(
  endpointId: string,
  input: UpdateAdminEndpointInput
): Promise<ManagedEndpoint> {
  return apiFetch<{ endpoint: ManagedEndpoint }>(
    `/api/admin/endpoints/${encodeURIComponent(endpointId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    }
  ).then((response) => response.endpoint)
}

export function archiveAdminEndpoint(endpointId: string): Promise<ManagedEndpoint> {
  return apiFetch<{ endpoint: ManagedEndpoint }>(
    `/api/admin/endpoints/${encodeURIComponent(endpointId)}/archive`,
    { method: "POST" }
  ).then((response) => response.endpoint)
}

export function restoreAdminEndpoint(endpointId: string): Promise<ManagedEndpoint> {
  return apiFetch<{ endpoint: ManagedEndpoint }>(
    `/api/admin/endpoints/${encodeURIComponent(endpointId)}/restore`,
    { method: "POST" }
  ).then((response) => response.endpoint)
}

// Admin hosts
export function fetchAdminHosts(): Promise<AdminHostState[]> {
  return apiFetch<{ hosts: AdminHostState[] }>("/api/admin/hosts").then((response) => response.hosts)
}

export function fetchAdminHost(hostId: string): Promise<AdminHostState> {
  return apiFetch<{ host: AdminHostState }>(`/api/admin/hosts/${encodeURIComponent(hostId)}`).then(
    (response) => response.host
  )
}

export function syncAdminHostState(endpointId: string): Promise<AdminHostState> {
  return apiFetch<{ host: AdminHostState }>(
    `/api/admin/endpoints/${encodeURIComponent(endpointId)}/agent-state/sync`,
    { method: "POST" }
  ).then((response) => response.host)
}

// Admin tenants
export function fetchAdminTenants(): Promise<ManagedTenant[]> {
  return apiFetch<{ tenants: ManagedTenant[] }>("/api/admin/tenants").then((response) => response.tenants)
}

export function fetchAdminTenant(tenantId: string): Promise<ManagedTenant> {
  return apiFetch<{ tenant: ManagedTenant }>(`/api/admin/tenants/${encodeURIComponent(tenantId)}`).then(
    (response) => response.tenant
  )
}

export function createAdminTenant(input: CreateAdminTenantInput): Promise<CreateAdminTenantResponse> {
  return apiFetch<CreateAdminTenantResponse>("/api/admin/tenants", {
    method: "POST",
    body: JSON.stringify(input),
  })
}

export function updateAdminTenant(
  tenantId: string,
  input: UpdateAdminTenantInput
): Promise<ManagedTenant> {
  return apiFetch<{ tenant: ManagedTenant }>(`/api/admin/tenants/${encodeURIComponent(tenantId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  }).then((response) => response.tenant)
}

export function archiveAdminTenant(tenantId: string): Promise<ManagedTenant> {
  return apiFetch<{ tenant: ManagedTenant }>(
    `/api/admin/tenants/${encodeURIComponent(tenantId)}/archive`,
    { method: "POST" }
  ).then((response) => response.tenant)
}

export function restoreAdminTenant(tenantId: string): Promise<ManagedTenant> {
  return apiFetch<{ tenant: ManagedTenant }>(
    `/api/admin/tenants/${encodeURIComponent(tenantId)}/restore`,
    { method: "POST" }
  ).then((response) => response.tenant)
}

// Admin projects
export function fetchAdminProjects(): Promise<ManagedProject[]> {
  return apiFetch<{ projects: ManagedProject[] }>("/api/admin/projects").then(
    (response) => response.projects
  )
}

export function fetchAdminProject(projectId: string): Promise<AdminProjectDetail> {
  return apiFetch<AdminProjectDetail>(`/api/admin/projects/${encodeURIComponent(projectId)}`)
}

export function createAdminProject(input: CreateAdminProjectInput): Promise<ManagedProject> {
  return apiFetch<{ project: ManagedProject }>("/api/admin/projects", {
    method: "POST",
    body: JSON.stringify(input),
  }).then((response) => response.project)
}

export function updateAdminProject(
  projectId: string,
  input: UpdateAdminProjectInput
): Promise<ManagedProject> {
  return apiFetch<{ project: ManagedProject }>(
    `/api/admin/projects/${encodeURIComponent(projectId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    }
  ).then((response) => response.project)
}

export function archiveAdminProject(projectId: string): Promise<ManagedProject> {
  return apiFetch<{ project: ManagedProject }>(
    `/api/admin/projects/${encodeURIComponent(projectId)}/archive`,
    { method: "POST" }
  ).then((response) => response.project)
}

export function restoreAdminProject(projectId: string): Promise<ManagedProject> {
  return apiFetch<{ project: ManagedProject }>(
    `/api/admin/projects/${encodeURIComponent(projectId)}/restore`,
    { method: "POST" }
  ).then((response) => response.project)
}

export function addAdminProjectTenant(
  projectId: string,
  input: { tenantId: string; role: ManagedProjectTenant["role"] }
): Promise<ManagedProjectTenant> {
  return apiFetch<{ participant: ManagedProjectTenant }>(
    `/api/admin/projects/${encodeURIComponent(projectId)}/tenants`,
    {
      method: "POST",
      body: JSON.stringify(input),
    }
  ).then((response) => response.participant)
}

export function updateAdminProjectTenant(
  projectId: string,
  tenantId: string,
  input: { role: ManagedProjectTenant["role"] }
): Promise<ManagedProjectTenant> {
  return apiFetch<{ participant: ManagedProjectTenant }>(
    `/api/admin/projects/${encodeURIComponent(projectId)}/tenants/${encodeURIComponent(tenantId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    }
  ).then((response) => response.participant)
}

export function removeAdminProjectTenant(
  projectId: string,
  tenantId: string
): Promise<ManagedProjectTenant> {
  return apiFetch<{ participant: ManagedProjectTenant }>(
    `/api/admin/projects/${encodeURIComponent(projectId)}/tenants/${encodeURIComponent(tenantId)}/remove`,
    { method: "POST" }
  ).then((response) => response.participant)
}

export function setAdminProjectQuota(
  projectId: string,
  input: QuotaInput
): Promise<ProjectQuotaPolicy> {
  return apiFetch<{ quota: ProjectQuotaPolicy }>(
    `/api/admin/projects/${encodeURIComponent(projectId)}/quota`,
    {
      method: "PUT",
      body: JSON.stringify(input),
    }
  ).then((response) => response.quota)
}

export function setAdminProjectTenantQuota(
  projectId: string,
  tenantId: string,
  input: TenantQuotaInput
): Promise<ProjectTenantQuotaAllocation> {
  return apiFetch<{ quota: ProjectTenantQuotaAllocation }>(
    `/api/admin/projects/${encodeURIComponent(projectId)}/tenants/${encodeURIComponent(tenantId)}/quota`,
    {
      method: "PUT",
      body: JSON.stringify(input),
    }
  ).then((response) => response.quota)
}

export function addAdminProjectEndpointBinding(
  projectId: string,
  endpointId: string
): Promise<ManagedEndpointProjectBinding> {
  return apiFetch<{ binding: ManagedEndpointProjectBinding }>(
    `/api/admin/projects/${encodeURIComponent(projectId)}/endpoints`,
    {
      method: "POST",
      body: JSON.stringify({ endpointId }),
    }
  ).then((response) => response.binding)
}

export function removeAdminProjectEndpointBinding(
  projectId: string,
  endpointId: string
): Promise<ManagedEndpointProjectBinding> {
  return apiFetch<{ binding: ManagedEndpointProjectBinding }>(
    `/api/admin/projects/${encodeURIComponent(projectId)}/endpoints/${encodeURIComponent(endpointId)}/remove`,
    { method: "POST" }
  ).then((response) => response.binding)
}

// Admin permissions and audit
export function fetchAdminPermissionMatrix(): Promise<PermissionMatrix> {
  return apiFetch<{ matrix: PermissionMatrix }>("/api/admin/permissions/matrix").then(
    (response) => response.matrix
  )
}

export function fetchAdminAudit(query: AuditQuery = {}): Promise<AuditResponse> {
  const searchParams = new URLSearchParams()
  appendQuery(searchParams, "actorUserId", query.actorUserId)
  appendQuery(searchParams, "targetType", query.targetType)
  appendQuery(searchParams, "targetId", query.targetId)
  appendQuery(searchParams, "teamId", query.teamId)
  appendQuery(searchParams, "action", query.action)
  appendQuery(searchParams, "from", query.from)
  appendQuery(searchParams, "to", query.to)
  appendQuery(searchParams, "limit", query.limit)
  appendQuery(searchParams, "offset", query.offset)

  const queryString = searchParams.toString()
  return apiFetch<AuditResponse>(`/api/admin/audit${queryString ? `?${queryString}` : ""}`)
}

function appendQuery(
  searchParams: URLSearchParams,
  key: string,
  value: string | number | undefined
): void {
  if (value !== undefined && value !== "") {
    searchParams.set(key, String(value))
  }
}

// Admin network (M12). Read/sync/dry-run/apply through Anvil /api only.
// Browser code never calls Agent, Incus, WireGuard sockets, or tunnel URLs.
export function fetchAdminNetworkFabrics(): Promise<AdminNetworkFabric[]> {
  return apiFetch<AdminNetworkFabricsResponse>("/api/admin/network/fabrics").then(
    (response) => response.fabrics
  )
}

export function fetchAdminNetworkFabric(fabricId: string): Promise<AdminNetworkFabricDetail> {
  return apiFetch<AdminNetworkFabricResponse>(
    `/api/admin/network/fabrics/${encodeURIComponent(fabricId)}`
  ).then((response) => response.fabric)
}

export function syncAdminNetworkFabric(fabricId: string): Promise<AdminNetworkSyncResponse> {
  return apiFetch<AdminNetworkSyncResponse>(
    `/api/admin/network/fabrics/${encodeURIComponent(fabricId)}/sync`,
    { method: "POST" }
  )
}

export function dryRunAdminNetworkFabric(fabricId: string): Promise<AdminNetworkApplyResponse> {
  return apiFetch<AdminNetworkApplyResponse>(
    `/api/admin/network/fabrics/${encodeURIComponent(fabricId)}/dry-run`,
    { method: "POST" }
  )
}

export function applyAdminNetworkFabric(fabricId: string): Promise<AdminNetworkApplyResponse> {
  return apiFetch<AdminNetworkApplyResponse>(
    `/api/admin/network/fabrics/${encodeURIComponent(fabricId)}/apply`,
    { method: "POST" }
  )
}

export function fetchAdminProjectNetworkPools(): Promise<AdminProjectNetworkPool[]> {
  return apiFetch<AdminProjectNetworkPoolsResponse>("/api/admin/network/project-pools").then(
    (response) => response.pools
  )
}

export { ApiRequestError }
