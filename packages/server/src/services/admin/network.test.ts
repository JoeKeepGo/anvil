import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  NetworkAgentUnavailableError,
  NetworkDuplicateFabricSlugError,
  NetworkDuplicatePeerAddressError,
  NetworkFabricArchivedError,
  NetworkFabricHasActiveChildrenError,
  NetworkFabricNotFoundError,
  NetworkInvariantError,
  NetworkMalformedAgentResponseError,
  NetworkPermissionDeniedError,
  NetworkPoolNotFoundError,
  applyFabric,
  archiveFabric,
  createFabric,
  createHub,
  createPeer,
  createPool,
  createPrefix,
  generateWireGuardKeyPair,
  getFabric,
  listFabrics,
  listProjectPools,
  restoreFabric,
  syncFabric,
  updateFabric,
  updatePool,
  type FabricPeerEndpoint,
  type NetworkAdminStore,
  type NetworkAgentClient,
} from "./network"
import type { AdminAuditEntry, AdminPrincipal } from "./session"
import type { AgentRequest, AgentResponse } from "../agent"
import type {
  PersistedFabricPrefix,
  PersistedHostNetworkPeer,
  PersistedNetworkApplyOperation,
  PersistedNetworkFabric,
  PersistedProjectNetworkPool,
  PersistedWireGuardHub,
} from "./networkModels"

const networkSecretKey = "m12-phase4-network-secret-key-with-enough-entropy"
const env = { ANVIL_NETWORK_SECRET_KEY: networkSecretKey }

const globalAdmin: AdminPrincipal = {
  id: "admin-1",
  email: "admin@example.com",
  name: "Admin User",
  status: "ACTIVE",
  globalRole: "ADMIN",
  teams: [],
}

const member: AdminPrincipal = {
  id: "member-1",
  email: "member@example.com",
  name: "Member User",
  status: "ACTIVE",
  globalRole: "MEMBER",
  teams: [],
}

const now = new Date("2026-06-23T00:00:00.000Z")

describe("network admin service permissions", () => {
  test("read/write/apply are gated by network permissions", async () => {
    const store = new TestNetworkStore()
    await assert.rejects(listFabrics(store, member), NetworkPermissionDeniedError)
    await assert.rejects(
      createFabric(store, member, { name: "F", slug: "f", overlayIpv4Cidr: "10.20.0.0/16", overlayIpv6Cidr: "fd00:dead:beef::/48" }),
      NetworkPermissionDeniedError
    )
    await assert.rejects(applyFabric(store, member, "fabric-1", "DRY_RUN"), NetworkPermissionDeniedError)

    // admin can read/write/apply
    const fabric = await createFabric(store, globalAdmin, {
      name: "Primary Fabric",
      slug: "primary-fabric",
      overlayIpv4Cidr: "10.20.0.0/16",
      overlayIpv6Cidr: "fd00:dead:beef::/48",
    })
    assert.equal(fabric.slug, "primary-fabric")
    assert.deepEqual(await listFabrics(store, globalAdmin), [fabric])
  })
})

describe("network fabric CRUD and audit", () => {
  test("create/update/archive/restore fabric with audit and redaction", async () => {
    const store = new TestNetworkStore()
    const fabric = await createFabric(store, globalAdmin, {
      name: "Primary Fabric",
      slug: "primary-fabric",
      mode: "MESH",
      overlayIpv4Cidr: "10.20.0.0/16",
      overlayIpv6Cidr: "fd00:dead:beef::/48",
    })
    assert.equal(fabric.status, "PLANNED")
    assert.equal(fabric.mode, "MESH")

    const updated = await updateFabric(store, globalAdmin, fabric.id, { name: "Renamed Fabric" })
    assert.equal(updated.name, "Renamed Fabric")

    const detail = await getFabric(store, globalAdmin, fabric.id)
    assert.equal(detail.hubs.length, 0)

    await assert.rejects(
      createFabric(store, globalAdmin, {
        name: "Dup",
        slug: "primary-fabric",
        overlayIpv4Cidr: "10.30.0.0/16",
        overlayIpv6Cidr: "fd01::/48",
      }),
      NetworkDuplicateFabricSlugError
    )

    const archived = await archiveFabric(store, globalAdmin, fabric.id)
    assert.equal(archived.status, "ARCHIVED")
    await assert.rejects(updateFabric(store, globalAdmin, fabric.id, { name: "x" }), NetworkFabricArchivedError)

    const restored = await restoreFabric(store, globalAdmin, fabric.id)
    assert.equal(restored.status, "ACTIVE")

    assert.deepEqual(
      store.auditEntries.map((e) => e.action),
      ["network_fabric.create", "network_fabric.update", "network_fabric.archive", "network_fabric.restore"]
    )
    const serialized = JSON.stringify(store.auditEntries)
    assert.equal(serialized.includes("privateKey"), false)
    assert.equal(serialized.includes("presharedKey"), false)
  })

  test("archive rejects when fabric has active children", async () => {
    const store = new TestNetworkStore()
    const fabric = await createFabric(store, globalAdmin, {
      name: "F",
      slug: "f-active",
      overlayIpv4Cidr: "10.20.0.0/16",
      overlayIpv6Cidr: "fd00:dead:beef::/48",
    })
    await createHub(store, globalAdmin, { fabricId: fabric.id, name: "hub", listenPort: 51820, endpointHost: "hub.internal" }, env)
    await assert.rejects(archiveFabric(store, globalAdmin, fabric.id), NetworkFabricHasActiveChildrenError)
  })

  test("create fabric rejects invalid overlay CIDRs", async () => {
    const store = new TestNetworkStore()
    await assert.rejects(
      createFabric(store, globalAdmin, { name: "F", slug: "bad", overlayIpv4Cidr: "fd00::/32", overlayIpv6Cidr: "fd01::/48" }),
      NetworkInvariantError
    )
    await assert.rejects(
      createFabric(store, globalAdmin, { name: "F", slug: "bad2", overlayIpv4Cidr: "10.20.0.0/16", overlayIpv6Cidr: "10.30.0.0/16" }),
      NetworkInvariantError
    )
  })
})

