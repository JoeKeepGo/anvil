// M13 Phase 4: backend VM lifecycle orchestration service.
//
// This module wires Phase 2 policy helpers (`evaluateVmCreatePolicy`,
// `evaluateVmActionPolicy` from `./vmLifecyclePolicy`) to a persistence store
// and to a typed agent lifecycle protocol call. The service is the single
// orchestration point invoked by Phase 4 route handlers
// (`/api/admin/vms`, `/api/admin/vm-operations`).
//
// Order of operations for every mutation:
//   1. Backend policy passes (permission / tenant / project / endpoint binding /
//      network pool readiness / quota / allocation) BEFORE any agent call.
//   2. The VM instance record and its initial lifecycle operation record
//      (QUEUED) are persisted atomically in a single database transaction
//      (`createVmInstanceAndQueuedOperation`) so a crash cannot leave a VM
//      without an operation record or vice versa. The agent call happens
//      AFTER this transaction commits, outside it, and the operation then
//      transitions RUNNING -> SUCCEEDED|FAILED.
//   3. Only AFTER backend policy passes is the agent lifecycle protocol
//      invoked. The call is routed through the accepted Phase 3
//      `VmLifecycleAgentClient` boundary.
//   4. Every mutation records a redaction-safe audit entry
//      (`buildVmLifecycleAuditMetadata`).
//
// This file is server-only: it imports Prisma, decrypts endpoint tokens, and
// talks to agents. It must never be imported from the browser bundle.

import { PrismaClient, type Prisma } from "@prisma/client"
import { randomUUID } from "node:crypto"
import {
  AgentClient,
  AgentConnectionError,
  AgentProtocolError,
  AgentTimeoutError,
  type AgentClientOptions,
  type AgentRequest,
  type AgentResponse,
} from "../agent"
import { AuthConfigError } from "../auth"
import { decryptEndpointToken, EndpointTokenKeyError } from "./endpoints"
import type { AdminAuditEntry, AdminPrincipal } from "./session"
import {
  evaluateVmActionPolicy,
  evaluateVmCreatePolicy,
  type EvaluateVmActionPolicyInput,
  type EvaluateVmCreatePolicyInput,
  type PolicyEndpoint,
  type PolicyEndpointProjectBinding,
  type PolicyProject,
  type PolicyProjectNetworkPool,
  type PolicyProjectTenant,
  type PolicyQuota,
  type PolicyVmInstance,
  type PolicyVmUsage,
  type VmLifecycleDenyReason,
  type VmLifecyclePolicyStore,
} from "./vmLifecyclePolicy"
import {
  buildVmLifecycleAuditMetadata,
  toBrowserVmInstance,
  toBrowserVmLifecycleOperation,
  type BrowserVmInstance,
  type BrowserVmLifecycleOperation,
  type PersistedVmInstance,
  type PersistedVmLifecycleOperation,
  type VmAddressFamily,
  type VmInstanceStatus,
  type VmLifecycleAction,
  type VmLifecycleOperationStatus,
} from "./vmLifecycleModels"

// ---------------------------------------------------------------------------
// Public input types (route layer)
// ---------------------------------------------------------------------------

export interface CreateVmInput {
  name: string
  endpointId: string
  projectId: string
  tenantId: string
  networkPoolId: string | null
  imageReference: string
  cpuCount: number
  memoryBytes: number
  rootDiskBytes: number
  addressFamily: VmAddressFamily
}

export interface PerformVmActionInput {
  vmInstanceId: string
  action: Exclude<VmLifecycleAction, "CREATE">
}

export interface ListVmsQuery {
  projectId?: string
  tenantId?: string
  endpointId?: string
  status?: VmInstanceStatus
}

export interface ListOperationsQuery {
  vmInstanceId?: string
  action?: VmLifecycleAction
  status?: VmLifecycleOperationStatus
  limit?: number
  offset?: number
}

export interface CreateVmResult {
  vm: BrowserVmInstance
  operation: BrowserVmLifecycleOperation
}

export interface PerformVmActionResult {
  vm: BrowserVmInstance
  operation: BrowserVmLifecycleOperation
}

// ---------------------------------------------------------------------------
// Persistence store contract
// ---------------------------------------------------------------------------

export interface VmLifecycleEndpointForAgent {
  id: string
  url: string
  tokenCiphertext?: string
  status: "ACTIVE" | "ARCHIVED"
}

export interface VmLifecycleHostReadiness {
  endpointId: string
  status: string
  incusAvailable: boolean
  capabilityVmLifecycle: boolean
  lastSeenAt: Date | string
}

export interface VmLifecycleStore extends VmLifecyclePolicyStore {
  // Lifecycle persistence
  raceCreateVm(input: {
    endpointId: string
    name: string
  }): Promise<{ conflict: boolean }>
  createVmInstance(input: {
    id: string
    name: string
    endpointId: string
    projectId: string
    tenantId: string
    networkPoolId: string | null
    imageReference: string
    cpuCount: number
    memoryBytes: bigint
    rootDiskBytes: bigint
    addressFamily: VmAddressFamily
    status: VmInstanceStatus
  }): Promise<PersistedVmInstance>
  updateVmInstanceStatus(
    vmInstanceId: string,
    status: VmInstanceStatus
  ): Promise<PersistedVmInstance>
  getVmInstanceRecord(vmInstanceId: string): Promise<PersistedVmInstance | null>
  listVmInstances(query: ListVmsQuery): Promise<PersistedVmInstance[]>
  // Operations
  createOperation(input: {
    vmInstanceId: string
    action: VmLifecycleAction
    status: VmLifecycleOperationStatus
    requestedByUserId: string
    summary?: string | null
    errorSummary?: string | null
  }): Promise<PersistedVmLifecycleOperation>
  /**
   * Atomically persist the VM instance record and its initial lifecycle
   * operation. Implementations MUST commit both rows in a single database
   * transaction so a crash between the two writes cannot leave a VM without
   * an operation record (or vice versa). The agent call happens AFTER this
   * method returns, outside the transaction.
   */
  createVmInstanceAndQueuedOperation(input: {
    vmInstance: {
      id: string
      name: string
      endpointId: string
      projectId: string
      tenantId: string
      networkPoolId: string | null
      imageReference: string
      cpuCount: number
      memoryBytes: bigint
      rootDiskBytes: bigint
      addressFamily: VmAddressFamily
      status: VmInstanceStatus
    }
    operation: {
      action: VmLifecycleAction
      requestedByUserId: string
    }
  }): Promise<{ vmInstance: PersistedVmInstance; operation: PersistedVmLifecycleOperation }>
  updateOperation(
    operationId: string,
    input: { status: VmLifecycleOperationStatus; summary?: string | null; errorSummary?: string | null }
  ): Promise<PersistedVmLifecycleOperation>
  listOperations(query: {
    vmInstanceId?: string
    action?: VmLifecycleAction
    status?: VmLifecycleOperationStatus
    limit: number
    offset: number
  }): Promise<{ entries: PersistedVmLifecycleOperation[]; total: number }>
  // Endpoint fetch for agent calls
  getEndpointForAgent(endpointId: string): Promise<VmLifecycleEndpointForAgent | null>
  // Latest HostState readiness for mutation gates
  getLatestHostStateForEndpoint(endpointId: string): Promise<VmLifecycleHostReadiness | null>
  // Audit
  recordAudit(entry: AdminAuditEntry): Promise<void>
}

