import { PrismaClient, type Prisma } from "@prisma/client"
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
import { canPerformGlobalAction, canPerformTeamAction } from "./permissions"
import type { AdminAuditEntry, AdminPrincipal } from "./session"

const maxPostgresInteger = 2147483647
const hostStateAdvisoryLockNamespace = 0x4d313148

export type HostStateEndpointStatus = "ACTIVE" | "ARCHIVED"
export type HostStateTeamStatus = "ACTIVE" | "ARCHIVED"
export type HostStateStatus = "ONLINE"

export interface HostStateEndpointSummary {
  id: string
  name: string
  status: HostStateEndpointStatus
  team: {
    id: string
    name: string
    status: HostStateTeamStatus
  }
}

export interface HostStateSyncEndpoint extends HostStateEndpointSummary {
  url: string
  tokenCiphertext?: string
}

export interface BrowserHostState {
  id: string
  endpoint: {
    id: string
    name: string
    status: HostStateEndpointStatus
  }
  agent: HostStateAgentSummary
  host: HostStateHostSummary
  incus: HostStateIncusSummary
  capabilities: HostStateCapabilitySummary
  snapshot: HostStateSnapshotSummary
  status: HostStateStatus
  firstSeenAt: string
  lastSeenAt: string
}

export interface HostStateRecord extends Omit<BrowserHostState, "endpoint"> {
  endpoint: HostStateEndpointSummary
}

export interface HostStateAgentSummary {
  id: string
  version: string
  stateSchemaVersion: number
  startedAt: string
  reportedAt: string
}

export interface HostStateHostSummary {
  hostname: string
  os: string
  arch: string
}

export interface HostStateIncusSummary {
  available: boolean
  statusCode: number
  serverVersion?: string
  apiVersion?: string
}

export interface HostStateCapabilitySummary {
  incusProxy: boolean
  events: boolean
  stateReport: boolean
  wireGuard: boolean
  vmLifecycle: boolean
}

export interface HostStateSnapshotSummary {
  instancesTotal: number
  imagesTotal: number
  operationsTotal: number
}

export interface HostStateUpsertInput {
  endpoint: HostStateEndpointSummary
  agent: HostStateAgentSummary
  host: HostStateHostSummary
  incus: HostStateIncusSummary
  capabilities: HostStateCapabilitySummary
  snapshot: HostStateSnapshotSummary
  observedAt: string
}

export interface HostStateSyncCommitInput extends HostStateUpsertInput {
  actor: AdminPrincipal
}

export interface HostStateStore {
  listHostStates(): Promise<HostStateRecord[]>
  getHostState(hostStateId: string): Promise<HostStateRecord | null>
  getEndpointForHostStateSyncAuth(endpointId: string): Promise<HostStateEndpointSummary | null>
  getEndpointForHostStateSync(endpointId: string): Promise<HostStateSyncEndpoint | null>
  syncHostState(input: HostStateSyncCommitInput): Promise<HostStateRecord>
}

export interface HostStateAgentClient {
  execute(request: AgentRequest): Promise<AgentResponse>
  close?(): void
}

export interface HostStateSyncOptions {
  env?: NodeJS.ProcessEnv
  createAgentClient?: (options: AgentClientOptions) => HostStateAgentClient
  now?: () => Date
}

export class HostStatePermissionDeniedError extends Error {
  constructor(message = "Admin host permission denied.") {
    super(message)
    this.name = "HostStatePermissionDeniedError"
  }
}

export class HostStateNotFoundError extends Error {
  constructor(message = "Host state was not found.") {
    super(message)
    this.name = "HostStateNotFoundError"
  }
}

export class HostStateEndpointNotFoundError extends Error {
  constructor(message = "Endpoint was not found.") {
    super(message)
    this.name = "HostStateEndpointNotFoundError"
  }
}

export class HostStateEndpointArchivedError extends Error {
  constructor(message = "Endpoint is archived.") {
    super(message)
    this.name = "HostStateEndpointArchivedError"
  }
}

export class HostStateMalformedReportError extends Error {
  constructor(message = "Agent state report is malformed.") {
    super(message)
    this.name = "HostStateMalformedReportError"
  }
}

export class HostStateAgentUnavailableError extends Error {
  constructor(message = "Agent is unavailable.") {
    super(message)
    this.name = "HostStateAgentUnavailableError"
  }
}

export class HostStateAgentConflictError extends Error {
  constructor(message = "Endpoint agent identity changed.") {
    super(message)
    this.name = "HostStateAgentConflictError"
  }
}

