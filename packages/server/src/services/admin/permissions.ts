import type {
  AdminPrincipal,
  BrowserAccessSummary,
  GlobalAction,
  GlobalRole,
  TeamAction,
  TeamRole,
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
  }
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