// ---------------------------------------------------------------------------
// Agent lifecycle client boundary
// ---------------------------------------------------------------------------

export interface VmLifecycleAgentClient {
  execute(request: AgentRequest): Promise<AgentResponse>
  close?(): void
}

export interface VmLifecycleAgentRequestPayload {
  action: VmLifecycleAction
  vmInstanceId: string
  instanceName: string
  imageReference: string
  limits: { cpuCount: number; memoryBytes: number; rootDiskBytes: number }
  network: { poolId: string | null; addressFamily: VmAddressFamily }
  secureBootEnabled: boolean
}

/**
 * Resolve whether Secure Boot should be enabled for a given image reference.
 *
 * M13 policy: all known smoke/Alpine images require Secure Boot disabled
 * (image property requirements.secureboot=false). Unknown images default to
 * false for M13 — the safe choice when image capability is not yet catalogued.
 *
 * M14+: derive from image metadata (Incus image properties
 * requirements.secureboot) via agent GET /1.0/images read path, or from an
 * image capability catalogue, rather than extending the list here.
 */
export function resolveVmSecureBootEnabled(_imageReference: string): boolean {
  // M13: no supported image requires Secure Boot. Default false until an image
  // catalogue with requirements.secureboot=true entries is introduced.
  return false
}

export interface VmLifecycleAgentResponsePayload {
  action: Exclude<VmLifecycleAction, "CREATE"> | "CREATE"
  instanceName: string
  agentStatus: "operation-completed" | "sync-ok"
  operationId: string
  operationKind: "async" | "sync"
  summary: string
}

export interface VmLifecycleActionOptions {
  env?: NodeJS.ProcessEnv
  createAgentClient?: (options: AgentClientOptions) => VmLifecycleAgentClient
  now?: () => Date
}

export const VM_LIFECYCLE_HOST_STATE_FRESHNESS_MS = 15 * 60 * 1000

// ---------------------------------------------------------------------------
// Errors (stable names; route layer maps to safe HTTP codes)
// ---------------------------------------------------------------------------

abstract class VmLifecycleError extends Error {
  abstract readonly code: VmLifecycleDenyReason | string
}

export class VmLifecyclePermissionDeniedError extends VmLifecycleError {
  readonly code = "FORBIDDEN" as const
  constructor(message = "Admin VM lifecycle permission denied.") {
    super(message)
    this.name = "VmLifecyclePermissionDeniedError"
  }
}

export class VmLifecycleUnauthenticatedError extends VmLifecycleError {
  readonly code = "UNAUTHENTICATED" as const
  constructor(message = "Authentication is required.") {
    super(message)
    this.name = "VmLifecycleUnauthenticatedError"
  }
}

export class VmLifecycleVmNotFoundError extends VmLifecycleError {
  readonly code = "VM_NOT_FOUND" as const
  constructor(message = "VM instance was not found.") {
    super(message)
    this.name = "VmLifecycleVmNotFoundError"
  }
}

export class VmLifecycleDuplicateNameError extends VmLifecycleError {
  readonly code = "VM_DUPLICATE_NAME" as const
  constructor(message = "A VM with that name already exists.") {
    super(message)
    this.name = "VmLifecycleDuplicateNameError"
  }
}

export class VmLifecycleInvalidRequestError extends VmLifecycleError {
  readonly code = "VM_INVALID_REQUEST" as const
  constructor(message = "VM lifecycle request is invalid.") {
    super(message)
    this.name = "VmLifecycleInvalidRequestError"
  }
}

export class VmLifecycleOperationConflictError extends VmLifecycleError {
  readonly code = "VM_OPERATION_CONFLICT" as const
  constructor(message = "A lifecycle operation is already running for this VM.") {
    super(message)
    this.name = "VmLifecycleOperationConflictError"
  }
}

export class VmLifecycleStatusConflictError extends VmLifecycleError {
  readonly code = "VM_STATUS_CONFLICT" as const
  constructor(message: string) {
    super(message)
    this.name = "VmLifecycleStatusConflictError"
  }
}

export class VmLifecycleAgentUnavailableError extends VmLifecycleError {
  readonly code = "VM_AGENT_UNAVAILABLE" as const
  constructor(message = "Agent lifecycle protocol is unavailable.") {
    super(message)
    this.name = "VmLifecycleAgentUnavailableError"
  }
}

export class VmLifecycleMalformedAgentResponseError extends VmLifecycleError {
  readonly code = "VM_AGENT_MALFORMED" as const
  constructor(message = "Agent lifecycle response is malformed.") {
    super(message)
    this.name = "VmLifecycleMalformedAgentResponseError"
  }
}

export class VmLifecycleAgentLifecycleFailedError extends VmLifecycleError {
  readonly code = "VM_AGENT_LIFECYCLE_FAILED" as const
  readonly reason: string

  constructor(reason: string) {
    const safeReason = sanitizeAgentLifecycleFailureReason(reason)
    super(`Agent lifecycle operation failed: ${safeReason}`)
    this.name = "VmLifecycleAgentLifecycleFailedError"
    this.reason = safeReason
  }
}

