import { hasGlobalAction } from "../../lib/adminAccess"
import type { AdminAccessSummary } from "../../types"

// M13 VM lifecycle capability helpers. VM actions are global-only in the
// accepted backend permission model. Read requires vms:read, write requires
// vms:write. The backend checks globalRole === "ADMIN" for all VM operations,
// so these gated actions serve as additional frontend guards.
export function canReadVms(access: AdminAccessSummary): boolean {
  return hasGlobalAction(access, "vms:read")
}

export function canWriteVms(access: AdminAccessSummary): boolean {
  return hasGlobalAction(access, "vms:write")
}