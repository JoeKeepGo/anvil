import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createNetworkRoutes } from "./network"
import { signAdminSession } from "../../services/admin/session"
import type {
  AdminAuditEntry,
  AdminDataStore,
  AdminPrincipal,
  CreateBootstrapAdminRecord,
} from "../../services/admin/session"
import { AgentConnectionError } from "../../services/agent"
import type { AgentRequest, AgentResponse } from "../../services/agent"
import type {
  FabricPeerEndpoint,
  NetworkAdminStore,
  NetworkAgentClient,
} from "../../services/admin/network"
import type {
  PersistedFabricPrefix,
  PersistedHostNetworkPeer,
  PersistedNetworkApplyOperation,
  PersistedNetworkFabric,
  PersistedProjectNetworkPool,
  PersistedWireGuardHub,
} from "../../services/admin/networkModels"

const sessionSecret = "test-session-secret-with-enough-entropy"
const networkSecretKey = "m12-phase4-network-secret-key-with-enough-entropy"
const env = {
  ANVIL_SESSION_SECRET: sessionSecret,
  ANVIL_NETWORK_SECRET_KEY: networkSecretKey,
}

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

function sessionCookie(principal: AdminPrincipal): string {
  return `anvil_session=${signAdminSession({ ANVIL_SESSION_SECRET: sessionSecret }, principal)}`
}

async function readJson(response: Response): Promise<unknown> {
  return response.json()
}

function jsonHeaders(cookie: string): Record<string, string> {
  return { cookie, "content-type": "application/json" }
}