describe("network hub/peer/prefix/pool services and secret boundary", () => {
  test("createHub generates a server-side keypair, stores encrypted private key, returns browser-safe hub", async () => {
    const store = new TestNetworkStore()
    const fabric = await createFabric(store, globalAdmin, {
      name: "F",
      slug: "hub-fabric",
      overlayIpv4Cidr: "10.20.0.0/16",
      overlayIpv6Cidr: "fd00:dead:beef::/48",
    })
    const hub = await createHub(store, globalAdmin, { fabricId: fabric.id, name: "primary-hub", listenPort: 51820, endpointHost: "hub.internal" }, env)
    assert.equal(hub.name, "primary-hub")
    assert.equal(hub.listenPort, 51820)
    assert.equal(hub.publicKey.length, 44)
    assert.equal(hub.privateKeyConfigured, true)
    assert.equal(hub.presharedKeyMode, "DISABLED")

    const stored = store.hubs.get(hub.id)
    assert.ok(stored)
    assert.ok(stored.privateKeyCiphertext.startsWith("v1:"))
    assert.equal(stored.privateKeyCiphertext.includes(stored.publicKey), false)

    const serialized = JSON.stringify(hub)
    assert.equal(serialized.includes("privateKeyCiphertext"), false)
    assert.equal(serialized.includes("Ciphertext"), false)
    assert.equal(serialized.includes("v1:"), false)

    const audit = store.auditEntries.find((e) => e.action === "network_hub.create")
    assert.ok(audit)
    assert.equal(audit.metadata?.privateKey, "[REDACTED]")
  })

  test("createHub requires a network secret key", async () => {
    const store = new TestNetworkStore()
    const fabric = await createFabric(store, globalAdmin, {
      name: "F",
      slug: "hub-key-fabric",
      overlayIpv4Cidr: "10.20.0.0/16",
      overlayIpv6Cidr: "fd00:dead:beef::/48",
    })
    await assert.rejects(
      createHub(store, globalAdmin, { fabricId: fabric.id, name: "hub", listenPort: 51820, endpointHost: "hub.internal" }, {}),
      Error
    )
  })

  test("createPeer generates keypair/PSK, encrypts, validates overlay addresses, never returns secrets", async () => {
    const store = new TestNetworkStore()
    const fabric = await createFabric(store, globalAdmin, {
      name: "F",
      slug: "peer-fabric",
      overlayIpv4Cidr: "10.20.0.0/16",
      overlayIpv6Cidr: "fd00:dead:beef::/48",
    })
    const peer = await createPeer(
      store,
      globalAdmin,
      {
        fabricId: fabric.id,
        name: "anvilwg0",
        endpointId: "endpoint-1",
        overlayIpv4Address: "10.20.0.2",
        overlayIpv6Address: "fd00:dead:beef::2",
        generatePresharedKey: true,
      },
      env
    )
    assert.equal(peer.name, "anvilwg0")
    assert.equal(peer.publicKey.length, 44)
    assert.equal(peer.privateKeyConfigured, true)
    assert.equal(peer.presharedKeyConfigured, true)

    const stored = store.peers.get(peer.id)
    assert.ok(stored)
    assert.ok(stored.privateKeyCiphertext.startsWith("v1:"))
    assert.ok(stored.presharedKeyCiphertext?.startsWith("v1:"))

    const serialized = JSON.stringify(peer)
    assert.equal(serialized.includes("privateKeyCiphertext"), false)
    assert.equal(serialized.includes("presharedKeyCiphertext"), false)
    assert.equal(serialized.includes("Ciphertext"), false)
    assert.equal(serialized.includes("v1:"), false)

    const audit = store.auditEntries.find((e) => e.action === "network_peer.create")
    assert.ok(audit)
    assert.equal(audit.metadata?.privateKey, "[REDACTED]")
    assert.equal(audit.metadata?.presharedKey, "[REDACTED]")
  })

  test("createPeer rejects overlay addresses outside the fabric", async () => {
    const store = new TestNetworkStore()
    const fabric = await createFabric(store, globalAdmin, {
      name: "F",
      slug: "peer-bad-fabric",
      overlayIpv4Cidr: "10.20.0.0/16",
      overlayIpv6Cidr: "fd00:dead:beef::/48",
    })
    await assert.rejects(
      createPeer(store, globalAdmin, { fabricId: fabric.id, name: "p", overlayIpv4Address: "10.30.0.2" }, env),
      NetworkInvariantError
    )
  })

  test("createPeer rejects duplicate overlay addresses within the fabric", async () => {
    const store = new TestNetworkStore()
    const fabric = await createFabric(store, globalAdmin, {
      name: "F",
      slug: "peer-dup-addr-fabric",
      overlayIpv4Cidr: "10.20.0.0/16",
      overlayIpv6Cidr: "fd00:dead:beef::/48",
    })
    await createPeer(store, globalAdmin, { fabricId: fabric.id, name: "anvilwg0", overlayIpv4Address: "10.20.0.2", overlayIpv6Address: "fd00:dead:beef::2" }, env)
    await assert.rejects(
      createPeer(store, globalAdmin, { fabricId: fabric.id, name: "anvilwg1", overlayIpv4Address: "10.20.0.2" }, env),
      NetworkDuplicatePeerAddressError
    )
    await assert.rejects(
      createPeer(store, globalAdmin, { fabricId: fabric.id, name: "anvilwg2", overlayIpv6Address: "fd00:dead:beef::2" }, env),
      NetworkDuplicatePeerAddressError
    )
    // A different address is accepted.
    const peer = await createPeer(store, globalAdmin, { fabricId: fabric.id, name: "anvilwg3", overlayIpv4Address: "10.20.0.4" }, env)
    assert.equal(peer.overlayIpv4Address, "10.20.0.4")
  })

  test("createPrefix and createPool validate CIDRs against the fabric overlay", async () => {
    const store = new TestNetworkStore()
    const fabric = await createFabric(store, globalAdmin, {
      name: "F",
      slug: "prefix-pool-fabric",
      overlayIpv4Cidr: "10.20.0.0/16",
      overlayIpv6Cidr: "fd00:dead:beef::/48",
    })
    const prefix = await createPrefix(store, globalAdmin, { fabricId: fabric.id, kind: "SUBNET", cidr: "10.20.30.0/24" })
    assert.equal(prefix.family, 4)
    await assert.rejects(
      createPrefix(store, globalAdmin, { fabricId: fabric.id, kind: "SUBNET", cidr: "10.30.0.0/24" }),
      NetworkInvariantError
    )

    const pool = await createPool(store, globalAdmin, { projectId: "project-1", fabricId: fabric.id, ipv4Cidr: "10.20.40.0/24" })
    assert.equal(pool.projectId, "project-1")
    await assert.rejects(
      createPool(store, globalAdmin, { projectId: "project-1", fabricId: fabric.id, ipv4Cidr: "10.30.0.0/24" }),
      NetworkInvariantError
    )
  })

  test("updatePool updates and rejects out-of-overlay CIDRs", async () => {
    const store = new TestNetworkStore()
    const fabric = await createFabric(store, globalAdmin, {
      name: "F",
      slug: "pool-update-fabric",
      overlayIpv4Cidr: "10.20.0.0/16",
      overlayIpv6Cidr: "fd00:dead:beef::/48",
    })
    const pool = await createPool(store, globalAdmin, { projectId: "project-1", fabricId: fabric.id, ipv4Cidr: "10.20.40.0/24" })
    const updated = await updatePool(store, globalAdmin, pool.id, { allocationMode: "DYNAMIC" })
    assert.equal(updated.allocationMode, "DYNAMIC")
    await assert.rejects(updatePool(store, globalAdmin, pool.id, { ipv4Cidr: "10.30.0.0/24" }), NetworkInvariantError)
    await assert.rejects(updatePool(store, globalAdmin, "missing", { allocationMode: "STATIC" }), NetworkPoolNotFoundError)
    assert.deepEqual(await listProjectPools(store, globalAdmin), [updated])
  })
})

