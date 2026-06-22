import { hasGlobalAction, hasTeamAction } from "../../lib/adminAccess"
import type { AdminAccessSummary, AdminHostState } from "../../types"

export function canSyncAdminHost(access: AdminAccessSummary, host: AdminHostState): boolean {
  if (hasGlobalAction(access, "hosts:sync")) {
    return true
  }

  return host.endpoint.team ? hasTeamAction(access, host.endpoint.team.id, "hosts:sync") : false
}

export function countSyncableHosts(access: AdminAccessSummary, hosts: AdminHostState[]): number {
  return hosts.filter((host) => canSyncAdminHost(access, host)).length
}
