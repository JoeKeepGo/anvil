// M12 Phase 2: browser-safe network domain types and invariants.
//
// This module defines the persistence-adjacent network model boundaries that
// later phases consume. Browser-safe serialization types intentionally never
// include WireGuard private keys or preshared keys; they expose only public
// keys and `*Configured` boolean flags.
//
// Invariants are pure functions so they can be unit-tested without a database.

export type NetworkFabricStatus = "PLANNED" | "ACTIVE" | "ARCHIVED"
export type NetworkFabricMode = "HUB_SPOKE" | "MESH"
export type WireGuardHubStatus = "PLANNED" | "ACTIVE" | "ARCHIVED"
export type NetworkPresharedKeyMode = "DISABLED" | "PAIRWISE" | "FABRIC"
export type HostNetworkPeerStatus = "PLANNED" | "ACTIVE" | "ARCHIVED"
export type HostNetworkPeerRole = "MEMBER" | "RELAY"
export type FabricPrefixKind = "SUBNET" | "ROUTE" | "RESERVED"
export type FabricPrefixStatus = "ACTIVE" | "ARCHIVED"
export type ProjectNetworkPoolStatus = "ACTIVE" | "ARCHIVED"
export type NetworkPoolAllocationMode = "STATIC" | "DYNAMIC" | "RESERVED"
export type NetworkApplyTargetType = "FABRIC" | "HUB" | "PEER" | "PREFIX" | "POOL"
export type NetworkApplyMode = "DRY_RUN" | "APPLY"
export type NetworkApplyStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED"

// ---------------------------------------------------------------------------
// Browser-safe serialization types
// ---------------------------------------------------------------------------

export interface BrowserNetworkFabric {
  id: string
  name: string
  slug: string
  status: NetworkFabricStatus
  mode: NetworkFabricMode
  overlayIpv4Cidr: string
  overlayIpv6Cidr: string
  hubCount: number
  peerCount: number
  prefixCount: number
  poolCount: number
  createdAt: string
  updatedAt: string
}

export interface BrowserWireGuardHub {
  id: string
  fabricId: string
  name: string
  status: WireGuardHubStatus
  listenPort: number
  endpointHost: string
  publicKey: string
  presharedKeyMode: NetworkPresharedKeyMode
  privateKeyConfigured: boolean
  createdAt: string
  updatedAt: string
}

export interface BrowserHostNetworkPeer {
  id: string
  fabricId: string
  endpointId: string | null
  name: string
  status: HostNetworkPeerStatus
  role: HostNetworkPeerRole
  publicKey: string
  privateKeyConfigured: boolean
  presharedKeyConfigured: boolean
  overlayIpv4Address: string | null
  overlayIpv6Address: string | null
  createdAt: string
  updatedAt: string
}

export interface BrowserFabricPrefix {
  id: string
  fabricId: string
  kind: FabricPrefixKind
  cidr: string
  family: number
  status: FabricPrefixStatus
  ownerPeerId: string | null
  createdAt: string
  updatedAt: string
}

export interface BrowserProjectNetworkPool {
  id: string
  projectId: string
  fabricId: string
  ipv4Cidr: string | null
  ipv6Cidr: string | null
  status: ProjectNetworkPoolStatus
  allocationMode: NetworkPoolAllocationMode
  createdAt: string
  updatedAt: string
}

export interface BrowserNetworkApplyOperation {
  id: string
  targetType: NetworkApplyTargetType
  targetId: string
  mode: NetworkApplyMode
  status: NetworkApplyStatus
  requestedByUserId: string
  summary: string | null
  errorSummary: string | null
  createdAt: string
  updatedAt: string
}

// ---------------------------------------------------------------------------
// Persisted record inputs (raw, server-only; include ciphertext)
// ---------------------------------------------------------------------------

