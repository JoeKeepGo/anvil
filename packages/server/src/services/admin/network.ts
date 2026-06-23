import { generateKeyPairSync, randomBytes } from "node:crypto"
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
import {
  decryptNetworkSecret,
  encryptNetworkSecret,
  NetworkSecretKeyError,
} from "./networkSecrets"
import {
  applyTargetTypeToAuditTargetType,
  assertFabricOverlayCidrs,
  assertFabricPrefixInFabric,
  assertHostNetworkPeerAddressesInFabric,
  assertProjectNetworkPoolInFabric,
  NetworkInvariantError,
  assertUniquePeerPublicKeys,
  parseCidr,
  toBrowserApplyOperation,
  toBrowserFabric,
  toBrowserHub,
  toBrowserPeer,
  toBrowserPool,
  toBrowserPrefix,
  type BrowserHostNetworkPeer,
  type BrowserNetworkApplyOperation,
  type BrowserNetworkFabric,
  type BrowserProjectNetworkPool,
  type BrowserWireGuardHub,
  type FabricPrefixKind,
  type FabricPrefixStatus,
  type HostNetworkPeerRole,
  type HostNetworkPeerStatus,
  type NetworkApplyMode,
  type NetworkApplyStatus,
  type NetworkApplyTargetType,
  type NetworkFabricMode,
  type NetworkFabricStatus,
  type NetworkPresharedKeyMode,
  type NetworkPoolAllocationMode,
  type PersistedFabricPrefix,
  type PersistedHostNetworkPeer,
  type PersistedNetworkApplyOperation,
  type PersistedNetworkFabric,
  type PersistedProjectNetworkPool,
  type PersistedWireGuardHub,
} from "./networkModels"

// Re-export the Phase 2 invariant error so callers catch a single class
// regardless of whether it was thrown by networkModels helpers or this service.
export { NetworkInvariantError } from "./networkModels"
export { NetworkSecretKeyError } from "./networkSecrets"
import { canPerformGlobalAction } from "./permissions"
import { recordAdminAudit } from "./audit"
import type { AdminAuditEntry, AdminPrincipal } from "./session"

const maxPostgresInteger = 2147483647
const maxApplyPeers = 256

// ---------------------------------------------------------------------------
// Browser-safe detail types
// ---------------------------------------------------------------------------

export interface BrowserFabricDetail extends BrowserNetworkFabric {
  hubs: BrowserWireGuardHub[]
  peers: BrowserHostNetworkPeer[]
  prefixes: BrowserFabricPrefix[]
  pools: BrowserProjectNetworkPool[]
}

export type BrowserFabricPrefix = ReturnType<typeof toBrowserPrefix>

export interface FabricDetail {
  fabric: PersistedNetworkFabric
  hubs: PersistedWireGuardHub[]
  peers: PersistedHostNetworkPeer[]
  prefixes: PersistedFabricPrefix[]
  pools: PersistedProjectNetworkPool[]
}

export interface BrowserNetworkStateSnapshot {
  id: string
  endpointId: string
  fabricId: string | null
  agentId: string
  stateSchemaVersion: number
  observedAt: string
  wireGuardAvailable: boolean
  ipCommandAvailable: boolean
  iptablesAvailable: boolean
  ip6tablesAvailable: boolean
  forwarding: { ipv4: boolean; ipv6: boolean }
  managedInterfaceCount: number
  status: string
}

export interface FabricSyncEndpointResult {
  endpointId: string
  endpointName: string
  status: "SYNCED" | "SKIPPED" | "FAILED"
  snapshot?: BrowserNetworkStateSnapshot
  error?: string
}

export interface FabricSyncResponse {
  fabricId: string
  endpoints: FabricSyncEndpointResult[]
}

export interface FabricApplyEndpointResult {
  endpointId: string
  endpointName: string
  status: "OK" | "FAILED" | "SKIPPED"
  mode: NetworkApplyMode
  summary?: string
  error?: string
}

export interface FabricApplyResponse {
  fabricId: string
  operationId: string
  mode: NetworkApplyMode
  status: NetworkApplyStatus
  endpoints: FabricApplyEndpointResult[]
  summary: string
}

// ---------------------------------------------------------------------------
// Service inputs
// ---------------------------------------------------------------------------

export interface FabricCreateInput {
  name: string
  slug: string
  mode?: NetworkFabricMode
  overlayIpv4Cidr: string
  overlayIpv6Cidr: string
}

export interface FabricUpdateInput {
  name?: string
  mode?: NetworkFabricMode
  overlayIpv4Cidr?: string
  overlayIpv6Cidr?: string
}

export interface HubCreateInput {
  fabricId: string
  name: string
  listenPort: number
  endpointHost: string
  presharedKeyMode?: NetworkPresharedKeyMode
}

export interface PeerCreateInput {
  fabricId: string
  endpointId?: string
  name: string
  role?: HostNetworkPeerRole
  overlayIpv4Address?: string
  overlayIpv6Address?: string
  generatePresharedKey?: boolean
}

export interface PrefixCreateInput {
  fabricId: string
  kind: FabricPrefixKind
  cidr: string
  ownerPeerId?: string
}

export interface PoolCreateInput {
  projectId: string
  fabricId: string
  ipv4Cidr?: string
  ipv6Cidr?: string
  allocationMode?: NetworkPoolAllocationMode
}

export interface PoolUpdateInput {
  ipv4Cidr?: string
  ipv6Cidr?: string
  status?: ProjectNetworkPoolStatus
  allocationMode?: NetworkPoolAllocationMode
}

export type ProjectNetworkPoolStatus = "ACTIVE" | "ARCHIVED"

// ---------------------------------------------------------------------------
// Persistence inputs (ciphertext for secrets)
// ---------------------------------------------------------------------------

interface FabricPersistInput {
  name: string
  slug: string
  mode: NetworkFabricMode
  overlayIpv4Cidr: string
  overlayIpv6Cidr: string
  status?: NetworkFabricStatus
}

interface HubPersistInput {
  fabricId: string
  name: string
  listenPort: number
  endpointHost: string
  publicKey: string
  privateKeyCiphertext: string
  presharedKeyMode: NetworkPresharedKeyMode
  status?: WireGuardHubStatus
}

interface PeerPersistInput {
  fabricId: string
  endpointId: string | null
  name: string
  role: HostNetworkPeerRole
  publicKey: string
  privateKeyCiphertext: string
  presharedKeyCiphertext: string | null
  overlayIpv4Address: string | null
  overlayIpv6Address: string | null
  status?: HostNetworkPeerStatus
}

interface PrefixPersistInput {
  fabricId: string
  kind: FabricPrefixKind
  cidr: string
  family: number
  ownerPeerId: string | null
  status?: FabricPrefixStatus
}

interface PoolPersistInput {
  projectId: string
  fabricId: string
  ipv4Cidr: string | null
  ipv6Cidr: string | null
  allocationMode: NetworkPoolAllocationMode
  status?: ProjectNetworkPoolStatus
}

interface SnapshotPersistInput {
  endpointId: string
  fabricId: string | null
  agentId: string
  stateSchemaVersion: number
  observedAt: string
  wireGuardAvailable: boolean
  ipCommandAvailable: boolean
  iptablesAvailable: boolean
  ip6tablesAvailable: boolean
  ipv4Forwarding: boolean
  ipv6Forwarding: boolean
  managedInterfaceCount: number
  status: "ONLINE" | "OFFLINE" | "ERROR"
}