describe("admin network routes", () => {
  test("requires authentication before network read/apply", async () => {
    const routes = createNetworkRoutes({
      env,
      sessionStore: new TestSessionStore(globalAdmin),
      networkStore: new FakeNetworkStore(),
    })

    const listRes = await routes.request("/fabrics")
    assert.equal(listRes.status, 401)

    const applyRes = await routes.request("/fabrics/fabric-1/apply", { method: "POST" })
    assert.equal(applyRes.status, 401)
  })

  test("denies members without network permissions", async () => {
    const store = new FakeNetworkStore()
    const routes = createNetworkRoutes({
      env,
      sessionStore: new TestSessionStore(member),
      networkStore: store,
    })

    const readRes = await routes.request("/fabrics", { headers: { cookie: sessionCookie(member) } })
    assert.equal(readRes.status, 403)
    assert.deepEqual(await readJson(readRes), {
      error: { code: "ADMIN_FORBIDDEN", message: "Admin network permission denied.", details: {} },
    })

    const writeRes = await routes.request("/fabrics", {
      method: "POST",
      headers: jsonHeaders(sessionCookie(member)),
      body: JSON.stringify({ name: "F", slug: "f", overlayIpv4Cidr: "10.20.0.0/16", overlayIpv6Cidr: "fd00::/48" }),
    })
    assert.equal(writeRes.status, 403)

    const applyRes = await routes.request("/fabrics/fabric-1/apply", {
      method: "POST",
      headers: { cookie: sessionCookie(member) },
    })
    assert.equal(applyRes.status, 403)

    const syncRes = await routes.request("/fabrics/fabric-1/sync", {
      method: "POST",
      headers: { cookie: sessionCookie(member) },
    })
    assert.equal(syncRes.status, 403)
  })

  test("admin fabric CRUD contract with safe responses", async () => {
    const store = new FakeNetworkStore()
    const routes = createNetworkRoutes({
      env,
      sessionStore: new TestSessionStore(globalAdmin),
      networkStore: store,
    })

    const createRes = await routes.request("/fabrics", {
      method: "POST",
      headers: jsonHeaders(sessionCookie(globalAdmin)),
      body: JSON.stringify({ name: "Primary Fabric", slug: "primary-fabric", overlayIpv4Cidr: "10.20.0.0/16", overlayIpv6Cidr: "fd00:dead:beef::/48" }),
    })
    assert.equal(createRes.status, 201)
    const created = (await readJson(createRes)) as { fabric: { id: string; slug: string; status: string } }
    assert.equal(created.fabric.slug, "primary-fabric")
    assert.equal(created.fabric.status, "PLANNED")
    const fabricId = created.fabric.id

    const listRes = await routes.request("/fabrics", { headers: { cookie: sessionCookie(globalAdmin) } })
    assert.equal(listRes.status, 200)
    const listed = (await readJson(listRes)) as { fabrics: unknown[] }
    assert.equal(listed.fabrics.length, 1)

    const detailRes = await routes.request(`/fabrics/${fabricId}`, { headers: { cookie: sessionCookie(globalAdmin) } })
    assert.equal(detailRes.status, 200)
    const detail = (await readJson(detailRes)) as { fabric: { hubs: unknown[]; peers: unknown[] } }
    assert.equal(detail.fabric.hubs.length, 0)

    const dupRes = await routes.request("/fabrics", {
      method: "POST",
      headers: jsonHeaders(sessionCookie(globalAdmin)),
      body: JSON.stringify({ name: "Dup", slug: "primary-fabric", overlayIpv4Cidr: "10.30.0.0/16", overlayIpv6Cidr: "fd01::/48" }),
    })
    assert.equal(dupRes.status, 409)

    const missingRes = await routes.request("/fabrics/missing", { headers: { cookie: sessionCookie(globalAdmin) } })
    assert.equal(missingRes.status, 404)
  })

  test("hub create returns browser-safe hub without private key material", async () => {
    const store = new FakeNetworkStore()
    const fabric = await store.seedFabric()
    const routes = createNetworkRoutes({
      env,
      sessionStore: new TestSessionStore(globalAdmin),
      networkStore: store,
    })

    const res = await routes.request(`/fabrics/${fabric.id}/hubs`, {
      method: "POST",
      headers: jsonHeaders(sessionCookie(globalAdmin)),
      body: JSON.stringify({ name: "primary-hub", listenPort: 51820, endpointHost: "hub.internal" }),
    })
    assert.equal(res.status, 201)
    const body = (await readJson(res)) as { hub: { publicKey: string; privateKeyConfigured: boolean } }
    assert.equal(body.hub.publicKey.length, 44)
    assert.equal(body.hub.privateKeyConfigured, true)
    const serialized = JSON.stringify(body)
    assert.equal(serialized.includes("privateKeyCiphertext"), false)
    assert.equal(serialized.includes("v1:"), false)
  })

  test("sync route returns browser-safe summary and calls the agent", async () => {
    const store = new FakeNetworkStore()
    const fabric = await store.seedFabric()
    store.addEndpoint({ id: "endpoint-1", name: "host-1", url: "ws://x/ws", status: "ACTIVE", teamId: "team-1" })
    await store.seedPeer(fabric.id, "anvilwg0", "endpoint-1", "10.20.0.2")
    const agent = new FakeAgentClient()
    agent.queueNetworkState({ agentId: "agent-1" })

    const routes = createNetworkRoutes({
      env,
      sessionStore: new TestSessionStore(globalAdmin),
      networkStore: store,
      createAgentClient: () => agent,
      now: () => now,
    })

    const res = await routes.request(`/fabrics/${fabric.id}/sync`, {
      method: "POST",
      headers: { cookie: sessionCookie(globalAdmin) },
    })
    assert.equal(res.status, 200)
    const body = (await readJson(res)) as { sync: { endpoints: Array<{ status: string; snapshot?: { wireGuardAvailable: boolean } }> } }
    assert.equal(body.sync.endpoints[0]?.status, "SYNCED")
    assert.equal(body.sync.endpoints[0]?.snapshot?.wireGuardAvailable, true)
    assert.equal(store.snapshots.size, 1)
    assert.equal(store.auditEntries.some((e) => e.action === "network.sync"), true)
  })

  test("dry-run route records an operation and redacts the response", async () => {
    const store = new FakeNetworkStore()
    const fabric = await store.seedFabric()
    store.addEndpoint({ id: "endpoint-1", name: "host-1", url: "ws://x/ws", status: "ACTIVE", teamId: "team-1" })
    await store.seedPeer(fabric.id, "anvilwg0", "endpoint-1", "10.20.0.2")
    const agent = new FakeAgentClient()
    agent.queueApplyResponse({ status: 200 })

    const routes = createNetworkRoutes({
      env,
      sessionStore: new TestSessionStore(globalAdmin),
      networkStore: store,
      createAgentClient: () => agent,
      now: () => now,
    })

    const res = await routes.request(`/fabrics/${fabric.id}/dry-run`, {
      method: "POST",
      headers: { cookie: sessionCookie(globalAdmin) },
    })
    assert.equal(res.status, 200)
    const body = (await readJson(res)) as { apply: { mode: string; status: string; operationId: string } }
    assert.equal(body.apply.mode, "DRY_RUN")
    assert.equal(body.apply.status, "SUCCEEDED")
    assert.ok(body.apply.operationId)
    assert.equal(store.applyOperations.size, 1)
    assert.equal(store.auditEntries.some((e) => e.action === "network.dry_run"), true)

    const serialized = JSON.stringify(body)
    assert.equal(serialized.includes("privateKey"), false)
    assert.equal(serialized.includes("presharedKey"), false)
  })

  test("sync maps agent unavailability to 503 at the route", async () => {
    const store = new FakeNetworkStore()
    const fabric = await store.seedFabric()
    store.addEndpoint({ id: "endpoint-1", name: "host-1", url: "ws://x/ws", status: "ACTIVE", teamId: "team-1" })
    await store.seedPeer(fabric.id, "anvilwg0", "endpoint-1", "10.20.0.2")
    const agent = new FakeAgentClient()
    agent.nextThrow = new AgentConnectionError("connection refused")

    const routes = createNetworkRoutes({
      env,
      sessionStore: new TestSessionStore(globalAdmin),
      networkStore: store,
      createAgentClient: () => agent,
      now: () => now,
    })

    const res = await routes.request(`/fabrics/${fabric.id}/sync`, {
      method: "POST",
      headers: { cookie: sessionCookie(globalAdmin) },
    })
    assert.equal(res.status, 503)
    assert.deepEqual(await readJson(res), {
      error: { code: "NETWORK_SYNC_FAILED", message: "Unable to reach network agent.", details: {} },
    })
  })

  test("sync maps malformed agent response to 502 at the route", async () => {
    const store = new FakeNetworkStore()
    const fabric = await store.seedFabric()
    store.addEndpoint({ id: "endpoint-1", name: "host-1", url: "ws://x/ws", status: "ACTIVE", teamId: "team-1" })
    await store.seedPeer(fabric.id, "anvilwg0", "endpoint-1", "10.20.0.2")
    const agent = new FakeAgentClient()
    agent.nextBody = "not-an-object"

    const routes = createNetworkRoutes({
      env,
      sessionStore: new TestSessionStore(globalAdmin),
      networkStore: store,
      createAgentClient: () => agent,
      now: () => now,
    })

    const res = await routes.request(`/fabrics/${fabric.id}/sync`, {
      method: "POST",
      headers: { cookie: sessionCookie(globalAdmin) },
    })
    assert.equal(res.status, 502)
  })

  test("peer create rejects duplicate overlay address with 409", async () => {
    const store = new FakeNetworkStore()
    const fabric = await store.seedFabric()
    const routes = createNetworkRoutes({
      env,
      sessionStore: new TestSessionStore(globalAdmin),
      networkStore: store,
    })

    const first = await routes.request(`/fabrics/${fabric.id}/peers`, {
      method: "POST",
      headers: jsonHeaders(sessionCookie(globalAdmin)),
      body: JSON.stringify({ name: "anvilwg0", overlayIpv4Address: "10.20.0.2" }),
    })
    assert.equal(first.status, 201)

    const dup = await routes.request(`/fabrics/${fabric.id}/peers`, {
      method: "POST",
      headers: jsonHeaders(sessionCookie(globalAdmin)),
      body: JSON.stringify({ name: "anvilwg1", overlayIpv4Address: "10.20.0.2" }),
    })
    assert.equal(dup.status, 409)
  })

  test("invalid fabric body returns 400", async () => {
    const store = new FakeNetworkStore()
    const routes = createNetworkRoutes({
      env,
      sessionStore: new TestSessionStore(globalAdmin),
      networkStore: store,
    })
    const res = await routes.request("/fabrics", {
      method: "POST",
      headers: jsonHeaders(sessionCookie(globalAdmin)),
      body: JSON.stringify({ name: "F" }),
    })
    assert.equal(res.status, 400)
  })
})