export interface PersistedNetworkFabric {
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

export interface PersistedWireGuardHub {
  id: string
  fabricId: string
  name: string
  status: WireGuardHubStatus
  listenPort: number
  endpointHost: string
  publicKey: string
  privateKeyCiphertext: string
  presharedKeyMode: NetworkPresharedKeyMode
  createdAt: Date
  updatedAt: Date
}

export interface PersistedHostNetworkPeer {
  id: string
  fabricId: string
  endpointId: string | null
  name: string
  status: HostNetworkPeerStatus
  role: HostNetworkPeerRole
  publicKey: string
  privateKeyCiphertext: string
  presharedKeyCiphertext: string | null
  overlayIpv4Address: string | null
  overlayIpv6Address: string | null
  createdAt: Date
  updatedAt: Date
}

export interface PersistedFabricPrefix {
  id: string
  fabricId: string
  kind: FabricPrefixKind
  cidr: string
  family: number
  status: FabricPrefixStatus
  ownerPeerId: string | null
  createdAt: Date
  updatedAt: Date
}

export interface PersistedProjectNetworkPool {
  id: string
  projectId: string
  fabricId: string
  ipv4Cidr: string | null
  ipv6Cidr: string | null
  status: ProjectNetworkPoolStatus
  allocationMode: NetworkPoolAllocationMode
  createdAt: Date
  updatedAt: Date
}

export interface PersistedNetworkApplyOperation {
  id: string
  targetType: NetworkApplyTargetType
  targetId: string
  mode: NetworkApplyMode
  status: NetworkApplyStatus
  requestedByUserId: string
  summary: string | null
  errorSummary: string | null
  createdAt: Date
  updatedAt: Date
}

// ---------------------------------------------------------------------------
// Browser-safe serializers
// ---------------------------------------------------------------------------

export interface NetworkFabricCounts {
  hubCount?: number
  peerCount?: number
  prefixCount?: number
  poolCount?: number
}

export function toBrowserFabric(
  fabric: PersistedNetworkFabric,
  counts: NetworkFabricCounts = {}
): BrowserNetworkFabric {
  return {
    id: fabric.id,
    name: fabric.name,
    slug: fabric.slug,
    status: fabric.status,
    mode: fabric.mode,
    overlayIpv4Cidr: fabric.overlayIpv4Cidr,
    overlayIpv6Cidr: fabric.overlayIpv6Cidr,
    hubCount: counts.hubCount ?? 0,
    peerCount: counts.peerCount ?? 0,
    prefixCount: counts.prefixCount ?? 0,
    poolCount: counts.poolCount ?? 0,
    createdAt: fabric.createdAt.toISOString(),
    updatedAt: fabric.updatedAt.toISOString(),
  }
}

export function toBrowserHub(hub: PersistedWireGuardHub): BrowserWireGuardHub {
  return {
    id: hub.id,
    fabricId: hub.fabricId,
    name: hub.name,
    status: hub.status,
    listenPort: hub.listenPort,
    endpointHost: hub.endpointHost,
    publicKey: hub.publicKey,
    presharedKeyMode: hub.presharedKeyMode,
    privateKeyConfigured: isPresent(hub.privateKeyCiphertext),
    createdAt: hub.createdAt.toISOString(),
    updatedAt: hub.updatedAt.toISOString(),
  }
}

export function toBrowserPeer(peer: PersistedHostNetworkPeer): BrowserHostNetworkPeer {
  return {
    id: peer.id,
    fabricId: peer.fabricId,
    endpointId: peer.endpointId,
    name: peer.name,
    status: peer.status,
    role: peer.role,
    publicKey: peer.publicKey,
    privateKeyConfigured: isPresent(peer.privateKeyCiphertext),
    presharedKeyConfigured: isPresent(peer.presharedKeyCiphertext),
    overlayIpv4Address: peer.overlayIpv4Address,
    overlayIpv6Address: peer.overlayIpv6Address,
    createdAt: peer.createdAt.toISOString(),
    updatedAt: peer.updatedAt.toISOString(),
  }
}

export function toBrowserPrefix(prefix: PersistedFabricPrefix): BrowserFabricPrefix {
  return {
    id: prefix.id,
    fabricId: prefix.fabricId,
    kind: prefix.kind,
    cidr: prefix.cidr,
    family: prefix.family,
    status: prefix.status,
    ownerPeerId: prefix.ownerPeerId,
    createdAt: prefix.createdAt.toISOString(),
    updatedAt: prefix.updatedAt.toISOString(),
  }
}

export function toBrowserPool(pool: PersistedProjectNetworkPool): BrowserProjectNetworkPool {
  return {
    id: pool.id,
    projectId: pool.projectId,
    fabricId: pool.fabricId,
    ipv4Cidr: pool.ipv4Cidr,
    ipv6Cidr: pool.ipv6Cidr,
    status: pool.status,
    allocationMode: pool.allocationMode,
    createdAt: pool.createdAt.toISOString(),
    updatedAt: pool.updatedAt.toISOString(),
  }
}

export function toBrowserApplyOperation(
  operation: PersistedNetworkApplyOperation
): BrowserNetworkApplyOperation {
  return {
    id: operation.id,
    targetType: operation.targetType,
    targetId: operation.targetId,
    mode: operation.mode,
    status: operation.status,
    requestedByUserId: operation.requestedByUserId,
    summary: operation.summary,
    errorSummary: operation.errorSummary,
    createdAt: operation.createdAt.toISOString(),
    updatedAt: operation.updatedAt.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// CIDR helpers and network invariants
// ---------------------------------------------------------------------------

export class NetworkCidrError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NetworkCidrError"
  }
}

export class NetworkInvariantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NetworkInvariantError"
  }
}

