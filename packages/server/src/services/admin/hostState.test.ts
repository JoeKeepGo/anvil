import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  AgentConnectionError,
  AgentTimeoutError,
  type AgentClientOptions,
  type AgentRequest,
  type AgentResponse,
} from "../agent"
import { encryptEndpointToken } from "./endpoints"
import {
  PrismaHostStateStore,
  HostStateAgentConflictError,
  HostStateAgentUnavailableError,
  HostStateEndpointArchivedError,
  HostStateEndpointNotFoundError,
  HostStateMalformedReportError,
  HostStatePermissionDeniedError,
  getHostState,
  listHostStates,
  syncEndpointHostState,
  type HostStateAgentClient,
  type HostStateRecord,
  type HostStateStore,
  type HostStateSyncCommitInput,
  type HostStateSyncEndpoint,
  type HostStateUpsertInput,
} from "./hostState"
import type { AdminAuditEntry, AdminPrincipal } from "./session"
import { PrismaClient } from "@prisma/client"

const endpointTokenKey = "m11-host-state-token-key-with-enough-entropy"

const globalAdmin: AdminPrincipal = {
  id: "admin-1",
  email: "admin@example.com",
  name: "Admin User",
  status: "ACTIVE",
  globalRole: "ADMIN",
  teams: [],
}

const teamViewer: AdminPrincipal = {
  id: "viewer-1",
  email: "viewer@example.com",
  name: "Viewer User",
  status: "ACTIVE",
  globalRole: "MEMBER",
  teams: [
    {
      id: "team-1",
      name: "Primary Team",
      role: "VIEWER",
      status: "ACTIVE",
    },
  ],
}

const teamSyncer: AdminPrincipal = {
  id: "syncer-1",
  email: "syncer@example.com",
  name: "Syncer User",
  status: "ACTIVE",
  globalRole: "MEMBER",
  teams: [
    {
      id: "team-1",
      name: "Primary Team",
      role: "OWNER",
      status: "ACTIVE",
    },
  ],
}

const memberWithoutHostAccess: AdminPrincipal = {
  id: "member-1",
  email: "member@example.com",
  name: "Member User",
  status: "ACTIVE",
  globalRole: "MEMBER",
  teams: [],
}

const postgresHostStateSkip = process.env.ANVIL_HOST_STATE_DATABASE_URL
  ? false
  : "set ANVIL_HOST_STATE_DATABASE_URL to run the PostgreSQL HostState regression test"

