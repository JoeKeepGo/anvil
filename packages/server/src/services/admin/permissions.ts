import type {
  AdminPrincipal,
  BrowserAccessSummary,
  ProjectAction,
  GlobalAction,
  GlobalRole,
  TeamAction,
  TeamRole,
  TenantAction,
  TenantProjectAccessScopes,
} from "./session"

export type { AdminPrincipal } from "./session"

export const globalAdminActions: GlobalAction[] = [
  "users:read",
  "users:write",
  "teams:read",
  "teams:write",
  "endpoints:read",
  "endpoints:write",
  "audit:read",
  "tenants:read",
  "tenants:write",
  "projects:read",
  "projects:write",
  "quotas:read",
  "quotas:write",
  "resources:read",
  "hosts:read",
  "hosts:sync",
  "network:read",
  "network:write",
  "network:apply",
]

export const teamOwnerActions: TeamAction[] = [
  "members:read",
  "members:write",
  "endpoints:read",
  "endpoints:write",
  "audit:read",
  "hosts:read",
  "hosts:sync",
]

const teamMaintainerActions: TeamAction[] = [
  "members:read",
  "endpoints:read",
  "endpoints:write",
  "audit:read",
  "hosts:read",
  "hosts:sync",
]
const teamViewerActions: TeamAction[] = ["members:read", "endpoints:read", "audit:read", "hosts:read"]
const activeTenantActions: TenantAction[] = ["tenants:read", "projects:read", "resources:read"]
const activeProjectActions: ProjectAction[] = ["projects:read", "quotas:read", "resources:read"]

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

export function buildAccessSummary(
  principal: AdminPrincipal,
  bootstrapComplete: boolean,
  tenantProjectScopes: TenantProjectAccessScopes = emptyTenantProjectScopes()
): BrowserAccessSummary {
  if (principal.status !== "ACTIVE") {
    return emptyAccessSummary(bootstrapComplete)
  }

  const globalActions = principal.globalRole === "ADMIN" ? globalAdminActions : []
  const teams = principal.teams
    .filter((team) => team.status === "ACTIVE")
    .map((team) => ({
      teamId: team.id,
      actions: actionsForTeamRole(team.role),
    }))
    .filter((team) => team.actions.length > 0)
  const tenants = tenantScopeSummaries(tenantProjectScopes)
  const projects = projectScopeSummaries(tenantProjectScopes)

  return {
    bootstrapComplete,
    canAdmin: globalActions.length > 0 || teams.length > 0 || tenants.length > 0 || projects.length > 0,
    globalActions,
    tenants,
    projects,
    teams,
  }
}

export function canPerformGlobalAction(principal: AdminPrincipal, action: GlobalAction): boolean {
  return buildAccessSummary(principal, true).globalActions.includes(action)
}

export function canPerformTeamAction(
  principal: AdminPrincipal,
  teamId: string,
  action: TeamAction
): boolean {
  return (
    buildAccessSummary(principal, true)
      .teams.find((team) => team.teamId === teamId)
      ?.actions.includes(action) ?? false
  )
}

export function canPerformTenantAction(
  access: BrowserAccessSummary,
  tenantId: string,
  action: TenantAction
): boolean {
  return access.tenants.find((tenant) => tenant.tenantId === tenantId)?.actions.includes(action) ?? false
}

export function canPerformProjectAction(
  access: BrowserAccessSummary,
  projectId: string,
  action: ProjectAction
): boolean {
  return access.projects.find((project) => project.projectId === projectId)?.actions.includes(action) ?? false
}

export function getPermissionMatrix(): PermissionMatrix {
  return {
    global: [
      {
        role: "ADMIN",
        actions: globalAdminActions,
      },
      {
        role: "MEMBER",
        actions: [],
      },
    ],
    team: [
      {
        role: "OWNER",
        actions: teamOwnerActions,
      },
      {
        role: "MAINTAINER",
        actions: teamMaintainerActions,
      },
      {
        role: "VIEWER",
        actions: teamViewerActions,
      },
    ],
    tenant: [
      {
        scope: "ACTIVE_TENANT",
        actions: activeTenantActions,
      },
    ],
    project: [
      {
        scope: "ACTIVE_PROJECT",
        actions: activeProjectActions,
      },
    ],
  }
}

function emptyAccessSummary(bootstrapComplete: boolean): BrowserAccessSummary {
  return {
    bootstrapComplete,
    canAdmin: false,
    globalActions: [],
    tenants: [],
    projects: [],
    teams: [],
  }
}

function emptyTenantProjectScopes(): TenantProjectAccessScopes {
  return { tenants: [], projects: [] }
}

function tenantScopeSummaries(scopes: TenantProjectAccessScopes): BrowserAccessSummary["tenants"] {
  return scopes.tenants
    .filter((tenant) => tenant.status === "ACTIVE")
    .map((tenant) => ({
      tenantId: tenant.tenantId,
      actions: activeTenantActions,
    }))
}

function projectScopeSummaries(scopes: TenantProjectAccessScopes): BrowserAccessSummary["projects"] {
  const activeTenantIds = new Set(
    scopes.tenants.filter((tenant) => tenant.status === "ACTIVE").map((tenant) => tenant.tenantId)
  )
  return scopes.projects
    .filter((project) => project.status === "ACTIVE" && activeTenantIds.has(project.tenantId))
    .map((project) => ({
      projectId: project.projectId,
      tenantId: project.tenantId,
      actions: activeProjectActions,
    }))
}

function actionsForTeamRole(role: AdminPrincipal["teams"][number]["role"]): TeamAction[] {
  switch (role) {
    case "OWNER":
      return teamOwnerActions
    case "MAINTAINER":
      return teamMaintainerActions
    case "VIEWER":
      return teamViewerActions
  }
}
