import type {
  AdminAccessSummary,
  GlobalAction,
  ProjectAction,
  TeamAction,
  TenantAction,
} from "@/types"

export function canUseAdminConsole(access: AdminAccessSummary): boolean {
  return access.bootstrapComplete && access.canAdmin
}

export function hasGlobalAction(
  access: AdminAccessSummary,
  action: GlobalAction
): boolean {
  return access.globalActions.includes(action)
}

export function hasAnyGlobalAction(
  access: AdminAccessSummary,
  actions: GlobalAction[]
): boolean {
  return actions.some((action) => hasGlobalAction(access, action))
}

export function hasTeamAction(
  access: AdminAccessSummary,
  teamId: string,
  action: TeamAction
): boolean {
  return (
    access.teams.find((teamAccess) => teamAccess.teamId === teamId)?.actions.includes(action) ??
    false
  )
}

export function hasAnyTeamAction(access: AdminAccessSummary, action: TeamAction): boolean {
  return access.teams.some((teamAccess) => teamAccess.actions.includes(action))
}

export function hasTenantAction(
  access: AdminAccessSummary,
  tenantId: string,
  action: TenantAction
): boolean {
  return (
    access.tenants.find((tenantAccess) => tenantAccess.tenantId === tenantId)?.actions.includes(action) ??
    false
  )
}

export function hasProjectAction(
  access: AdminAccessSummary,
  projectId: string,
  action: ProjectAction
): boolean {
  return (
    access.projects.find((projectAccess) => projectAccess.projectId === projectId)?.actions.includes(action) ??
    false
  )
}