describe("admin host state service", () => {
  test("sync creates and updates the latest host state through the endpoint agent path", async () => {
    const store = new TestHostStateStore()
    const tokenCiphertext = encryptEndpointToken(
      { ANVIL_ENDPOINT_TOKEN_KEY: endpointTokenKey },
      "endpoint-token-that-must-not-leak"
    )
    store.addEndpoint({
      id: "endpoint-1",
      name: "Local VM",
      url: "ws://127.0.0.1:19090/ws",
      tokenCiphertext,
      status: "ACTIVE",
      team: { id: "team-1", name: "Primary Team", status: "ACTIVE" },
    })
    const agent = new RecordingAgent(stateResponse(stateReport({ version: "dev", instancesTotal: 0 })))
    const clientOptions: AgentClientOptions[] = []
    const nowValues = [
      new Date("2026-06-22T01:00:00.000Z"),
      new Date("2026-06-22T02:00:00.000Z"),
    ]

    const created = await syncEndpointHostState(store, globalAdmin, "endpoint-1", {
      env: { ANVIL_ENDPOINT_TOKEN_KEY: endpointTokenKey },
      createAgentClient: (options) => {
        clientOptions.push(options)
        return agent
      },
      now: () => nowValues.shift() ?? new Date("2026-06-22T03:00:00.000Z"),
    })
    agent.response = stateResponse(stateReport({ version: "dev-2", instancesTotal: 3 }))
    const updated = await syncEndpointHostState(store, globalAdmin, "endpoint-1", {
      env: { ANVIL_ENDPOINT_TOKEN_KEY: endpointTokenKey },
      createAgentClient: (options) => {
        clientOptions.push(options)
        return agent
      },
      now: () => nowValues.shift() ?? new Date("2026-06-22T03:00:00.000Z"),
    })

    assert.deepEqual(agent.calls, [
      { method: "GET", path: "/agent/v1/state" },
      { method: "GET", path: "/agent/v1/state" },
    ])
    assert.equal(clientOptions[0]?.url, "ws://127.0.0.1:19090/ws")
    assert.equal(clientOptions[0]?.token, "endpoint-token-that-must-not-leak")
    assert.equal(created.id, "host-state-1")
    assert.equal(updated.id, "host-state-1")
    assert.equal(created.firstSeenAt, "2026-06-22T01:00:00.000Z")
    assert.equal(updated.firstSeenAt, "2026-06-22T01:00:00.000Z")
    assert.equal(updated.lastSeenAt, "2026-06-22T02:00:00.000Z")
    assert.equal(updated.agent.id, "11111111-1111-4111-8111-111111111111")
    assert.equal(updated.agent.version, "dev-2")
    assert.equal(updated.snapshot.instancesTotal, 3)
    assert.equal(updated.status, "ONLINE")
    assert.deepEqual(store.auditEntries.map((entry) => entry.action), [
      "host_state.sync",
      "host_state.sync",
    ])

    const serialized = JSON.stringify([created, updated, store.auditEntries])
    for (const forbidden of [
      "endpoint-token-that-must-not-leak",
      tokenCiphertext,
      "tokenCiphertext",
      "passwordHash",
      "sessionSecret",
      "authorization",
      "cookie",
      "rawIncus",
      "/var/lib/incus/unix.socket",
    ]) {
      assert.equal(serialized.includes(forbidden), false, `serialized host state leaked ${forbidden}`)
    }
  })

  test("sync rejects malformed and unreachable agent state without mutating stored state", async () => {
    const store = new TestHostStateStore()
    store.addEndpoint(activeEndpoint())

    await assert.rejects(
      syncEndpointHostState(store, globalAdmin, "endpoint-1", {
        createAgentClient: () => new RecordingAgent({ id: "state-1", status: 200, body: { agent: {} } }),
      }),
      HostStateMalformedReportError
    )
    await assert.rejects(
      syncEndpointHostState(store, globalAdmin, "endpoint-1", {
        createAgentClient: () => new ThrowingAgent(new AgentConnectionError("connect ECONNREFUSED")),
      }),
      HostStateAgentUnavailableError
    )
    await assert.rejects(
      syncEndpointHostState(store, globalAdmin, "endpoint-1", {
        createAgentClient: () => new ThrowingAgent(new AgentTimeoutError("timed out")),
      }),
      HostStateAgentUnavailableError
    )

    assert.deepEqual(await store.listHostStates(), [])
    assert.deepEqual(store.auditEntries, [])
  })

  test("sync maps a hanging agent state call to unavailable through the request timeout", async () => {
    const store = new TestHostStateStore()
    store.addEndpoint(activeEndpoint())

    await assert.rejects(
      syncEndpointHostState(store, globalAdmin, "endpoint-1", {
        env: { ANVIL_AGENT_REQUEST_TIMEOUT_MS: "5" },
        createAgentClient: () => new HangingAgent(),
      }),
      HostStateAgentUnavailableError
    )

    assert.deepEqual(await store.listHostStates(), [])
    assert.deepEqual(store.auditEntries, [])
  })

  test("sync rejects unsafe agent integer values before persistence", async () => {
    const cases: unknown[] = [
      stateReport({ stateSchemaVersion: 2147483648 }),
      stateReport({ incusStatusCode: 2147483648 }),
      stateReport({ instancesTotal: -1 }),
      stateReport({ imagesTotal: 2147483648 }),
      stateReport({ operationsTotal: -1 }),
    ]

    for (const [index, report] of cases.entries()) {
      const store = new TestHostStateStore()
      store.addEndpoint(activeEndpoint())

      await assert.rejects(
        syncEndpointHostState(store, globalAdmin, "endpoint-1", {
          createAgentClient: () => new RecordingAgent(stateResponse(report)),
        }),
        HostStateMalformedReportError,
        `case ${index} should reject before persistence`
      )
      assert.deepEqual(await store.listHostStates(), [], `case ${index} mutated host state`)
      assert.deepEqual(store.auditEntries, [], `case ${index} wrote audit`)
    }
  })

  test("sync rejects active endpoints attached to archived teams", async () => {
    const store = new TestHostStateStore()
    store.addEndpoint({
      ...activeEndpoint(),
      team: { id: "team-1", name: "Primary Team", status: "ARCHIVED" },
    })
    const agent = new RecordingAgent(stateResponse(stateReport()))

    await assert.rejects(
      syncEndpointHostState(store, globalAdmin, "endpoint-1", {
        createAgentClient: () => agent,
      }),
      HostStateEndpointArchivedError
    )

    assert.deepEqual(agent.calls, [])
    assert.deepEqual(await store.listHostStates(), [])
  })

  test("sync checks authorization before loading endpoint credentials", async () => {
    const store = new TestHostStateStore()
    store.addEndpoint({
      ...activeEndpoint(),
      tokenCiphertext: "encrypted-token-that-should-not-be-loaded",
    })

    await assert.rejects(
      syncEndpointHostState(store, memberWithoutHostAccess, "endpoint-1", {
        createAgentClient: () => new RecordingAgent(stateResponse(stateReport())),
      }),
      HostStatePermissionDeniedError
    )

    assert.equal(store.credentialLoads, 0)
    assert.deepEqual(await store.listHostStates(), [])
  })

  test("sync rejects missing, archived, and conflicting endpoints deterministically", async () => {
    const store = new TestHostStateStore()

    await assert.rejects(
      syncEndpointHostState(store, globalAdmin, "missing-endpoint", {
        createAgentClient: () => new RecordingAgent(stateResponse(stateReport())),
      }),
      HostStateEndpointNotFoundError
    )

    store.addEndpoint({ ...activeEndpoint(), status: "ARCHIVED" })
    await assert.rejects(
      syncEndpointHostState(store, globalAdmin, "endpoint-1", {
        createAgentClient: () => new RecordingAgent(stateResponse(stateReport())),
      }),
      HostStateEndpointArchivedError
    )

    store.addEndpoint(activeEndpoint())
    const first = await syncEndpointHostState(store, globalAdmin, "endpoint-1", {
      createAgentClient: () => new RecordingAgent(stateResponse(stateReport({ agentId: "agent-original" }))),
      now: () => new Date("2026-06-22T01:00:00.000Z"),
    })
    await assert.rejects(
      syncEndpointHostState(store, globalAdmin, "endpoint-1", {
        createAgentClient: () => new RecordingAgent(stateResponse(stateReport({ agentId: "agent-replacement" }))),
        now: () => new Date("2026-06-22T02:00:00.000Z"),
      }),
      HostStateAgentConflictError
    )

    assert.equal((await store.getHostState(first.id))?.agent.id, "agent-original")
    assert.equal(store.auditEntries.length, 1)
  })

  test("sync revalidates endpoint status and authorization at commit time", async () => {
    const archivedStore = new TestHostStateStore()
    archivedStore.addEndpoint(activeEndpoint())
    archivedStore.beforeCommit = () => {
      archivedStore.addEndpoint({ ...activeEndpoint(), status: "ARCHIVED" })
    }

    await assert.rejects(
      syncEndpointHostState(archivedStore, globalAdmin, "endpoint-1", {
        createAgentClient: () => new RecordingAgent(stateResponse(stateReport())),
      }),
      HostStateEndpointArchivedError
    )
    assert.deepEqual(await archivedStore.listHostStates(), [])
    assert.deepEqual(archivedStore.auditEntries, [])

    const reassignedStore = new TestHostStateStore()
    reassignedStore.addEndpoint(activeEndpoint())
    reassignedStore.beforeCommit = () => {
      reassignedStore.addEndpoint({
        ...activeEndpoint(),
        team: { id: "team-2", name: "Other Team", status: "ACTIVE" },
      })
    }

    await assert.rejects(
      syncEndpointHostState(reassignedStore, teamSyncer, "endpoint-1", {
        createAgentClient: () => new RecordingAgent(stateResponse(stateReport())),
      }),
      HostStatePermissionDeniedError
    )
    assert.deepEqual(await reassignedStore.listHostStates(), [])
    assert.deepEqual(reassignedStore.auditEntries, [])
  })

  test("sync rejects concurrent first reports with different agent identities", async () => {
    const store = new RaceyFirstSyncStore()
    store.addEndpoint(activeEndpoint())

    const results = await Promise.allSettled([
      syncEndpointHostState(store, globalAdmin, "endpoint-1", {
        createAgentClient: () => new RecordingAgent(stateResponse(stateReport({ agentId: "agent-original" }))),
        now: () => new Date("2026-06-22T01:00:00.000Z"),
      }),
      syncEndpointHostState(store, globalAdmin, "endpoint-1", {
        createAgentClient: () => new RecordingAgent(stateResponse(stateReport({ agentId: "agent-replacement" }))),
        now: () => new Date("2026-06-22T01:00:01.000Z"),
      }),
    ])

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
    assert.equal(results.filter((result) => result.status === "rejected").length, 1)
    assert(results.some((result) => result.status === "rejected" && result.reason instanceof HostStateAgentConflictError))
    const states = await store.listHostStates()
    assert.equal(states.length, 1)
    assert.equal(store.auditEntries.length, 1)
    assert.match(states[0]!.agent.id, /^agent-(original|replacement)$/)
  })

  test("sync does not persist host state when the audit write fails", async () => {
    const store = new TestHostStateStore()
    store.addEndpoint(activeEndpoint())
    store.failAuditWrites = true

    await assert.rejects(
      syncEndpointHostState(store, globalAdmin, "endpoint-1", {
        createAgentClient: () => new RecordingAgent(stateResponse(stateReport())),
      }),
      /audit write failed/
    )

    assert.deepEqual(await store.listHostStates(), [])
  })

  test("lists and reads browser-safe host state by host permissions", async () => {
    const store = new TestHostStateStore()
    store.addEndpoint(activeEndpoint())
    await syncEndpointHostState(store, globalAdmin, "endpoint-1", {
      createAgentClient: () => new RecordingAgent(stateResponse(stateReport())),
      now: () => new Date("2026-06-22T01:00:00.000Z"),
    })

    assert.equal((await listHostStates(store, globalAdmin)).length, 1)
    assert.equal((await listHostStates(store, teamViewer)).length, 1)
    assert.equal((await getHostState(store, teamViewer, "host-state-1")).id, "host-state-1")
    await assert.rejects(listHostStates(store, memberWithoutHostAccess), HostStatePermissionDeniedError)
    await assert.rejects(
      getHostState(store, memberWithoutHostAccess, "host-state-1"),
      HostStatePermissionDeniedError
    )
  })

  test(
    "persists latest host state through the real PostgreSQL Prisma store",
    {
      skip: postgresHostStateSkip,
    },
    async () => {
      await withPostgresHostStateFixture(async ({ prisma, store, endpointId, admin }) => {
        const first = await syncEndpointHostState(store, admin, endpointId, {
          createAgentClient: () => new RecordingAgent(stateResponse(stateReport({ agentId: "postgres-agent" }))),
          now: () => new Date("2026-06-22T01:00:00.000Z"),
        })
        const second = await syncEndpointHostState(store, admin, endpointId, {
          createAgentClient: () =>
            new RecordingAgent(stateResponse(stateReport({ agentId: "postgres-agent", instancesTotal: 4 }))),
          now: () => new Date("2026-06-22T02:00:00.000Z"),
        })

        assert.equal(first.id, second.id)
        assert.equal(second.snapshot.instancesTotal, 4)
        assert.equal(await prisma.hostState.count({ where: { endpointId } }), 1)
        assert.equal(await prisma.auditLog.count({ where: { action: "host_state.sync" } }), 2)
      })
    }
  )

  test(
    "rejects concurrent first syncs with different agent identities through the real PostgreSQL Prisma store",
    {
      skip: postgresHostStateSkip,
    },
    async () => {
      await withPostgresHostStateFixture(async ({ prisma, store, endpointId, admin }) => {
        const barrier = new AgentBarrier(2)
        const results = await Promise.allSettled([
          syncEndpointHostState(store, admin, endpointId, {
            createAgentClient: () =>
              new CoordinatedAgent(stateResponse(stateReport({ agentId: "postgres-agent-original" })), barrier),
            now: () => new Date("2026-06-22T01:00:00.000Z"),
          }),
          syncEndpointHostState(store, admin, endpointId, {
            createAgentClient: () =>
              new CoordinatedAgent(stateResponse(stateReport({ agentId: "postgres-agent-replacement" })), barrier),
            now: () => new Date("2026-06-22T01:00:01.000Z"),
          }),
        ])

        assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
        assert(results.some((result) => result.status === "rejected" && result.reason instanceof HostStateAgentConflictError))
        assert.equal(await prisma.hostState.count({ where: { endpointId } }), 1)
        assert.equal(await prisma.auditLog.count({ where: { action: "host_state.sync" } }), 1)
      })
    }
  )

  test(
    "revalidates endpoint status after the agent call in the real PostgreSQL Prisma store",
    {
      skip: postgresHostStateSkip,
    },
    async () => {
      await withPostgresHostStateFixture(async ({ prisma, store, endpointId, admin }) => {
        const agent = new MutatingAgent(stateResponse(stateReport({ agentId: "postgres-agent" })), async () => {
          await prisma.agentEndpoint.update({
            where: { id: endpointId },
            data: { status: "ARCHIVED" },
          })
        })

        await assert.rejects(
          syncEndpointHostState(store, admin, endpointId, {
            createAgentClient: () => agent,
            now: () => new Date("2026-06-22T01:00:00.000Z"),
          }),
          HostStateEndpointArchivedError
        )
        assert.equal(await prisma.hostState.count({ where: { endpointId } }), 0)
        assert.equal(await prisma.auditLog.count({ where: { action: "host_state.sync" } }), 0)
      })
    }
  )

  test(
    "rolls back host state when the PostgreSQL Prisma audit write fails",
    {
      skip: postgresHostStateSkip,
    },
    async () => {
      await withPostgresHostStateFixture(async ({ prisma, store, endpointId }) => {
        const ghostAdmin: AdminPrincipal = {
          ...globalAdmin,
          id: "missing-admin",
          email: "missing-admin@example.com",
        }

        await assert.rejects(
          syncEndpointHostState(store, ghostAdmin, endpointId, {
            createAgentClient: () => new RecordingAgent(stateResponse(stateReport({ agentId: "postgres-agent" }))),
            now: () => new Date("2026-06-22T01:00:00.000Z"),
          })
        )

        assert.equal(await prisma.hostState.count({ where: { endpointId } }), 0)
        assert.equal(await prisma.auditLog.count({ where: { action: "host_state.sync" } }), 0)
      })
    }
  )
})