interface ApplyOperationPersistInput {
  targetType: NetworkApplyTargetType
  targetId: string
  mode: NetworkApplyMode
  status: NetworkApplyStatus
  requestedByUserId: string
  summary: string | null
  errorSummary: string | null
}

type WireGuardHubStatus = "PLANNED" | "ACTIVE" | "ARCHIVED"

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

export interface FabricPeerEndpoint {
  peer: PersistedHostNetworkPeer
  endpoint: {
    id: string
    name: string
    url: string
    tokenCiphertext: string | null
    status: "ACTIVE" | "ARCHIVED"
    teamId: string
  }
}

export interface NetworkAdminStore {
  listFabrics(): Promise<PersistedNetworkFabric[]>
  getFabric(fabricId: string): Promise<PersistedNetworkFabric | null>
  getFabricDetail(fabricId: string): Promise<FabricDetail | null>
  findFabricBySlug(slug: string): Promise<PersistedNetworkFabric | null>
  createFabric(input: FabricPersistInput): Promise<PersistedNetworkFabric>
  updateFabric(fabricId: string, data: Partial<FabricPersistInput>): Promise<PersistedNetworkFabric>
  setFabricStatus(fabricId: string, status: NetworkFabricStatus): Promise<PersistedNetworkFabric>
  countActiveFabricChildren(fabricId: string): Promise<{ hubs: number; peers: number; pools: number }>
  createHub(input: HubPersistInput): Promise<PersistedWireGuardHub>
  createPeer(input: PeerPersistInput): Promise<PersistedHostNetworkPeer>
  createPrefix(input: PrefixPersistInput): Promise<PersistedFabricPrefix>
  listProjectPools(): Promise<PersistedProjectNetworkPool[]>
  findPoolById(poolId: string): Promise<PersistedProjectNetworkPool | null>
  createPool(input: PoolPersistInput): Promise<PersistedProjectNetworkPool>
  updatePool(poolId: string, data: Partial<PoolPersistInput>): Promise<PersistedProjectNetworkPool>
  getFabricPeersWithEndpoints(fabricId: string): Promise<FabricPeerEndpoint[]>
  findActivePeerWithOverlayAddress(
    fabricId: string,
    overlayIpv4Address: string | null,
    overlayIpv6Address: string | null
  ): Promise<PersistedHostNetworkPeer | null>
  upsertNetworkStateSnapshot(input: SnapshotPersistInput): Promise<BrowserNetworkStateSnapshot>
  createApplyOperation(input: ApplyOperationPersistInput): Promise<PersistedNetworkApplyOperation>
  recordAudit(entry: AdminAuditEntry): Promise<void>
}

// ---------------------------------------------------------------------------
// Agent client boundary
// ---------------------------------------------------------------------------

export interface NetworkAgentClient {
  execute(request: AgentRequest): Promise<AgentResponse>
  close?(): void
}

export interface NetworkActionOptions {
  env?: NodeJS.ProcessEnv
  createAgentClient?: (options: AgentClientOptions) => NetworkAgentClient
  now?: () => Date
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class NetworkPermissionDeniedError extends Error {
  constructor(message = "Admin network permission denied.") {
    super(message)
    this.name = "NetworkPermissionDeniedError"
  }
}

export class NetworkFabricNotFoundError extends Error {
  constructor(message = "Network fabric was not found.") {
    super(message)
    this.name = "NetworkFabricNotFoundError"
  }
}

export class NetworkPoolNotFoundError extends Error {
  constructor(message = "Network project pool was not found.") {
    super(message)
    this.name = "NetworkPoolNotFoundError"
  }
}

export class NetworkDuplicatePeerAddressError extends Error {
  constructor(message = "A peer with that overlay address already exists in the fabric.") {
    super(message)
    this.name = "NetworkDuplicatePeerAddressError"
  }
}

export class NetworkDuplicateFabricSlugError extends Error {
  constructor(message = "A fabric with that slug already exists.") {
    super(message)
    this.name = "NetworkDuplicateFabricSlugError"
  }
}

export class NetworkFabricArchivedError extends Error {
  constructor(message = "Network fabric is archived.") {
    super(message)
    this.name = "NetworkFabricArchivedError"
  }
}

export class NetworkFabricHasActiveChildrenError extends Error {
  constructor(message = "Fabric has active hubs, peers, or pools.") {
    super(message)
    this.name = "NetworkFabricHasActiveChildrenError"
  }
}

export class NetworkMalformedAgentResponseError extends Error {
  constructor(message = "Agent network response is malformed.") {
    super(message)
    this.name = "NetworkMalformedAgentResponseError"
  }
}

export class NetworkAgentUnavailableError extends Error {
  constructor(message = "Agent is unavailable.") {
    super(message)
    this.name = "NetworkAgentUnavailableError"
  }
}

// ---------------------------------------------------------------------------
// WireGuard key generation (server-side; private keys never reach the browser)
// ---------------------------------------------------------------------------

export function generateWireGuardKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519")
  const pubJwk = publicKey.export({ format: "jwk" }) as { x: string }
  const privJwk = privateKey.export({ format: "jwk" }) as { d: string }
  return {
    publicKey: b64urlToB64(pubJwk.x),
    privateKey: b64urlToB64(privJwk.d),
  }
}

export function generatePresharedKey(): string {
  return randomBytes(32).toString("base64")
}

function b64urlToB64(value: string): string {
  return Buffer.from(value, "base64url").toString("base64")
}

// ---------------------------------------------------------------------------
// Permission helpers
// ---------------------------------------------------------------------------

function assertNetworkRead(actor: AdminPrincipal): void {
  if (canPerformGlobalAction(actor, "network:read")) {
    return
  }
  throw new NetworkPermissionDeniedError()
}

function assertNetworkWrite(actor: AdminPrincipal): void {
  if (canPerformGlobalAction(actor, "network:write")) {
    return
  }
  throw new NetworkPermissionDeniedError()
}

function assertNetworkApply(actor: AdminPrincipal): void {
  if (canPerformGlobalAction(actor, "network:apply")) {
    return
  }
  throw new NetworkPermissionDeniedError()
}

// ---------------------------------------------------------------------------
// Fabric services
// ---------------------------------------------------------------------------

export async function listFabrics(
  store: NetworkAdminStore,
  actor: AdminPrincipal
): Promise<BrowserNetworkFabric[]> {
  assertNetworkRead(actor)
  const fabrics = await store.listFabrics()
  return fabrics.map((fabric) => toBrowserFabric(fabric))
}

export async function getFabric(
  store: NetworkAdminStore,
  actor: AdminPrincipal,
  fabricId: string
): Promise<BrowserFabricDetail> {
  assertNetworkRead(actor)
  const detail = await store.getFabricDetail(fabricId)
  if (!detail) {
    throw new NetworkFabricNotFoundError()
  }
  return toBrowserFabricDetail(detail)
}

export async function listProjectPools(
  store: NetworkAdminStore,
  actor: AdminPrincipal
): Promise<BrowserProjectNetworkPool[]> {
  assertNetworkRead(actor)
  const pools = await store.listProjectPools()
  return pools.map((pool) => toBrowserPool(pool))
}

