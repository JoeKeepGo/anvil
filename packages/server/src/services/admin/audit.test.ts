import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { listAdminAuditEntries, recordAdminAudit, type AdminAuditQueryStore } from "./audit"
import type { AdminAuditEntry, AdminDataStore, AdminPrincipal, CreateBootstrapAdminRecord } from "./session"

describe("admin audit writer", () => {
  test("records admin mutations with redacted metadata", async () => {
    const store = new TestAdminStore()

    await recordAdminAudit(store, {
      actorUserId: "user-1",
      action: "bootstrap.create",
      targetType: "user",
      targetId: "user-1",
      teamId: "team-1",
      metadata: {
        email: "admin@example.com",
        password: "correct horse battery staple",
        passwordHash: "hash-that-must-not-appear",
        token: "endpoint-token-that-must-not-appear",
        sessionSecret: "secret-that-must-not-appear",
        nested: {
          authorization: "Bearer secret",
          teamName: "Primary Team",
        },
      },
    })

    assert.deepEqual(store.auditEntries, [
      {
        actorUserId: "user-1",
        action: "bootstrap.create",
        targetType: "user",
        targetId: "user-1",
        teamId: "team-1",
        metadata: {
          email: "admin@example.com",
          password: "[REDACTED]",
          passwordHash: "[REDACTED]",
          token: "[REDACTED]",
          sessionSecret: "[REDACTED]",
          nested: {
            authorization: "[REDACTED]",
            teamName: "Primary Team",
          },
        },
      },
    ])

    const serialized = JSON.stringify(store.auditEntries)
    assert.equal(serialized.includes("correct horse battery staple"), false)
    assert.equal(serialized.includes("hash-that-must-not-appear"), false)
    assert.equal(serialized.includes("endpoint-token-that-must-not-appear"), false)
    assert.equal(serialized.includes("secret-that-must-not-appear"), false)
    assert.equal(serialized.includes("Bearer secret"), false)
  })

  test("lists audit entries with filters, pagination, permission checks, and redaction", async () => {
    const store = new TestAuditQueryStore()

    store.addAuditEntry({
      id: "audit-1",
      actor: { id: "admin-1", email: "admin@example.com", name: "Admin User" },
      action: "endpoint.create",
      targetType: "endpoint",
      targetId: "endpoint-1",
      teamId: "team-1",
      metadata: {
        name: "Primary Agent",
        token: "endpoint-token-that-must-not-leak",
        nested: {
          sessionSecret: "session-secret-that-must-not-leak",
        },
      },
      createdAt: "2026-06-21T00:00:00.000Z",
    })
    store.addAuditEntry({
      id: "audit-2",
      actor: { id: "owner-1", email: "owner@example.com", name: "Owner User" },
      action: "team.member.add",
      targetType: "membership",
      targetId: "member-1",
      teamId: "team-2",
      metadata: { role: "VIEWER" },
      createdAt: "2026-06-21T00:01:00.000Z",
    })

    const result = await listAdminAuditEntries(
      store,
      {
        id: "admin-1",
        email: "admin@example.com",
        name: "Admin User",
        status: "ACTIVE",
        globalRole: "ADMIN",
        teams: [],
      },
      {
        targetType: "endpoint",
        limit: 1,
      }
    )

    assert.deepEqual(result, {
      audit: [
        {
          id: "audit-1",
          actor: { id: "admin-1", email: "admin@example.com", name: "Admin User" },
          action: "endpoint.create",
          targetType: "endpoint",
          targetId: "endpoint-1",
          teamId: "team-1",
          metadata: {
            name: "Primary Agent",
            token: "[REDACTED]",
            nested: {
              sessionSecret: "[REDACTED]",
            },
          },
          createdAt: "2026-06-21T00:00:00.000Z",
        },
      ],
      page: {
        limit: 1,
        offset: 0,
        total: 1,
      },
    })

    const teamScoped = await listAdminAuditEntries(
      store,
      {
        id: "owner-1",
        email: "owner@example.com",
        name: "Owner User",
        status: "ACTIVE",
        globalRole: "MEMBER",
        teams: [
          {
            id: "team-2",
            name: "Other Team",
            status: "ACTIVE",
            role: "OWNER",
          },
        ],
      },
      {}
    )

    assert.deepEqual(teamScoped.audit.map((entry) => entry.id), ["audit-2"])
    assert.deepEqual(store.lastQuery?.teamIds, ["team-2"])

    const mismatchedTeamFilter = await listAdminAuditEntries(
      store,
      {
        id: "owner-1",
        email: "owner@example.com",
        name: "Owner User",
        status: "ACTIVE",
        globalRole: "MEMBER",
        teams: [
          {
            id: "team-2",
            name: "Other Team",
            status: "ACTIVE",
            role: "OWNER",
          },
        ],
      },
      { teamId: "team-1" }
    )

    assert.deepEqual(mismatchedTeamFilter.audit, [])

    const serialized = JSON.stringify(result)
    assert.equal(serialized.includes("endpoint-token-that-must-not-leak"), false)
    assert.equal(serialized.includes("session-secret-that-must-not-leak"), false)
  })
})