export class VmLifecycleHostNotReadyError extends VmLifecycleError {
  readonly code = "VM_HOST_NOT_READY" as const
  constructor(message: string) {
    super(message)
    this.name = "VmLifecycleHostNotReadyError"
  }
}

// ---------------------------------------------------------------------------
// Public service functions
// ---------------------------------------------------------------------------

export async function createVm(
  store: VmLifecycleStore,
  actor: AdminPrincipal,
  input: CreateVmInput,
  options: VmLifecycleActionOptions = {}
): Promise<CreateVmResult> {
  if (!input.name || input.name.trim() === "") {
    throw new VmLifecycleInvalidRequestError("VM name is required.")
  }
  if (!input.imageReference || input.imageReference.trim() === "") {
    throw new VmLifecycleInvalidRequestError("Image reference is required.")
  }

  const policyInput: EvaluateVmCreatePolicyInput = {
    principal: actor,
    endpointId: input.endpointId,
    projectId: input.projectId,
    tenantId: input.tenantId,
    networkPoolId: input.networkPoolId,
    cpuCount: input.cpuCount,
    memoryBytes: input.memoryBytes,
    rootDiskBytes: input.rootDiskBytes,
    addressFamily: input.addressFamily,
  }
  await assertPolicyPasses(await evaluateVmCreatePolicy(store, policyInput))
  await assertHostReadyForLifecycle(store, input.endpointId, options)

  // Duplicate-name guard under the (endpointId, name) unique constraint.
  const race = await store.raceCreateVm({
    endpointId: input.endpointId,
    name: input.name,
  })
  if (race.conflict) {
    throw new VmLifecycleDuplicateNameError()
  }

  const vmId = cryptoRandomUuid()
  const now = options.now?.() ?? new Date()
  void now

  // Provision the VM instance + queued operation atomically (store commits
  // both rows in a single transaction). The agent call happens AFTER this
  // returns, outside the transaction, and the operation then transitions to
  // RUNNING -> SUCCEEDED|FAILED.
  const { vmInstance: instance, operation } = await store.createVmInstanceAndQueuedOperation({
    vmInstance: {
      id: vmId,
      name: input.name,
      endpointId: input.endpointId,
      projectId: input.projectId,
      tenantId: input.tenantId,
      networkPoolId: input.networkPoolId,
      imageReference: input.imageReference,
      cpuCount: input.cpuCount,
      memoryBytes: BigInt(input.memoryBytes),
      rootDiskBytes: BigInt(input.rootDiskBytes),
      addressFamily: input.addressFamily,
      status: "PROVISIONING",
    },
    operation: {
      action: "CREATE",
      requestedByUserId: actor.id,
    },
  })

  // Audit the creation of the operation record (queued) immediately.
  await recordLifecycleAudit(store, actor, "vm.create", instance, operation)

  try {
    await store.updateOperation(operation.id, { status: "RUNNING" })
    const agentPayload: VmLifecycleAgentRequestPayload = {
      action: "CREATE",
      vmInstanceId: vmId,
      instanceName: input.name,
      imageReference: input.imageReference,
      limits: {
        cpuCount: input.cpuCount,
        memoryBytes: input.memoryBytes,
        rootDiskBytes: input.rootDiskBytes,
      },
      network: { poolId: input.networkPoolId, addressFamily: input.addressFamily },
      secureBootEnabled: resolveVmSecureBootEnabled(input.imageReference),
    }
    const agentResponse = await callAgentLifecycle(store, input.endpointId, agentPayload, options)
    const updatedInstance = await store.updateVmInstanceStatus(vmId, "PROVISIONING")
    const completedOperation = await store.updateOperation(operation.id, {
      status: "SUCCEEDED",
      summary: agentResponse.summary,
    })
    await recordLifecycleAudit(store, actor, "vm.create", updatedInstance, completedOperation)
    return {
      vm: toBrowserVmInstance(updatedInstance),
      operation: toBrowserVmLifecycleOperation(completedOperation),
    }
  } catch (error) {
    const errorSummary = safeErrorSummary(error)
    const failedInstance = await store.updateVmInstanceStatus(vmId, "FAILED")
    const failedOperation = await store.updateOperation(operation.id, {
      status: "FAILED",
      errorSummary,
    })
    await recordLifecycleAudit(store, actor, "vm.create", failedInstance, failedOperation)
    throw error
  }
}