export async function createFabric(
  store: NetworkAdminStore,
  actor: AdminPrincipal,
  input: FabricCreateInput
): Promise<BrowserNetworkFabric> {
  assertNetworkWrite(actor)
  const slug = input.slug.trim()
  const name = input.name.trim()
  if (name === "" || slug === "") {
    throw new NetworkInvariantError("Fabric name and slug are required.")
  }
  assertFabricOverlayCidrs({ overlayIpv4Cidr: input.overlayIpv4Cidr, overlayIpv6Cidr: input.overlayIpv6Cidr })

  const existing = await store.findFabricBySlug(slug)
  if (existing) {
    throw new NetworkDuplicateFabricSlugError()
  }

  const fabric = await store.createFabric({
    name,
    slug,
    mode: input.mode ?? "HUB_SPOKE",
    overlayIpv4Cidr: input.overlayIpv4Cidr,
    overlayIpv6Cidr: input.overlayIpv6Cidr,
    status: "PLANNED",
  })

  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "network_fabric.create",
    targetType: "network_fabric",
    targetId: fabric.id,
    metadata: { name: fabric.name, slug: fabric.slug, mode: fabric.mode },
  })

  return toBrowserFabric(fabric)
}

export async function updateFabric(
  store: NetworkAdminStore,
  actor: AdminPrincipal,
  fabricId: string,
  input: FabricUpdateInput
): Promise<BrowserNetworkFabric> {
  assertNetworkWrite(actor)
  const existing = await store.getFabric(fabricId)
  if (!existing) {
    throw new NetworkFabricNotFoundError()
  }
  if (existing.status === "ARCHIVED") {
    throw new NetworkFabricArchivedError()
  }

  const nextOverlay = {
    overlayIpv4Cidr: input.overlayIpv4Cidr ?? existing.overlayIpv4Cidr,
    overlayIpv6Cidr: input.overlayIpv6Cidr ?? existing.overlayIpv6Cidr,
  }
  assertFabricOverlayCidrs(nextOverlay)

  const data: Partial<FabricPersistInput> = {}
  if (input.name !== undefined) {
    data.name = input.name.trim()
  }
  if (input.mode !== undefined) {
    data.mode = input.mode
  }
  if (input.overlayIpv4Cidr !== undefined) {
    data.overlayIpv4Cidr = input.overlayIpv4Cidr
  }
  if (input.overlayIpv6Cidr !== undefined) {
    data.overlayIpv6Cidr = input.overlayIpv6Cidr
  }

  const fabric = await store.updateFabric(fabricId, data)
  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "network_fabric.update",
    targetType: "network_fabric",
    targetId: fabric.id,
    metadata: { name: data.name, mode: data.mode },
  })
  return toBrowserFabric(fabric)
}

export async function archiveFabric(
  store: NetworkAdminStore,
  actor: AdminPrincipal,
  fabricId: string
): Promise<BrowserNetworkFabric> {
  assertNetworkWrite(actor)
  const existing = await store.getFabric(fabricId)
  if (!existing) {
    throw new NetworkFabricNotFoundError()
  }
  if (existing.status === "ARCHIVED") {
    throw new NetworkFabricArchivedError()
  }
  const counts = await store.countActiveFabricChildren(fabricId)
  if (counts.hubs > 0 || counts.peers > 0 || counts.pools > 0) {
    throw new NetworkFabricHasActiveChildrenError()
  }
  const fabric = await store.setFabricStatus(fabricId, "ARCHIVED")
  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "network_fabric.archive",
    targetType: "network_fabric",
    targetId: fabric.id,
    metadata: { status: "ARCHIVED" },
  })
  return toBrowserFabric(fabric)
}

export async function restoreFabric(
  store: NetworkAdminStore,
  actor: AdminPrincipal,
  fabricId: string
): Promise<BrowserNetworkFabric> {
  assertNetworkWrite(actor)
  const existing = await store.getFabric(fabricId)
  if (!existing) {
    throw new NetworkFabricNotFoundError()
  }
  const fabric = await store.setFabricStatus(fabricId, "ACTIVE")
  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "network_fabric.restore",
    targetType: "network_fabric",
    targetId: fabric.id,
    metadata: { status: "ACTIVE" },
  })
  return toBrowserFabric(fabric)
}

// ---------------------------------------------------------------------------
// Hub / peer / prefix services
// ---------------------------------------------------------------------------

export async function createHub(
  store: NetworkAdminStore,
  actor: AdminPrincipal,
  input: HubCreateInput,
  env: NodeJS.ProcessEnv
): Promise<BrowserWireGuardHub> {
  assertNetworkWrite(actor)
  const fabric = await requireActiveFabric(store, input.fabricId)
  if (input.name.trim() === "") {
    throw new NetworkInvariantError("Hub name is required.")
  }
  if (input.listenPort < 1 || input.listenPort > 65535) {
    throw new NetworkInvariantError("Hub listenPort is out of range.")
  }

  const keyPair = generateWireGuardKeyPair()
  const privateKeyCiphertext = encryptNetworkSecret(env, keyPair.privateKey)

  const hub = await store.createHub({
    fabricId: fabric.id,
    name: input.name.trim(),
    listenPort: input.listenPort,
    endpointHost: input.endpointHost.trim(),
    publicKey: keyPair.publicKey,
    privateKeyCiphertext,
    presharedKeyMode: input.presharedKeyMode ?? "DISABLED",
    status: "PLANNED",
  })

  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "network_hub.create",
    targetType: "network_hub",
    targetId: hub.id,
    metadata: {
      fabricId: hub.fabricId,
      name: hub.name,
      listenPort: hub.listenPort,
      presharedKeyMode: hub.presharedKeyMode,
      privateKey: "[REDACTED]",
    },
  })

  return toBrowserHub(hub)
}

export async function createPeer(
  store: NetworkAdminStore,
  actor: AdminPrincipal,
  input: PeerCreateInput,
  env: NodeJS.ProcessEnv
): Promise<BrowserHostNetworkPeer> {
  assertNetworkWrite(actor)
  const fabric = await requireActiveFabric(store, input.fabricId)
  if (input.name.trim() === "") {
    throw new NetworkInvariantError("Peer name is required.")
  }

  assertHostNetworkPeerAddressesInFabric(
    { overlayIpv4Cidr: fabric.overlayIpv4Cidr, overlayIpv6Cidr: fabric.overlayIpv6Cidr },
    { overlayIpv4Address: input.overlayIpv4Address, overlayIpv6Address: input.overlayIpv6Address }
  )

  const conflictingPeer = await store.findActivePeerWithOverlayAddress(
    fabric.id,
    input.overlayIpv4Address ?? null,
    input.overlayIpv6Address ?? null
  )
  if (conflictingPeer) {
    throw new NetworkDuplicatePeerAddressError()
  }

  const keyPair = generateWireGuardKeyPair()
  const privateKeyCiphertext = encryptNetworkSecret(env, keyPair.privateKey)
  let presharedKeyCiphertext: string | null = null
  if (input.generatePresharedKey) {
    presharedKeyCiphertext = encryptNetworkSecret(env, generatePresharedKey())
  }

  const peer = await store.createPeer({
    fabricId: fabric.id,
    endpointId: input.endpointId ?? null,
    name: input.name.trim(),
    role: input.role ?? "MEMBER",
    publicKey: keyPair.publicKey,
    privateKeyCiphertext,
    presharedKeyCiphertext,
    overlayIpv4Address: input.overlayIpv4Address ?? null,
    overlayIpv6Address: input.overlayIpv6Address ?? null,
    status: "PLANNED",
  })

  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "network_peer.create",
    targetType: "network_peer",
    targetId: peer.id,
    metadata: {
      fabricId: peer.fabricId,
      name: peer.name,
      role: peer.role,
      privateKey: "[REDACTED]",
      presharedKey: presharedKeyCiphertext ? "[REDACTED]" : undefined,
    },
  })

  return toBrowserPeer(peer)
}

