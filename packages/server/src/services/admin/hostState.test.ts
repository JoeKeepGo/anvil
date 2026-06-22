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

const memberWithoutHostAccess: AdminPrincipal = {
  id: "member-1",
  email: "member@example.com",
  name: "Member User",
  status: "ACTIVE",
  globalRole: "MEMBER",
  teams: [],
}

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
      skip: process.env.ANVIL_HOST_STATE_DATABASE_URL
        ? false
        : "set ANVIL_HOST_STATE_DATABASE_URL to run the PostgreSQL HostState regression test",
    },
    async () => {
      const originalDatabaseUrl = process.env.DATABASE_URL
      process.env.DATABASE_URL = process.env.ANVIL_HOST_STATE_DATABASE_URL
      const prisma = new PrismaClient()
      try {
        await prisma.auditLog.deleteMany({ where: { targetType: "host_state" } })
        await prisma.hostState.deleteMany()
        await prisma.agentEndpoint.deleteMany({ where: { id: "host-state-postgres-endpoint" } })
        await prisma.teamMembership.deleteMany({ where: { userId: globalAdmin.id } })
        await prisma.user.deleteMany({ where: { id: globalAdmin.id } })
        await prisma.team.deleteMany({ where: { id: "host-state-postgres-team" } })
        await prisma.team.create({
          data: {
            id: "host-state-postgres-team",
            name: `Host State Postgres Team ${Date.now()}`,
            status: "ACTIVE",
          },
        })
        await prisma.user.create({
          data: {
            id: globalAdmin.id,
            email: globalAdmin.email,
            name: globalAdmin.name,
            passwordHash: "not-used-in-this-test",
            status: "ACTIVE",
            globalRole: "ADMIN",
          },
        })
        await prisma.agentEndpoint.create({
          data: {
            id: "host-state-postgres-endpoint",
            name: "Postgres Agent",
            url: "ws://127.0.0.1:19090/ws",
            status: "ACTIVE",
            teamId: "host-state-postgres-team",
          },
        })

        const store = new PrismaHostStateStore(prisma, {
          DATABASE_URL: process.env.ANVIL_HOST_STATE_DATABASE_URL,
        })
        const first = await syncEndpointHostState(store, globalAdmin, "host-state-postgres-endpoint", {
          createAgentClient: () => new RecordingAgent(stateResponse(stateReport({ agentId: "postgres-agent" }))),
          now: () => new Date("2026-06-22T01:00:00.000Z"),
        })
        const second = await syncEndpointHostState(store, globalAdmin, "host-state-postgres-endpoint", {
          createAgentClient: () => new RecordingAgent(stateResponse(stateReport({ agentId: "postgres-agent", instancesTotal: 4 }))),
          now: () => new Date("2026-06-22T02:00:00.000Z"),
        })

        assert.equal(first.id, second.id)
        assert.equal(second.snapshot.instancesTotal, 4)
        assert.equal(await prisma.hostState.count({ where: { endpointId: "host-state-postgres-endpoint" } }), 1)
        assert.equal(await prisma.auditLog.count({ where: { action: "host_state.sync" } }), 2)
      } finally {
        await prisma.$disconnect()
        if (originalDatabaseUrl === undefined) {
          delete process.env.DATABASE_URL
        } else {
          process.env.DATABASE_URL = originalDatabaseUrl
        }
      }
    }
  )
})

class TestHostStateStore implements HostStateStore {
  private readonly endpoints = new Map<string, HostStateSyncEndpoint>()
  private readonly statesByEndpoint = new Map<string, HostStateRecord>()
  private nextHostStateNumber = 1
  readonly auditEntries: AdminAuditEntry[] = []

  async listHostStates(): Promise<HostStateRecord[]> {
    return [...this.statesByEndpoint.values()]
  }

  async getHostState(hostStateId: string): Promise<HostStateRecord | null> {
    return [...this.statesByEndpoint.values()].find((state) => state.id === hostStateId) ?? null
  }

  async getEndpointForHostStateSync(endpointId: string): Promise<HostStateSyncEndpoint | null> {
    return this.endpoints.get(endpointId) ?? null
  }

  async getHostStateByEndpointId(endpointId: string): Promise<HostStateRecord | null> {
    return this.statesByEndpoint.get(endpointId) ?? null
  }

  async upsertHostState(input: HostStateUpsertInput): Promise<HostStateRecord> {
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
    this.auditEntries.push(entry)
  }

  addEndpoint(endpoint: HostStateSyncEndpoint): void {
    this.endpoints.set(endpoint.id, endpoint)
  }
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

function stateReport(overrides: { agentId?: string; version?: string; instancesTotal?: number } = {}) {
  return {
    agent: {
      id: overrides.agentId ?? "11111111-1111-4111-8111-111111111111",
      version: overrides.version ?? "dev",
      stateSchemaVersion: 1,
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
      statusCode: 200,
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
      imagesTotal: 1,
      operationsTotal: 0,
    },
  }
}
