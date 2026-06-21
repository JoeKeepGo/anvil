import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  AdminEndpointPermissionDeniedError,
  DuplicateEndpointNameError,
  EndpointTokenKeyError,
  ArchivedEndpointTeamError,
  createAdminEndpoint,
  decryptEndpointToken,
  getAdminEndpoint,
  listAdminEndpoints,
  updateAdminEndpoint,
  archiveAdminEndpoint,
  restoreAdminEndpoint,
  type AdminEndpointManagementStore,
  type ManagedEndpoint,
} from "./endpoints"
import type { AdminAuditEntry, AdminPrincipal } from "./session"

const endpointTokenKey = "phase4-endpoint-token-key-with-enough-entropy"

const globalAdmin: AdminPrincipal = {
  id: "admin-1",
  email: "admin@example.com",
  name: "Admin User",
  status: "ACTIVE",
  globalRole: "ADMIN",
  teams: [
    {
      id: "team-1",
      name: "Primary Team",
      role: "OWNER",
      status: "ACTIVE",
    },
  ],
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

const teamMaintainer: AdminPrincipal = {
  id: "maintainer-1",
  email: "maintainer@example.com",
  name: "Maintainer User",
  status: "ACTIVE",
  globalRole: "MEMBER",
  teams: [
    {
      id: "team-1",
      name: "Primary Team",
      role: "MAINTAINER",
      status: "ACTIVE",
    },
  ],
}

describe("admin endpoint management service", () => {
  test("creates, lists, updates, archives, and restores endpoints with encrypted tokens and audit", async () => {
    const store = new TestEndpointStore()
    store.addTeam({ id: "team-1", name: "Primary Team", status: "ACTIVE" })

    const created = await createAdminEndpoint(
      store,
      globalAdmin,
      {
        name: "Primary Agent",
        url: "ws://127.0.0.1:9090/ws",
        teamId: "team-1",
        token: "endpoint-token-that-must-not-leak",
      },
      { ANVIL_ENDPOINT_TOKEN_KEY: endpointTokenKey }
    )
    const listed = await listAdminEndpoints(store, globalAdmin)
    const detail = await getAdminEndpoint(store, globalAdmin, "endpoint-1")
    const updated = await updateAdminEndpoint(
      store,
      globalAdmin,
      "endpoint-1",
      {
        name: "Renamed Agent",
        url: "wss://agent.example.com/ws",
        token: "rotated-endpoint-token-that-must-not-leak",
      },
      { ANVIL_ENDPOINT_TOKEN_KEY: endpointTokenKey }
    )
    const archived = await archiveAdminEndpoint(store, globalAdmin, "endpoint-1")
    const restored = await restoreAdminEndpoint(store, globalAdmin, "endpoint-1")

    assert.deepEqual(created, {
      id: "endpoint-1",
      name: "Primary Agent",
      url: "ws://127.0.0.1:9090/ws",
      status: "ACTIVE",
      team: {
        id: "team-1",
        name: "Primary Team",
        status: "ACTIVE",
      },
      credentialConfigured: true,
    })
    assert.deepEqual(listed, [created])
    assert.deepEqual(detail, created)
    assert.equal(updated.name, "Renamed Agent")
    assert.equal(updated.url, "wss://agent.example.com/ws")
    assert.equal(archived.status, "ARCHIVED")
    assert.equal(restored.status, "ACTIVE")

    const firstCiphertext = store.ciphertextFor("endpoint-1", 0)
    const rotatedCiphertext = store.ciphertextFor("endpoint-1", 1)
    assert.notEqual(firstCiphertext, "endpoint-token-that-must-not-leak")
    assert.notEqual(rotatedCiphertext, "rotated-endpoint-token-that-must-not-leak")
    assert.equal(
      decryptEndpointToken({ ANVIL_ENDPOINT_TOKEN_KEY: endpointTokenKey }, firstCiphertext),
      "endpoint-token-that-must-not-leak"
    )
    assert.equal(
      decryptEndpointToken({ ANVIL_ENDPOINT_TOKEN_KEY: endpointTokenKey }, rotatedCiphertext),
      "rotated-endpoint-token-that-must-not-leak"
    )
    assert.deepEqual(store.auditEntries.map((entry) => entry.action), [
      "endpoint.create",
      "endpoint.update",
      "endpoint.archive",
      "endpoint.restore",
    ])
    assert.equal(store.auditEntries[0]?.teamId, "team-1")
    assert.deepEqual(store.auditEntries[1]?.metadata, {
      name: "Renamed Agent",
      url: "wss://agent.example.com/ws",
      teamId: undefined,
      status: undefined,
      token: "[REDACTED]",
    })

    const serialized = JSON.stringify([created, listed, detail, updated, archived, restored, store.auditEntries])
    assert.equal(serialized.includes("endpoint-token-that-must-not-leak"), false)
    assert.equal(serialized.includes("rotated-endpoint-token-that-must-not-leak"), false)
    assert.equal(serialized.includes(firstCiphertext), false)
    assert.equal(serialized.includes(rotatedCiphertext), false)
    assert.equal(serialized.includes("tokenCiphertext"), false)
    assert.equal(serialized.includes("privateConfig"), false)
  })

  test("requires an encryption key when token material is submitted", async () => {
    const store = new TestEndpointStore()
    store.addTeam({ id: "team-1", name: "Primary Team", status: "ACTIVE" })

    await assert.rejects(
      createAdminEndpoint(
        store,
        globalAdmin,
        {
          name: "Primary Agent",
          url: "ws://127.0.0.1:9090/ws",
          teamId: "team-1",
          token: "endpoint-token-that-must-not-be-stored-plain",
        },
        {}
      ),
      EndpointTokenKeyError
    )
    assert.deepEqual(await listAdminEndpoints(store, globalAdmin), [])
    assert.deepEqual(store.auditEntries, [])
  })

  test("enforces scoped endpoint permissions and duplicate names", async () => {
    const store = new TestEndpointStore()
    store.addTeam({ id: "team-1", name: "Primary Team", status: "ACTIVE" })
    store.addTeam({ id: "team-2", name: "Other Team", status: "ACTIVE" })
    store.addTeam({ id: "team-3", name: "Archived Team", status: "ARCHIVED" })

    await createAdminEndpoint(
      store,
      globalAdmin,
      {
        name: "Primary Agent",
        url: "ws://127.0.0.1:9090/ws",
        teamId: "team-1",
      },
      { ANVIL_ENDPOINT_TOKEN_KEY: endpointTokenKey }
    )
    await createAdminEndpoint(
      store,
      globalAdmin,
      {
        name: "Other Agent",
        url: "ws://127.0.0.1:19090/ws",
        teamId: "team-2",
      },
      { ANVIL_ENDPOINT_TOKEN_KEY: endpointTokenKey }
    )

    assert.deepEqual((await listAdminEndpoints(store, teamViewer)).map((endpoint) => endpoint.id), [
      "endpoint-1",
    ])
    await assert.rejects(getAdminEndpoint(store, teamViewer, "endpoint-2"), AdminEndpointPermissionDeniedError)
    await assert.rejects(
      updateAdminEndpoint(
        store,
        teamViewer,
        "endpoint-1",
        { name: "Viewer Rename" },
        { ANVIL_ENDPOINT_TOKEN_KEY: endpointTokenKey }
      ),
      AdminEndpointPermissionDeniedError
    )
    await assert.rejects(
      createAdminEndpoint(
        store,
        teamMaintainer,
        {
          name: "Primary Agent",
          url: "ws://127.0.0.1:29090/ws",
          teamId: "team-1",
        },
        { ANVIL_ENDPOINT_TOKEN_KEY: endpointTokenKey }
      ),
      DuplicateEndpointNameError
    )
    await assert.rejects(
      createAdminEndpoint(
        store,
        globalAdmin,
        {
          name: "Archived Agent",
          url: "ws://127.0.0.1:39090/ws",
          teamId: "team-3",
        },
        { ANVIL_ENDPOINT_TOKEN_KEY: endpointTokenKey }
      ),
      ArchivedEndpointTeamError
    )
  })
})

interface TestTeam {
  id: string
  name: string
  status: "ACTIVE" | "ARCHIVED"
}

class TestEndpointStore implements AdminEndpointManagementStore {
  private readonly endpoints = new Map<string, ManagedEndpoint & { tokenCiphertext?: string }>()
  private readonly teams = new Map<string, TestTeam>()
  private readonly ciphertextHistory = new Map<string, string[]>()
  private nextEndpointNumber = 1
  readonly auditEntries: AdminAuditEntry[] = []

  async listEndpoints(): Promise<ManagedEndpoint[]> {
    return [...this.endpoints.values()].map(stripTokenCiphertext)
  }

  async getEndpoint(endpointId: string): Promise<ManagedEndpoint | null> {
    const endpoint = this.endpoints.get(endpointId)
    return endpoint ? stripTokenCiphertext(endpoint) : null
  }

  async findEndpointByTeamAndName(teamId: string, name: string): Promise<ManagedEndpoint | null> {
    const normalized = name.trim().toLowerCase()
    const endpoint = [...this.endpoints.values()].find(
      (candidate) => candidate.team.id === teamId && candidate.name.toLowerCase() === normalized
    )
    return endpoint ? stripTokenCiphertext(endpoint) : null
  }

  async createEndpointRecord(input: {
    name: string
    url: string
    teamId: string
    status?: "ACTIVE" | "ARCHIVED"
    tokenCiphertext?: string
  }): Promise<ManagedEndpoint> {
    const team = this.teams.get(input.teamId)
    assert.ok(team)
    const endpoint = {
      id: `endpoint-${this.nextEndpointNumber++}`,
      name: input.name,
      url: input.url,
      status: input.status ?? "ACTIVE",
      team: { ...team },
      credentialConfigured: input.tokenCiphertext !== undefined,
      tokenCiphertext: input.tokenCiphertext,
    }
    this.endpoints.set(endpoint.id, endpoint)
    this.pushCiphertext(endpoint.id, input.tokenCiphertext)
    return stripTokenCiphertext(endpoint)
  }

  async updateEndpointRecord(
    endpointId: string,
    input: {
      name?: string
      url?: string
      teamId?: string
      status?: "ACTIVE" | "ARCHIVED"
      tokenCiphertext?: string
    }
  ): Promise<ManagedEndpoint> {
    const endpoint = this.endpoints.get(endpointId)
    assert.ok(endpoint)
    const team = input.teamId ? this.teams.get(input.teamId) : endpoint.team
    assert.ok(team)
    const updated = {
      ...endpoint,
      name: input.name ?? endpoint.name,
      url: input.url ?? endpoint.url,
      status: input.status ?? endpoint.status,
      team: { ...team },
      credentialConfigured: input.tokenCiphertext !== undefined || endpoint.credentialConfigured,
      tokenCiphertext: input.tokenCiphertext ?? endpoint.tokenCiphertext,
    }
    this.endpoints.set(endpointId, updated)
    this.pushCiphertext(endpointId, input.tokenCiphertext)
    return stripTokenCiphertext(updated)
  }

  async getTeam(teamId: string): Promise<TestTeam | null> {
    return this.teams.get(teamId) ?? null
  }

  async recordAudit(entry: AdminAuditEntry): Promise<void> {
    this.auditEntries.push(entry)
  }

  addTeam(team: TestTeam): void {
    this.teams.set(team.id, team)
  }

  ciphertextFor(endpointId: string, index: number): string {
    const ciphertext = this.ciphertextHistory.get(endpointId)?.[index]
    assert.ok(ciphertext)
    return ciphertext
  }

  private pushCiphertext(endpointId: string, ciphertext: string | undefined): void {
    if (ciphertext === undefined) {
      return
    }
    this.ciphertextHistory.set(endpointId, [...(this.ciphertextHistory.get(endpointId) ?? []), ciphertext])
  }
}

function stripTokenCiphertext(endpoint: ManagedEndpoint & { tokenCiphertext?: string }): ManagedEndpoint {
  return {
    id: endpoint.id,
    name: endpoint.name,
    url: endpoint.url,
    status: endpoint.status,
    team: { ...endpoint.team },
    credentialConfigured: endpoint.credentialConfigured,
  }
}