export async function createPrefix(
  store: NetworkAdminStore,
  actor: AdminPrincipal,
  input: PrefixCreateInput
): Promise<BrowserFabricPrefix> {
  assertNetworkWrite(actor)
  const fabric = await requireActiveFabric(store, input.fabricId)
  const block = parseCidr(input.cidr)
  assertFabricPrefixInFabric(
    { overlayIpv4Cidr: fabric.overlayIpv4Cidr, overlayIpv6Cidr: fabric.overlayIpv6Cidr },
    input.cidr,
    block.family
  )

  const prefix = await store.createPrefix({
    fabricId: fabric.id,
    kind: input.kind,
    cidr: input.cidr,
    family: block.family,
    ownerPeerId: input.ownerPeerId ?? null,
    status: "ACTIVE",
  })

  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "network_prefix.create",
    targetType: "network_prefix",
    targetId: prefix.id,
    metadata: { fabricId: prefix.fabricId, kind: prefix.kind, family: prefix.family },
  })

  return toBrowserPrefix(prefix)
}

// ---------------------------------------------------------------------------
// Project pool services
// ---------------------------------------------------------------------------

export async function createPool(
  store: NetworkAdminStore,
  actor: AdminPrincipal,
  input: PoolCreateInput
): Promise<BrowserProjectNetworkPool> {
  assertNetworkWrite(actor)
  const fabric = await requireActiveFabric(store, input.fabricId)
  assertProjectNetworkPoolInFabric(
    { overlayIpv4Cidr: fabric.overlayIpv4Cidr, overlayIpv6Cidr: fabric.overlayIpv6Cidr },
    { ipv4Cidr: input.ipv4Cidr, ipv6Cidr: input.ipv6Cidr }
  )

  const pool = await store.createPool({
    projectId: input.projectId,
    fabricId: fabric.id,
    ipv4Cidr: input.ipv4Cidr ?? null,
    ipv6Cidr: input.ipv6Cidr ?? null,
    allocationMode: input.allocationMode ?? "STATIC",
    status: "ACTIVE",
  })

  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "network_pool.create",
    targetType: "network_pool",
    targetId: pool.id,
    metadata: { projectId: pool.projectId, fabricId: pool.fabricId, allocationMode: pool.allocationMode },
  })

  return toBrowserPool(pool)
}

export async function updatePool(
  store: NetworkAdminStore,
  actor: AdminPrincipal,
  poolId: string,
  input: PoolUpdateInput
): Promise<BrowserProjectNetworkPool> {
  assertNetworkWrite(actor)
  const existing = await store.findPoolById(poolId)
  if (!existing) {
    throw new NetworkPoolNotFoundError()
  }
  const fabric = await store.getFabric(existing.fabricId)
  if (!fabric) {
    throw new NetworkFabricNotFoundError()
  }

  const nextPool = {
    ipv4Cidr: input.ipv4Cidr !== undefined ? input.ipv4Cidr : existing.ipv4Cidr,
    ipv6Cidr: input.ipv6Cidr !== undefined ? input.ipv6Cidr : existing.ipv6Cidr,
  }
  if (nextPool.ipv4Cidr || nextPool.ipv6Cidr) {
    assertProjectNetworkPoolInFabric(
      { overlayIpv4Cidr: fabric.overlayIpv4Cidr, overlayIpv6Cidr: fabric.overlayIpv6Cidr },
      nextPool
    )
  }

  const data: Partial<PoolPersistInput> = {}
  if (input.ipv4Cidr !== undefined) data.ipv4Cidr = input.ipv4Cidr
  if (input.ipv6Cidr !== undefined) data.ipv6Cidr = input.ipv6Cidr
  if (input.status !== undefined) data.status = input.status
  if (input.allocationMode !== undefined) data.allocationMode = input.allocationMode

  const pool = await store.updatePool(poolId, data)
  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "network_pool.update",
    targetType: "network_pool",
    targetId: pool.id,
    metadata: { status: data.status, allocationMode: data.allocationMode },
  })
  return toBrowserPool(pool)
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export async function syncFabric(
  store: NetworkAdminStore,
  actor: AdminPrincipal,
  fabricId: string,
  options: NetworkActionOptions = {}
): Promise<FabricSyncResponse> {
  // Sync is an action that persists observed snapshots and writes audit, so it
  // requires network:apply, not network:read.
  assertNetworkApply(actor)
  const fabric = await store.getFabric(fabricId)
  if (!fabric) {
    throw new NetworkFabricNotFoundError()
  }
  if (fabric.status === "ARCHIVED") {
    throw new NetworkFabricArchivedError()
  }

  const peerEndpoints = await store.getFabricPeersWithEndpoints(fabricId)
  const observedAt = (options.now?.() ?? new Date()).toISOString()
  const results: FabricSyncEndpointResult[] = []
  const failureClasses: SyncFailureClass[] = []
  let firstFailure: Error | undefined

  for (const { peer, endpoint } of peerEndpoints) {
    if (endpoint.status === "ARCHIVED") {
      results.push({ endpointId: endpoint.id, endpointName: endpoint.name, status: "SKIPPED" })
      continue
    }
    try {
      const snapshot = await syncEndpointNetworkState(store, fabric.id, peer, endpoint, observedAt, options)
      results.push({
        endpointId: endpoint.id,
        endpointName: endpoint.name,
        status: "SYNCED",
        snapshot,
      })
    } catch (error) {
      const failureClass = syncFailureClass(error)
      if (failureClass !== "other") {
        failureClasses.push(failureClass)
      }
      if (!firstFailure) {
        firstFailure = error instanceof Error ? error : new Error("sync failed")
      }
      results.push({
        endpointId: endpoint.id,
        endpointName: endpoint.name,
        status: "FAILED",
        error: safeSyncError(error),
      })
    }
  }

  // If every attempted endpoint failed, surface the documented route-level
  // error so callers see 502/503 instead of a silent 200 with only failures.
  const attempted = results.filter((r) => r.status === "SYNCED" || r.status === "FAILED")
  const syncedCount = results.filter((r) => r.status === "SYNCED").length
  if (attempted.length > 0 && syncedCount === 0) {
    if (failureClasses.includes("unavailable")) {
      throw new NetworkAgentUnavailableError()
    }
    if (failureClasses.includes("malformed")) {
      throw new NetworkMalformedAgentResponseError()
    }
    if (firstFailure) {
      throw firstFailure
    }
    throw new NetworkMalformedAgentResponseError()
  }

  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "network.sync",
    targetType: "network_fabric",
    targetId: fabric.id,
    metadata: {
      endpointsTotal: results.length,
      synced: syncedCount,
      failed: results.filter((r) => r.status === "FAILED").length,
    },
  })

  return { fabricId: fabric.id, endpoints: results }
}

type SyncFailureClass = "unavailable" | "malformed" | "other"

function syncFailureClass(error: unknown): SyncFailureClass {
  if (error instanceof NetworkAgentUnavailableError) {
    return "unavailable"
  }
  if (error instanceof NetworkMalformedAgentResponseError) {
    return "malformed"
  }
  return "other"
}

