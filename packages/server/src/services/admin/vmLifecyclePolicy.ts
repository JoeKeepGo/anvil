// M13 Phase 2: server-side VM lifecycle policy helpers.
//
// These pure functions evaluate create and action requests against M10
// ownership/quota/allocation, M11 endpoint binding, and M12 network pool
// readiness before any agent call or Incus mutation. They return a stable
// allow/deny verdict with a stable reason code so Phase 4 route handlers can
// map denials to safe HTTP responses without leaking internal state.
//
// No agent call and no Incus mutation happen here. Policy reads are delegated
// to an injected VmLifecyclePolicyStore so the helpers stay pure and
// unit-testable without a database.

import { canPerformGlobalAction } from "./permissions"
import type { AdminPrincipal, GlobalAction } from "./session"
import type {
  VmAddressFamily,
  VmInstanceStatus,
  VmLifecycleAction,
} from "./vmLifecycleModels"

export type { AdminPrincipal, GlobalAction } from "./session"

// ---------------------------------------------------------------------------
// Stable deny reason codes (phase doc contract)
// ---------------------------------------------------------------------------

export type VmLifecycleDenyReason =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "PROJECT_NOT_FOUND"
  | "TENANT_NOT_IN_PROJECT"
  | "ENDPOINT_NOT_BOUND"
  | "QUOTA_EXCEEDED"
  | "TENANT_ALLOCATION_EXCEEDED"
  | "NETWORK_POOL_UNAVAILABLE"
  | "INVALID_LIMITS"
  | "VM_NOT_FOUND"

export interface VmPolicyAllow {
  allowed: true
}

export interface VmPolicyDeny {
  allowed: false
  reason: VmLifecycleDenyReason
}

export type VmPolicyDecision = VmPolicyAllow | VmPolicyDeny

export function deny(reason: VmLifecycleDenyReason): VmPolicyDeny {
  return { allowed: false, reason }
}

export function allow(): VmPolicyAllow {
  return { allowed: true }
}

// ---------------------------------------------------------------------------
// Policy store contract (injected for testability)
// ---------------------------------------------------------------------------

export type ManagedProjectStatus = "ACTIVE" | "ARCHIVED"
export type ManagedTenantStatus = "ACTIVE" | "ARCHIVED"
export type ManagedEndpointStatus = "ACTIVE" | "ARCHIVED"
export type ManagedEndpointProjectBindingStatus = "ACTIVE" | "REMOVED"
export type ManagedProjectTenantStatus = "ACTIVE" | "REMOVED"
export type ManagedProjectNetworkPoolStatus = "ACTIVE" | "ARCHIVED"

export interface PolicyProject {
  id: string
  status: ManagedProjectStatus
  ownerTenantId: string
}

export interface PolicyProjectTenant {
  projectId: string
  tenantId: string
  status: ManagedProjectTenantStatus
}

export interface PolicyEndpoint {
  id: string
  status: ManagedEndpointStatus
}

export interface PolicyEndpointProjectBinding {
  endpointId: string
  projectId: string
  status: ManagedEndpointProjectBindingStatus
}

export interface PolicyProjectNetworkPool {
  id: string
  projectId: string
  status: ManagedProjectNetworkPoolStatus
}

export interface PolicyQuota {
  maxVcpu: number | null
  maxMemoryBytes: number | null
  maxDiskBytes: number | null
  maxInstances: number | null
}

export interface PolicyVmUsage {
  instanceCount: number
  totalVcpu: number
  totalMemoryBytes: number
  totalDiskBytes: number
}

export interface PolicyVmInstance {
  id: string
  endpointId: string
  projectId: string
  tenantId: string
  status: VmInstanceStatus
}

export interface VmLifecyclePolicyStore {
  getProject(projectId: string): Promise<PolicyProject | null>
  getProjectTenant(
    projectId: string,
    tenantId: string
  ): Promise<PolicyProjectTenant | null>
  getEndpoint(endpointId: string): Promise<PolicyEndpoint | null>
  getEndpointProjectBinding(
    endpointId: string,
    projectId: string
  ): Promise<PolicyEndpointProjectBinding | null>
  getProjectNetworkPool(poolId: string): Promise<PolicyProjectNetworkPool | null>
  getProjectQuota(projectId: string): Promise<PolicyQuota | null>
  getProjectTenantQuota(projectId: string, tenantId: string): Promise<PolicyQuota | null>
  getVmUsage(projectId: string, tenantId?: string): Promise<PolicyVmUsage>
  getVmInstance(vmInstanceId: string): Promise<PolicyVmInstance | null>
}