export interface CidrBlock {
  family: 4 | 6
  bytes: number[]
  prefix: number
}

const ipv4ByteLength = 4
const ipv6ByteLength = 16
const ipv4MaxPrefix = 32
const ipv6MaxPrefix = 128

export function parseCidr(cidr: string): CidrBlock {
  const slashIndex = cidr.indexOf("/")
  if (slashIndex < 0) {
    throw new NetworkCidrError(`CIDR is missing prefix length: ${cidr}`)
  }
  const address = cidr.slice(0, slashIndex)
  const prefixText = cidr.slice(slashIndex + 1)
  if (address === "" || prefixText === "") {
    throw new NetworkCidrError(`CIDR is malformed: ${cidr}`)
  }

  const prefix = Number(prefixText)
  if (!Number.isInteger(prefix) || prefix < 0) {
    throw new NetworkCidrError(`CIDR prefix is invalid: ${cidr}`)
  }

  const ipv4Bytes = parseIpv4(address)
  if (ipv4Bytes) {
    if (prefix > ipv4MaxPrefix) {
      throw new NetworkCidrError(`IPv4 prefix is out of range: ${cidr}`)
    }
    return { family: 4, bytes: maskBytes(ipv4Bytes, prefix), prefix }
  }

  const ipv6Bytes = parseIpv6(address)
  if (ipv6Bytes) {
    if (prefix > ipv6MaxPrefix) {
      throw new NetworkCidrError(`IPv6 prefix is out of range: ${cidr}`)
    }
    return { family: 6, bytes: maskBytes(ipv6Bytes, prefix), prefix }
  }

  throw new NetworkCidrError(`CIDR address is not a valid IP: ${cidr}`)
}

export function parseIpAddress(address: string): { family: 4 | 6; bytes: number[] } {
  const ipv4 = parseIpv4(address)
  if (ipv4) {
    return { family: 4, bytes: ipv4 }
  }
  const ipv6 = parseIpv6(address)
  if (ipv6) {
    return { family: 6, bytes: ipv6 }
  }
  throw new NetworkCidrError(`Address is not a valid IP: ${address}`)
}

export function cidrContains(parent: CidrBlock, child: CidrBlock): boolean {
  if (parent.family !== child.family) {
    return false
  }
  if (parent.prefix > child.prefix) {
    return false
  }
  const childMasked = maskBytes(child.bytes, parent.prefix)
  return bytesEqual(childMasked, parent.bytes)
}

export function cidrContainsAddress(parent: CidrBlock, address: string): boolean {
  const parsed = parseIpAddress(address)
  if (parsed.family !== parent.family) {
    return false
  }
  const masked = maskBytes(parsed.bytes, parent.prefix)
  return bytesEqual(masked, parent.bytes)
}

export function cidrsOverlap(a: CidrBlock, b: CidrBlock): boolean {
  if (a.family !== b.family) {
    return false
  }
  const minPrefix = Math.min(a.prefix, b.prefix)
  return bytesEqual(maskBytes(a.bytes, minPrefix), maskBytes(b.bytes, minPrefix))
}

export function assertFabricOverlayCidrs(input: {
  overlayIpv4Cidr: string
  overlayIpv6Cidr: string
}): { ipv4: CidrBlock; ipv6: CidrBlock } {
  const ipv4 = parseCidr(input.overlayIpv4Cidr)
  if (ipv4.family !== 4) {
    throw new NetworkInvariantError("Fabric overlay IPv4 CIDR must be an IPv4 network.")
  }
  const ipv6 = parseCidr(input.overlayIpv6Cidr)
  if (ipv6.family !== 6) {
    throw new NetworkInvariantError("Fabric overlay IPv6 CIDR must be an IPv6 network.")
  }
  return { ipv4, ipv6 }
}