describe("network sync and apply over agent protocol", () => {
  test("syncFabric fans out, persists snapshot, writes audit, returns browser-safe summaries", async () => {
    const store = new TestNetworkStore()
    const fabric = await createFabric(store, globalAdmin, {
      name: "F",
      slug: "sync-fabric",
      overlayIpv4Cidr: "10.20.0.0/16",
      overlayIpv6Cidr: "fd00:dead:beef::/48",
    })
    store.addEndpoint({ id: "endpoint-1", name: "host-1", url: "ws://127.0.0.1:19090/ws", tokenCiphertext: undefined, status: "ACTIVE", teamId: "team-1" })
    await createPeer(store, globalAdmin, { fabricId: fabric.id, name: "anvilwg0", endpointId: "endpoint-1", overlayIpv4Address: "10.20.0.2" }, env)

    const agent = new FakeNetworkAgentClient()
    agent.queueNetworkState({ agentId: "agent-uuid-1", wireGuardAvailable: true })
    const result = await syncFabric(store, globalAdmin, fabric.id, { env, createAgentClient: () => agent, now: () => now })

    assert.equal(result.fabricId, fabric.id)
    assert.equal(result.endpoints.length, 1)
    assert.equal(result.endpoints[0]?.status, "SYNCED")
    assert.equal(result.endpoints[0]?.snapshot?.wireGuardAvailable, true)
    assert.equal(result.endpoints[0]?.snapshot?.agentId, "agent-uuid-1")
    assert.equal(store.snapshots.get("endpoint-1")?.managedInterfaceCount, 1)

    const audit = store.auditEntries.find((e) => e.action === "network.sync")
    assert.ok(audit)
    assert.equal(audit.metadata?.synced, 1)

    const serialized = JSON.stringify(result)
    assert.equal(serialized.includes("privateKey"), false)
    assert.equal(serialized.includes("presharedKey"), false)
  })

  test("syncFabric maps agent unavailable to 503 and malformed to 502", async () => {
    const store = new TestNetworkStore()
    const fabric = await createFabric(store, globalAdmin, {
      name: "F",
      slug: "sync-err-fabric",
      overlayIpv4Cidr: "10.20.0.0/16",
      overlayIpv6Cidr: "fd00:dead:beef::/48",
    })
    store.addEndpoint({ id: "endpoint-1", name: "host-1", url: "ws://x/ws", tokenCiphertext: undefined, status: "ACTIVE", teamId: "team-1" })
    await createPeer(store, globalAdmin, { fabricId: fabric.id, name: "anvilwg0", endpointId: "endpoint-1" }, env)

    const unavailable = new FakeNetworkAgentClient()
    unavailable.nextError = new NetworkAgentUnavailableError()
    await assert.rejects(
      syncFabric(store, globalAdmin, fabric.id, { env, createAgentClient: () => unavailable, now: () => now }),
      NetworkAgentUnavailableError
    )

    const malformed = new FakeNetworkAgentClient()
    malformed.queueResponse({ status: 200, body: "not-an-object" })
    await assert.rejects(
      syncFabric(store, globalAdmin, fabric.id, { env, createAgentClient: () => malformed, now: () => now }),
      NetworkMalformedAgentResponseError
    )
  })

  test("syncFabric requires network:apply, not network:read", async () => {
    const store = new TestNetworkStore()
    const fabric = await createFabric(store, globalAdmin, {
      name: "F",
      slug: "sync-perm-fabric",
      overlayIpv4Cidr: "10.20.0.0/16",
      overlayIpv6Cidr: "fd00:dead:beef::/48",
    })
    store.addEndpoint({ id: "endpoint-1", name: "host-1", url: "ws://x/ws", tokenCiphertext: undefined, status: "ACTIVE", teamId: "team-1" })
    await createPeer(store, globalAdmin, { fabricId: fabric.id, name: "anvilwg0", endpointId: "endpoint-1" }, env)
    await assert.rejects(syncFabric(store, member, fabric.id, { env, now: () => now }), NetworkPermissionDeniedError)
  })

  test("syncFabric returns 200 with summaries when at least one endpoint syncs", async () => {
    const store = new TestNetworkStore()
    const fabric = await createFabric(store, globalAdmin, {
      name: "F",
      slug: "sync-partial-fabric",
      overlayIpv4Cidr: "10.20.0.0/16",
      overlayIpv6Cidr: "fd00:dead:beef::/48",
    })
    store.addEndpoint({ id: "endpoint-1", name: "host-1", url: "ws://x/ws", tokenCiphertext: undefined, status: "ACTIVE", teamId: "team-1" })
    store.addEndpoint({ id: "endpoint-2", name: "host-2", url: "ws://x/ws", tokenCiphertext: undefined, status: "ACTIVE", teamId: "team-1" })
    await createPeer(store, globalAdmin, { fabricId: fabric.id, name: "anvilwg0", endpointId: "endpoint-1", overlayIpv4Address: "10.20.0.2" }, env)
    await createPeer(store, globalAdmin, { fabricId: fabric.id, name: "anvilwg1", endpointId: "endpoint-2", overlayIpv4Address: "10.20.0.3" }, env)

    const agent = new FakeNetworkAgentClient()
    agent.queueNetworkState({ agentId: "agent-1" })
    const failing = new FakeNetworkAgentClient()
    failing.nextError = new NetworkAgentUnavailableError()
    let call = 0
    const routes0 = { env, createAgentClient: () => (call++ === 0 ? agent : failing), now: () => now }
    const result = await syncFabric(store, globalAdmin, fabric.id, routes0)
    assert.equal(result.endpoints.length, 2)
    assert.equal(result.endpoints.some((e) => e.status === "SYNCED"), true)
    assert.equal(result.endpoints.some((e) => e.status === "FAILED"), true)
  })

  test("syncFabric rejects archived fabric and missing fabric", async () => {
    const store = new TestNetworkStore()
    const fabric = await createFabric(store, globalAdmin, {
      name: "F",
      slug: "sync-arch-fabric",
      overlayIpv4Cidr: "10.20.0.0/16",
      overlayIpv6Cidr: "fd00:dead:beef::/48",
    })
    await archiveFabric(store, globalAdmin, fabric.id)
    await assert.rejects(syncFabric(store, globalAdmin, fabric.id, { env, now: () => now }), NetworkFabricArchivedError)
    await assert.rejects(syncFabric(store, globalAdmin, "missing", { env, now: () => now }), NetworkFabricNotFoundError)
  })

  test("applyFabric dry-run calls agent apply, records operation, does not mutate host state, redacts", async () => {
    const store = new TestNetworkStore()
    const fabric = await createFabric(store, globalAdmin, {
      name: "F",
      slug: "apply-fabric",
      overlayIpv4Cidr: "10.20.0.0/16",
      overlayIpv6Cidr: "fd00:dead:beef::/48",
    })
    await createHub(store, globalAdmin, { fabricId: fabric.id, name: "hub", listenPort: 51820, endpointHost: "hub.internal" }, env)
    store.addEndpoint({ id: "endpoint-1", name: "host-1", url: "ws://x/ws", tokenCiphertext: undefined, status: "ACTIVE", teamId: "team-1" })
    await createPeer(store, globalAdmin, { fabricId: fabric.id, name: "anvilwg0", endpointId: "endpoint-1", overlayIpv4Address: "10.20.0.2" }, env)
    await createPeer(store, globalAdmin, { fabricId: fabric.id, name: "anvilwg1", overlayIpv4Address: "10.20.0.3" }, env)

    const agent = new FakeNetworkAgentClient()
    agent.queueApplyResponse({ status: 200, summary: "validated anvilwg0 with 1 peer(s); dry-run, no host mutation" })
    const result = await applyFabric(store, globalAdmin, fabric.id, "DRY_RUN", { env, createAgentClient: () => agent, now: () => now })

    assert.equal(result.mode, "DRY_RUN")
    assert.equal(result.status, "SUCCEEDED")
    assert.equal(result.endpoints[0]?.status, "OK")
    assert.ok(result.operationId)

    const op = store.applyOperations.get(result.operationId)
    assert.ok(op)
    assert.equal(op.mode, "DRY_RUN")
    assert.equal(op.status, "SUCCEEDED")

    const audit = store.auditEntries.find((e) => e.action === "network.dry_run")
    assert.ok(audit)
    assert.equal(audit.metadata?.operationId, result.operationId)

    // The agent received an apply request with the peer interface and other-peer allowed IPs.
    const applyReq = agent.applyRequests[0]
    assert.ok(applyReq)
    assert.equal(applyReq.body.mode, "DRY_RUN")
    assert.equal(applyReq.body.interface.name, "anvilwg0")
    assert.equal(applyReq.body.interface.listenPort, 51820)
    assert.equal(applyReq.body.peers.length, 1)
    assert.equal(applyReq.body.peers[0].allowedIps.includes("10.20.0.3/32"), true)

    const serialized = JSON.stringify(result)
    assert.equal(serialized.includes("privateKey"), false)
    assert.equal(serialized.includes("presharedKey"), false)
  })

  test("applyFabric renders decrypted peer PSKs into the agent apply request and redacts responses", async () => {
    const store = new TestNetworkStore()
    const fabric = await createFabric(store, globalAdmin, {
      name: "F",
      slug: "apply-psk-fabric",
      overlayIpv4Cidr: "10.20.0.0/16",
      overlayIpv6Cidr: "fd00:dead:beef::/48",
    })
    store.addEndpoint({ id: "endpoint-1", name: "host-1", url: "ws://x/ws", tokenCiphertext: undefined, status: "ACTIVE", teamId: "team-1" })
    await createPeer(store, globalAdmin, { fabricId: fabric.id, name: "anvilwg0", endpointId: "endpoint-1", overlayIpv4Address: "10.20.0.2" }, env)
    // anvilwg1 carries an encrypted PSK generated server-side.
    await createPeer(store, globalAdmin, { fabricId: fabric.id, name: "anvilwg1", overlayIpv4Address: "10.20.0.3", generatePresharedKey: true }, env)

    const agent = new FakeNetworkAgentClient()
    agent.queueApplyResponse({ status: 200 })
    const result = await applyFabric(store, globalAdmin, fabric.id, "DRY_RUN", { env, createAgentClient: () => agent, now: () => now })

    const applyReq = agent.applyRequests[0]
    assert.ok(applyReq)
    const remotePeer = applyReq.body.peers.find((p: { publicKey: string }) => p.publicKey !== "")
    assert.ok(remotePeer)
    // The remote peer entry must carry the decrypted preshared key for the agent.
    assert.ok((remotePeer as { presharedKey?: string }).presharedKey, "expected decrypted presharedKey in agent apply request")
    assert.equal((remotePeer as { presharedKey?: string }).presharedKey?.length, 44)

    // The backend response and audit must never include the PSK material.
    const serialized = JSON.stringify(result)
    assert.equal(serialized.includes("presharedKey"), false)
    assert.equal(serialized.includes("privateKey"), false)
    const audit = store.auditEntries.find((e) => e.action === "network.dry_run")
    assert.ok(audit)
    assert.equal(JSON.stringify(audit).includes("presharedKey"), false)
  })

  test("applyFabric apply mode records FAILED operation when agent rejects", async () => {
    const store = new TestNetworkStore()
    const fabric = await createFabric(store, globalAdmin, {
      name: "F",
      slug: "apply-fail-fabric",
      overlayIpv4Cidr: "10.20.0.0/16",
      overlayIpv6Cidr: "fd00:dead:beef::/48",
    })
    store.addEndpoint({ id: "endpoint-1", name: "host-1", url: "ws://x/ws", tokenCiphertext: undefined, status: "ACTIVE", teamId: "team-1" })
    await createPeer(store, globalAdmin, { fabricId: fabric.id, name: "anvilwg0", endpointId: "endpoint-1", overlayIpv4Address: "10.20.0.2" }, env)

    const agent = new FakeNetworkAgentClient()
    agent.queueApplyResponse({ status: 400 })
    const result = await applyFabric(store, globalAdmin, fabric.id, "APPLY", { env, createAgentClient: () => agent, now: () => now })
    assert.equal(result.status, "FAILED")
    assert.equal(result.endpoints[0]?.status, "FAILED")
    assert.equal(store.applyOperations.get(result.operationId)?.status, "FAILED")
  })

  test("applyFabric rejects duplicate peer public keys and archived fabric", async () => {
    const store = new TestNetworkStore()
    const fabric = await createFabric(store, globalAdmin, {
      name: "F",
      slug: "apply-dup-fabric",
      overlayIpv4Cidr: "10.20.0.0/16",
      overlayIpv6Cidr: "fd00:dead:beef::/48",
    })
    store.addEndpoint({ id: "endpoint-1", name: "host-1", url: "ws://x/ws", tokenCiphertext: undefined, status: "ACTIVE", teamId: "team-1" })
    await createPeer(store, globalAdmin, { fabricId: fabric.id, name: "anvilwg0", endpointId: "endpoint-1", overlayIpv4Address: "10.20.0.2" }, env)
    // Force a duplicate public key by inserting a peer with the same key as an existing one.
    const existing = [...store.peers.values()][0]!
    store.peers.set("peer-dup", { ...existing, id: "peer-dup", name: "dup" })

    await assert.rejects(applyFabric(store, globalAdmin, fabric.id, "DRY_RUN", { env, now: () => now }), NetworkInvariantError)

    const archivedFabric = await createFabric(store, globalAdmin, {
      name: "F2",
      slug: "apply-arch-fabric",
      overlayIpv4Cidr: "10.40.0.0/16",
      overlayIpv6Cidr: "fd02::/48",
    })
    await archiveFabric(store, globalAdmin, archivedFabric.id)
    await assert.rejects(applyFabric(store, globalAdmin, archivedFabric.id, "DRY_RUN", { env, now: () => now }), NetworkFabricArchivedError)
  })
})