export async function performVmAction(
  store: VmLifecycleStore,
  actor: AdminPrincipal,
  input: PerformVmActionInput,
  options: VmLifecycleActionOptions = {}
): Promise<PerformVmActionResult> {
  const existing = await store.getVmInstanceRecord(input.vmInstanceId)
  if (!existing) {
    throw new VmLifecycleVmNotFoundError()
  }

  const policyInput: EvaluateVmActionPolicyInput = {
    principal: actor,
    action: input.action,
    vmInstanceId: input.vmInstanceId,
    projectId: existing.projectId,
    tenantId: existing.tenantId,
    endpointId: existing.endpointId,
  }
  await assertPolicyPasses(await evaluateVmActionPolicy(store, policyInput))

  assertVmCanPerformAction(existing.status, input.action)

  // Operation-conflict guard: a RUNNING/QUEUED lifecycle operation blocks
  // heading into a new one to satisfy the "Operation conflict" edge case.
  const inflight = await store.listOperations({
    vmInstanceId: input.vmInstanceId,
    limit: 1,
    offset: 0,
  })
  if (
    inflight.entries.length > 0 &&
    (inflight.entries[0].status === "QUEUED" || inflight.entries[0].status === "RUNNING")
  ) {
    throw new VmLifecycleOperationConflictError()
  }
  await assertHostReadyForLifecycle(store, existing.endpointId, options)

  const operation = await store.createOperation({
    vmInstanceId: input.vmInstanceId,
    action: input.action,
    status: "QUEUED",
    requestedByUserId: actor.id,
  })
  await recordLifecycleAudit(store, actor, actionToAuditName(input.action), existing, operation)

  try {
    await store.updateOperation(operation.id, { status: "RUNNING" })

    const targetAgentStatus: VmInstanceStatus = actionTargetStatus(input.action, existing.status)
    let nextStatus = targetAgentStatus
    let summary = `${input.action.toLowerCase()} acknowledged by agent lifecycle protocol`

    if (input.action === "DELETE") {
      const agentResponse = await callAgentLifecycle(
        store,
        existing.endpointId,
        {
          action: input.action,
          vmInstanceId: input.vmInstanceId,
          instanceName: existing.name,
          imageReference: existing.imageReference,
          limits: {
            cpuCount: existing.cpuCount,
            memoryBytes: numberFromBigInt(existing.memoryBytes),
            rootDiskBytes: numberFromBigInt(existing.rootDiskBytes),
          },
          network: { poolId: existing.networkPoolId, addressFamily: existing.addressFamily },
          secureBootEnabled: false,
        },
        options
      )
      summary = agentResponse.summary
      const deletedInstance = await store.updateVmInstanceStatus(input.vmInstanceId, "DELETED")
      const completedOperation = await store.updateOperation(operation.id, {
        status: "SUCCEEDED",
        summary,
      })
      await recordLifecycleAudit(store, actor, actionToAuditName(input.action), deletedInstance, completedOperation)
      return {
        vm: toBrowserVmInstance(deletedInstance),
        operation: toBrowserVmLifecycleOperation(completedOperation),
      }
    }

    const agentResponse = await callAgentLifecycle(
      store,
      existing.endpointId,
      {
        action: input.action,
        vmInstanceId: input.vmInstanceId,
        instanceName: existing.name,
        imageReference: existing.imageReference,
        limits: {
          cpuCount: existing.cpuCount,
          memoryBytes: numberFromBigInt(existing.memoryBytes),
          rootDiskBytes: numberFromBigInt(existing.rootDiskBytes),
        },
        network: { poolId: existing.networkPoolId, addressFamily: existing.addressFamily },
        secureBootEnabled: false,
      },
      options
    )
    summary = agentResponse.summary
    const finalStatus: VmInstanceStatus = nextStatus
    const updatedInstance = await store.updateVmInstanceStatus(
      input.vmInstanceId,
      finalStatus
    )
    const completedOperation = await store.updateOperation(operation.id, {
      status: "SUCCEEDED",
      summary,
    })
    await recordLifecycleAudit(store, actor, actionToAuditName(input.action), updatedInstance, completedOperation)
    return {
      vm: toBrowserVmInstance(updatedInstance),
      operation: toBrowserVmLifecycleOperation(completedOperation),
    }
  } catch (error) {
    const errorSummary = safeErrorSummary(error)
    const failedInstance = await store.updateVmInstanceStatus(input.vmInstanceId, "FAILED")
    const failedOperation = await store.updateOperation(operation.id, {
      status: "FAILED",
      errorSummary,
    })
    await recordLifecycleAudit(store, actor, actionToAuditName(input.action), failedInstance, failedOperation)
    throw error
  }
}

export async function listVms(
  store: VmLifecycleStore,
  actor: AdminPrincipal,
  query: ListVmsQuery = {}
): Promise<BrowserVmInstance[]> {
  assertReadPermission(actor)
  const records = await store.listVmInstances(query)
  return records.map(toBrowserVmInstance)
}

export async function getVm(
  store: VmLifecycleStore,
  actor: AdminPrincipal,
  vmInstanceId: string
): Promise<BrowserVmInstance> {
  assertReadPermission(actor)
  const record = await store.getVmInstanceRecord(vmInstanceId)
  if (!record) {
    throw new VmLifecycleVmNotFoundError()
  }
  return toBrowserVmInstance(record)
}