// ---------------------------------------------------------------------------
// Create policy input
// ---------------------------------------------------------------------------

export interface EvaluateVmCreatePolicyInput {
  principal: AdminPrincipal | null
  endpointId: string
  projectId: string
  tenantId: string
  networkPoolId: string | null
  cpuCount: number
  memoryBytes: number
  rootDiskBytes: number
  addressFamily: VmAddressFamily
}

export interface EvaluateVmActionPolicyInput {
  principal: AdminPrincipal | null
  action: VmLifecycleAction
  vmInstanceId: string
  projectId: string
  tenantId: string
  endpointId: string
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const safeIntegerMax = 2_147_483_647
const byteMax = 9_007_199_254_740_991

export function isValidVmLimits(input: {
  cpuCount: number
  memoryBytes: number
  rootDiskBytes: number
}): boolean {
  const { cpuCount, memoryBytes, rootDiskBytes } = input
  if (!Number.isSafeInteger(cpuCount) || cpuCount < 1 || cpuCount > safeIntegerMax) {
    return false
  }
  if (
    !Number.isSafeInteger(memoryBytes) ||
    memoryBytes < 1 ||
    memoryBytes > byteMax
  ) {
    return false
  }
  if (
    !Number.isSafeInteger(rootDiskBytes) ||
    rootDiskBytes < 1 ||
    rootDiskBytes > byteMax
  ) {
    return false
  }
  return true
}

function actionToPermission(action: VmLifecycleAction): GlobalAction {
  switch (action) {
    case "CREATE":
      return "vm:create"
    case "START":
      return "vm:start"
    case "STOP":
      return "vm:stop"
    case "RESTART":
      return "vm:restart"
    case "DELETE":
      return "vm:delete"
  }
}

async function assertPermission(
  principal: AdminPrincipal,
  action: GlobalAction
): Promise<VmPolicyDecision | null> {
  if (!canPerformGlobalAction(principal, action)) {
    return deny("FORBIDDEN")
  }
  return null
}

/**
 * Resolve the active principal or a deny decision. The returned principal is
 * narrowed to a non-null `AdminPrincipal` so subsequent permission checks
 * type-check without re-asserting nullability.
 */
function resolveActivePrincipal(
  principal: AdminPrincipal | null
): { principal: AdminPrincipal } | { decision: VmPolicyDeny } {
  if (!principal || principal.status !== "ACTIVE") {
    return { decision: deny("UNAUTHENTICATED") }
  }
  return { principal }
}

async function assertProjectActive(
  store: VmLifecyclePolicyStore,
  projectId: string
): Promise<PolicyProject | VmPolicyDecision> {
  const project = await store.getProject(projectId)
  if (!project || project.status !== "ACTIVE") {
    return deny("PROJECT_NOT_FOUND")
  }
  return project
}

async function assertTenantInProject(
  store: VmLifecyclePolicyStore,
  projectId: string,
  tenantId: string
): Promise<PolicyProjectTenant | VmPolicyDecision> {
  const participation = await store.getProjectTenant(projectId, tenantId)
  if (!participation || participation.status !== "ACTIVE") {
    return deny("TENANT_NOT_IN_PROJECT")
  }
  return participation
}

async function assertEndpointBound(
  store: VmLifecyclePolicyStore,
  endpointId: string,
  projectId: string
): Promise<PolicyEndpointProjectBinding | VmPolicyDecision> {
  const endpoint = await store.getEndpoint(endpointId)
  if (!endpoint || endpoint.status !== "ACTIVE") {
    return deny("ENDPOINT_NOT_BOUND")
  }
  const binding = await store.getEndpointProjectBinding(endpointId, projectId)
  if (!binding || binding.status !== "ACTIVE") {
    return deny("ENDPOINT_NOT_BOUND")
  }
  return binding
}

async function assertNetworkPoolReady(
  store: VmLifecyclePolicyStore,
  poolId: string | null,
  projectId: string
): Promise<PolicyProjectNetworkPool | VmPolicyDecision> {
  if (!poolId) {
    return deny("NETWORK_POOL_UNAVAILABLE")
  }
  const pool = await store.getProjectNetworkPool(poolId)
  if (!pool || pool.status !== "ACTIVE" || pool.projectId !== projectId) {
    return deny("NETWORK_POOL_UNAVAILABLE")
  }
  return pool
}

function usageWouldExceedQuota(
  quota: PolicyQuota | null,
  usage: PolicyVmUsage,
  request: { cpuCount: number; memoryBytes: number; rootDiskBytes: number }
): boolean {
  if (!quota) {
    return false
  }
  if (
    quota.maxInstances !== null &&
    usage.instanceCount + 1 > quota.maxInstances
  ) {
    return true
  }
  if (
    quota.maxVcpu !== null &&
    usage.totalVcpu + request.cpuCount > quota.maxVcpu
  ) {
    return true
  }
  if (
    quota.maxMemoryBytes !== null &&
    usage.totalMemoryBytes + request.memoryBytes > quota.maxMemoryBytes
  ) {
    return true
  }
  if (
    quota.maxDiskBytes !== null &&
    usage.totalDiskBytes + request.rootDiskBytes > quota.maxDiskBytes
  ) {
    return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Public policy functions (phase doc contract)
// ---------------------------------------------------------------------------

export async function evaluateVmCreatePolicy(
  store: VmLifecyclePolicyStore,
  input: EvaluateVmCreatePolicyInput
): Promise<VmPolicyDecision> {
  const resolved = resolveActivePrincipal(input.principal)
  if ("decision" in resolved) {
    return resolved.decision
  }
  const { principal } = resolved

  const permissionDecision = await assertPermission(principal, "vm:create")
  if (permissionDecision) {
    return permissionDecision
  }

  if (!isValidVmLimits(input)) {
    return deny("INVALID_LIMITS")
  }

  const project = await assertProjectActive(store, input.projectId)
  if ("allowed" in project) {
    return project
  }

  const participation = await assertTenantInProject(store, input.projectId, input.tenantId)
  if ("allowed" in participation) {
    return participation
  }

  const binding = await assertEndpointBound(store, input.endpointId, input.projectId)
  if ("allowed" in binding) {
    return binding
  }

  const pool = await assertNetworkPoolReady(store, input.networkPoolId, input.projectId)
  if ("allowed" in pool) {
    return pool
  }

  const projectUsage = await store.getVmUsage(input.projectId)
  if (
    usageWouldExceedQuota(
      await store.getProjectQuota(input.projectId),
      projectUsage,
      input
    )
  ) {
    return deny("QUOTA_EXCEEDED")
  }

  const tenantUsage = await store.getVmUsage(input.projectId, input.tenantId)
  if (
    usageWouldExceedQuota(
      await store.getProjectTenantQuota(input.projectId, input.tenantId),
      tenantUsage,
      input
    )
  ) {
    return deny("TENANT_ALLOCATION_EXCEEDED")
  }

  return allow()
}

export async function evaluateVmActionPolicy(
  store: VmLifecyclePolicyStore,
  input: EvaluateVmActionPolicyInput
): Promise<VmPolicyDecision> {
  const resolved = resolveActivePrincipal(input.principal)
  if ("decision" in resolved) {
    return resolved.decision
  }
  const { principal } = resolved

  const permissionDecision = await assertPermission(
    principal,
    actionToPermission(input.action)
  )
  if (permissionDecision) {
    return permissionDecision
  }

  const project = await assertProjectActive(store, input.projectId)
  if ("allowed" in project) {
    return project
  }

  const participation = await assertTenantInProject(store, input.projectId, input.tenantId)
  if ("allowed" in participation) {
    return participation
  }

  const binding = await assertEndpointBound(store, input.endpointId, input.projectId)
  if ("allowed" in binding) {
    return binding
  }

  const vm = await store.getVmInstance(input.vmInstanceId)
  if (
    !vm ||
    vm.projectId !== input.projectId ||
    vm.tenantId !== input.tenantId ||
    vm.endpointId !== input.endpointId
  ) {
    return deny("VM_NOT_FOUND")
  }
  if (vm.status === "DELETED" && input.action !== "DELETE") {
    return deny("VM_NOT_FOUND")
  }

  return allow()
}