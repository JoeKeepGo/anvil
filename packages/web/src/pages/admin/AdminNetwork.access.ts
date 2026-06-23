import { hasGlobalAction } from "../../lib/adminAccess"
import type { AdminAccessSummary } from "../../types"

// M12 network console capability helpers. Network actions are global-only in
// the accepted backend permission model; there is no team-scoped network
// action. Read requires network:read. Sync, dry-run, and apply all route
// through the backend syncFabric / applyFabric services, which both assert
// network:apply (the dry-run path uses applyFabric with mode DRY_RUN), so the
// frontend must gate every mutation control on network:apply to match.
export function canReadNetwork(access: AdminAccessSummary): boolean {
  return hasGlobalAction(access, "network:read")
}

export function canSyncNetwork(access: AdminAccessSummary): boolean {
  return hasGlobalAction(access, "network:apply")
}

export function canDryRunNetwork(access: AdminAccessSummary): boolean {
  return hasGlobalAction(access, "network:apply")
}

export function canApplyNetwork(access: AdminAccessSummary): boolean {
  return hasGlobalAction(access, "network:apply")
}