export async function listVmOperations(
  store: VmLifecycleStore,
  actor: AdminPrincipal,
  query: ListOperationsQuery = {}
): Promise<{ entries: BrowserVmLifecycleOperation[]; total: number }> {
  assertReadPermission(actor)
  const limit = clampLimit(query.limit)
  const offset = clampOffset(query.offset)
  const result = await store.listOperations({
    vmInstanceId: query.vmInstanceId,
    action: query.action,
    status: query.status,
    limit,
    offset,
  })
  return {
    entries: result.entries.map(toBrowserVmLifecycleOperation),
    total: result.total,
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function assertReadPermission(actor: AdminPrincipal): void {
  if (actor.status !== "ACTIVE") {
    throw new VmLifecycleUnauthenticatedError()
  }
  if (actor.globalRole !== "ADMIN") {
    throw new VmLifecyclePermissionDeniedError()
  }
}

async function assertPolicyPasses(
  decision: { allowed: true } | { allowed: false; reason: VmLifecycleDenyReason }
): Promise<void> {
  if (decision.allowed) {
    return
  }
  switch (decision.reason) {
    case "UNAUTHENTICATED":
      throw new VmLifecycleUnauthenticatedError()
    case "FORBIDDEN":
      throw new VmLifecyclePermissionDeniedError()
    case "VM_NOT_FOUND":
      throw new VmLifecycleVmNotFoundError()
    case "INVALID_LIMITS":
      throw new VmLifecycleInvalidRequestError("VM limits are invalid.")
    case "PROJECT_NOT_FOUND":
    case "TENANT_NOT_IN_PROJECT":
    case "ENDPOINT_NOT_BOUND":
    case "QUOTA_EXCEEDED":
    case "TENANT_ALLOCATION_EXCEEDED":
    case "NETWORK_POOL_UNAVAILABLE":
      throw new VmLifecycleInvalidRequestError(`VM lifecycle denied: ${decision.reason}`)
    default:
      throw new VmLifecycleInvalidRequestError(`VM lifecycle denied: ${decision.reason}`)
  }
}

function assertVmCanPerformAction(status: VmInstanceStatus, action: Exclude<VmLifecycleAction, "CREATE">): void {
  if (status === "DELETED") {
    throw new VmLifecycleVmNotFoundError()
  }
  if (action === "START" && status === "RUNNING") {
    throw new VmLifecycleStatusConflictError("VM is already running.")
  }
  if (action === "STOP" && status === "STOPPED") {
    throw new VmLifecycleStatusConflictError("VM is already stopped.")
  }
  if (action === "RESTART" && status !== "RUNNING") {
    throw new VmLifecycleStatusConflictError("VM must be running to restart.")
  }
}

async function assertHostReadyForLifecycle(
  store: VmLifecycleStore,
  endpointId: string,
  options: VmLifecycleActionOptions
): Promise<void> {
  const hostState = await store.getLatestHostStateForEndpoint(endpointId)
  if (!hostState) {
    throw new VmLifecycleHostNotReadyError("Host state is required before VM lifecycle mutations.")
  }
  const lastSeenAt =
    hostState.lastSeenAt instanceof Date
      ? hostState.lastSeenAt.getTime()
      : Date.parse(hostState.lastSeenAt)
  const now = (options.now?.() ?? new Date()).getTime()
  if (!Number.isFinite(lastSeenAt) || now - lastSeenAt > VM_LIFECYCLE_HOST_STATE_FRESHNESS_MS) {
    throw new VmLifecycleHostNotReadyError("Host state is stale before VM lifecycle mutation.")
  }
  if (hostState.status !== "ONLINE") {
    throw new VmLifecycleHostNotReadyError("Host is not online for VM lifecycle mutations.")
  }
  if (!hostState.incusAvailable) {
    throw new VmLifecycleHostNotReadyError("Incus is unavailable for VM lifecycle mutations.")
  }
  if (!hostState.capabilityVmLifecycle) {
    throw new VmLifecycleHostNotReadyError("Host VM lifecycle capability is unavailable.")
  }
}

function actionTargetStatus(action: Exclude<VmLifecycleAction, "CREATE">, current: VmInstanceStatus): VmInstanceStatus {
  switch (action) {
    case "START":
      return "RUNNING"
    case "STOP":
      return "STOPPED"
    case "RESTART":
      return "RUNNING"
    case "DELETE":
      return "DELETED"
  }
}

function actionToAuditName(action: VmLifecycleAction): string {
  switch (action) {
    case "CREATE":
      return "vm.create"
    case "START":
      return "vm.start"
    case "STOP":
      return "vm.stop"
    case "RESTART":
      return "vm.restart"
    case "DELETE":
      return "vm.delete"
  }
}

async function recordLifecycleAudit(
  store: VmLifecycleStore,
  actor: AdminPrincipal,
  action: string,
  vmInstance: PersistedVmInstance,
  operation: PersistedVmLifecycleOperation
): Promise<void> {
  const metadata = buildVmLifecycleAuditMetadata({
    vmInstance: {
      id: vmInstance.id,
      endpointId: vmInstance.endpointId,
      projectId: vmInstance.projectId,
      tenantId: vmInstance.tenantId,
      cpuCount: vmInstance.cpuCount,
      memoryBytes: vmInstance.memoryBytes,
      rootDiskBytes: vmInstance.rootDiskBytes,
      addressFamily: vmInstance.addressFamily,
      networkPoolId: vmInstance.networkPoolId,
    },
    operation: { action: operation.action, status: operation.status },
    summary: operation.summary ?? undefined,
  })
  await store.recordAudit({
    actorUserId: actor.id,
    action,
    targetType: "vm_lifecycle_operation",
    targetId: operation.id,
    metadata: metadata as unknown as Record<string, unknown>,
  })
}

async function callAgentLifecycle(
  store: VmLifecycleStore,
  endpointId: string,
  payload: VmLifecycleAgentRequestPayload,
  options: VmLifecycleActionOptions
): Promise<VmLifecycleAgentResponsePayload> {
  const env = options.env ?? process.env
  const timeoutMs = parseRequestTimeout(env.ANVIL_AGENT_REQUEST_TIMEOUT_MS)
  const endpoint = await store.getEndpointForAgent(endpointId)
  if (!endpoint) {
    throw new VmLifecycleAgentUnavailableError()
  }
  if (endpoint.status === "ARCHIVED") {
    throw new VmLifecycleAgentUnavailableError()
  }

  const createAgentClient = options.createAgentClient ?? ((clientOptions) => new AgentClient(clientOptions))
  let client: VmLifecycleAgentClient
  try {
    client = createAgentClient({
      url: endpoint.url,
      token: endpoint.tokenCiphertext ? decryptEndpointToken(env, endpoint.tokenCiphertext) : undefined,
      requestTimeoutMs: timeoutMs,
    })
  } catch (error) {
    if (error instanceof EndpointTokenKeyError) {
      throw error
    }
    throw new VmLifecycleAgentUnavailableError()
  }

  try {
    const request = buildAgentLifecycleRequest(payload)
    const response = await withAgentTimeout(
      client.execute(request),
      timeoutMs
    )
    if (response.status < 200 || response.status >= 300) {
      throw new VmLifecycleAgentLifecycleFailedError(agentLifecycleFailureReason(response))
    }
    return normalizeAgentLifecycleResponse(response.body, payload)
  } catch (error) {
    if (
      error instanceof VmLifecycleMalformedAgentResponseError ||
      error instanceof VmLifecycleAgentLifecycleFailedError ||
      error instanceof VmLifecycleAgentUnavailableError ||
      error instanceof EndpointTokenKeyError
    ) {
      throw error
    }
    if (
      error instanceof AgentConnectionError ||
      error instanceof AgentTimeoutError ||
      error instanceof AgentProtocolError
    ) {
      throw new VmLifecycleAgentUnavailableError()
    }
    throw error
  } finally {
    client.close?.()
  }
}

function agentLifecycleFailureReason(response: AgentResponse): string {
  if (typeof response.error === "string" && response.error.trim() !== "") {
    return response.error
  }
  return `agent lifecycle request failed with status ${response.status}`
}

function sanitizeAgentLifecycleFailureReason(reason: string): string {
  const normalized = reason.replace(/\s+/g, " ").trim()
  return normalized.length > 0 ? normalized : "agent lifecycle operation failed"
}

function buildAgentLifecycleRequest(payload: VmLifecycleAgentRequestPayload): AgentRequest {
  switch (payload.action) {
    case "CREATE":
      return {
        method: "POST",
        path: "/agent/v1/lifecycle/instances/create",
        body: {
          name: payload.instanceName,
          image: payload.imageReference,
          cpuCount: payload.limits.cpuCount,
          memoryBytes: payload.limits.memoryBytes,
          rootDiskBytes: payload.limits.rootDiskBytes,
          secureBootEnabled: payload.secureBootEnabled,
        },
      }
    case "START":
      return {
        method: "POST",
        path: `/agent/v1/lifecycle/instances/${encodeURIComponent(payload.instanceName)}/start`,
      }
    case "STOP":
      return {
        method: "POST",
        path: `/agent/v1/lifecycle/instances/${encodeURIComponent(payload.instanceName)}/stop`,
      }
    case "RESTART":
      return {
        method: "POST",
        path: `/agent/v1/lifecycle/instances/${encodeURIComponent(payload.instanceName)}/restart`,
      }
    case "DELETE":
      return {
        method: "POST",
        path: `/agent/v1/lifecycle/instances/${encodeURIComponent(payload.instanceName)}/delete`,
        body: { confirm: true },
      }
  }
}

function agentActionName(action: VmLifecycleAction): "create" | "start" | "stop" | "restart" | "delete" {
  switch (action) {
    case "CREATE":
      return "create"
    case "START":
      return "start"
    case "STOP":
      return "stop"
    case "RESTART":
      return "restart"
    case "DELETE":
      return "delete"
  }
}

function normalizeAgentLifecycleResponse(
  body: unknown,
  payload: VmLifecycleAgentRequestPayload
): VmLifecycleAgentResponsePayload {
  if (!body || typeof body !== "object") {
    throw new VmLifecycleMalformedAgentResponseError()
  }
  const candidate = body as Record<string, unknown>
  const expectedAction = agentActionName(payload.action)
  if (candidate.action !== expectedAction || candidate.instance !== payload.instanceName) {
    throw new VmLifecycleMalformedAgentResponseError()
  }
  if (candidate.status !== "operation-completed" && candidate.status !== "sync-ok") {
    throw new VmLifecycleMalformedAgentResponseError()
  }
  if (candidate.operationKind !== "async" && candidate.operationKind !== "sync") {
    throw new VmLifecycleMalformedAgentResponseError()
  }
  if (
    (candidate.status === "operation-completed" && candidate.operationKind !== "async") ||
    (candidate.status === "sync-ok" && candidate.operationKind !== "sync")
  ) {
    throw new VmLifecycleMalformedAgentResponseError()
  }
  if (typeof candidate.operationId !== "string") {
    throw new VmLifecycleMalformedAgentResponseError()
  }
  const operationId = candidate.operationId
  const summary =
    operationId.length > 0
      ? `${expectedAction} ${candidate.status} (${operationId})`
      : `${expectedAction} ${candidate.status}`
  return {
    action: payload.action,
    instanceName: payload.instanceName,
    agentStatus: candidate.status,
    operationKind: candidate.operationKind,
    operationId,
    summary,
  }
}

async function withAgentTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(
          () => reject(new AgentTimeoutError(`Agent request timed out after ${timeoutMs}ms`)),
          timeoutMs
        )
      }),
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

