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

export type GlobalRole = "ADMIN" | "MEMBER"
export type TeamRole = "OWNER" | "MAINTAINER" | "VIEWER"
export type UserStatus = "ACTIVE" | "DISABLED"
export type TeamStatus = "ACTIVE" | "ARCHIVED"
export type MembershipStatus = "ACTIVE" | "REMOVED"
export type EndpointStatus = "ACTIVE" | "ARCHIVED"

export interface AuthUser {
  id: string
  email: string
  name: string
  status: UserStatus
  globalRole: GlobalRole
  teams: AuthUserTeam[]
}

export interface AuthUserTeam {
  id: string
  name: string
  role: TeamRole
  status: TeamStatus
}

export type GlobalAction =
  | "users:read"
  | "users:write"
  | "teams:read"
  | "teams:write"
  | "endpoints:read"
  | "endpoints:write"
  | "audit:read"

export type TeamAction =
  | "members:read"
  | "members:write"
  | "endpoints:read"
  | "endpoints:write"
  | "audit:read"

export interface AdminAccessSummary {
  bootstrapComplete: boolean
  canAdmin: boolean
  globalActions: GlobalAction[]
  teams: Array<{
    teamId: string
    actions: TeamAction[]
  }>
}

export interface AuthResponse {
  user: AuthUser
  access: AdminAccessSummary
}

export type AuthSession = AuthResponse

export interface LogoutResponse {
  ok: true
}

export interface BootstrapStatus {
  bootstrapComplete: boolean
  available: boolean
}

export interface BootstrapAdminInput {
  email: string
  name: string
  password: string
  teamName: string
}

export interface ManagedUserTeam {
  id: string
  name: string
  status: TeamStatus
  role: TeamRole
  membershipStatus: MembershipStatus
}

export interface ManagedUser {
  id: string
  email: string
  name: string
  status: UserStatus
  globalRole: GlobalRole
  teams: ManagedUserTeam[]
}

export interface CreateAdminUserInput {
  email: string
  name: string
  password: string
  globalRole: GlobalRole
  memberships?: Array<{
    teamId: string
    role: TeamRole
  }>
}

export interface UpdateAdminUserInput {
  email?: string
  name?: string
  globalRole?: GlobalRole
  status?: UserStatus
}

export interface ManagedTeamMember {
  userId: string
  email: string
  role: TeamRole
  status: MembershipStatus
}

export interface ManagedTeam {
  id: string
  name: string
  status: TeamStatus
  members: ManagedTeamMember[]
}

export interface ManagedEndpoint {
  id: string
  name: string
  url: string
  status: EndpointStatus
  team: {
    id: string
    name: string
    status: TeamStatus
  }
  credentialConfigured: boolean
}

export interface CreateAdminEndpointInput {
  name: string
  url: string
  token?: string
  teamId: string
  status?: EndpointStatus
}

export interface UpdateAdminEndpointInput {
  name?: string
  url?: string
  token?: string
  teamId?: string
  status?: EndpointStatus
}

export interface PermissionMatrix {
  global: Array<{
    role: GlobalRole
    actions: GlobalAction[]
  }>
  team: Array<{
    role: TeamRole
    actions: TeamAction[]
  }>
}

export interface BrowserAuditEntry {
  id: string
  actor: {
    id: string
    email: string
    name: string
  }
  action: string
  targetType: string
  targetId: string
  teamId?: string
  metadata?: Record<string, unknown>
  createdAt: string
}

export interface AuditPage {
  limit: number
  offset: number
  total: number
}

export interface AuditResponse {
  audit: BrowserAuditEntry[]
  page: AuditPage
}

export interface AuditQuery {
  actorUserId?: string
  targetType?: string
  targetId?: string
  teamId?: string
  action?: string
  from?: string
  to?: string
  limit?: number
  offset?: number
}

export interface ApiError {
  code: string
  message: string
  details: Record<string, unknown>
}