export class PrismaHostStateStore implements HostStateStore {
  constructor(
    private readonly prisma: PrismaHostStateClient = new PrismaClient(),
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  async listHostStates(): Promise<HostStateRecord[]> {
    this.assertDatabaseConfigured()
    const states = await this.prisma.hostState.findMany({
      include: hostStateInclude,
      orderBy: [{ lastSeenAt: "desc" }, { id: "asc" }],
    })
    return states.map(mapPrismaHostState)
  }

  async getHostState(hostStateId: string): Promise<HostStateRecord | null> {
    this.assertDatabaseConfigured()
    const state = await this.prisma.hostState.findUnique({
      where: { id: hostStateId },
      include: hostStateInclude,
    })
    return state ? mapPrismaHostState(state) : null
  }

  async getEndpointForHostStateSyncAuth(endpointId: string): Promise<HostStateEndpointSummary | null> {
    this.assertDatabaseConfigured()
    const endpoint = await this.prisma.agentEndpoint.findUnique({
      where: { id: endpointId },
      select: {
        id: true,
        name: true,
        status: true,
        team: {
          select: {
            id: true,
            name: true,
            status: true,
          },
        },
      },
    })
    return endpoint ? mapPrismaEndpointSummary(endpoint) : null
  }

  async getEndpointForHostStateSync(endpointId: string): Promise<HostStateSyncEndpoint | null> {
    this.assertDatabaseConfigured()
    const endpoint = await this.prisma.agentEndpoint.findUnique({
      where: { id: endpointId },
      select: {
        id: true,
        name: true,
        url: true,
        tokenCiphertext: true,
        status: true,
        team: {
          select: {
            id: true,
            name: true,
            status: true,
          },
        },
      },
    })
    return endpoint ? mapPrismaEndpointForSync(endpoint) : null
  }

  async syncHostState(input: HostStateSyncCommitInput): Promise<HostStateRecord> {
    this.assertDatabaseConfigured()
    const observedAt = new Date(input.observedAt)
    const state = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(
          ${hostStateAdvisoryLockNamespace}::int,
          hashtext(${input.endpoint.id})::int
        )
      `

      const currentEndpoint = await tx.agentEndpoint.findUnique({
        where: { id: input.endpoint.id },
        select: endpointSummarySelect,
      })
      if (!currentEndpoint) {
        throw new HostStateEndpointNotFoundError()
      }
      const endpoint = mapPrismaEndpointSummary(currentEndpoint)
      assertCanSyncHostState(input.actor, endpoint.team.id)
      assertEndpointCanSync(endpoint)

      const existing = await tx.hostState.findUnique({
        where: { endpointId: endpoint.id },
        select: { agentId: true },
      })
      if (existing && existing.agentId !== input.agent.id) {
        throw new HostStateAgentConflictError()
      }

      const nextState = await tx.hostState.upsert({
        where: { endpointId: endpoint.id },
        create: {
          endpointId: endpoint.id,
          ...hostStatePersistenceFields({ ...input, endpoint }),
          firstSeenAt: observedAt,
          lastSeenAt: observedAt,
          status: "ONLINE",
        },
        update: {
          ...hostStatePersistenceFields({ ...input, endpoint }),
          lastSeenAt: observedAt,
          status: "ONLINE",
        },
        include: hostStateInclude,
      })
      const record = mapPrismaHostState(nextState)
      const auditEntry = hostStateSyncAuditEntry({ ...input, endpoint }, record)
      await tx.auditLog.create({
        data: {
          actorId: auditEntry.actorUserId,
          action: auditEntry.action,
          targetType: auditEntry.targetType,
          targetId: auditEntry.targetId,
          teamId: auditEntry.teamId,
          metadata: auditEntry.metadata as Prisma.InputJsonValue | undefined,
        },
      })
      return nextState
    })
    return mapPrismaHostState(state)
  }

  private assertDatabaseConfigured(): void {
    if (!this.env.DATABASE_URL || this.env.DATABASE_URL.trim() === "") {
      throw new AuthConfigError()
    }
  }
}

export async function listHostStates(
  store: HostStateStore,
  actor: AdminPrincipal
): Promise<HostStateRecord[]> {
  assertHasAnyHostReadPermission(actor)
  const states = await store.listHostStates()
  if (canPerformGlobalAction(actor, "hosts:read")) {
    return states
  }
  return states.filter((state) => canPerformTeamAction(actor, state.endpoint.team.id, "hosts:read"))
}

export async function getHostState(
  store: HostStateStore,
  actor: AdminPrincipal,
  hostStateId: string
): Promise<HostStateRecord> {
  assertHasAnyHostReadPermission(actor)
  const state = await store.getHostState(hostStateId)
  if (!state) {
    throw new HostStateNotFoundError()
  }
  assertCanReadHostState(actor, state.endpoint.team.id)
  return state
}

export async function syncEndpointHostState(
  store: HostStateStore,
  actor: AdminPrincipal,
  endpointId: string,
  options: HostStateSyncOptions = {}
): Promise<HostStateRecord> {
  assertHasAnyHostSyncPermission(actor)
  const endpointTarget = await store.getEndpointForHostStateSyncAuth(endpointId)
  if (!endpointTarget) {
    throw new HostStateEndpointNotFoundError()
  }
  assertCanSyncHostState(actor, endpointTarget.team.id)
  assertEndpointCanSync(endpointTarget)

  const endpoint = await store.getEndpointForHostStateSync(endpointId)
  if (!endpoint) {
    throw new HostStateEndpointNotFoundError()
  }
  assertEndpointCanSync(endpoint)

  const report = normalizeAgentStateReport(await fetchAgentStateReport(endpoint, options))
  const observedAt = (options.now?.() ?? new Date()).toISOString()
  return store.syncHostState({
    endpoint,
    ...report,
    observedAt,
    actor,
  })
}

function assertEndpointCanSync(endpoint: HostStateEndpointSummary): void {
  if (endpoint.status === "ARCHIVED" || endpoint.team.status === "ARCHIVED") {
    throw new HostStateEndpointArchivedError()
  }
}

export function toBrowserHostState(state: HostStateRecord): BrowserHostState {
  return {
    id: state.id,
    endpoint: {
      id: state.endpoint.id,
      name: state.endpoint.name,
      status: state.endpoint.status,
    },
    agent: state.agent,
    host: state.host,
    incus: state.incus,
    capabilities: state.capabilities,
    snapshot: state.snapshot,
    status: state.status,
    firstSeenAt: state.firstSeenAt,
    lastSeenAt: state.lastSeenAt,
  }
}

async function fetchAgentStateReport(
  endpoint: HostStateSyncEndpoint,
  options: HostStateSyncOptions
): Promise<unknown> {
  const env = options.env ?? process.env
  const requestTimeoutMs = parseRequestTimeout(env.ANVIL_AGENT_REQUEST_TIMEOUT_MS)
  const client = (options.createAgentClient ?? ((clientOptions) => new AgentClient(clientOptions)))({
    url: endpoint.url,
    token: endpoint.tokenCiphertext ? decryptEndpointToken(env, endpoint.tokenCiphertext) : undefined,
    requestTimeoutMs,
  })

  try {
    const response = await withAgentRequestTimeout(
      client.execute({ method: "GET", path: "/agent/v1/state" }),
      requestTimeoutMs
    )
    if (response.status < 200 || response.status >= 300) {
      throw new HostStateMalformedReportError()
    }
    return response.body
  } catch (error) {
    if (error instanceof HostStateMalformedReportError) {
      throw error
    }
    if (
      error instanceof AgentConnectionError ||
      error instanceof AgentTimeoutError ||
      error instanceof AgentProtocolError
    ) {
      throw new HostStateAgentUnavailableError()
    }
    throw error
  } finally {
    client.close?.()
  }
}

async function withAgentRequestTimeout<T>(operation: Promise<T>, requestTimeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new AgentTimeoutError(`Agent request timed out after ${requestTimeoutMs}ms`))
        }, requestTimeoutMs)
      }),
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

function normalizeAgentStateReport(value: unknown): Omit<HostStateUpsertInput, "endpoint" | "observedAt"> {
  if (!value || typeof value !== "object") {
    throw new HostStateMalformedReportError()
  }
  const candidate = value as Record<string, unknown>
  return {
    agent: normalizeAgentSummary(candidate.agent),
    host: normalizeHostSummary(candidate.host),
    incus: normalizeIncusSummary(candidate.incus),
    capabilities: normalizeCapabilitySummary(candidate.capabilities),
    snapshot: normalizeSnapshotSummary(candidate.snapshot),
  }
}

function normalizeAgentSummary(value: unknown): HostStateAgentSummary {
  const candidate = objectValue(value)
  return {
    id: requiredString(candidate.id),
    version: requiredString(candidate.version),
    stateSchemaVersion: requiredPositiveInteger(candidate.stateSchemaVersion),
    startedAt: requiredDateString(candidate.startedAt),
    reportedAt: requiredDateString(candidate.reportedAt),
  }
}

function normalizeHostSummary(value: unknown): HostStateHostSummary {
  const candidate = objectValue(value)
  return {
    hostname: requiredString(candidate.hostname),
    os: requiredString(candidate.os),
    arch: requiredString(candidate.arch),
  }
}

function normalizeIncusSummary(value: unknown): HostStateIncusSummary {
  const candidate = objectValue(value)
  return {
    available: requiredBoolean(candidate.available),
    statusCode: requiredHttpStatusCode(candidate.statusCode),
    serverVersion: optionalString(candidate.serverVersion),
    apiVersion: optionalString(candidate.apiVersion),
  }
}

function normalizeCapabilitySummary(value: unknown): HostStateCapabilitySummary {
  const candidate = objectValue(value)
  return {
    incusProxy: requiredBoolean(candidate.incusProxy),
    events: requiredBoolean(candidate.events),
    stateReport: requiredBoolean(candidate.stateReport),
    wireGuard: requiredBoolean(candidate.wireGuard),
    vmLifecycle: requiredBoolean(candidate.vmLifecycle),
  }
}

function normalizeSnapshotSummary(value: unknown): HostStateSnapshotSummary {
  const candidate = objectValue(value)
  return {
    instancesTotal: requiredNonNegativeInteger(candidate.instancesTotal),
    imagesTotal: requiredNonNegativeInteger(candidate.imagesTotal),
    operationsTotal: requiredNonNegativeInteger(candidate.operationsTotal),
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HostStateMalformedReportError()
  }
  return value as Record<string, unknown>
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HostStateMalformedReportError()
  }
  return value
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined
  }
  return requiredString(value)
}

function requiredInteger(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) > maxPostgresInteger) {
    throw new HostStateMalformedReportError()
  }
  return value as number
}

function requiredPositiveInteger(value: unknown): number {
  const integer = requiredInteger(value)
  if (integer < 1) {
    throw new HostStateMalformedReportError()
  }
  return integer
}

function requiredNonNegativeInteger(value: unknown): number {
  const integer = requiredInteger(value)
  if (integer < 0) {
    throw new HostStateMalformedReportError()
  }
  return integer
}

function requiredHttpStatusCode(value: unknown): number {
  const integer = requiredInteger(value)
  if (integer < 100 || integer > 599) {
    throw new HostStateMalformedReportError()
  }
  return integer
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new HostStateMalformedReportError()
  }
  return value
}

function requiredDateString(value: unknown): string {
  const raw = requiredString(value)
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) {
    throw new HostStateMalformedReportError()
  }
  return parsed.toISOString()
}

function assertHasAnyHostReadPermission(actor: AdminPrincipal): void {
  if (
    canPerformGlobalAction(actor, "hosts:read") ||
    actor.teams.some((team) => canPerformTeamAction(actor, team.id, "hosts:read"))
  ) {
    return
  }
  throw new HostStatePermissionDeniedError()
}

function assertHasAnyHostSyncPermission(actor: AdminPrincipal): void {
  if (
    canPerformGlobalAction(actor, "hosts:sync") ||
    actor.teams.some((team) => canPerformTeamAction(actor, team.id, "hosts:sync"))
  ) {
    return
  }
  throw new HostStatePermissionDeniedError()
}

function assertCanReadHostState(actor: AdminPrincipal, teamId: string): void {
  if (canPerformGlobalAction(actor, "hosts:read") || canPerformTeamAction(actor, teamId, "hosts:read")) {
    return
  }
  throw new HostStatePermissionDeniedError()
}

function assertCanSyncHostState(actor: AdminPrincipal, teamId: string): void {
  if (canPerformGlobalAction(actor, "hosts:sync") || canPerformTeamAction(actor, teamId, "hosts:sync")) {
    return
  }
  throw new HostStatePermissionDeniedError()
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

function hostStatePersistenceFields(input: HostStateUpsertInput) {
  return {
    agentId: input.agent.id,
    agentVersion: input.agent.version,
    agentStateSchemaVersion: input.agent.stateSchemaVersion,
    agentStartedAt: new Date(input.agent.startedAt),
    agentReportedAt: new Date(input.agent.reportedAt),
    hostHostname: input.host.hostname,
    hostOs: input.host.os,
    hostArch: input.host.arch,
    incusAvailable: input.incus.available,
    incusStatusCode: input.incus.statusCode,
    incusServerVersion: input.incus.serverVersion,
    incusApiVersion: input.incus.apiVersion,
    capabilityIncusProxy: input.capabilities.incusProxy,
    capabilityEvents: input.capabilities.events,
    capabilityStateReport: input.capabilities.stateReport,
    capabilityWireGuard: input.capabilities.wireGuard,
    capabilityVmLifecycle: input.capabilities.vmLifecycle,
    snapshotInstancesTotal: input.snapshot.instancesTotal,
    snapshotImagesTotal: input.snapshot.imagesTotal,
    snapshotOperationsTotal: input.snapshot.operationsTotal,
  }
}

function hostStateSyncAuditEntry(
  input: HostStateSyncCommitInput,
  state: HostStateRecord
): AdminAuditEntry {
  return {
    actorUserId: input.actor.id,
    action: "host_state.sync",
    targetType: "host_state",
    targetId: state.id,
    teamId: input.endpoint.team.id,
    metadata: {
      endpointId: input.endpoint.id,
      endpointName: input.endpoint.name,
      agentId: state.agent.id,
      status: state.status,
      incusAvailable: state.incus.available,
      stateSchemaVersion: state.agent.stateSchemaVersion,
    },
  }
}

const hostStateInclude = {
  endpoint: {
    include: {
      team: {
        select: {
          id: true,
          name: true,
          status: true,
        },
      },
    },
  },
} as const

const endpointSummarySelect = {
  id: true,
  name: true,
  status: true,
  team: {
    select: {
      id: true,
      name: true,
      status: true,
    },
  },
} as const

type PrismaHostStateClient = Pick<PrismaClient, "agentEndpoint" | "hostState" | "$transaction">
type PrismaHostStateWithEndpoint = Prisma.HostStateGetPayload<{ include: typeof hostStateInclude }>

function mapPrismaEndpointSummary(endpoint: {
  id: string
  name: string
  status: HostStateEndpointStatus
  team: {
    id: string
    name: string
    status: HostStateTeamStatus
  }
}): HostStateEndpointSummary {
  return {
    id: endpoint.id,
    name: endpoint.name,
    status: endpoint.status,
    team: endpoint.team,
  }
}

function mapPrismaEndpointForSync(endpoint: {
  id: string
  name: string
  url: string
  tokenCiphertext: string | null
  status: HostStateEndpointStatus
  team: {
    id: string
    name: string
    status: HostStateTeamStatus
  }
}): HostStateSyncEndpoint {
  return {
    id: endpoint.id,
    name: endpoint.name,
    url: endpoint.url,
    status: endpoint.status,
    ...(endpoint.tokenCiphertext ? { tokenCiphertext: endpoint.tokenCiphertext } : {}),
    team: endpoint.team,
  }
}

function mapPrismaHostState(state: PrismaHostStateWithEndpoint): HostStateRecord {
  return {
    id: state.id,
    endpoint: {
      id: state.endpoint.id,
      name: state.endpoint.name,
      status: state.endpoint.status,
      team: state.endpoint.team,
    },
    agent: {
      id: state.agentId,
      version: state.agentVersion,
      stateSchemaVersion: state.agentStateSchemaVersion,
      startedAt: state.agentStartedAt.toISOString(),
      reportedAt: state.agentReportedAt.toISOString(),
    },
    host: {
      hostname: state.hostHostname,
      os: state.hostOs,
      arch: state.hostArch,
    },
    incus: {
      available: state.incusAvailable,
      statusCode: state.incusStatusCode,
      ...(state.incusServerVersion ? { serverVersion: state.incusServerVersion } : {}),
      ...(state.incusApiVersion ? { apiVersion: state.incusApiVersion } : {}),
    },
    capabilities: {
      incusProxy: state.capabilityIncusProxy,
      events: state.capabilityEvents,
      stateReport: state.capabilityStateReport,
      wireGuard: state.capabilityWireGuard,
      vmLifecycle: state.capabilityVmLifecycle,
    },
    snapshot: {
      instancesTotal: state.snapshotInstancesTotal,
      imagesTotal: state.snapshotImagesTotal,
      operationsTotal: state.snapshotOperationsTotal,
    },
    status: state.status,
    firstSeenAt: state.firstSeenAt.toISOString(),
    lastSeenAt: state.lastSeenAt.toISOString(),
  }
}

export { EndpointTokenKeyError }