export function assertFabricPrefixInFabric(
  fabric: { overlayIpv4Cidr: string; overlayIpv6Cidr: string },
  prefixCidr: string,
  prefixFamily: number
): CidrBlock {
  const overlay = assertFabricOverlayCidrs(fabric)
  const prefix = parseCidr(prefixCidr)
  const overlayBlock = prefixFamily === 4 ? overlay.ipv4 : prefixFamily === 6 ? overlay.ipv6 : null
  if (!overlayBlock) {
    throw new NetworkInvariantError(`Prefix family ${prefixFamily} is unsupported.`)
  }
  if (prefix.family !== overlayBlock.family) {
    throw new NetworkInvariantError(
      `Prefix ${prefixCidr} family does not match declared family ${prefixFamily}.`
    )
  }
  if (!cidrContains(overlayBlock, prefix)) {
    throw new NetworkInvariantError(`Prefix ${prefixCidr} is outside the fabric overlay range.`)
  }
  return prefix
}

export function assertProjectNetworkPoolInFabric(
  fabric: { overlayIpv4Cidr: string; overlayIpv6Cidr: string },
  pool: { ipv4Cidr?: string | null; ipv6Cidr?: string | null }
): { ipv4?: CidrBlock; ipv6?: CidrBlock } {
  const overlay = assertFabricOverlayCidrs(fabric)
  const result: { ipv4?: CidrBlock; ipv6?: CidrBlock } = {}
  if (pool.ipv4Cidr) {
    const block = parseCidr(pool.ipv4Cidr)
    if (block.family !== 4) {
      throw new NetworkInvariantError("Project network pool IPv4 CIDR must be an IPv4 network.")
    }
    if (!cidrContains(overlay.ipv4, block)) {
      throw new NetworkInvariantError(
        `Project network pool IPv4 ${pool.ipv4Cidr} is outside the fabric overlay range.`
      )
    }
    result.ipv4 = block
  }
  if (pool.ipv6Cidr) {
    const block = parseCidr(pool.ipv6Cidr)
    if (block.family !== 6) {
      throw new NetworkInvariantError("Project network pool IPv6 CIDR must be an IPv6 network.")
    }
    if (!cidrContains(overlay.ipv6, block)) {
      throw new NetworkInvariantError(
        `Project network pool IPv6 ${pool.ipv6Cidr} is outside the fabric overlay range.`
      )
    }
    result.ipv6 = block
  }
  return result
}

export function assertHostNetworkPeerAddressesInFabric(
  fabric: { overlayIpv4Cidr: string; overlayIpv6Cidr: string },
  peer: { overlayIpv4Address?: string | null; overlayIpv6Address?: string | null }
): void {
  const overlay = assertFabricOverlayCidrs(fabric)
  if (peer.overlayIpv4Address) {
    if (!cidrContainsAddress(overlay.ipv4, peer.overlayIpv4Address)) {
      throw new NetworkInvariantError(
        `Peer overlay IPv4 ${peer.overlayIpv4Address} is outside the fabric overlay range.`
      )
    }
  }
  if (peer.overlayIpv6Address) {
    if (!cidrContainsAddress(overlay.ipv6, peer.overlayIpv6Address)) {
      throw new NetworkInvariantError(
        `Peer overlay IPv6 ${peer.overlayIpv6Address} is outside the fabric overlay range.`
      )
    }
  }
}

export function assertUniquePeerPublicKeys(publicKeys: string[]): void {
  const seen = new Set<string>()
  for (const key of publicKeys) {
    if (seen.has(key)) {
      throw new NetworkInvariantError(`Duplicate WireGuard peer public key: ${key}`)
    }
    seen.add(key)
  }
}

// ---------------------------------------------------------------------------
// Audit metadata helpers for network mutations
// ---------------------------------------------------------------------------

export const NETWORK_AUDIT_TARGET_TYPES = [
  "network_fabric",
  "network_hub",
  "network_peer",
  "network_prefix",
  "network_pool",
  "network_apply",
] as const

export type NetworkAuditTargetType = (typeof NETWORK_AUDIT_TARGET_TYPES)[number]

export interface NetworkApplyAuditMetadata {
  targetType: NetworkAuditTargetType
  targetId: string
  mode: NetworkApplyMode
  status: NetworkApplyStatus
}

