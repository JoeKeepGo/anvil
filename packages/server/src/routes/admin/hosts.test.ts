import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { AgentConnectionError, type AgentClientOptions, type AgentRequest, type AgentResponse } from "../../services/agent"
import { encryptEndpointToken } from "../../services/admin/endpoints"
import {
  createEndpointAgentStateSyncRoutes,
  createHostRoutes,
} from "./hosts"
import { signAdminSession } from "../../services/admin/session"
import type {
  AdminAuditEntry,
  AdminDataStore,
  AdminPrincipal,
  CreateBootstrapAdminRecord,
} from "../../services/admin/session"
import {
  HostStateAgentConflictError,
  type HostStateAgentClient,
  type HostStateRecord,
  type HostStateStore,
  type HostStateSyncCommitInput,
  type HostStateSyncEndpoint,
  type HostStateUpsertInput,
} from "../../services/admin/hostState"

const sessionSecret = "test-session-secret-with-enough-entropy"
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
      status: "ACTIVE",
      role: "VIEWER",
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

describe("admin host routes", () => {
  test("requires authentication and host read permission for host list and detail", async () => {
    const hostStore = new TestHostRouteStore()
    await hostStore.seedHostState()
    const unauthenticatedRoutes = createHostRoutes({
      env: { ANVIL_SESSION_SECRET: sessionSecret },
      sessionStore: new TestSessionStore(globalAdmin),
      hostStateStore: hostStore,
    })
    const deniedRoutes = createHostRoutes({
      env: { ANVIL_SESSION_SECRET: sessionSecret },
      sessionStore: new TestSessionStore(memberWithoutHostAccess),
      hostStateStore: hostStore,
    })

    assert.equal((await unauthenticatedRoutes.request("/")).status, 401)
    assert.equal((await unauthenticatedRoutes.request("/host-state-1")).status, 401)

    const listDenied = await deniedRoutes.request("/", {
      headers: { cookie: sessionCookie(memberWithoutHostAccess) },
    })
    const detailDenied = await deniedRoutes.request("/host-state-1", {
      headers: { cookie: sessionCookie(memberWithoutHostAccess) },
    })

    assert.equal(listDenied.status, 403)
    assert.equal(detailDenied.status, 403)
    assert.deepEqual(await readJson(listDenied), {
      error: {
        code: "ADMIN_FORBIDDEN",
        message: "Admin permission denied.",
        details: {},
      },
    })
  })

  test("returns browser-safe host list and detail responses", async () => {
    const hostStore = new TestHostRouteStore()
    const host = await hostStore.seedHostState()
    const routes = createHostRoutes({
      env: { ANVIL_SESSION_SECRET: sessionSecret },
      sessionStore: new TestSessionStore(globalAdmin),
      hostStateStore: hostStore,
    })

    const listed = await routes.request("/", { headers: { cookie: sessionCookie(globalAdmin) } })
    const detail = await routes.request(`/${host.id}`, { headers: { cookie: sessionCookie(globalAdmin) } })

    assert.equal(listed.status, 200)
    assert.equal(detail.status, 200)
    assert.deepEqual(await readJson(listed), { hosts: [browserHost(host)] })
    assert.deepEqual(await readJson(detail), { host: browserHost(host) })
    const serialized = JSON.stringify([await readJson(await routes.request("/", {
      headers: { cookie: sessionCookie(globalAdmin) },
    })), await readJson(await routes.request(`/${host.id}`, {
      headers: { cookie: sessionCookie(globalAdmin) },
    }))])
    for (const forbidden of ["token", "tokenCiphertext", "passwordHash", sessionSecret, "cookie", "rawIncus"]) {
      assert.equal(serialized.includes(forbidden), false, `host response leaked ${forbidden}`)
    }
  })

  test("explicit sync requires host sync permission before contacting the agent", async () => {
    const hostStore = new TestHostRouteStore()
    hostStore.addEndpoint(activeEndpoint())
    const agent = new RecordingAgent(stateResponse(stateReport()))
    const routes = createEndpointAgentStateSyncRoutes({
      env: { ANVIL_SESSION_SECRET: sessionSecret },
      sessionStore: new TestSessionStore(teamViewer),
      hostStateStore: hostStore,
      createAgentClient: () => agent,
    })

    const response = await routes.request("/endpoint-1/agent-state/sync", {
      method: "POST",
      headers: { cookie: sessionCookie(teamViewer) },
    })

    assert.equal(response.status, 403)
    assert.equal(hostStore.credentialLoads, 0)
    assert.deepEqual(agent.calls, [])
    assert.deepEqual(await readJson(response), {
      error: {
        code: "ADMIN_FORBIDDEN",
        message: "Admin permission denied.",
        details: {},
      },
    })
  })

  test("explicit sync calls agent state path and returns safe host state without endpoint secrets", async () => {
    const hostStore = new TestHostRouteStore()
    const tokenCiphertext = encryptEndpointToken(
      { ANVIL_ENDPOINT_TOKEN_KEY: endpointTokenKey },
      "endpoint-token-that-must-not-leak"
    )
    hostStore.addEndpoint({ ...activeEndpoint(), tokenCiphertext })
    const agent = new RecordingAgent(stateResponse(stateReport()))
    const clientOptions: AgentClientOptions[] = []
    const routes = createEndpointAgentStateSyncRoutes({
      env: {
        ANVIL_SESSION_SECRET: sessionSecret,
        ANVIL_ENDPOINT_TOKEN_KEY: endpointTokenKey,
      },
      sessionStore: new TestSessionStore(globalAdmin),
      hostStateStore: hostStore,
      createAgentClient: (options) => {
        clientOptions.push(options)
        return agent
      },
      now: () => new Date("2026-06-22T01:00:00.000Z"),
    })

    const response = await routes.request("/endpoint-1/agent-state/sync", {
      method: "POST",
      headers: { cookie: sessionCookie(globalAdmin) },
    })
    const body = await readJson(response)

    assert.equal(response.status, 200)
    assert.deepEqual(agent.calls, [{ method: "GET", path: "/agent/v1/state" }])
    assert.equal(clientOptions[0]?.url, "ws://127.0.0.1:19090/ws")
    assert.equal(clientOptions[0]?.token, "endpoint-token-that-must-not-leak")
    assert.deepEqual(body, { host: browserHost((await hostStore.getHostState("host-state-1"))!) })
    const serialized = JSON.stringify([body, hostStore.auditEntries])
    for (const forbidden of ["endpoint-token-that-must-not-leak", tokenCiphertext, "tokenCiphertext", "passwordHash", sessionSecret, "cookie"]) {
      assert.equal(serialized.includes(forbidden), false, `sync response leaked ${forbidden}`)
    }
  })

  test("explicit sync maps missing, archived, malformed, unreachable, and conflicting state safely", async () => {
    assert.deepEqual(
      await syncErrorBody(new TestHostRouteStore(), new RecordingAgent(stateResponse(stateReport()))),
      {
        status: 404,
        body: { error: { code: "ENDPOINT_NOT_FOUND", message: "Endpoint was not found.", details: {} } },
      }
    )

    const archivedStore = new TestHostRouteStore()
    archivedStore.addEndpoint({ ...activeEndpoint(), status: "ARCHIVED" })
    assert.deepEqual(await syncErrorBody(archivedStore, new RecordingAgent(stateResponse(stateReport()))), {
      status: 409,
      body: { error: { code: "ENDPOINT_ARCHIVED", message: "Endpoint is archived.", details: {} } },
    })

    const malformedStore = new TestHostRouteStore()
    malformedStore.addEndpoint(activeEndpoint())
    assert.deepEqual(await syncErrorBody(malformedStore, new RecordingAgent({ id: "state-1", status: 200, body: { agent: {} } })), {
      status: 502,
      body: {
        error: { code: "HOST_STATE_SYNC_FAILED", message: "Unable to sync host state.", details: {} },
      },
    })

    const unreachableStore = new TestHostRouteStore()
    unreachableStore.addEndpoint(activeEndpoint())
    assert.deepEqual(await syncErrorBody(unreachableStore, new ThrowingAgent(new AgentConnectionError("ECONNREFUSED"))), {
      status: 503,
      body: {
        error: { code: "HOST_STATE_SYNC_FAILED", message: "Unable to sync host state.", details: {} },
      },
    })

    const conflictStore = new TestHostRouteStore()
    conflictStore.addEndpoint(activeEndpoint())
    await conflictStore.seedHostState({ agentId: "agent-original" })
    assert.deepEqual(
      await syncErrorBody(conflictStore, new RecordingAgent(stateResponse(stateReport({ agentId: "agent-replacement" })))),
      {
        status: 409,
        body: {
          error: { code: "HOST_STATE_AGENT_CONFLICT", message: "Endpoint agent identity changed.", details: {} },
        },
      }
    )
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

  async recordAudit(_entry: AdminAuditEntry): Promise<void> {}
}

class TestHostRouteStore implements HostStateStore {
  private readonly endpoints = new Map<string, HostStateSyncEndpoint>()
  private readonly statesByEndpoint = new Map<string, HostStateRecord>()
  private nextHostStateNumber = 1
  readonly auditEntries: AdminAuditEntry[] = []
  credentialLoads = 0

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
    const existing = this.statesByEndpoint.get(input.endpoint.id)
    if (existing && existing.agent.id !== input.agent.id) {
      throw new HostStateAgentConflictError()
    }
    const state = this.writeHostState(input)
    this.auditEntries.push(hostStateAuditEntry(input, state))
    return state
  }

  async recordAudit(entry: AdminAuditEntry): Promise<void> {
    this.auditEntries.push(entry)
  }

  addEndpoint(endpoint: HostStateSyncEndpoint): void {
    this.endpoints.set(endpoint.id, endpoint)
  }

  async seedHostState(overrides: { agentId?: string } = {}): Promise<HostStateRecord> {
    this.addEndpoint(activeEndpoint())
    return this.writeHostState({
      endpoint: activeEndpoint(),
      agent: {
        id: overrides.agentId ?? "11111111-1111-4111-8111-111111111111",
        version: "dev",
        stateSchemaVersion: 1,
        startedAt: "2026-06-22T00:00:00.000Z",
        reportedAt: "2026-06-22T00:30:00.000Z",
      },
      host: { hostname: "anvil-local-vm", os: "linux", arch: "arm64" },
      incus: { available: true, statusCode: 200, serverVersion: "6.12", apiVersion: "1.0" },
      capabilities: { incusProxy: true, events: true, stateReport: true, wireGuard: false, vmLifecycle: false },
      snapshot: { instancesTotal: 0, imagesTotal: 1, operationsTotal: 0 },
      observedAt: "2026-06-22T01:00:00.000Z",
    })
  }

  private writeHostState(input: HostStateUpsertInput): HostStateRecord {
    const existing = this.statesByEndpoint.get(input.endpoint.id)
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
      firstSeenAt: existing?.firstSeenAt ?? input.observedAt,
      lastSeenAt: input.observedAt,
    }
    this.statesByEndpoint.set(input.endpoint.id, record)
    return record
  }
}

class RecordingAgent implements HostStateAgentClient {
  readonly calls: AgentRequest[] = []

  constructor(private readonly response: AgentResponse) {}

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

async function syncErrorBody(store: TestHostRouteStore, agent: HostStateAgentClient) {
  const routes = createEndpointAgentStateSyncRoutes({
    env: {
      ANVIL_SESSION_SECRET: sessionSecret,
      ANVIL_ENDPOINT_TOKEN_KEY: endpointTokenKey,
    },
    sessionStore: new TestSessionStore(globalAdmin),
    hostStateStore: store,
    createAgentClient: () => agent,
  })
  const response = await routes.request("/endpoint-1/agent-state/sync", {
    method: "POST",
    headers: { cookie: sessionCookie(globalAdmin) },
  })
  return { status: response.status, body: await readJson(response) }
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

function browserHost(host: HostStateRecord) {
  return {
    ...host,
    endpoint: {
      id: host.endpoint.id,
      name: host.endpoint.name,
      status: host.endpoint.status,
    },
  }
}

function stateResponse(body: unknown): AgentResponse {
  return { id: "state-1", status: 200, body }
}

function stateReport(overrides: { agentId?: string } = {}) {
  return {
    agent: {
      id: overrides.agentId ?? "11111111-1111-4111-8111-111111111111",
      version: "dev",
      stateSchemaVersion: 1,
      startedAt: "2026-06-22T00:00:00.000Z",
      reportedAt: "2026-06-22T00:30:00.000Z",
    },
    host: { hostname: "anvil-local-vm", os: "linux", arch: "arm64" },
    incus: { available: true, statusCode: 200, serverVersion: "6.12", apiVersion: "1.0" },
    capabilities: { incusProxy: true, events: true, stateReport: true, wireGuard: false, vmLifecycle: false },
    snapshot: { instancesTotal: 0, imagesTotal: 1, operationsTotal: 0 },
  }
}

function hostStateAuditEntry(input: HostStateSyncCommitInput, state: HostStateRecord): AdminAuditEntry {
  return {
    actorUserId: input.actorUserId,
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

function sessionCookie(principal: AdminPrincipal): string {
  return `anvil_session=${signAdminSession({ ANVIL_SESSION_SECRET: sessionSecret }, principal)}`
}

async function readJson(response: Response): Promise<unknown> {
  return response.json()
}