describe("network key generation", () => {
  test("generateWireGuardKeyPair returns 44-char base64 keys", () => {
    const pair = generateWireGuardKeyPair()
    assert.equal(pair.publicKey.length, 44)
    assert.equal(pair.privateKey.length, 44)
    assert.notEqual(pair.publicKey, pair.privateKey)
  })
})

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface TestEndpoint {
  id: string
  name: string
  url: string
  tokenCiphertext: string | undefined
  status: "ACTIVE" | "ARCHIVED"
  teamId: string
}

class TestNetworkStore implements NetworkAdminStore {
  readonly fabrics = new Map<string, PersistedNetworkFabric>()
  readonly hubs = new Map<string, PersistedWireGuardHub>()
  readonly peers = new Map<string, PersistedHostNetworkPeer>()
  readonly prefixes = new Map<string, PersistedFabricPrefix>()
  readonly pools = new Map<string, PersistedProjectNetworkPool>()
  readonly snapshots = new Map<string, { managedInterfaceCount: number; agentId: string }>()
  readonly applyOperations = new Map<string, PersistedNetworkApplyOperation>()
  readonly endpoints = new Map<string, TestEndpoint>()
  readonly auditEntries: AdminAuditEntry[] = []
  private counter = 1
  private opCounter = 1

  async listFabrics(): Promise<PersistedNetworkFabric[]> {
    return [...this.fabrics.values()].sort((a, b) => a.name.localeCompare(b.name))
  }
  async getFabric(fabricId: string): Promise<PersistedNetworkFabric | null> {
    return this.fabrics.get(fabricId) ?? null
  }
  async getFabricDetail(fabricId: string) {
    const fabric = this.fabrics.get(fabricId)
    if (!fabric) return null
    return {
      fabric,
      hubs: [...this.hubs.values()].filter((h) => h.fabricId === fabricId),
      peers: [...this.peers.values()].filter((p) => p.fabricId === fabricId),
      prefixes: [...this.prefixes.values()].filter((p) => p.fabricId === fabricId),
      pools: [...this.pools.values()].filter((p) => p.fabricId === fabricId),
    }
  }
  async findFabricBySlug(slug: string): Promise<PersistedNetworkFabric | null> {
    return [...this.fabrics.values()].find((f) => f.slug === slug) ?? null
  }
  async createFabric(input: PersistedNetworkFabric & { status?: string }): Promise<PersistedNetworkFabric> {
    const id = `fabric-${this.counter++}`
    const fabric: PersistedNetworkFabric = {
      id,
      name: input.name,
      slug: input.slug,
      status: (input.status as PersistedNetworkFabric["status"]) ?? "PLANNED",
      mode: input.mode,
      overlayIpv4Cidr: input.overlayIpv4Cidr,
      overlayIpv6Cidr: input.overlayIpv6Cidr,
      createdAt: now,
      updatedAt: now,
    }
    this.fabrics.set(id, fabric)
    return fabric
  }
  async updateFabric(fabricId: string, data: Partial<PersistedNetworkFabric>): Promise<PersistedNetworkFabric> {
    const fabric = this.fabrics.get(fabricId)!
    const updated = { ...fabric, ...stripUndefined(data), updatedAt: now }
    this.fabrics.set(fabricId, updated)
    return updated
  }
  async setFabricStatus(fabricId: string, status: PersistedNetworkFabric["status"]): Promise<PersistedNetworkFabric> {
    const fabric = this.fabrics.get(fabricId)!
    const updated = { ...fabric, status, updatedAt: now }
    this.fabrics.set(fabricId, updated)
    return updated
  }
  async countActiveFabricChildren(fabricId: string) {
    return {
      hubs: [...this.hubs.values()].filter((h) => h.fabricId === fabricId && h.status !== "ARCHIVED").length,
      peers: [...this.peers.values()].filter((p) => p.fabricId === fabricId && p.status !== "ARCHIVED").length,
      pools: [...this.pools.values()].filter((p) => p.fabricId === fabricId && p.status !== "ARCHIVED").length,
    }
  }
  async createHub(input: PersistedWireGuardHub & { status?: string }): Promise<PersistedWireGuardHub> {
    const id = `hub-${this.counter++}`
    const hub: PersistedWireGuardHub = {
      id,
      fabricId: input.fabricId,
      name: input.name,
      status: (input.status as PersistedWireGuardHub["status"]) ?? "PLANNED",
      listenPort: input.listenPort,
      endpointHost: input.endpointHost,
      publicKey: input.publicKey,
      privateKeyCiphertext: input.privateKeyCiphertext,
      presharedKeyMode: input.presharedKeyMode,
      createdAt: now,
      updatedAt: now,
    }
    this.hubs.set(id, hub)
    return hub
  }
  async createPeer(input: PersistedHostNetworkPeer & { status?: string }): Promise<PersistedHostNetworkPeer> {
    const id = `peer-${this.counter++}`
    const peer: PersistedHostNetworkPeer = {
      id,
      fabricId: input.fabricId,
      endpointId: input.endpointId,
      name: input.name,
      status: (input.status as PersistedHostNetworkPeer["status"]) ?? "PLANNED",
      role: input.role,
      publicKey: input.publicKey,
      privateKeyCiphertext: input.privateKeyCiphertext,
      presharedKeyCiphertext: input.presharedKeyCiphertext,
      overlayIpv4Address: input.overlayIpv4Address,
      overlayIpv6Address: input.overlayIpv6Address,
      createdAt: now,
      updatedAt: now,
    }
    this.peers.set(id, peer)
    return peer
  }
  async createPrefix(input: PersistedFabricPrefix & { status?: string }): Promise<PersistedFabricPrefix> {
    const id = `prefix-${this.counter++}`
    const prefix: PersistedFabricPrefix = {
      id,
      fabricId: input.fabricId,
      kind: input.kind,
      cidr: input.cidr,
      family: input.family,
      status: (input.status as PersistedFabricPrefix["status"]) ?? "ACTIVE",
      ownerPeerId: input.ownerPeerId,
      createdAt: now,
      updatedAt: now,
    }
    this.prefixes.set(id, prefix)
    return prefix
  }
  async listProjectPools(): Promise<PersistedProjectNetworkPool[]> {
    return [...this.pools.values()].sort((a, b) => a.projectId.localeCompare(b.projectId))
  }
  async findPoolById(poolId: string): Promise<PersistedProjectNetworkPool | null> {
    return this.pools.get(poolId) ?? null
  }
  async createPool(input: PersistedProjectNetworkPool & { status?: string }): Promise<PersistedProjectNetworkPool> {
    const id = `pool-${this.counter++}`
    const pool: PersistedProjectNetworkPool = {
      id,
      projectId: input.projectId,
      fabricId: input.fabricId,
      ipv4Cidr: input.ipv4Cidr,
      ipv6Cidr: input.ipv6Cidr,
      status: (input.status as PersistedProjectNetworkPool["status"]) ?? "ACTIVE",
      allocationMode: input.allocationMode,
      createdAt: now,
      updatedAt: now,
    }
    this.pools.set(id, pool)
    return pool
  }
  async updatePool(poolId: string, data: Partial<PersistedProjectNetworkPool>): Promise<PersistedProjectNetworkPool> {
    const pool = this.pools.get(poolId)!
    const updated = { ...pool, ...stripUndefined(data), updatedAt: now }
    this.pools.set(poolId, updated)
    return updated
  }
  async getFabricPeersWithEndpoints(fabricId: string): Promise<FabricPeerEndpoint[]> {
    const result: FabricPeerEndpoint[] = []
    for (const peer of [...this.peers.values()].filter((p) => p.fabricId === fabricId && p.status !== "ARCHIVED")) {
      if (!peer.endpointId) continue
      const endpoint = this.endpoints.get(peer.endpointId)
      if (!endpoint) continue
      result.push({
        peer,
        endpoint: {
          id: endpoint.id,
          name: endpoint.name,
          url: endpoint.url,
          tokenCiphertext: endpoint.tokenCiphertext ?? null,
          status: endpoint.status,
          teamId: endpoint.teamId,
        },
      })
    }
    return result.sort((a, b) => a.peer.name.localeCompare(b.peer.name))
  }
  async findActivePeerWithOverlayAddress(
    fabricId: string,
    overlayIpv4Address: string | null,
    overlayIpv6Address: string | null
  ): Promise<PersistedHostNetworkPeer | null> {
    if (!overlayIpv4Address && !overlayIpv6Address) {
      return null
    }
    return (
      [...this.peers.values()].find(
        (p) =>
          p.fabricId === fabricId &&
          p.status !== "ARCHIVED" &&
          ((overlayIpv4Address !== null && p.overlayIpv4Address === overlayIpv4Address) ||
            (overlayIpv6Address !== null && p.overlayIpv6Address === overlayIpv6Address))
      ) ?? null
    )
  }
  async upsertNetworkStateSnapshot(input: {
    endpointId: string
    managedInterfaceCount: number
    agentId: string
    stateSchemaVersion: number
    observedAt: string
    wireGuardAvailable: boolean
    ipCommandAvailable: boolean
    iptablesAvailable: boolean
    ip6tablesAvailable: boolean
    ipv4Forwarding: boolean
    ipv6Forwarding: boolean
    status: string
    fabricId: string | null
  }) {
    this.snapshots.set(input.endpointId, { managedInterfaceCount: input.managedInterfaceCount, agentId: input.agentId })
    return {
      id: `snapshot-${input.endpointId}`,
      endpointId: input.endpointId,
      fabricId: input.fabricId,
      agentId: input.agentId,
      stateSchemaVersion: input.stateSchemaVersion,
      observedAt: input.observedAt,
      wireGuardAvailable: input.wireGuardAvailable,
      ipCommandAvailable: input.ipCommandAvailable,
      iptablesAvailable: input.iptablesAvailable,
      ip6tablesAvailable: input.ip6tablesAvailable,
      forwarding: { ipv4: input.ipv4Forwarding, ipv6: input.ipv6Forwarding },
      managedInterfaceCount: input.managedInterfaceCount,
      status: input.status,
    }
  }
  async createApplyOperation(input: PersistedNetworkApplyOperation): Promise<PersistedNetworkApplyOperation> {
    const id = `op-${this.opCounter++}`
    const op: PersistedNetworkApplyOperation = {
      id,
      targetType: input.targetType,
      targetId: input.targetId,
      mode: input.mode,
      status: input.status,
      requestedByUserId: input.requestedByUserId,
      summary: input.summary,
      errorSummary: input.errorSummary,
      createdAt: now,
      updatedAt: now,
    }
    this.applyOperations.set(id, op)
    return op
  }
  async recordAudit(entry: AdminAuditEntry): Promise<void> {
    this.auditEntries.push(entry)
  }