class TestSessionStore implements AdminDataStore {
  constructor(private readonly principal: AdminPrincipal) {}
  async isBootstrapComplete(): Promise<boolean> {
    return true
  }
  async createBootstrapAdmin(_record: CreateBootstrapAdminRecord): Promise<AdminPrincipal> {
    throw new Error("not used")
  }
  async findUserByEmail(): Promise<(AdminPrincipal & { passwordHash: string }) | null> {
    return null
  }
  async findUserById(userId: string): Promise<AdminPrincipal | null> {
    return userId === this.principal.id ? this.principal : null
  }
  async recordAudit(): Promise<void> {}
}

interface FakeEndpoint {
  id: string
  name: string
  url: string
  tokenCiphertext: string | null
  status: "ACTIVE" | "ARCHIVED"
  teamId: string
}

class FakeNetworkStore implements NetworkAdminStore {
  readonly fabrics = new Map<string, PersistedNetworkFabric>()
  readonly hubs = new Map<string, PersistedWireGuardHub>()
  readonly peers = new Map<string, PersistedHostNetworkPeer>()
  readonly prefixes = new Map<string, PersistedFabricPrefix>()
  readonly pools = new Map<string, PersistedProjectNetworkPool>()
  readonly snapshots = new Map<string, unknown>()
  readonly applyOperations = new Map<string, PersistedNetworkApplyOperation>()
  readonly endpoints = new Map<string, FakeEndpoint>()
  readonly auditEntries: AdminAuditEntry[] = []
  private counter = 1
  private opCounter = 1