async function syncEndpointNetworkState(
  store: NetworkAdminStore,
  fabricId: string,
  peer: PersistedHostNetworkPeer,
  endpoint: FabricPeerEndpoint["endpoint"],
  observedAt: string,
  options: NetworkActionOptions
): Promise<BrowserNetworkStateSnapshot> {
  const response = await fetchAgentNetworkState(endpoint, options)
  if (response.status < 200 || response.status >= 300) {
    throw new NetworkMalformedAgentResponseError()
  }
  const summary = normalizeAgentNetworkState(response.body)
  return store.upsertNetworkStateSnapshot({
    endpointId: endpoint.id,
    fabricId,
    agentId: summary.agent.id,
    stateSchemaVersion: summary.agent.stateSchemaVersion,
    observedAt,
    wireGuardAvailable: summary.network.wireGuardAvailable,
    ipCommandAvailable: summary.network.ipCommandAvailable,
    iptablesAvailable: summary.network.iptablesAvailable,
    ip6tablesAvailable: summary.network.ip6tablesAvailable,
    ipv4Forwarding: summary.network.forwarding.ipv4,
    ipv6Forwarding: summary.network.forwarding.ipv6,
    managedInterfaceCount: summary.network.managedInterfaces.length,
    status: "ONLINE",
  })
}

// ---------------------------------------------------------------------------
// Apply / dry-run
// ---------------------------------------------------------------------------

export async function applyFabric(
  store: NetworkAdminStore,
  actor: AdminPrincipal,
  fabricId: string,
  mode: NetworkApplyMode,
  options: NetworkActionOptions = {}
): Promise<FabricApplyResponse> {
  assertNetworkApply(actor)
  if (mode !== "DRY_RUN" && mode !== "APPLY") {
    throw new NetworkInvariantError("Unsupported apply mode.")
  }
  const detail = await store.getFabricDetail(fabricId)
  if (!detail) {
    throw new NetworkFabricNotFoundError()
  }
  if (detail.fabric.status === "ARCHIVED") {
    throw new NetworkFabricArchivedError()
  }
  assertUniquePeerPublicKeys(detail.peers.map((p) => p.publicKey))
  if (detail.peers.length > maxApplyPeers) {
    throw new NetworkInvariantError("Fabric has too many peers to apply.")
  }

  const hub = detail.hubs.find((h) => h.status !== "ARCHIVED")
  const peerEndpoints = await store.getFabricPeersWithEndpoints(fabricId)
  const results: FabricApplyEndpointResult[] = []

  // Decrypt each active peer's preshared key once so it can be rendered into
  // the declarative apply request sent to each peer's host agent. Decrypted
  // PSKs are never persisted, logged, or returned to the browser; they only
  // transit the trusted backend->agent transport. A missing/misconfigured
  // network secret key surfaces as a 500 config error before any agent call.
  const peerPskMap = decryptPeerPresharedKeys(detail.peers, options.env)

  for (const { peer, endpoint } of peerEndpoints) {
    if (endpoint.status === "ARCHIVED") {
      results.push({ endpointId: endpoint.id, endpointName: endpoint.name, status: "SKIPPED", mode })
      continue
    }
    const requestBody = renderApplyRequest(peer, detail.peers, hub, peerPskMap)
    try {
      const response = await sendAgentApply(endpoint, mode, requestBody, options)
      if (response.status >= 200 && response.status < 300) {
        const parsed = normalizeAgentApplyResponse(response.body)
        results.push({
          endpointId: endpoint.id,
          endpointName: endpoint.name,
          status: "OK",
          mode,
          summary: parsed.summary,
        })
      } else {
        results.push({
          endpointId: endpoint.id,
          endpointName: endpoint.name,
          status: "FAILED",
          mode,
          error: safeApplyError(response),
        })
      }
    } catch (error) {
      results.push({
        endpointId: endpoint.id,
        endpointName: endpoint.name,
        status: "FAILED",
        mode,
        error: safeSyncError(error),
      })
    }
  }

  const okCount = results.filter((r) => r.status === "OK").length
  const failedCount = results.filter((r) => r.status === "FAILED").length
  const aggregateStatus: NetworkApplyStatus = failedCount > 0 ? "FAILED" : "SUCCEEDED"
  const summary =
    mode === "DRY_RUN"
      ? `dry-run validated ${okCount} endpoint(s), ${failedCount} failed`
      : `apply planned for ${okCount} endpoint(s), ${failedCount} failed; execution deferred to managed service`

  const operation = await store.createApplyOperation({
    targetType: "FABRIC",
    targetId: detail.fabric.id,
    mode,
    status: aggregateStatus,
    requestedByUserId: actor.id,
    summary,
    errorSummary: failedCount > 0 ? `${failedCount} endpoint(s) failed` : null,
  })

  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: mode === "DRY_RUN" ? "network.dry_run" : "network.apply",
    targetType: applyTargetTypeToAuditTargetType("FABRIC"),
    targetId: detail.fabric.id,
    metadata: {
      operationId: operation.id,
      mode,
      status: aggregateStatus,
      endpointsTotal: results.length,
      ok: okCount,
      failed: failedCount,
    },
  })

  return {
    fabricId: detail.fabric.id,
    operationId: operation.id,
    mode,
    status: aggregateStatus,
    endpoints: results,
    summary,
  }
}

interface RenderedApplyRequest {
  mode: NetworkApplyMode
  interface: { name: string; listenPort: number; addresses: string[] }
  peers: Array<{ publicKey: string; presharedKey?: string; allowedIps: string[] }>
  routing: { ipv4Forwarding: boolean; ipv6Forwarding: boolean }
}

function decryptPeerPresharedKeys(
  peers: PersistedHostNetworkPeer[],
  env: NodeJS.ProcessEnv | undefined
): Map<string, string | undefined> {
  const resolvedEnv = env ?? process.env
  const map = new Map<string, string | undefined>()
  for (const peer of peers) {
    if (peer.status === "ARCHIVED" || !peer.presharedKeyCiphertext) {
      map.set(peer.id, undefined)
      continue
    }
    map.set(peer.id, decryptNetworkSecret(resolvedEnv, peer.presharedKeyCiphertext))
  }
  return map
}

function renderApplyRequest(
  peer: PersistedHostNetworkPeer,
  allPeers: PersistedHostNetworkPeer[],
  hub: PersistedWireGuardHub | undefined,
  pskMap: Map<string, string | undefined>
): RenderedApplyRequest {
  const addresses: string[] = []
  if (peer.overlayIpv4Address) addresses.push(`${peer.overlayIpv4Address}/32`)
  if (peer.overlayIpv6Address) addresses.push(`${peer.overlayIpv6Address}/128`)

  const otherPeers = allPeers
    .filter((candidate) => candidate.id !== peer.id && candidate.status !== "ARCHIVED")
    .map((candidate) => {
      const allowedIps: string[] = []
      if (candidate.overlayIpv4Address) allowedIps.push(`${candidate.overlayIpv4Address}/32`)
      if (candidate.overlayIpv6Address) allowedIps.push(`${candidate.overlayIpv6Address}/128`)
      const presharedKey = pskMap.get(candidate.id)
      return {
        publicKey: candidate.publicKey,
        ...(presharedKey ? { presharedKey } : {}),
        allowedIps,
      }
    })

  return {
    mode: "DRY_RUN", // overwritten by caller
    interface: {
      name: peer.name,
      listenPort: hub?.listenPort ?? 51820,
      addresses,
    },
    peers: otherPeers,
    routing: { ipv4Forwarding: true, ipv6Forwarding: true },
  }
}

// ---------------------------------------------------------------------------
// Agent transport
// ---------------------------------------------------------------------------

