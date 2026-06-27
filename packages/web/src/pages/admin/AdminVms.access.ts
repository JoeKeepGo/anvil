import { hasGlobalAction } from "../../lib/adminAccess"
import type { AdminAccessSummary } from "../../types"

export function canReadVms(access: AdminAccessSummary): boolean {
  return hasGlobalAction(access, "vm:read")
}

export function canCreateVm(access: AdminAccessSummary): boolean {
  return hasGlobalAction(access, "vm:create")
}

export function canStartVm(access: AdminAccessSummary): boolean {
  return hasGlobalAction(access, "vm:start")
}

export function canStopVm(access: AdminAccessSummary): boolean {
  return hasGlobalAction(access, "vm:stop")
}

export function canRestartVm(access: AdminAccessSummary): boolean {
  return hasGlobalAction(access, "vm:restart")
}

export function canDeleteVm(access: AdminAccessSummary): boolean {
  return hasGlobalAction(access, "vm:delete")
}