function parseRequestTimeout(value: string | undefined): number {
  if (value === undefined) {
    return 5000
  }
  if (!/^[1-9]\d*$/.test(value)) {
    throw new AuthConfigError("ANVIL_AGENT_REQUEST_TIMEOUT_MS must be a positive integer")
  }
  return Number(value)
}

function safeErrorSummary(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name
  }
  return "VM lifecycle operation failed"
}

function numberFromBigInt(value: bigint | number): number {
  return typeof value === "bigint" ? Number(value) : value
}

function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) {
    return 50
  }
  return Math.min(value, 200)
}

function clampOffset(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) {
    return 0
  }
  return value
}

function cryptoRandomUuid(): string {
  return randomUUID()
}

// ---------------------------------------------------------------------------
// Prisma-backed store implementation
// ---------------------------------------------------------------------------

type VmLifecyclePrismaClient = Pick<
  PrismaClient,
  | "vmInstance"
  | "vmLifecycleOperation"
  | "agentEndpoint"
  | "hostState"
  | "auditLog"
  | "project"
  | "projectTenant"
  | "endpointProjectBinding"
  | "projectNetworkPool"
  | "projectQuota"
  | "projectTenantQuota"
  | "$transaction"
>

export class PrismaVmLifecycleStore implements VmLifecycleStore {
  constructor(
    private readonly prisma: VmLifecyclePrismaClient = new PrismaClient(),
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  // -- Policy store --
  async getProject(projectId: string): Promise<PolicyProject | null> {
    this.assertDatabaseConfigured()
    const row = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, status: true, ownerTenantId: true },
    })
    return row ? { id: row.id, status: row.status, ownerTenantId: row.ownerTenantId } : null
  }

  async getProjectTenant(
    projectId: string,
    tenantId: string
  ): Promise<PolicyProjectTenant | null> {
    this.assertDatabaseConfigured()
    const row = await this.prisma.projectTenant.findUnique({
      where: { projectId_tenantId: { projectId, tenantId } },
      select: { projectId: true, tenantId: true, status: true },
    })
    return row ? { projectId: row.projectId, tenantId: row.tenantId, status: row.status } : null
  }

  async getEndpoint(endpointId: string): Promise<PolicyEndpoint | null> {
    this.assertDatabaseConfigured()
    const row = await this.prisma.agentEndpoint.findUnique({
      where: { id: endpointId },
      select: { id: true, url: true, tokenCiphertext: true, status: true },
    })
    if (!row) {
      return null
    }
    return { id: row.id, status: row.status }
  }

  async getEndpointProjectBinding(
    endpointId: string,
    projectId: string
  ): Promise<PolicyEndpointProjectBinding | null> {
    this.assertDatabaseConfigured()
    const row = await this.prisma.endpointProjectBinding.findUnique({
      where: { endpointId_projectId: { endpointId, projectId } },
      select: { endpointId: true, projectId: true, status: true },
    })
    return row
      ? { endpointId: row.endpointId, projectId: row.projectId, status: row.status }
      : null
  }

  async getProjectNetworkPool(poolId: string): Promise<PolicyProjectNetworkPool | null> {
    this.assertDatabaseConfigured()
    const row = await this.prisma.projectNetworkPool.findUnique({
      where: { id: poolId },
      select: { id: true, projectId: true, status: true },
    })
    return row ? { id: row.id, projectId: row.projectId, status: row.status } : null
  }

  async getProjectQuota(projectId: string): Promise<PolicyQuota | null> {
    this.assertDatabaseConfigured()
    const row = await this.prisma.projectQuota.findUnique({
      where: { projectId },
      select: { maxVcpu: true, maxMemoryBytes: true, maxDiskBytes: true, maxInstances: true },
    })
    if (!row) {
      return null
    }
    return mapQuotaRow(row)
  }

  async getProjectTenantQuota(
    projectId: string,
    tenantId: string
  ): Promise<PolicyQuota | null> {
    this.assertDatabaseConfigured()
    const row = await this.prisma.projectTenantQuota.findUnique({
      where: { projectId_tenantId: { projectId, tenantId } },
      select: { maxVcpu: true, maxMemoryBytes: true, maxDiskBytes: true, maxInstances: true },
    })
    if (!row) {
      return null
    }
    return mapQuotaRow(row)
  }

  async getVmUsage(projectId: string, tenantId?: string): Promise<PolicyVmUsage> {
    this.assertDatabaseConfigured()
    // Materialized usage is computed via a bounded query against VmInstance,
    // excluding soft-deleted instances so they stop counting against quota.
    const rows = await this.prisma.vmInstance.findMany({
      where: {
        projectId,
        ...(tenantId ? { tenantId } : {}),
        status: { not: { equals: "DELETED" } },
      } as Prisma.VmInstanceWhereInput,
      orderBy: [{ id: "asc" }],
    })
    return {
      instanceCount: rows.length,
      totalVcpu: rows.reduce((sum, row) => sum + row.cpuCount, 0),
      totalMemoryBytes: rows.reduce((sum, row) => sum + Number(row.memoryBytes), 0),
      totalDiskBytes: rows.reduce((sum, row) => sum + Number(row.rootDiskBytes), 0),
    }
  }

  async getVmInstance(vmInstanceId: string): Promise<PolicyVmInstance | null> {
    this.assertDatabaseConfigured()
    const row = await this.prisma.vmInstance.findUnique({ where: { id: vmInstanceId } })
    if (!row) {
      return null
    }
    return {
      id: row.id,
      endpointId: row.endpointId,
      projectId: row.projectId,
      tenantId: row.tenantId,
      status: row.status,
    }
  }

  // -- Lifecycle store --
  async raceCreateVm(input: {
    endpointId: string
    name: string
  }): Promise<{ conflict: boolean }> {
    this.assertDatabaseConfigured()
    // The (endpointId, name) unique constraint is the source of truth: a
    // duplicate-key insert would surface here, but we use a lightweight
    // existence probe to keep the error path testable without depending on
    // Prisma's P2002 typing.
    const existing = await this.prisma.vmInstance.findMany({
      where: {
        endpointId: input.endpointId,
        name: input.name,
        status: { not: { equals: "DELETED" } },
      } as Prisma.VmInstanceWhereInput,
      orderBy: [{ id: "asc" }],
    })
    return { conflict: existing.length > 0 }
  }

  async createVmInstance(input: {
    id: string
    name: string
    endpointId: string
    projectId: string
    tenantId: string
    networkPoolId: string | null
    imageReference: string
    cpuCount: number
    memoryBytes: bigint
    rootDiskBytes: bigint
    addressFamily: VmAddressFamily
    status: VmInstanceStatus
  }): Promise<PersistedVmInstance> {
    this.assertDatabaseConfigured()
    const row = await this.prisma.vmInstance.create({
      data: {
        id: input.id,
        name: input.name,
        endpointId: input.endpointId,
        projectId: input.projectId,
        tenantId: input.tenantId,
        networkPoolId: input.networkPoolId,
        imageReference: input.imageReference,
        status: input.status,
        cpuCount: input.cpuCount,
        memoryBytes: input.memoryBytes,
        rootDiskBytes: input.rootDiskBytes,
        addressFamily: input.addressFamily,
      },
    })
    return mapPrismaVmInstance(row)
  }

  async updateVmInstanceStatus(
    vmInstanceId: string,
    status: VmInstanceStatus
  ): Promise<PersistedVmInstance> {
    this.assertDatabaseConfigured()
    const row = await this.prisma.vmInstance.update({
      where: { id: vmInstanceId },
      data: { status, updatedAt: new Date() },
    })
    return mapPrismaVmInstance(row)
  }

  async getVmInstanceRecord(vmInstanceId: string): Promise<PersistedVmInstance | null> {
    this.assertDatabaseConfigured()
    const row = await this.prisma.vmInstance.findUnique({ where: { id: vmInstanceId } })
    return row ? mapPrismaVmInstance(row) : null
  }

  async listVmInstances(query: ListVmsQuery): Promise<PersistedVmInstance[]> {
    this.assertDatabaseConfigured()
    const where: Prisma.VmInstanceWhereInput = {
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.tenantId ? { tenantId: query.tenantId } : {}),
      ...(query.endpointId ? { endpointId: query.endpointId } : {}),
      ...(query.status ? { status: query.status } : {}),
    }
    const rows = await this.prisma.vmInstance.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    })
    return rows.map(mapPrismaVmInstance)
  }

  async createOperation(input: {
    vmInstanceId: string
    action: VmLifecycleAction
    status: VmLifecycleOperationStatus
    requestedByUserId: string
    summary?: string | null
    errorSummary?: string | null
  }): Promise<PersistedVmLifecycleOperation> {
    this.assertDatabaseConfigured()
    const row = await this.prisma.vmLifecycleOperation.create({
      data: {
        vmInstanceId: input.vmInstanceId,
        action: input.action,
        status: input.status,
        requestedByUserId: input.requestedByUserId,
        summary: input.summary ?? null,
        errorSummary: input.errorSummary ?? null,
      },
    })
    return mapPrismaOperation(row)
  }

  async createVmInstanceAndQueuedOperation(input: {
    vmInstance: {
      id: string
      name: string
      endpointId: string
      projectId: string
      tenantId: string
      networkPoolId: string | null
      imageReference: string
      cpuCount: number
      memoryBytes: bigint
      rootDiskBytes: bigint
      addressFamily: VmAddressFamily
      status: VmInstanceStatus
    }
    operation: { action: VmLifecycleAction; requestedByUserId: string }
  }): Promise<{ vmInstance: PersistedVmInstance; operation: PersistedVmLifecycleOperation }> {
    this.assertDatabaseConfigured()
    // Both rows commit atomically; a crash between writes cannot leave the
    // VM record without its initial operation record (or vice versa). The
    // agent call happens after this method returns, outside the transaction.
    const result = await this.prisma.$transaction(async (tx) => {
      const vmRow = await tx.vmInstance.create({
        data: {
          id: input.vmInstance.id,
          name: input.vmInstance.name,
          endpointId: input.vmInstance.endpointId,
          projectId: input.vmInstance.projectId,
          tenantId: input.vmInstance.tenantId,
          networkPoolId: input.vmInstance.networkPoolId,
          imageReference: input.vmInstance.imageReference,
          status: input.vmInstance.status,
          cpuCount: input.vmInstance.cpuCount,
          memoryBytes: input.vmInstance.memoryBytes,
          rootDiskBytes: input.vmInstance.rootDiskBytes,
          addressFamily: input.vmInstance.addressFamily,
        },
      })
      const opRow = await tx.vmLifecycleOperation.create({
        data: {
          vmInstanceId: vmRow.id,
          action: input.operation.action,
          status: "QUEUED",
          requestedByUserId: input.operation.requestedByUserId,
          summary: null,
          errorSummary: null,
        },
      })
      return { vmInstance: vmRow, operation: opRow }
    })
    return {
      vmInstance: mapPrismaVmInstance(result.vmInstance),
      operation: mapPrismaOperation(result.operation),
    }
  }

  async updateOperation(
    operationId: string,
    input: { status: VmLifecycleOperationStatus; summary?: string | null; errorSummary?: string | null }
  ): Promise<PersistedVmLifecycleOperation> {
    this.assertDatabaseConfigured()
    const row = await this.prisma.vmLifecycleOperation.update({
      where: { id: operationId },
      data: {
        status: input.status,
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
        ...(input.errorSummary !== undefined ? { errorSummary: input.errorSummary } : {}),
      },
    })
    return mapPrismaOperation(row)
  }

  async listOperations(query: {
    vmInstanceId?: string
    action?: VmLifecycleAction
    status?: VmLifecycleOperationStatus
    limit: number
    offset: number
  }): Promise<{ entries: PersistedVmLifecycleOperation[]; total: number }> {
    this.assertDatabaseConfigured()
    const where: Prisma.VmLifecycleOperationWhereInput = {
      ...(query.vmInstanceId ? { vmInstanceId: query.vmInstanceId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.status ? { status: query.status } : {}),
    }
    const [entries, total] = await Promise.all([
      this.prisma.vmLifecycleOperation.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        skip: query.offset,
        take: query.limit,
      }),
      this.prisma.vmLifecycleOperation.count({ where }),
    ])
    return { entries: entries.map(mapPrismaOperation), total }
  }

  async getEndpointForAgent(endpointId: string): Promise<VmLifecycleEndpointForAgent | null> {
    this.assertDatabaseConfigured()
    const row = await this.prisma.agentEndpoint.findUnique({
      where: { id: endpointId },
      select: { id: true, url: true, tokenCiphertext: true, status: true },
    })
    if (!row) {
      return null
    }
    return {
      id: row.id,
      url: row.url,
      tokenCiphertext: row.tokenCiphertext ?? undefined,
      status: row.status,
    }
  }

  async getLatestHostStateForEndpoint(endpointId: string): Promise<VmLifecycleHostReadiness | null> {
    this.assertDatabaseConfigured()
    const row = await this.prisma.hostState.findUnique({
      where: { endpointId },
      select: {
        endpointId: true,
        status: true,
        incusAvailable: true,
        capabilityVmLifecycle: true,
        lastSeenAt: true,
      },
    })
    return row
      ? {
          endpointId: row.endpointId,
          status: row.status,
          incusAvailable: row.incusAvailable,
          capabilityVmLifecycle: row.capabilityVmLifecycle,
          lastSeenAt: row.lastSeenAt,
        }
      : null
  }

  async recordAudit(entry: AdminAuditEntry): Promise<void> {
    this.assertDatabaseConfigured()
    await this.prisma.auditLog.create({
      data: {
        actorId: entry.actorUserId,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        teamId: entry.teamId,
        metadata: entry.metadata as Prisma.InputJsonValue | undefined,
      },
    })
  }

  private assertDatabaseConfigured(): void {
    if (!this.env.DATABASE_URL || this.env.DATABASE_URL.trim() === "") {
      throw new AuthConfigError()
    }
  }
}

