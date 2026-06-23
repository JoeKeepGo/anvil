import { hasGlobalAction } from "../../lib/adminAccess"
import type { AdminAccessSummary } from "../../types"

// M12 network console capability helpers. Network actions are global-only in
// the accepted backend permission model; there is no team-scoped network
// action. Read requires network:read, sync requires network:read (sync is a
// read-adjacent observation action), dry-run requires network:write, and
// apply requires network:apply.
export function canReadNetwork(access: AdminAccessSummary): boolean {
  return hasGlobalAction(access, "network:read")
}

export function canSyncNetwork(access: AdminAccessSummary): boolean {
  return hasGlobalAction(access, "network:read")
}

export function canDryRunNetwork(access: AdminAccessSummary): boolean {
  return hasGlobalAction(access, "network:write")
}

export function canApplyNetwork(access: AdminAccessSummary): boolean {
  return hasGlobalAction(access, "network:apply")
}