class TestHostStateStore implements HostStateStore {
  private readonly endpoints = new Map<string, HostStateSyncEndpoint>()
  private readonly statesByEndpoint = new Map<string, HostStateRecord>()
  private nextHostStateNumber = 1
  readonly auditEntries: AdminAuditEntry[] = []
  credentialLoads = 0
  failAuditWrites = false
  beforeCommit?: () => void

  async listHostStates(): Promise<HostStateRecord[]> {
    return [...this.statesByEndpoint.values()]
  }

  async getHostState(hostStateId: string): Promise<HostStateRecord | null> {
    return [...this.statesByEndpoint.values()].find((state) => state.id === hostStateId) ?? null
  }

  async getEndpointForHostStateSyncAuth(endpointId: string): Promise<HostStateSyncEndpoint | null> {
    return this.endpoints.get(endpointId) ?? null
  }

  async getEndpointForHostStateSync(endpointId: string): Promise<HostStateSyncEndpoint | null> {
    this.credentialLoads++
    return this.endpoints.get(endpointId) ?? null
  }

  async syncHostState(input: HostStateSyncCommitInput): Promise<HostStateRecord> {
    this.beforeCommit?.()
    const currentEndpoint = this.endpoints.get(input.endpoint.id)
    if (!currentEndpoint) {
      throw new HostStateEndpointNotFoundError()
    }
    assertCanSyncAtCommit(input.actor, currentEndpoint)

    const existing = this.statesByEndpoint.get(currentEndpoint.id)
    if (existing && existing.agent.id !== input.agent.id) {
      throw new HostStateAgentConflictError()
    }

    const state = this.writeHostState({ ...input, endpoint: currentEndpoint })
    try {
      await this.recordAudit(hostStateAuditEntry({ ...input, endpoint: currentEndpoint }, state))
    } catch (error) {
      if (existing) {
        this.statesByEndpoint.set(input.endpoint.id, existing)
      } else {
        this.statesByEndpoint.delete(input.endpoint.id)
      }
      throw error
    }
    return state
  }