// A Prisma-stub client shape used by the VmLifecyclePrismaClient alias; the
// real PrismaClient satisfies these signatures via `Pick<>`.
export type { VmLifecyclePrismaClient }

function mapPrismaVmInstance(row: Prisma.VmInstanceGetPayload<{}>): PersistedVmInstance {
  return {
    id: row.id,
    name: row.name,
    endpointId: row.endpointId,
    projectId: row.projectId,
    tenantId: row.tenantId,
    networkPoolId: row.networkPoolId,
    imageReference: row.imageReference,
    status: row.status,
    cpuCount: row.cpuCount,
    memoryBytes: row.memoryBytes,
    rootDiskBytes: row.rootDiskBytes,
    addressFamily: row.addressFamily,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function mapPrismaOperation(row: Prisma.VmLifecycleOperationGetPayload<{}>): PersistedVmLifecycleOperation {
  return {
    id: row.id,
    vmInstanceId: row.vmInstanceId,
    action: row.action,
    status: row.status,
    requestedByUserId: row.requestedByUserId,
    summary: row.summary,
    errorSummary: row.errorSummary,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function mapQuotaRow(row: {
  maxVcpu: number | null
  maxMemoryBytes: bigint | null
  maxDiskBytes: bigint | null
  maxInstances: number | null
}): PolicyQuota {
  return {
    maxVcpu: row.maxVcpu,
    maxMemoryBytes: row.maxMemoryBytes === null ? null : Number(row.maxMemoryBytes),
    maxDiskBytes: row.maxDiskBytes === null ? null : Number(row.maxDiskBytes),
    maxInstances: row.maxInstances,
  }
}