class TestAdminStore implements AdminDataStore {
  readonly auditEntries: AdminAuditEntry[] = []

  async isBootstrapComplete(): Promise<boolean> {
    return false
  }

  async createBootstrapAdmin(_record: CreateBootstrapAdminRecord): Promise<AdminPrincipal> {
    throw new Error("not used")
  }

  async findUserByEmail(): Promise<(AdminPrincipal & { passwordHash: string }) | null> {
    return null
  }

  async findUserById(): Promise<AdminPrincipal | null> {
    return null
  }

  async recordAudit(entry: AdminAuditEntry): Promise<void> {
    this.auditEntries.push(entry)
  }
}

class TestAuditQueryStore implements AdminAuditQueryStore {
  private readonly entries: Array<{
    id: string
    actor: {
      id: string
      email: string
      name: string
    }
    action: string
    targetType: string
    targetId: string
    teamId?: string
    metadata?: Record<string, unknown>
    createdAt: string
  }> = []
  lastQuery: Parameters<AdminAuditQueryStore["listAuditEntries"]>[0] | undefined

  async listAuditEntries(query: Parameters<AdminAuditQueryStore["listAuditEntries"]>[0]) {
    this.lastQuery = query
    const filtered = this.entries.filter((entry) => {
      if (query.actorUserId && entry.actor.id !== query.actorUserId) {
        return false
      }
      if (query.targetType && entry.targetType !== query.targetType) {
        return false
      }
      if (query.targetId && entry.targetId !== query.targetId) {
        return false
      }
      if (query.action && entry.action !== query.action) {
        return false
      }
      if (query.teamId && entry.teamId !== query.teamId) {
        return false
      }
      if (query.teamIds && query.teamIds.length === 0) {
        return false
      }
      if (query.teamIds && !query.teamIds.includes(entry.teamId ?? "")) {
        return false
      }
      return true
    })
    return {
      entries: filtered.slice(query.offset, query.offset + query.limit),
      total: filtered.length,
    }
  }

  addAuditEntry(entry: {
    id: string
    actor: {
      id: string
      email: string
      name: string
    }
    action: string
    targetType: string
    targetId: string
    teamId?: string
    metadata?: Record<string, unknown>
    createdAt: string
  }): void {
    this.entries.push(entry)
  }
}

describe("network audit redaction", () => {
  test("redacts network secret material while preserving apply action identity", async () => {
    const store = new TestAdminStore()

    await recordAdminAudit(store, {
      actorUserId: "admin-1",
      action: "network.apply",
      targetType: "network_apply",
      targetId: "apply-1",
      metadata: {
        targetType: "network_hub",
        targetId: "hub-1",
        mode: "APPLY",
        status: "SUCCEEDED",
        privateKey: "wireguard-private-key-that-must-not-leak",
        presharedKey: "wireguard-preshared-key-that-must-not-leak",
        privateKeyCiphertext: "v1:private-ciphertext-envelope",
        presharedKeyCiphertext: "v1:preshared-ciphertext-envelope",
        endpointToken: "endpoint-token-that-must-not-leak",
        networkSecretKey: "network-secret-key-that-must-not-leak",
        summary: "applied anvilwg0 hub config",
      },
    })

    const entry = store.auditEntries[0]
    assert.ok(entry)
    assert.equal(entry.action, "network.apply")
    assert.equal(entry.targetType, "network_apply")
    assert.equal(entry.metadata?.targetType, "network_hub")
    assert.equal(entry.metadata?.targetId, "hub-1")
    assert.equal(entry.metadata?.mode, "APPLY")
    assert.equal(entry.metadata?.status, "SUCCEEDED")
    assert.equal(entry.metadata?.summary, "applied anvilwg0 hub config")
    assert.equal(entry.metadata?.privateKey, "[REDACTED]")
    assert.equal(entry.metadata?.presharedKey, "[REDACTED]")
    assert.equal(entry.metadata?.privateKeyCiphertext, "[REDACTED]")
    assert.equal(entry.metadata?.presharedKeyCiphertext, "[REDACTED]")
    assert.equal(entry.metadata?.endpointToken, "[REDACTED]")
    assert.equal(entry.metadata?.networkSecretKey, "[REDACTED]")

    const serialized = JSON.stringify(store.auditEntries)
    assert.equal(serialized.includes("wireguard-private-key-that-must-not-leak"), false)
    assert.equal(serialized.includes("wireguard-preshared-key-that-must-not-leak"), false)
    assert.equal(serialized.includes("v1:private-ciphertext-envelope"), false)
    assert.equal(serialized.includes("v1:preshared-ciphertext-envelope"), false)
    assert.equal(serialized.includes("endpoint-token-that-must-not-leak"), false)
    assert.equal(serialized.includes("network-secret-key-that-must-not-leak"), false)
  })
})