  protected writeHostState(input: HostStateUpsertInput): HostStateRecord {
    const existing = this.statesByEndpoint.get(input.endpoint.id)
    const firstSeenAt = existing?.firstSeenAt ?? input.observedAt
    const record: HostStateRecord = {
      id: existing?.id ?? `host-state-${this.nextHostStateNumber++}`,
      endpoint: {
        id: input.endpoint.id,
        name: input.endpoint.name,
        status: input.endpoint.status,
        team: { ...input.endpoint.team },
      },
      agent: input.agent,
      host: input.host,
      incus: input.incus,
      capabilities: input.capabilities,
      snapshot: input.snapshot,
      status: "ONLINE",
      firstSeenAt,
      lastSeenAt: input.observedAt,
    }
    this.statesByEndpoint.set(input.endpoint.id, record)
    return record
  }

  async recordAudit(entry: AdminAuditEntry): Promise<void> {
    if (this.failAuditWrites) {
      throw new Error("audit write failed")
    }
    this.auditEntries.push(entry)
  }

  addEndpoint(endpoint: HostStateSyncEndpoint): void {
    this.endpoints.set(endpoint.id, endpoint)
  }
}

class RaceyFirstSyncStore extends TestHostStateStore {
  private syncLock = Promise.resolve()

  override async syncHostState(input: HostStateSyncCommitInput): Promise<HostStateRecord> {
    const previousLock = this.syncLock
    let releaseCurrentLock!: () => void
    this.syncLock = new Promise<void>((resolve) => {
      releaseCurrentLock = resolve
    })
    await previousLock
    try {
      return await super.syncHostState(input)
    } finally {
      releaseCurrentLock()
    }
  }
}