async function fetchAgentNetworkState(
  endpoint: FabricPeerEndpoint["endpoint"],
  options: NetworkActionOptions
): Promise<AgentResponse> {
  const client = await createNetworkAgentClient(endpoint, options)
  try {
    return await withAgentTimeout(
      client.execute({ method: "GET", path: "/agent/v1/network/state" }),
      requestTimeoutMs(options.env)
    )
  } catch (error) {
    throw mapAgentError(error)
  } finally {
    client.close?.()
  }
}

async function sendAgentApply(
  endpoint: FabricPeerEndpoint["endpoint"],
  mode: NetworkApplyMode,
  body: RenderedApplyRequest,
  options: NetworkActionOptions
): Promise<AgentResponse> {
  const client = await createNetworkAgentClient(endpoint, options)
  try {
    const payload: RenderedApplyRequest = { ...body, mode }
    return await withAgentTimeout(
      client.execute({ method: "POST", path: "/agent/v1/network/apply", body: payload }),
      requestTimeoutMs(options.env)
    )
  } catch (error) {
    throw mapAgentError(error)
  } finally {
    client.close?.()
  }
}

async function createNetworkAgentClient(
  endpoint: FabricPeerEndpoint["endpoint"],
  options: NetworkActionOptions
): Promise<NetworkAgentClient> {
  const env = options.env ?? process.env
  const createAgentClient = options.createAgentClient ?? ((clientOptions) => new AgentClient(clientOptions))
  return createAgentClient({
    url: endpoint.url,
    token: endpoint.tokenCiphertext ? decryptEndpointToken(env, endpoint.tokenCiphertext) : undefined,
    requestTimeoutMs: requestTimeoutMs(env),
  })
}

function requestTimeoutMs(env: NodeJS.ProcessEnv | undefined): number {
  const value = (env ?? process.env).ANVIL_AGENT_REQUEST_TIMEOUT_MS
  if (value === undefined) {
    return 5000
  }
  if (!/^[1-9]\d*$/.test(value)) {
    throw new AuthConfigError("ANVIL_AGENT_REQUEST_TIMEOUT_MS must be a positive integer")
  }
  return Number(value)
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
    if (timeout) clearTimeout(timeout)
  }
}

function mapAgentError(error: unknown): Error {
  if (
    error instanceof AgentConnectionError ||
    error instanceof AgentTimeoutError ||
    error instanceof AgentProtocolError
  ) {
    return new NetworkAgentUnavailableError()
  }
  if (error instanceof EndpointTokenKeyError) {
    return error
  }
  return error instanceof Error ? error : new NetworkAgentUnavailableError()
}

function safeSyncError(error: unknown): string {
  if (error instanceof NetworkAgentUnavailableError) {
    return "agent unavailable"
  }
  if (error instanceof NetworkMalformedAgentResponseError) {
    return "malformed agent response"
  }
  if (error instanceof EndpointTokenKeyError) {
    return "endpoint token key not configured"
  }
  return "sync failed"
}

function safeApplyError(response: AgentResponse): string {
  if (response.status === 400) {
    return "apply request rejected by agent"
  }
  return `agent returned status ${response.status}`
}

// ---------------------------------------------------------------------------
// Agent response normalization
// ---------------------------------------------------------------------------

interface AgentNetworkStateSummary {
  agent: { id: string; stateSchemaVersion: number }
  network: {
    wireGuardAvailable: boolean
    ipCommandAvailable: boolean
    iptablesAvailable: boolean
    ip6tablesAvailable: boolean
    forwarding: { ipv4: boolean; ipv6: boolean }
    managedInterfaces: unknown[]
  }
}

function normalizeAgentNetworkState(body: unknown): AgentNetworkStateSummary {
  const root = objectValue(body)
  const agent = objectValue(root.agent)
  const network = objectValue(root.network)
  return {
    agent: {
      id: requiredString(agent.id),
      stateSchemaVersion: requiredPositiveInteger(agent.stateSchemaVersion),
    },
    network: {
      wireGuardAvailable: requiredBoolean(network.wireGuardAvailable),
      ipCommandAvailable: requiredBoolean(network.ipCommandAvailable),
      iptablesAvailable: requiredBoolean(network.iptablesAvailable),
      ip6tablesAvailable: requiredBoolean(network.ip6tablesAvailable),
      forwarding: {
        ipv4: requiredBoolean(objectValue(network.forwarding).ipv4),
        ipv6: requiredBoolean(objectValue(network.forwarding).ipv6),
      },
      managedInterfaces: arrayValue(network.managedInterfaces),
    },
  }
}

function normalizeAgentApplyResponse(body: unknown): { summary: string } {
  const root = objectValue(body)
  return { summary: optionalString(root.summary) ?? "apply planned" }
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NetworkMalformedAgentResponseError()
  }
  return value as Record<string, unknown>
}

function arrayValue(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new NetworkMalformedAgentResponseError()
  }
  return value
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new NetworkMalformedAgentResponseError()
  }
  return value
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined
  }
  return requiredString(value)
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new NetworkMalformedAgentResponseError()
  }
  return value
}

function requiredInteger(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) > maxPostgresInteger) {
    throw new NetworkMalformedAgentResponseError()
  }
  return value as number
}