/**
 * Build redaction-safe audit metadata for a network apply operation.
 * The returned metadata preserves action identity (target type/id, mode,
 * status) but never carries private key, preshared key, or endpoint token
 * material. The caller may include non-secret summary text.
 */
export function buildNetworkApplyAuditMetadata(
  operation: Pick<PersistedNetworkApplyOperation, "targetType" | "targetId" | "mode" | "status">,
  summary?: string
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    targetType: applyTargetTypeToAuditTargetType(operation.targetType),
    targetId: operation.targetId,
    mode: operation.mode,
    status: operation.status,
  }
  if (summary !== undefined) {
    metadata.summary = summary
  }
  return metadata
}

export function applyTargetTypeToAuditTargetType(
  targetType: NetworkApplyTargetType
): NetworkAuditTargetType {
  switch (targetType) {
    case "FABRIC":
      return "network_fabric"
    case "HUB":
      return "network_hub"
    case "PEER":
      return "network_peer"
    case "PREFIX":
      return "network_prefix"
    case "POOL":
      return "network_pool"
  }
}

// ---------------------------------------------------------------------------
// Internal byte helpers
// ---------------------------------------------------------------------------

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".")
  if (parts.length !== ipv4ByteLength) {
    return null
  }
  const bytes: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null
    }
    const octet = Number(part)
    if (octet > 255) {
      return null
    }
    // Reject leading zeros that change interpretation (e.g. "01") to keep parsing strict.
    if (part.length > 1 && part.startsWith("0")) {
      return null
    }
    bytes.push(octet)
  }
  return bytes
}

function parseIpv6(address: string): number[] | null {
  if (address === "") {
    return null
  }
  // Reject any stray scope id.
  if (address.includes("%")) {
    return null
  }

  // An embedded IPv4 tail (e.g. ::ffff:1.2.3.4) occupies the last 32 bits and
  // is always the final component. Strip it before expanding the hex groups.
  let hexPart = address
  let ipv4Tail: number[] | null = null
  const lastColon = address.lastIndexOf(":")
  if (lastColon >= 0) {
    const tail = address.slice(lastColon + 1)
    if (tail.includes(".")) {
      ipv4Tail = parseIpv4(tail)
      if (!ipv4Tail) {
        return null
      }
      hexPart = address.slice(0, lastColon)
    }
  }

  const need = ipv4Tail ? 6 : 8
  let groups: string[]
  const doubleColonIndex = hexPart.indexOf("::")
  if (doubleColonIndex >= 0) {
    if (hexPart.indexOf("::", doubleColonIndex + 1) >= 0) {
      return null
    }
    const head = hexPart.slice(0, doubleColonIndex)
    const tail = hexPart.slice(doubleColonIndex + 2)
    const headGroups = head ? head.split(":") : []
    const tailGroups = tail ? tail.split(":") : []
    const provided = headGroups.length + tailGroups.length
    if (provided >= need) {
      return null
    }
    groups = [...headGroups, ...new Array(need - provided).fill("0"), ...tailGroups]
  } else {
    groups = hexPart ? hexPart.split(":") : []
    if (groups.length !== need) {
      return null
    }
  }

  const bytes = new Array<number>(ipv6ByteLength).fill(0)
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index]
    if (group.includes(".")) {
      return null
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) {
      return null
    }
    const value = parseInt(group, 16)
    bytes[index * 2] = (value >> 8) & 0xff
    bytes[index * 2 + 1] = value & 0xff
  }

  if (ipv4Tail) {
    bytes[12] = ipv4Tail[0]
    bytes[13] = ipv4Tail[1]
    bytes[14] = ipv4Tail[2]
    bytes[15] = ipv4Tail[3]
  }
  return bytes
}

function maskBytes(bytes: number[], prefix: number): number[] {
  const masked = bytes.slice()
  for (let i = 0; i < bytes.length; i++) {
    const byteStart = i * 8
    if (prefix >= byteStart + 8) {
      // Full byte is inside the network prefix; keep it.
      continue
    }
    if (prefix <= byteStart) {
      // Full byte is outside the network prefix; zero it.
      masked[i] = 0
    } else {
      const keep = prefix - byteStart
      const mask = (0xff << (8 - keep)) & 0xff
      masked[i] = masked[i] & mask
    }
  }
  return masked
}

function bytesEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false
    }
  }
  return true
}

function isPresent(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim() !== ""
}
