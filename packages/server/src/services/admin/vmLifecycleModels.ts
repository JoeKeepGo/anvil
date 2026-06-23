// M13 Phase 2: browser-safe VM lifecycle domain types and serialization.
//
// This module defines persistence-adjacent types for tenant-scoped VM lifecycle
// v1: VmInstance ownership records and VmLifecycleOperation history.
// Browser-safe serialization intentionally hides Incus internals, agent
// configuration, endpoint tokens, and any private network material. It exposes
// only the durable lifecycle identity the admin UI needs to render.
//
// No agent call and no Incus mutation happen here; these helpers feed Phase 4
// route handlers after backend policy checks pass.

export type VmInstanceStatus =
  | "PROVISIONING"
  | "RUNNING"
  | "STOPPED"
  | "FAILED"
  | "DELETED"

export type VmLifecycleAction = "CREATE" | "START" | "STOP" | "RESTART" | "DELETE"

export type VmLifecycleOperationStatus =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"

export type VmAddressFamily = "IPV4" | "IPV6" | "DUAL"

// ---------------------------------------------------------------------------
// Persisted record inputs (raw, server-only)
// ---------------------------------------------------------------------------

export interface PersistedVmInstance {
  id: string
  name: string
  endpointId: string
  projectId: string
  tenantId: string
  networkPoolId: string | null
  imageReference: string
  status: VmInstanceStatus
  cpuCount: number
  memoryBytes: bigint | number
  rootDiskBytes: bigint | number
  addressFamily: VmAddressFamily
  createdAt: Date
  updatedAt: Date
}

export interface PersistedVmLifecycleOperation {
  id: string
  vmInstanceId: string
  action: VmLifecycleAction
  status: VmLifecycleOperationStatus
  requestedByUserId: string
  summary: string | null
  errorSummary: string | null
  createdAt: Date
  updatedAt: Date
}

// ---------------------------------------------------------------------------
// Browser-safe serialization types
// ---------------------------------------------------------------------------

export interface BrowserVmLimits {
  cpu: number
  memoryBytes: number
  rootDiskBytes: number
}

export interface BrowserVmNetwork {
  poolId: string | null
  addressFamily: VmAddressFamily
}

export interface BrowserVmInstance {
  id: string
  name: string
  endpointId: string
  projectId: string
  tenantId: string
  imageReference: string
  status: VmInstanceStatus
  limits: BrowserVmLimits
  network: BrowserVmNetwork
  createdAt: string
  updatedAt: string
}

export interface BrowserVmLifecycleOperation {
  id: string
  vmInstanceId: string
  action: VmLifecycleAction
  status: VmLifecycleOperationStatus
  requestedByUserId: string
  summary: string | null
  errorSummary: string | null
  createdAt: string
  updatedAt: string
}

// ---------------------------------------------------------------------------
// Browser-safe serializers
// ---------------------------------------------------------------------------

export function toBrowserVmInstance(record: PersistedVmInstance): BrowserVmInstance {
  return {
    id: record.id,
    name: record.name,
    endpointId: record.endpointId,
    projectId: record.projectId,
    tenantId: record.tenantId,
    imageReference: record.imageReference,
    status: record.status,
    limits: {
      cpu: record.cpuCount,
      memoryBytes: numberFromBigInt(record.memoryBytes),
      rootDiskBytes: numberFromBigInt(record.rootDiskBytes),
    },
    network: {
      poolId: record.networkPoolId,
      addressFamily: record.addressFamily,
    },
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

export function toBrowserVmLifecycleOperation(
  record: PersistedVmLifecycleOperation
): BrowserVmLifecycleOperation {
  return {
    id: record.id,
    vmInstanceId: record.vmInstanceId,
    action: record.action,
    status: record.status,
    requestedByUserId: record.requestedByUserId,
    summary: record.summary,
    errorSummary: record.errorSummary,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Audit metadata helpers for lifecycle mutations
// ---------------------------------------------------------------------------

export const VM_LIFECYCLE_AUDIT_TARGET_TYPES = [
  "vm_instance",
  "vm_lifecycle_operation",
] as const

export type VmLifecycleAuditTargetType = (typeof VM_LIFECYCLE_AUDIT_TARGET_TYPES)[number]

export interface VmLifecycleAuditMetadata {
  vmInstanceId: string
  action: VmLifecycleAction
  status: VmLifecycleOperationStatus
  endpointId: string
  projectId: string
  tenantId: string
  cpuCount?: number
  memoryBytes?: number
  rootDiskBytes?: number
  addressFamily?: VmAddressFamily
  networkPoolId?: string | null
  summary?: string
}

/**
 * Build redaction-safe audit metadata for a VM lifecycle operation. The
 * returned metadata preserves action identity (vm/operation/action/status,
 * tenant/project/endpoint ownership, declared limits) but never carries
 * agent tokens, WireGuard keys, preshared keys, or endpoint credentials.
 * Callers may include a non-secret summary string.
 */
export function buildVmLifecycleAuditMetadata(
  input: {
    vmInstance: Pick<
      PersistedVmInstance,
      "id" | "endpointId" | "projectId" | "tenantId" | "cpuCount" | "memoryBytes" | "rootDiskBytes" | "addressFamily" | "networkPoolId"
    >
    operation: Pick<PersistedVmLifecycleOperation, "action" | "status">
    summary?: string
  }
): VmLifecycleAuditMetadata {
  const metadata: VmLifecycleAuditMetadata = {
    vmInstanceId: input.vmInstance.id,
    action: input.operation.action,
    status: input.operation.status,
    endpointId: input.vmInstance.endpointId,
    projectId: input.vmInstance.projectId,
    tenantId: input.vmInstance.tenantId,
    cpuCount: input.vmInstance.cpuCount,
    memoryBytes: numberFromBigInt(input.vmInstance.memoryBytes),
    rootDiskBytes: numberFromBigInt(input.vmInstance.rootDiskBytes),
    addressFamily: input.vmInstance.addressFamily,
    networkPoolId: input.vmInstance.networkPoolId,
  }
  if (input.summary !== undefined) {
    metadata.summary = input.summary
  }
  return metadata
}

function numberFromBigInt(value: bigint | number): number {
  return typeof value === "bigint" ? Number(value) : value
}