function requiredPositiveInteger(value: unknown): number {
  const integer = requiredInteger(value)
  if (integer < 1) {
    throw new NetworkMalformedAgentResponseError()
  }
  return integer
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function requireActiveFabric(store: NetworkAdminStore, fabricId: string): Promise<PersistedNetworkFabric> {
  const fabric = await store.getFabric(fabricId)
  if (!fabric) {
    throw new NetworkFabricNotFoundError()
  }
  if (fabric.status === "ARCHIVED") {
    throw new NetworkFabricArchivedError()
  }
  return fabric
}

export function toBrowserFabricDetail(detail: FabricDetail): BrowserFabricDetail {
  return {
    ...toBrowserFabric(detail.fabric, {
      hubCount: detail.hubs.length,
      peerCount: detail.peers.length,
      prefixCount: detail.prefixes.length,
      poolCount: detail.pools.length,
    }),
    hubs: detail.hubs.map((hub) => toBrowserHub(hub)),
    peers: detail.peers.map((peer) => toBrowserPeer(peer)),
    prefixes: detail.prefixes.map((prefix) => toBrowserPrefix(prefix)),
    pools: detail.pools.map((pool) => toBrowserPool(pool)),
  }
}

export function toBrowserApplyOperationSafe(
  operation: PersistedNetworkApplyOperation
): BrowserNetworkApplyOperation {
  return toBrowserApplyOperation(operation)
}

// ---------------------------------------------------------------------------
// Prisma store
// ---------------------------------------------------------------------------

type PrismaNetworkClient = Pick<
  PrismaClient,
  | "networkFabric"
  | "wireGuardHub"
  | "hostNetworkPeer"
  | "fabricPrefix"
  | "projectNetworkPool"
  | "networkApplyOperation"
  | "networkStateSnapshot"
  | "agentEndpoint"
  | "auditLog"
  | "$transaction"
>

export class PrismaNetworkAdminStore implements NetworkAdminStore {
  constructor(
    private readonly prisma: PrismaNetworkClient = new PrismaClient(),
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  async listFabrics(): Promise<PersistedNetworkFabric[]> {
    this.assertDatabaseConfigured()
    const fabrics = await this.prisma.networkFabric.findMany({ orderBy: [{ name: "asc" }] })
    return fabrics.map(mapPrismaFabric)
  }

  async getFabric(fabricId: string): Promise<PersistedNetworkFabric | null> {
    this.assertDatabaseConfigured()
    const fabric = await this.prisma.networkFabric.findUnique({ where: { id: fabricId } })
    return fabric ? mapPrismaFabric(fabric) : null
  }

  async getFabricDetail(fabricId: string): Promise<FabricDetail | null> {
    this.assertDatabaseConfigured()
    const fabric = await this.prisma.networkFabric.findUnique({
      where: { id: fabricId },
      include: fabricDetailInclude,
    })
    if (!fabric) {
      return null
    }
    return {
      fabric: mapPrismaFabric(fabric),
      hubs: fabric.hubs.map(mapPrismaHub),
      peers: fabric.peers.map(mapPrismaPeer),
      prefixes: fabric.prefixes.map(mapPrismaPrefix),
      pools: fabric.pools.map(mapPrismaPool),
    }
  }

  async findFabricBySlug(slug: string): Promise<PersistedNetworkFabric | null> {
    this.assertDatabaseConfigured()
    const fabric = await this.prisma.networkFabric.findUnique({ where: { slug } })
    return fabric ? mapPrismaFabric(fabric) : null
  }

  async createFabric(input: FabricPersistInput): Promise<PersistedNetworkFabric> {
    this.assertDatabaseConfigured()
    const fabric = await this.prisma.networkFabric.create({
      data: {
        name: input.name,
        slug: input.slug,
        mode: input.mode,
        status: input.status ?? "PLANNED",
        overlayIpv4Cidr: input.overlayIpv4Cidr,
        overlayIpv6Cidr: input.overlayIpv6Cidr,
      },
    })
    return mapPrismaFabric(fabric)
  }

  async updateFabric(fabricId: string, data: Partial<FabricPersistInput>): Promise<PersistedNetworkFabric> {
    this.assertDatabaseConfigured()
    const fabric = await this.prisma.networkFabric.update({
      where: { id: fabricId },
      data: {
        name: data.name,
        mode: data.mode,
        overlayIpv4Cidr: data.overlayIpv4Cidr,
        overlayIpv6Cidr: data.overlayIpv6Cidr,
      },
    })
    return mapPrismaFabric(fabric)
  }

  async setFabricStatus(fabricId: string, status: NetworkFabricStatus): Promise<PersistedNetworkFabric> {
    this.assertDatabaseConfigured()
    const fabric = await this.prisma.networkFabric.update({
      where: { id: fabricId },
      data: { status },
    })
    return mapPrismaFabric(fabric)
  }

  async countActiveFabricChildren(fabricId: string): Promise<{ hubs: number; peers: number; pools: number }> {
    this.assertDatabaseConfigured()
    const [hubs, peers, pools] = await this.prisma.$transaction([
      this.prisma.wireGuardHub.count({ where: { fabricId, status: { not: "ARCHIVED" } } }),
      this.prisma.hostNetworkPeer.count({ where: { fabricId, status: { not: "ARCHIVED" } } }),
      this.prisma.projectNetworkPool.count({ where: { fabricId, status: { not: "ARCHIVED" } } }),
    ])
    return { hubs, peers, pools }
  }

  async createHub(input: HubPersistInput): Promise<PersistedWireGuardHub> {
    this.assertDatabaseConfigured()
    const hub = await this.prisma.wireGuardHub.create({
      data: {
        fabricId: input.fabricId,
        name: input.name,
        status: input.status ?? "PLANNED",
        listenPort: input.listenPort,
        endpointHost: input.endpointHost,
        publicKey: input.publicKey,
        privateKeyCiphertext: input.privateKeyCiphertext,
        presharedKeyMode: input.presharedKeyMode,
      },
    })
    return mapPrismaHub(hub)
  }

  async createPeer(input: PeerPersistInput): Promise<PersistedHostNetworkPeer> {
    this.assertDatabaseConfigured()
    const peer = await this.prisma.hostNetworkPeer.create({
      data: {
        fabricId: input.fabricId,
        endpointId: input.endpointId,
        name: input.name,
        status: input.status ?? "PLANNED",
        role: input.role,
        publicKey: input.publicKey,
        privateKeyCiphertext: input.privateKeyCiphertext,
        presharedKeyCiphertext: input.presharedKeyCiphertext,
        overlayIpv4Address: input.overlayIpv4Address,
        overlayIpv6Address: input.overlayIpv6Address,
      },
    })
    return mapPrismaPeer(peer)
  }

  async createPrefix(input: PrefixPersistInput): Promise<PersistedFabricPrefix> {
    this.assertDatabaseConfigured()
    const prefix = await this.prisma.fabricPrefix.create({
      data: {
        fabricId: input.fabricId,
        kind: input.kind,
        cidr: input.cidr,
        family: input.family,
        status: input.status ?? "ACTIVE",
        ownerPeerId: input.ownerPeerId,
      },
    })
    return mapPrismaPrefix(prefix)
  }

  async listProjectPools(): Promise<PersistedProjectNetworkPool[]> {
    this.assertDatabaseConfigured()
    const pools = await this.prisma.projectNetworkPool.findMany({
      orderBy: [{ projectId: "asc" }, { fabricId: "asc" }],
    })
    return pools.map(mapPrismaPool)
  }

  async findPoolById(poolId: string): Promise<PersistedProjectNetworkPool | null> {
    this.assertDatabaseConfigured()
    const pool = await this.prisma.projectNetworkPool.findUnique({ where: { id: poolId } })
    return pool ? mapPrismaPool(pool) : null
  }

  async createPool(input: PoolPersistInput): Promise<PersistedProjectNetworkPool> {
    this.assertDatabaseConfigured()
    const pool = await this.prisma.projectNetworkPool.create({
      data: {
        projectId: input.projectId,
        fabricId: input.fabricId,
        ipv4Cidr: input.ipv4Cidr,
        ipv6Cidr: input.ipv6Cidr,
        status: input.status ?? "ACTIVE",
        allocationMode: input.allocationMode,
      },
    })
    return mapPrismaPool(pool)
  }

  async updatePool(poolId: string, data: Partial<PoolPersistInput>): Promise<PersistedProjectNetworkPool> {
    this.assertDatabaseConfigured()
    const pool = await this.prisma.projectNetworkPool.update({
      where: { id: poolId },
      data: {
        ipv4Cidr: data.ipv4Cidr,
        ipv6Cidr: data.ipv6Cidr,
        status: data.status,
        allocationMode: data.allocationMode,
      },
    })
    return mapPrismaPool(pool)
  }

  async getFabricPeersWithEndpoints(fabricId: string): Promise<FabricPeerEndpoint[]> {
    this.assertDatabaseConfigured()
    const peers = await this.prisma.hostNetworkPeer.findMany({
      where: { fabricId, status: { not: "ARCHIVED" }, endpoint: { isNot: null } },
      include: {
        endpoint: {
          select: {
            id: true,
            name: true,
            url: true,
            tokenCiphertext: true,
            status: true,
            teamId: true,
          },
        },
      },
      orderBy: [{ name: "asc" }],
    })
    const result: FabricPeerEndpoint[] = []
    for (const peer of peers) {
      const endpoint = peer.endpoint
      if (!endpoint) {
        continue
      }
      result.push({
        peer: mapPrismaPeer(peer),
        endpoint: {
          id: endpoint.id,
          name: endpoint.name,
          url: endpoint.url,
          tokenCiphertext: endpoint.tokenCiphertext,
          status: endpoint.status,
          teamId: endpoint.teamId,
        },
      })
    }
    return result
  }

  async findActivePeerWithOverlayAddress(
    fabricId: string,
    overlayIpv4Address: string | null,
    overlayIpv6Address: string | null
  ): Promise<PersistedHostNetworkPeer | null> {
    this.assertDatabaseConfigured()
    if (!overlayIpv4Address && !overlayIpv6Address) {
      return null
    }
    const where: Prisma.HostNetworkPeerWhereInput = {
      fabricId,
      status: { not: "ARCHIVED" },
      OR: [],
    }
    if (overlayIpv4Address) {
      where.OR!.push({ overlayIpv4Address })
    }
    if (overlayIpv6Address) {
      where.OR!.push({ overlayIpv6Address })
    }
    const peer = await this.prisma.hostNetworkPeer.findFirst({ where })
    return peer ? mapPrismaPeer(peer) : null
  }

  async upsertNetworkStateSnapshot(input: SnapshotPersistInput): Promise<BrowserNetworkStateSnapshot> {
    this.assertDatabaseConfigured()
    const snapshot = await this.prisma.networkStateSnapshot.upsert({
      where: { endpointId: input.endpointId },
      create: {
        endpointId: input.endpointId,
        fabricId: input.fabricId,
        agentId: input.agentId,
        stateSchemaVersion: input.stateSchemaVersion,
        observedAt: new Date(input.observedAt),
        wireGuardAvailable: input.wireGuardAvailable,
        ipCommandAvailable: input.ipCommandAvailable,
        iptablesAvailable: input.iptablesAvailable,
        ip6tablesAvailable: input.ip6tablesAvailable,
        ipv4Forwarding: input.ipv4Forwarding,
        ipv6Forwarding: input.ipv6Forwarding,
        managedInterfaceCount: input.managedInterfaceCount,
        status: input.status,
      },
      update: {
        fabricId: input.fabricId,
        agentId: input.agentId,
        stateSchemaVersion: input.stateSchemaVersion,
        observedAt: new Date(input.observedAt),
        wireGuardAvailable: input.wireGuardAvailable,
        ipCommandAvailable: input.ipCommandAvailable,
        iptablesAvailable: input.iptablesAvailable,
        ip6tablesAvailable: input.ip6tablesAvailable,
        ipv4Forwarding: input.ipv4Forwarding,
        ipv6Forwarding: input.ipv6Forwarding,
        managedInterfaceCount: input.managedInterfaceCount,
        status: input.status,
      },
    })
    return mapPrismaSnapshot(snapshot)
  }

  async createApplyOperation(input: ApplyOperationPersistInput): Promise<PersistedNetworkApplyOperation> {
    this.assertDatabaseConfigured()
    const operation = await this.prisma.networkApplyOperation.create({
      data: {
        targetType: input.targetType,
        targetId: input.targetId,
        mode: input.mode,
        status: input.status,
        requestedByUserId: input.requestedByUserId,
        summary: input.summary,
        errorSummary: input.errorSummary,
      },
    })
    return mapPrismaApplyOperation(operation)
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

const fabricDetailInclude = {
  hubs: true,
  peers: true,
  prefixes: true,
  pools: true,
} as const

type PrismaFabric = Prisma.NetworkFabricGetPayload<{ include: typeof fabricDetailInclude }>

interface FabricScalarRow {
  id: string
  name: string
  slug: string
  status: NetworkFabricStatus
  mode: NetworkFabricMode
  overlayIpv4Cidr: string
  overlayIpv6Cidr: string
  createdAt: Date
  updatedAt: Date
}

function mapPrismaFabric(fabric: FabricScalarRow): PersistedNetworkFabric {
  return {
    id: fabric.id,
    name: fabric.name,
    slug: fabric.slug,
    status: fabric.status,
    mode: fabric.mode,
    overlayIpv4Cidr: fabric.overlayIpv4Cidr,
    overlayIpv6Cidr: fabric.overlayIpv6Cidr,
    createdAt: fabric.createdAt,
    updatedAt: fabric.updatedAt,
  }
}

function mapPrismaHub(hub: Prisma.WireGuardHubGetPayload<Record<string, never>>): PersistedWireGuardHub {
  return {
    id: hub.id,
    fabricId: hub.fabricId,
    name: hub.name,
    status: hub.status,
    listenPort: hub.listenPort,
    endpointHost: hub.endpointHost,
    publicKey: hub.publicKey,
    privateKeyCiphertext: hub.privateKeyCiphertext,
    presharedKeyMode: hub.presharedKeyMode,
    createdAt: hub.createdAt,
    updatedAt: hub.updatedAt,
  }
}

function mapPrismaPeer(peer: Prisma.HostNetworkPeerGetPayload<Record<string, never>>): PersistedHostNetworkPeer {
  return {
    id: peer.id,
    fabricId: peer.fabricId,
    endpointId: peer.endpointId,
    name: peer.name,
    status: peer.status,
    role: peer.role,
    publicKey: peer.publicKey,
    privateKeyCiphertext: peer.privateKeyCiphertext,
    presharedKeyCiphertext: peer.presharedKeyCiphertext,
    overlayIpv4Address: peer.overlayIpv4Address,
    overlayIpv6Address: peer.overlayIpv6Address,
    createdAt: peer.createdAt,
    updatedAt: peer.updatedAt,
  }
}

function mapPrismaPrefix(prefix: Prisma.FabricPrefixGetPayload<Record<string, never>>): PersistedFabricPrefix {
  return {
    id: prefix.id,
    fabricId: prefix.fabricId,
    kind: prefix.kind,
    cidr: prefix.cidr,
    family: prefix.family,
    status: prefix.status,
    ownerPeerId: prefix.ownerPeerId,
    createdAt: prefix.createdAt,
    updatedAt: prefix.updatedAt,
  }
}

function mapPrismaPool(pool: Prisma.ProjectNetworkPoolGetPayload<Record<string, never>>): PersistedProjectNetworkPool {
  return {
    id: pool.id,
    projectId: pool.projectId,
    fabricId: pool.fabricId,
    ipv4Cidr: pool.ipv4Cidr,
    ipv6Cidr: pool.ipv6Cidr,
    status: pool.status,
    allocationMode: pool.allocationMode,
    createdAt: pool.createdAt,
    updatedAt: pool.updatedAt,
  }
}

function mapPrismaApplyOperation(
  operation: Prisma.NetworkApplyOperationGetPayload<Record<string, never>>
): PersistedNetworkApplyOperation {
  return {
    id: operation.id,
    targetType: operation.targetType,
    targetId: operation.targetId,
    mode: operation.mode,
    status: operation.status,
    requestedByUserId: operation.requestedByUserId,
    summary: operation.summary,
    errorSummary: operation.errorSummary,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  }
}

function mapPrismaSnapshot(
  snapshot: Prisma.NetworkStateSnapshotGetPayload<Record<string, never>>
): BrowserNetworkStateSnapshot {
  return {
    id: snapshot.id,
    endpointId: snapshot.endpointId,
    fabricId: snapshot.fabricId,
    agentId: snapshot.agentId,
    stateSchemaVersion: snapshot.stateSchemaVersion,
    observedAt: snapshot.observedAt.toISOString(),
    wireGuardAvailable: snapshot.wireGuardAvailable,
    ipCommandAvailable: snapshot.ipCommandAvailable,
    iptablesAvailable: snapshot.iptablesAvailable,
    ip6tablesAvailable: snapshot.ip6tablesAvailable,
    forwarding: { ipv4: snapshot.ipv4Forwarding, ipv6: snapshot.ipv6Forwarding },
    managedInterfaceCount: snapshot.managedInterfaceCount,
    status: snapshot.status,
  }
}