  async seedFabric(): Promise<PersistedNetworkFabric> {
    return this.createFabric({
      name: "Seed Fabric",
      slug: `seed-${this.counter}`,
      mode: "HUB_SPOKE",
      overlayIpv4Cidr: "10.20.0.0/16",
      overlayIpv6Cidr: "fd00:dead:beef::/48",
      status: "ACTIVE",
    })
  }
  async seedPeer(fabricId: string, name: string, endpointId: string, overlayIpv4: string): Promise<PersistedHostNetworkPeer> {
    return this.createPeer({
      fabricId,
      endpointId,
      name,
      role: "MEMBER",
      publicKey: `pub-${name}`,
      privateKeyCiphertext: "v1:encrypted",
      presharedKeyCiphertext: null,
      overlayIpv4Address: overlayIpv4,
      overlayIpv6Address: null,
      status: "PLANNED",
    })
  }
  addEndpoint(ep: Omit<FakeEndpoint, "tokenCiphertext">): void {
    this.endpoints.set(ep.id, { ...ep, tokenCiphertext: null })
  }

  async listFabrics() {
    return [...this.fabrics.values()].sort((a, b) => a.name.localeCompare(b.name))
  }
  async getFabric(id: string) {
    return this.fabrics.get(id) ?? null
  }
  async getFabricDetail(id: string) {
    const fabric = this.fabrics.get(id)
    if (!fabric) return null
    return {
      fabric,
      hubs: [...this.hubs.values()].filter((h) => h.fabricId === id),
      peers: [...this.peers.values()].filter((p) => p.fabricId === id),
      prefixes: [...this.prefixes.values()].filter((p) => p.fabricId === id),
      pools: [...this.pools.values()].filter((p) => p.fabricId === id),
    }
  }
  async findFabricBySlug(slug: string) {
    return [...this.fabrics.values()].find((f) => f.slug === slug) ?? null
  }
  async createFabric(input: Omit<PersistedNetworkFabric, "id" | "createdAt" | "updatedAt"> & { status?: string }) {
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
  async updateFabric(id: string, data: Partial<PersistedNetworkFabric>) {
    const f = this.fabrics.get(id)!
    const u = { ...f, ...stripU(data), updatedAt: now }
    this.fabrics.set(id, u)
    return u
  }
  async setFabricStatus(id: string, status: PersistedNetworkFabric["status"]) {
    const f = this.fabrics.get(id)!
    const u = { ...f, status, updatedAt: now }
    this.fabrics.set(id, u)
    return u
  }
  async countActiveFabricChildren(id: string) {
    return {
      hubs: [...this.hubs.values()].filter((h) => h.fabricId === id && h.status !== "ARCHIVED").length,
      peers: [...this.peers.values()].filter((p) => p.fabricId === id && p.status !== "ARCHIVED").length,
      pools: [...this.pools.values()].filter((p) => p.fabricId === id && p.status !== "ARCHIVED").length,
    }
  }
  async createHub(input: Omit<PersistedWireGuardHub, "id" | "createdAt" | "updatedAt"> & { status?: string }) {
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
  async createPeer(input: Omit<PersistedHostNetworkPeer, "id" | "createdAt" | "updatedAt"> & { status?: string }) {
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
  async createPrefix(input: Omit<PersistedFabricPrefix, "id" | "createdAt" | "updatedAt"> & { status?: string }) {
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
  async listProjectPools() {
    return [...this.pools.values()]
  }
  async findPoolById(id: string) {
    return this.pools.get(id) ?? null
  }
  async createPool(input: Omit<PersistedProjectNetworkPool, "id" | "createdAt" | "updatedAt"> & { status?: string }) {
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
  async updatePool(id: string, data: Partial<PersistedProjectNetworkPool>) {
    const p = this.pools.get(id)!
    const u = { ...p, ...stripU(data), updatedAt: now }
    this.pools.set(id, u)
    return u
  }
  async getFabricPeersWithEndpoints(fabricId: string): Promise<FabricPeerEndpoint[]> {
    const result: FabricPeerEndpoint[] = []
    for (const peer of [...this.peers.values()].filter((p) => p.fabricId === fabricId && p.status !== "ARCHIVED")) {
      if (!peer.endpointId) continue
      const ep = this.endpoints.get(peer.endpointId)
      if (!ep) continue
      result.push({
        peer,
        endpoint: { id: ep.id, name: ep.name, url: ep.url, tokenCiphertext: ep.tokenCiphertext, status: ep.status, teamId: ep.teamId },
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
  async upsertNetworkStateSnapshot(input: { endpointId: string }) {
    this.snapshots.set(input.endpointId, input)
    return {
      id: `snap-${input.endpointId}`,
      endpointId: input.endpointId,
      fabricId: null,
      agentId: "agent-1",
      stateSchemaVersion: 1,
      observedAt: now.toISOString(),
      wireGuardAvailable: true,
      ipCommandAvailable: true,
      iptablesAvailable: true,
      ip6tablesAvailable: true,
      forwarding: { ipv4: true, ipv6: true },
      managedInterfaceCount: 1,
      status: "ONLINE",
    }
  }
  async createApplyOperation(input: PersistedNetworkApplyOperation) {
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
  async recordAudit(entry: AdminAuditEntry) {
    this.auditEntries.push(entry)
  }
}

function stripU<T extends Record<string, unknown>>(value: T): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined) out[k] = v
  }
  return out as Partial<T>
}

class FakeAgentClient implements NetworkAgentClient {
  private states: unknown[] = []
  private applies: AgentResponse[] = []
  nextStatus?: number
  nextThrow?: Error
  nextBody?: unknown
  readonly applyRequests: AgentRequest[] = []

  queueNetworkState(input: { agentId: string }) {
    this.states.push({
      agent: { id: input.agentId, stateSchemaVersion: 1 },
      network: {
        wireGuardAvailable: true,
        ipCommandAvailable: true,
        iptablesAvailable: true,
        ip6tablesAvailable: true,
        forwarding: { ipv4: true, ipv6: true },
        managedInterfaces: [{ name: "anvilwg0" }],
      },
    })
  }
  queueApplyResponse(response: { status: number }) {
    this.applies.push({
      id: "resp",
      status: response.status,
      body: response.status < 300 ? { mode: "DRY_RUN", status: "VALIDATED", summary: "ok" } : undefined,
      error: response.status >= 300 ? "rejected" : undefined,
    })
  }

  async execute(request: AgentRequest): Promise<AgentResponse> {
    if (this.nextThrow) {
      const err = this.nextThrow
      this.nextThrow = undefined
      throw err
    }
    if (request.method === "GET" && request.path === "/agent/v1/network/state") {
      if (this.nextStatus) {
        return { id: "resp", status: this.nextStatus, error: "unavailable" }
      }
      if (this.nextBody !== undefined) {
        const body = this.nextBody
        this.nextBody = undefined
        return { id: "resp", status: 200, body }
      }
      return { id: "resp", status: 200, body: this.states.shift() }
    }
    if (request.method === "POST" && request.path === "/agent/v1/network/apply") {
      this.applyRequests.push(request)
      const r = this.applies.shift()
      if (r) return r
      return { id: "resp", status: 200, body: { mode: "DRY_RUN", status: "VALIDATED", summary: "ok" } }
    }
    return { id: "resp", status: 404, error: "not found" }
  }
  close?(): void {}
}