function hostStateAuditEntry(input: HostStateSyncCommitInput, state: HostStateRecord): AdminAuditEntry {
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

function assertCanSyncAtCommit(actor: AdminPrincipal, endpoint: HostStateSyncEndpoint): void {
  if (endpoint.status === "ARCHIVED" || endpoint.team.status === "ARCHIVED") {
    throw new HostStateEndpointArchivedError()
  }
  if (actor.globalRole === "ADMIN") {
    return
  }
  const team = actor.teams.find((candidate) => candidate.id === endpoint.team.id)
  if (team?.status === "ACTIVE" && (team.role === "OWNER" || team.role === "MAINTAINER")) {
    return
  }
  throw new HostStatePermissionDeniedError()
}

class RecordingAgent implements HostStateAgentClient {
  readonly calls: AgentRequest[] = []

  constructor(public response: AgentResponse) {}

  async execute(request: AgentRequest): Promise<AgentResponse> {
    this.calls.push(request)
    return this.response
  }

  close(): void {}
}

class ThrowingAgent implements HostStateAgentClient {
  constructor(private readonly error: Error) {}

  async execute(): Promise<AgentResponse> {
    throw this.error
  }

  close(): void {}
}

function activeEndpoint(): HostStateSyncEndpoint {
  return {
    id: "endpoint-1",
    name: "Local VM",
    url: "ws://127.0.0.1:19090/ws",
    status: "ACTIVE",
    team: { id: "team-1", name: "Primary Team", status: "ACTIVE" },
  }
}

function stateResponse(body: unknown): AgentResponse {
  return { id: "state-1", status: 200, body }
}

class HangingAgent implements HostStateAgentClient {
  async execute(): Promise<AgentResponse> {
    return new Promise(() => {})
  }

  close(): void {}
}

class CoordinatedAgent implements HostStateAgentClient {
  readonly calls: AgentRequest[] = []

  constructor(
    private readonly response: AgentResponse,
    private readonly barrier: AgentBarrier
  ) {}

  async execute(request: AgentRequest): Promise<AgentResponse> {
    this.calls.push(request)
    await this.barrier.arrive()
    return this.response
  }

  close(): void {}
}

class MutatingAgent implements HostStateAgentClient {
  readonly calls: AgentRequest[] = []

  constructor(
    private readonly response: AgentResponse,
    private readonly mutate: () => Promise<void>
  ) {}

  async execute(request: AgentRequest): Promise<AgentResponse> {
    this.calls.push(request)
    await this.mutate()
    return this.response
  }

  close(): void {}
}

class AgentBarrier {
  private arrivals = 0
  private release!: () => void
  private readonly ready = new Promise<void>((resolve) => {
    this.release = resolve
  })

  constructor(private readonly expectedArrivals: number) {}

  async arrive(): Promise<void> {
    this.arrivals++
    if (this.arrivals >= this.expectedArrivals) {
      this.release()
    }
    await this.ready
  }
}

function stateReport(
  overrides: {
    agentId?: string
    version?: string
    stateSchemaVersion?: number
    incusStatusCode?: number
    instancesTotal?: number
    imagesTotal?: number
    operationsTotal?: number
  } = {}
) {
  return {
    agent: {
      id: overrides.agentId ?? "11111111-1111-4111-8111-111111111111",
      version: overrides.version ?? "dev",
      stateSchemaVersion: overrides.stateSchemaVersion ?? 1,
      startedAt: "2026-06-22T00:00:00.000Z",
      reportedAt: "2026-06-22T00:30:00.000Z",
    },
    host: {
      hostname: "anvil-local-vm",
      os: "linux",
      arch: "arm64",
    },
    incus: {
      available: true,
      statusCode: overrides.incusStatusCode ?? 200,
      serverVersion: "6.12",
      apiVersion: "1.0",
    },
    capabilities: {
      incusProxy: true,
      events: true,
      stateReport: true,
      wireGuard: false,
      vmLifecycle: false,
    },
    snapshot: {
      instancesTotal: overrides.instancesTotal ?? 0,
      imagesTotal: overrides.imagesTotal ?? 1,
      operationsTotal: overrides.operationsTotal ?? 0,
    },
  }
}

async function withPostgresHostStateFixture(
  run: (context: {
    prisma: PrismaClient
    store: PrismaHostStateStore
    endpointId: string
    teamId: string
    admin: AdminPrincipal
  }) => Promise<void>
): Promise<void> {
  const databaseUrl = process.env.ANVIL_HOST_STATE_DATABASE_URL
  if (!databaseUrl) {
    throw new Error("ANVIL_HOST_STATE_DATABASE_URL is required for PostgreSQL host-state fixture")
  }

  const originalDatabaseUrl = process.env.DATABASE_URL
  process.env.DATABASE_URL = databaseUrl
  const prisma = new PrismaClient()
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  const teamId = `host-state-postgres-team-${suffix}`
  const endpointId = `host-state-postgres-endpoint-${suffix}`
  const admin: AdminPrincipal = {
    ...globalAdmin,
    id: `host-state-postgres-admin-${suffix}`,
    email: `host-state-postgres-admin-${suffix}@example.com`,
  }

  try {
    await prisma.team.create({
      data: {
        id: teamId,
        name: `Host State Postgres Team ${suffix}`,
        status: "ACTIVE",
      },
    })
    await prisma.user.create({
      data: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        passwordHash: "not-used-in-this-test",
        status: "ACTIVE",
        globalRole: "ADMIN",
      },
    })
    await prisma.agentEndpoint.create({
      data: {
        id: endpointId,
        name: "Postgres Agent",
        url: "ws://127.0.0.1:19090/ws",
        status: "ACTIVE",
        teamId,
      },
    })

    const store = new PrismaHostStateStore(prisma, {
      DATABASE_URL: databaseUrl,
    })
    await run({ prisma, store, endpointId, teamId, admin })
  } finally {
    await prisma.auditLog.deleteMany({ where: { teamId, action: "host_state.sync" } })
    await prisma.hostState.deleteMany({ where: { endpointId } })
    await prisma.agentEndpoint.deleteMany({ where: { id: endpointId } })
    await prisma.teamMembership.deleteMany({ where: { userId: admin.id } })
    await prisma.user.deleteMany({ where: { id: admin.id } })
    await prisma.team.deleteMany({ where: { id: teamId } })
    await prisma.$disconnect()
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl
    }
  }
}
