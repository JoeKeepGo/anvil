import type {
  AdminPrincipal,
  BrowserAccessSummary,
  GlobalAction,
  TeamAction,
} from "./session"

export type { AdminPrincipal } from "./session"

export const globalAdminActions: GlobalAction[] = [
  "users:read",
  "users:write",
  "teams:read",
  "teams:write",
  "audit:read",
]

export const teamOwnerActions: TeamAction[] = [
  "members:read",
  "members:write",
  "endpoints:read",
  "endpoints:write",
  "audit:read",
]

const teamMaintainerActions: TeamAction[] = ["members:read", "endpoints:read", "endpoints:write", "audit:read"]
const teamViewerActions: TeamAction[] = ["members:read", "endpoints:read", "audit:read"]

export function buildAccessSummary(
  principal: AdminPrincipal,
  bootstrapComplete: boolean
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

  return {
    bootstrapComplete,
    canAdmin: globalActions.length > 0 || teams.length > 0,
    globalActions,
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

function emptyAccessSummary(bootstrapComplete: boolean): BrowserAccessSummary {
  return {
    bootstrapComplete,
    canAdmin: false,
    globalActions: [],
    teams: [],
  }
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
