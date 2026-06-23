import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  NetworkCidrError,
  NetworkInvariantError,
  applyTargetTypeToAuditTargetType,
  assertFabricOverlayCidrs,
  assertFabricPrefixInFabric,
  assertHostNetworkPeerAddressesInFabric,
  assertProjectNetworkPoolInFabric,
  assertUniquePeerPublicKeys,
  buildNetworkApplyAuditMetadata,
  cidrContains,
  cidrContainsAddress,
  cidrsOverlap,
  parseCidr,
  toBrowserApplyOperation,
  toBrowserFabric,
  toBrowserHub,
  toBrowserPeer,
  toBrowserPool,
  toBrowserPrefix,
  type PersistedFabricPrefix,
  type PersistedHostNetworkPeer,
  type PersistedNetworkApplyOperation,
  type PersistedNetworkFabric,
  type PersistedProjectNetworkPool,
  type PersistedWireGuardHub,
} from "./networkModels"

const now = new Date("2026-06-23T00:00:00.000Z")

describe("network CIDR helpers", () => {
  test("parses IPv4 and IPv6 CIDR blocks with masked network addresses", () => {
    const v4 = parseCidr("10.20.30.40/24")
    assert.equal(v4.family, 4)
    assert.deepEqual(v4.bytes, [10, 20, 30, 0])
    assert.equal(v4.prefix, 24)

    const v6 = parseCidr("fd00:dead:beef::1234/64")
    assert.equal(v6.family, 6)
    assert.deepEqual(v6.bytes.slice(0, 8), [0xfd, 0, 0xde, 0xad, 0xbe, 0xef, 0, 0])
    assert.deepEqual(v6.bytes.slice(8), [0, 0, 0, 0, 0, 0, 0, 0])
    assert.equal(v6.prefix, 64)

    const mapped = parseCidr("::ffff:1.2.3.4/120")
    assert.deepEqual(mapped.bytes.slice(0, 10), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    assert.deepEqual(mapped.bytes.slice(10, 12), [0xff, 0xff])
    assert.deepEqual(mapped.bytes.slice(12), [1, 2, 3, 0])
  })

  test("rejects malformed CIDR inputs", () => {
    assert.throws(() => parseCidr("10.20.30.40"), NetworkCidrError)
    assert.throws(() => parseCidr("10.20.30.40/33"), NetworkCidrError)
    assert.throws(() => parseCidr("10.20.30.300/24"), NetworkCidrError)
    assert.throws(() => parseCidr("10.20.30/24"), NetworkCidrError)
    assert.throws(() => parseCidr("fd00::/130"), NetworkCidrError)
    assert.throws(() => parseCidr("not-an-ip/24"), NetworkCidrError)
    assert.throws(() => parseCidr("::ffff:1.2.3.4/64::"), NetworkCidrError)
  })

  test("cidrContains and cidrsOverlap behave correctly across families", () => {
    const parent = parseCidr("10.20.0.0/16")
    const child = parseCidr("10.20.30.0/24")
    const outside = parseCidr("10.30.0.0/24")
    const overlapping = parseCidr("10.20.128.0/17")
    const v6 = parseCidr("fd00::/32")

    assert.equal(cidrContains(parent, child), true)
    assert.equal(cidrContains(child, parent), false)
    assert.equal(cidrContains(parent, outside), false)
    assert.equal(cidrContains(parent, v6), false)
    assert.equal(cidrsOverlap(parent, child), true)
    assert.equal(cidrsOverlap(parent, overlapping), true)
    assert.equal(cidrsOverlap(parent, outside), false)
    assert.equal(cidrsOverlap(parent, v6), false)
  })

  test("cidrContainsAddress checks host addresses inside and outside a range", () => {
    const v4 = parseCidr("10.20.0.0/16")
    const v6 = parseCidr("fd00:dead:beef::/48")
    assert.equal(cidrContainsAddress(v4, "10.20.30.40"), true)
    assert.equal(cidrContainsAddress(v4, "10.30.30.40"), false)
    assert.equal(cidrContainsAddress(v4, "fd00::1"), false)
    assert.equal(cidrContainsAddress(v6, "fd00:dead:beef::1234"), true)
    assert.equal(cidrContainsAddress(v6, "fd00:beef::1"), false)
  })
})

describe("network model invariants", () => {
  const fabric = { overlayIpv4Cidr: "10.20.0.0/16", overlayIpv6Cidr: "fd00:dead:beef::/48" }

  test("assertFabricOverlayCidrs validates family of each overlay", () => {
    assert.doesNotThrow(() => assertFabricOverlayCidrs(fabric))
    assert.throws(
      () => assertFabricOverlayCidrs({ overlayIpv4Cidr: "fd00::/32", overlayIpv6Cidr: "fd01::/32" }),
      NetworkInvariantError
    )
    assert.throws(
      () => assertFabricOverlayCidrs({ overlayIpv4Cidr: "10.20.0.0/16", overlayIpv6Cidr: "10.30.0.0/16" }),
      NetworkInvariantError
    )
  })

  test("assertFabricPrefixInFabric rejects prefixes outside the fabric overlay", () => {
    assert.doesNotThrow(() => assertFabricPrefixInFabric(fabric, "10.20.30.0/24", 4))
    assert.doesNotThrow(() => assertFabricPrefixInFabric(fabric, "fd00:dead:beef:1::/64", 6))
    assert.throws(() => assertFabricPrefixInFabric(fabric, "10.30.0.0/24", 4), NetworkInvariantError)
    assert.throws(() => assertFabricPrefixInFabric(fabric, "fd01::/48", 6), NetworkInvariantError)
    assert.throws(() => assertFabricPrefixInFabric(fabric, "10.20.30.0/24", 6), NetworkInvariantError)
    assert.throws(() => assertFabricPrefixInFabric(fabric, "10.20.30.0/24", 5), NetworkInvariantError)
  })

  test("assertProjectNetworkPoolInFabric rejects pool CIDRs outside the fabric overlay", () => {
    assert.doesNotThrow(() =>
      assertProjectNetworkPoolInFabric(fabric, { ipv4Cidr: "10.20.40.0/24", ipv6Cidr: "fd00:dead:beef:2::/64" })
    )
    assert.throws(
      () => assertProjectNetworkPoolInFabric(fabric, { ipv4Cidr: "10.30.0.0/24" }),
      NetworkInvariantError
    )
    assert.throws(
      () => assertProjectNetworkPoolInFabric(fabric, { ipv6Cidr: "fd01::/48" }),
      NetworkInvariantError
    )
    assert.throws(
      () => assertProjectNetworkPoolInFabric(fabric, { ipv4Cidr: "fd00::/32" }),
      NetworkInvariantError
    )
  })

  test("assertHostNetworkPeerAddressesInFabric rejects peer addresses outside the overlay", () => {
    assert.doesNotThrow(() =>
      assertHostNetworkPeerAddressesInFabric(fabric, {
        overlayIpv4Address: "10.20.30.40",
        overlayIpv6Address: "fd00:dead:beef::10",
      })
    )
    assert.throws(
      () => assertHostNetworkPeerAddressesInFabric(fabric, { overlayIpv4Address: "10.30.30.40" }),
      NetworkInvariantError
    )
    assert.throws(
      () => assertHostNetworkPeerAddressesInFabric(fabric, { overlayIpv6Address: "fd01::10" }),
      NetworkInvariantError
    )
  })

  test("assertUniquePeerPublicKeys rejects duplicate public keys", () => {
    assert.doesNotThrow(() => assertUniquePeerPublicKeys(["key-a", "key-b", "key-c"]))
    assert.throws(() => assertUniquePeerPublicKeys(["key-a", "key-b", "key-a"]), NetworkInvariantError)
  })
})

describe("browser-safe network serialization", () => {
  test("toBrowserFabric exposes counts and never ciphertext material", () => {
    const fabric: PersistedNetworkFabric = {
      id: "fabric-1",
      name: "Primary Fabric",
      slug: "primary-fabric",
      status: "ACTIVE",
      mode: "HUB_SPOKE",
      overlayIpv4Cidr: "10.20.0.0/16",
      overlayIpv6Cidr: "fd00:dead:beef::/48",
      createdAt: now,
      updatedAt: now,
    }
    const serialized = toBrowserFabric(fabric, { hubCount: 1, peerCount: 2, prefixCount: 3, poolCount: 1 })
    assert.deepEqual(serialized, {
      id: "fabric-1",
      name: "Primary Fabric",
      slug: "primary-fabric",
      status: "ACTIVE",
      mode: "HUB_SPOKE",
      overlayIpv4Cidr: "10.20.0.0/16",
      overlayIpv6Cidr: "fd00:dead:beef::/48",
      hubCount: 1,
      peerCount: 2,
      prefixCount: 3,
      poolCount: 1,
      createdAt: "2026-06-23T00:00:00.000Z",
      updatedAt: "2026-06-23T00:00:00.000Z",
    })
    assert.equal(JSON.stringify(serialized).includes("Ciphertext"), false)
  })

  test("toBrowserHub exposes publicKey and configured flags, never private key material", () => {
    const hub: PersistedWireGuardHub = {
      id: "hub-1",
      fabricId: "fabric-1",
      name: "primary-hub",
      status: "ACTIVE",
      listenPort: 51820,
      endpointHost: "hub.internal.example",
      publicKey: "hub-public-key",
      privateKeyCiphertext: "v1:secret-envelope-private-key-ciphertext",
      presharedKeyMode: "PAIRWISE",
      createdAt: now,
      updatedAt: now,
    }
    const serialized = toBrowserHub(hub)
    assert.equal(serialized.publicKey, "hub-public-key")
    assert.equal(serialized.privateKeyConfigured, true)
    assert.equal(serialized.presharedKeyMode, "PAIRWISE")
    const json = JSON.stringify(serialized)
    assert.equal(json.includes("v1:secret-envelope-private-key-ciphertext"), false)
    assert.equal(json.includes("privateKeyCiphertext"), false)
    assert.equal(json.includes("presharedKeyCiphertext"), false)
    assert.equal(json.includes("secret-envelope-private-key-ciphertext"), false)
  })

  test("toBrowserPeer exposes flags only and never private/PSK ciphertext", () => {
    const peer: PersistedHostNetworkPeer = {
      id: "peer-1",
      fabricId: "fabric-1",
      endpointId: "endpoint-1",
      name: "host-peer",
      status: "ACTIVE",
      role: "MEMBER",
      publicKey: "peer-public-key",
      privateKeyCiphertext: "v1:peer-private-key-ciphertext-envelope",
      presharedKeyCiphertext: "v1:peer-preshared-key-ciphertext-envelope",
      overlayIpv4Address: "10.20.30.40",
      overlayIpv6Address: "fd00:dead:beef::10",
      createdAt: now,
      updatedAt: now,
    }
    const serialized = toBrowserPeer(peer)
    assert.equal(serialized.publicKey, "peer-public-key")
    assert.equal(serialized.privateKeyConfigured, true)
    assert.equal(serialized.presharedKeyConfigured, true)
    assert.equal(serialized.endpointId, "endpoint-1")
    const json = JSON.stringify(serialized)
    assert.equal(json.includes("v1:peer-private-key-ciphertext-envelope"), false)
    assert.equal(json.includes("v1:peer-preshared-key-ciphertext-envelope"), false)
    assert.equal(json.includes("privateKeyCiphertext"), false)
    assert.equal(json.includes("presharedKeyCiphertext"), false)
  })

  test("toBrowserPrefix and toBrowserPool never expose secret fields", () => {
    const prefix: PersistedFabricPrefix = {
      id: "prefix-1",
      fabricId: "fabric-1",
      kind: "SUBNET",
      cidr: "10.20.30.0/24",
      family: 4,
      status: "ACTIVE",
      ownerPeerId: "peer-1",
      createdAt: now,
      updatedAt: now,
    }
    const pool: PersistedProjectNetworkPool = {
      id: "pool-1",
      projectId: "project-1",
      fabricId: "fabric-1",
      ipv4Cidr: "10.20.40.0/24",
      ipv6Cidr: "fd00:dead:beef:2::/64",
      status: "ACTIVE",
      allocationMode: "STATIC",
      createdAt: now,
      updatedAt: now,
    }
    assert.deepEqual(toBrowserPrefix(prefix), {
      id: "prefix-1",
      fabricId: "fabric-1",
      kind: "SUBNET",
      cidr: "10.20.30.0/24",
      family: 4,
      status: "ACTIVE",
      ownerPeerId: "peer-1",
      createdAt: "2026-06-23T00:00:00.000Z",
      updatedAt: "2026-06-23T00:00:00.000Z",
    })
    assert.deepEqual(toBrowserPool(pool), {
      id: "pool-1",
      projectId: "project-1",
      fabricId: "fabric-1",
      ipv4Cidr: "10.20.40.0/24",
      ipv6Cidr: "fd00:dead:beef:2::/64",
      status: "ACTIVE",
      allocationMode: "STATIC",
      createdAt: "2026-06-23T00:00:00.000Z",
      updatedAt: "2026-06-23T00:00:00.000Z",
    })
  })

  test("toBrowserApplyOperation preserves action identity without secret material", () => {
    const operation: PersistedNetworkApplyOperation = {
      id: "apply-1",
      targetType: "PEER",
      targetId: "peer-1",
      mode: "DRY_RUN",
      status: "SUCCEEDED",
      requestedByUserId: "user-1",
      summary: "rendered config for anvilwg0",
      errorSummary: null,
      createdAt: now,
      updatedAt: now,
    }
    assert.deepEqual(toBrowserApplyOperation(operation), {
      id: "apply-1",
      targetType: "PEER",
      targetId: "peer-1",
      mode: "DRY_RUN",
      status: "SUCCEEDED",
      requestedByUserId: "user-1",
      summary: "rendered config for anvilwg0",
      errorSummary: null,
      createdAt: "2026-06-23T00:00:00.000Z",
      updatedAt: "2026-06-23T00:00:00.000Z",
    })
  })
})

describe("network apply audit metadata", () => {
  test("builds redaction-safe metadata that preserves action identity", () => {
    const metadata = buildNetworkApplyAuditMetadata(
      { targetType: "HUB", targetId: "hub-1", mode: "APPLY", status: "SUCCEEDED" },
      "applied anvilwg0 hub config"
    )
    assert.deepEqual(metadata, {
      targetType: "network_hub",
      targetId: "hub-1",
      mode: "APPLY",
      status: "SUCCEEDED",
      summary: "applied anvilwg0 hub config",
    })
  })

  test("maps apply target types to audit target types", () => {
    assert.equal(applyTargetTypeToAuditTargetType("FABRIC"), "network_fabric")
    assert.equal(applyTargetTypeToAuditTargetType("HUB"), "network_hub")
    assert.equal(applyTargetTypeToAuditTargetType("PEER"), "network_peer")
    assert.equal(applyTargetTypeToAuditTargetType("PREFIX"), "network_prefix")
    assert.equal(applyTargetTypeToAuditTargetType("POOL"), "network_pool")
  })
})
