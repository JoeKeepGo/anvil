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
export type TenantStatus = "ACTIVE" | "ARCHIVED"
export type ProjectStatus = "ACTIVE" | "ARCHIVED"
export type HostStateStatus = "ONLINE"
export type ProjectTenantRole = "OWNER" | "PARTICIPANT"
export type ProjectTenantStatus = "ACTIVE" | "REMOVED"
export type EndpointProjectBindingStatus = "ACTIVE" | "REMOVED"

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
  | "tenants:read"
  | "tenants:write"
  | "projects:read"
  | "projects:write"
  | "quotas:read"
  | "quotas:write"
  | "resources:read"
  | "hosts:read"
  | "hosts:sync"
  | "network:read"
  | "network:write"
  | "network:apply"

export type TeamAction =
  | "members:read"
  | "members:write"
  | "endpoints:read"
  | "endpoints:write"
  | "audit:read"
  | "hosts:read"
  | "hosts:sync"

export type TenantAction = "tenants:read" | "projects:read" | "resources:read"
export type ProjectAction = "projects:read" | "quotas:read" | "resources:read"

export interface AdminAccessSummary {
  bootstrapComplete: boolean
  canAdmin: boolean
  globalActions: GlobalAction[]
  tenants: Array<{
    tenantId: string
    actions: TenantAction[]
  }>
  projects: Array<{
    projectId: string
    tenantId: string
    actions: ProjectAction[]
  }>
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

export interface AdminHostTeamSummary {
  id: string
  name: string
  status: TeamStatus
}

export interface AdminHostEndpointSummary {
  id: string
  name: string
  status: EndpointStatus
  team?: AdminHostTeamSummary
}

export interface AdminHostAgentSummary {
  id: string
  version: string
  stateSchemaVersion: number
  startedAt: string
  reportedAt: string
}

export interface AdminHostSummary {
  hostname: string
  os: string
  arch: string
}

export interface AdminHostIncusSummary {
  available: boolean
  statusCode: number
  serverVersion?: string
  apiVersion?: string
}

export interface AdminHostCapabilitySummary {
  incusProxy: boolean
  events: boolean
  stateReport: boolean
  wireGuard: boolean
  vmLifecycle: boolean
}

export interface AdminHostSnapshotSummary {
  instancesTotal: number
  imagesTotal: number
  operationsTotal: number
}

export interface AdminHostState {
  id: string
  endpoint: AdminHostEndpointSummary
  agent: AdminHostAgentSummary
  host: AdminHostSummary
  incus: AdminHostIncusSummary
  capabilities: AdminHostCapabilitySummary
  snapshot: AdminHostSnapshotSummary
  status: HostStateStatus
  firstSeenAt: string
  lastSeenAt: string
}

export interface ManagedTenant {
  id: string
  name: string
  slug: string
  status: TenantStatus
  defaultProjectId: string
}

export interface ManagedProject {
  id: string
  name: string
  slug: string
  status: ProjectStatus
  ownerTenantId: string
}

export interface ManagedProjectTenant {
  id: string
  projectId: string
  tenantId: string
  role: ProjectTenantRole
  status: ProjectTenantStatus
}

export interface ProjectQuotaPolicy {
  projectId: string
  maxVcpu: number | null
  maxMemoryBytes: number | null
  maxDiskBytes: number | null
  maxInstances: number | null
  maxIpv6Addresses: number | null
}

export interface ProjectTenantQuotaAllocation {
  projectId: string
  tenantId: string
  maxVcpu: number | null
  maxMemoryBytes: number | null
  maxDiskBytes: number | null
  maxInstances: number | null
  maxIpv6Addresses: number | null
}

export type QuotaInput = Omit<ProjectQuotaPolicy, "projectId">
export type TenantQuotaInput = Omit<ProjectTenantQuotaAllocation, "projectId" | "tenantId">

export interface ManagedEndpointProjectBinding {
  id: string
  endpointId: string
  projectId: string
  status: EndpointProjectBindingStatus
}

export interface AdminProjectDetail {
  project: ManagedProject
  participants: ManagedProjectTenant[]
  quota: ProjectQuotaPolicy | null
  tenantQuotas: ProjectTenantQuotaAllocation[]
  endpointBindings: ManagedEndpointProjectBinding[]
}

export interface CreateAdminTenantInput {
  name: string
  slug: string
}

export interface UpdateAdminTenantInput {
  name?: string
  slug?: string
}

export interface CreateAdminTenantResponse {
  tenant: ManagedTenant
  defaultProject: ManagedProject
}

export interface CreateAdminProjectInput {
  ownerTenantId: string
  name: string
  slug: string
}

export interface UpdateAdminProjectInput {
  name?: string
  slug?: string
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
  tenant: Array<{
    scope: "ACTIVE_TENANT"
    actions: TenantAction[]
  }>
  project: Array<{
    scope: "ACTIVE_PROJECT"
    actions: ProjectAction[]
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

// M12 network console types. These mirror the browser-safe backend contract:
// public keys and `*Configured` boolean flags only. WireGuard private keys and
// preshared keys are server-side only and never appear in these shapes.
export type NetworkFabricStatus = "PLANNED" | "ACTIVE" | "ARCHIVED"
export type NetworkFabricMode = "HUB_SPOKE" | "MESH"
export type WireGuardHubStatus = "PLANNED" | "ACTIVE" | "ARCHIVED"
export type NetworkPresharedKeyMode = "DISABLED" | "PAIRWISE" | "FABRIC"
export type HostNetworkPeerStatus = "PLANNED" | "ACTIVE" | "ARCHIVED"
export type HostNetworkPeerRole = "MEMBER" | "RELAY"
export type FabricPrefixKind = "SUBNET" | "ROUTE" | "RESERVED"
export type FabricPrefixStatus = "ACTIVE" | "ARCHIVED"
export type ProjectNetworkPoolStatus = "ACTIVE" | "ARCHIVED"
export type NetworkPoolAllocationMode = "STATIC" | "DYNAMIC" | "RESERVED"
export type NetworkApplyMode = "DRY_RUN" | "APPLY"
export type NetworkApplyStatus =
  | "PENDING"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"

export interface AdminNetworkFabric {
  id: string
  name: string
  slug: string
  status: NetworkFabricStatus
  mode: NetworkFabricMode
  overlayIpv4Cidr: string
  overlayIpv6Cidr: string
  hubCount: number
  peerCount: number
  prefixCount: number
  poolCount: number
  createdAt: string
  updatedAt: string
}

export interface AdminWireGuardHub {
  id: string
  fabricId: string
  name: string
  status: WireGuardHubStatus
  listenPort: number
  endpointHost: string
  publicKey: string
  presharedKeyMode: NetworkPresharedKeyMode
  privateKeyConfigured: boolean
  createdAt: string
  updatedAt: string
}

export interface AdminHostNetworkPeer {
  id: string
  fabricId: string
  endpointId: string | null
  name: string
  status: HostNetworkPeerStatus
  role: HostNetworkPeerRole
  publicKey: string
  privateKeyConfigured: boolean
  presharedKeyConfigured: boolean
  overlayIpv4Address: string | null
  overlayIpv6Address: string | null
  createdAt: string
  updatedAt: string
}

export interface AdminFabricPrefix {
  id: string
  fabricId: string
  kind: FabricPrefixKind
  cidr: string
  family: number
  status: FabricPrefixStatus
  ownerPeerId: string | null
  createdAt: string
  updatedAt: string
}

export interface AdminProjectNetworkPool {
  id: string
  projectId: string
  fabricId: string
  ipv4Cidr: string | null
  ipv6Cidr: string | null
  status: ProjectNetworkPoolStatus
  allocationMode: NetworkPoolAllocationMode
  createdAt: string
  updatedAt: string
}

export interface AdminNetworkFabricDetail extends AdminNetworkFabric {
  hubs: AdminWireGuardHub[]
  peers: AdminHostNetworkPeer[]
  prefixes: AdminFabricPrefix[]
  pools: AdminProjectNetworkPool[]
}

export interface AdminNetworkFabricsResponse {
  fabrics: AdminNetworkFabric[]
}

export interface AdminNetworkFabricResponse {
  fabric: AdminNetworkFabricDetail
}

export interface AdminProjectNetworkPoolsResponse {
  pools: AdminProjectNetworkPool[]
}

export interface AdminNetworkApplyEndpointResult {
  endpointId: string
  endpointName: string
  status: "OK" | "FAILED" | "SKIPPED"
  mode: NetworkApplyMode
  summary?: string
  error?: string
}

export interface AdminNetworkApplyResponse {
  fabricId: string
  operationId: string
  mode: NetworkApplyMode
  status: NetworkApplyStatus
  endpoints: AdminNetworkApplyEndpointResult[]
  summary: string
}

export interface AdminNetworkSyncEndpointResult {
  endpointId: string
  endpointName: string
  status: "SYNCED" | "SKIPPED" | "FAILED"
  snapshot?: AdminNetworkStateSnapshot
  error?: string
}

export interface AdminNetworkStateSnapshot {
  id: string
  endpointId: string
  fabricId: string | null
  agentId: string
  stateSchemaVersion: number
  observedAt: string
  wireGuardAvailable: boolean
  ipCommandAvailable: boolean
  iptablesAvailable: boolean
  ip6tablesAvailable: boolean
  forwarding: { ipv4: boolean; ipv6: boolean }
  managedInterfaceCount: number
  status: string
}

export interface AdminNetworkSyncResponse {
  fabricId: string
  endpoints: AdminNetworkSyncEndpointResult[]
}