  addEndpoint(endpoint: TestEndpoint): void {
    this.endpoints.set(endpoint.id, endpoint)
  }
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  const result: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(value)) {
    if (val !== undefined) result[key] = val
  }
  return result as Partial<T>
}

interface QueuedAgentApplyRequest {
  method: string
  path: string
  body: { mode: string; interface: { name: string; listenPort: number; addresses: string[] }; peers: Array<{ publicKey: string; allowedIps: string[] }>; routing: { ipv4Forwarding: boolean; ipv6Forwarding: boolean } }
}

class FakeNetworkAgentClient implements NetworkAgentClient {
  private responses: AgentResponse[] = []
  private stateBodies: unknown[] = []
  nextError?: Error
  readonly applyRequests: QueuedAgentApplyRequest[] = []

  queueNetworkState(input: { agentId: string; wireGuardAvailable?: boolean }): void {
    this.stateBodies.push({
      agent: { id: input.agentId, stateSchemaVersion: 1 },
      network: {
        wireGuardAvailable: input.wireGuardAvailable ?? true,
        ipCommandAvailable: true,
        iptablesAvailable: true,
        ip6tablesAvailable: true,
        forwarding: { ipv4: true, ipv6: true },
        managedInterfaces: [{ name: "anvilwg0" }],
      },
    })
  }
  queueResponse(response: Omit<AgentResponse, "id">): void {
    this.responses.push({ id: "resp", ...response })
  }
  queueApplyResponse(response: { status: number; summary?: string }): void {
    this.responses.push({
      id: "resp",
      status: response.status,
      body: response.status < 300 ? { mode: "DRY_RUN", status: "VALIDATED", summary: response.summary ?? "ok" } : undefined,
      error: response.status >= 300 ? "apply request rejected by agent" : undefined,
    })
  }

  async execute(request: AgentRequest): Promise<AgentResponse> {
    if (this.nextError) {
      const err = this.nextError
      this.nextError = undefined
      throw err
    }
    if (request.method === "GET" && request.path === "/agent/v1/network/state") {
      const body = this.stateBodies.shift()
      return { id: "resp", status: 200, body }
    }
    if (request.method === "POST" && request.path === "/agent/v1/network/apply") {
      this.applyRequests.push(request as unknown as QueuedAgentApplyRequest)
      const queued = this.responses.shift()
      if (queued) {
        queued.id = "resp"
        return queued
      }
      return { id: "resp", status: 200, body: { mode: "DRY_RUN", status: "VALIDATED", summary: "ok" } }
    }
    return { id: "resp", status: 404, error: "not found" }
  }
  close?(): void {}
}
