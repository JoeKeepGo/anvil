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

describe("network audit redaction completeness", () => {
  test("recordAdminAudit redacts generic ciphertext/cookie/sessionData/auth keys and nested occurrences", async () => {
    const store = new TestAdminStore()

    await recordAdminAudit(store, {
      actorUserId: "admin-1",
      action: "network.peer.create",
      targetType: "network_peer",
      targetId: "peer-1",
      metadata: {
        targetType: "network_peer",
        targetId: "peer-1",
        mode: "DRY_RUN",
        status: "SUCCEEDED",
        summary: "rendered config for anvilwg0",
        ciphertext: "v1:raw-ciphertext-envelope-that-must-not-leak",
        privateKeyCiphertext: "v1:private-ciphertext-envelope-that-must-not-leak",
        presharedKeyCiphertext: "v1:preshared-ciphertext-envelope-that-must-not-leak",
        cookie: "anvil_session=cookie-value-that-must-not-leak",
        cookies: "anvil_session=cookies-value-that-must-not-leak",
        sessionData: "session-data-that-must-not-leak",
        endpointToken: "endpoint-token-that-must-not-leak",
        authorization: "Bearer auth-value-that-must-not-leak",
        Ciphertext: "v1:cased-ciphertext-that-must-not-leak",
        nested: {
          ciphertext: "v1:nested-ciphertext-that-must-not-leak",
          cookie: "nested-cookie-that-must-not-leak",
          sessionData: "nested-session-data-that-must-not-leak",
          authorization: "Bearer nested-auth-that-must-not-leak",
          endpointToken: "nested-endpoint-token-that-must-not-leak",
        },
      },
    })

    const entry = store.auditEntries[0]
    assert.ok(entry)
    assert.equal(entry.action, "network.peer.create")
    assert.equal(entry.targetType, "network_peer")

    // Action identity metadata must survive redaction.
    assert.equal(entry.metadata?.targetType, "network_peer")
    assert.equal(entry.metadata?.targetId, "peer-1")
    assert.equal(entry.metadata?.mode, "DRY_RUN")
    assert.equal(entry.metadata?.status, "SUCCEEDED")
    assert.equal(entry.metadata?.summary, "rendered config for anvilwg0")

    // Secret material must be redacted.
    assert.equal(entry.metadata?.ciphertext, "[REDACTED]")
    assert.equal(entry.metadata?.privateKeyCiphertext, "[REDACTED]")
    assert.equal(entry.metadata?.presharedKeyCiphertext, "[REDACTED]")
    assert.equal(entry.metadata?.cookie, "[REDACTED]")
    assert.equal(entry.metadata?.cookies, "[REDACTED]")
    assert.equal(entry.metadata?.sessionData, "[REDACTED]")
    assert.equal(entry.metadata?.endpointToken, "[REDACTED]")
    assert.equal(entry.metadata?.authorization, "[REDACTED]")
    assert.equal(entry.metadata?.Ciphertext, "[REDACTED]")
    assert.equal((entry.metadata?.nested as Record<string, unknown> | undefined)?.ciphertext, "[REDACTED]")
    assert.equal((entry.metadata?.nested as Record<string, unknown> | undefined)?.cookie, "[REDACTED]")
    assert.equal((entry.metadata?.nested as Record<string, unknown> | undefined)?.sessionData, "[REDACTED]")
    assert.equal((entry.metadata?.nested as Record<string, unknown> | undefined)?.authorization, "[REDACTED]")
    assert.equal((entry.metadata?.nested as Record<string, unknown> | undefined)?.endpointToken, "[REDACTED]")

    const serialized = JSON.stringify(store.auditEntries)
    assert.equal(serialized.includes("raw-ciphertext-envelope-that-must-not-leak"), false)
    assert.equal(serialized.includes("private-ciphertext-envelope-that-must-not-leak"), false)
    assert.equal(serialized.includes("preshared-ciphertext-envelope-that-must-not-leak"), false)
    assert.equal(serialized.includes("cookie-value-that-must-not-leak"), false)
    assert.equal(serialized.includes("cookies-value-that-must-not-leak"), false)
    assert.equal(serialized.includes("session-data-that-must-not-leak"), false)
    assert.equal(serialized.includes("endpoint-token-that-must-not-leak"), false)
    assert.equal(serialized.includes("auth-value-that-must-not-leak"), false)
    assert.equal(serialized.includes("cased-ciphertext-that-must-not-leak"), false)
    assert.equal(serialized.includes("nested-ciphertext-that-must-not-leak"), false)
    assert.equal(serialized.includes("nested-cookie-that-must-not-leak"), false)
    assert.equal(serialized.includes("nested-session-data-that-must-not-leak"), false)
    assert.equal(serialized.includes("Bearer nested-auth-that-must-not-leak"), false)
    assert.equal(serialized.includes("nested-endpoint-token-that-must-not-leak"), false)
  })

  test("listAdminAuditEntries redacts the same secret keys before browser output", async () => {
    const store = new TestAuditQueryStore()
    store.addAuditEntry({
      id: "audit-net-1",
      actor: { id: "admin-1", email: "admin@example.com", name: "Admin User" },
      action: "network.apply",
      targetType: "network_apply",
      targetId: "apply-1",
      metadata: {
        targetType: "network_hub",
        targetId: "hub-1",
        mode: "APPLY",
        status: "SUCCEEDED",
        summary: "applied anvilwg0 hub config",
        ciphertext: "v1:list-ciphertext-that-must-not-leak",
        privateKeyCiphertext: "v1:list-private-ciphertext-that-must-not-leak",
        presharedKeyCiphertext: "v1:list-preshared-ciphertext-that-must-not-leak",
        cookie: "list-cookie-that-must-not-leak",
        cookies: "list-cookies-that-must-not-leak",
        sessionData: "list-session-data-that-must-not-leak",
        endpointToken: "list-endpoint-token-that-must-not-leak",
        authorization: "Bearer list-auth-that-must-not-leak",
        nested: {
          ciphertext: "v1:list-nested-ciphertext-that-must-not-leak",
          cookie: "list-nested-cookie-that-must-not-leak",
          sessionData: "list-nested-session-data-that-must-not-leak",
        },
      },
      createdAt: "2026-06-23T00:00:00.000Z",
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
      { targetType: "network_apply" }
    )

    const entry = result.audit[0]
    assert.ok(entry)
    // Action identity survives.
    assert.equal(entry.action, "network.apply")
    assert.equal(entry.targetType, "network_apply")
    assert.equal(entry.metadata?.targetType, "network_hub")
    assert.equal(entry.metadata?.targetId, "hub-1")
    assert.equal(entry.metadata?.mode, "APPLY")
    assert.equal(entry.metadata?.status, "SUCCEEDED")
    assert.equal(entry.metadata?.summary, "applied anvilwg0 hub config")
    // Secret material redacted.
    assert.equal(entry.metadata?.ciphertext, "[REDACTED]")
    assert.equal(entry.metadata?.privateKeyCiphertext, "[REDACTED]")
    assert.equal(entry.metadata?.presharedKeyCiphertext, "[REDACTED]")
    assert.equal(entry.metadata?.cookie, "[REDACTED]")
    assert.equal(entry.metadata?.cookies, "[REDACTED]")
    assert.equal(entry.metadata?.sessionData, "[REDACTED]")
    assert.equal(entry.metadata?.endpointToken, "[REDACTED]")
    assert.equal(entry.metadata?.authorization, "[REDACTED]")
    assert.equal((entry.metadata?.nested as Record<string, unknown> | undefined)?.ciphertext, "[REDACTED]")
    assert.equal((entry.metadata?.nested as Record<string, unknown> | undefined)?.cookie, "[REDACTED]")
    assert.equal((entry.metadata?.nested as Record<string, unknown> | undefined)?.sessionData, "[REDACTED]")

    const serialized = JSON.stringify(result)
    assert.equal(serialized.includes("list-ciphertext-that-must-not-leak"), false)
    assert.equal(serialized.includes("list-private-ciphertext-that-must-not-leak"), false)
    assert.equal(serialized.includes("list-preshared-ciphertext-that-must-not-leak"), false)
    assert.equal(serialized.includes("list-cookie-that-must-not-leak"), false)
    assert.equal(serialized.includes("list-cookies-that-must-not-leak"), false)
    assert.equal(serialized.includes("list-session-data-that-must-not-leak"), false)
    assert.equal(serialized.includes("list-endpoint-token-that-must-not-leak"), false)
    assert.equal(serialized.includes("list-auth-that-must-not-leak"), false)
    assert.equal(serialized.includes("list-nested-ciphertext-that-must-not-leak"), false)
    assert.equal(serialized.includes("list-nested-cookie-that-must-not-leak"), false)
    assert.equal(serialized.includes("list-nested-session-data-that-must-not-leak"), false)
  })
})

describe("vm lifecycle audit redaction", () => {
  test("redacts lifecycle agent payload and cloud-init material while preserving action identity", async () => {
    const store = new TestAdminStore()

    await recordAdminAudit(store, {
      actorUserId: "admin-1",
      action: "vm.create",
      targetType: "vm_instance",
      targetId: "vm-1",
      metadata: {
        vmInstanceId: "vm-1",
        action: "CREATE",
        status: "SUCCEEDED",
        endpointId: "endpoint-1",
        projectId: "project-1",
        tenantId: "tenant-1",
        cpuCount: 1,
        memoryBytes: 268_435_456,
        rootDiskBytes: 5_368_709_120,
        addressFamily: "IPV4",
        networkPoolId: "pool-1",
        summary: "create acknowledged by agent lifecycle protocol",
        vmConfig: "vm-config-that-must-not-leak",
        userData: "#cloud-config\npassword: must-not-leak",
        cloudInit: "cloud-init-that-must-not-leak",
        agentResponse: "agent-response-that-must-not-leak",
        agentPayload: "agent-payload-that-must-not-leak",
        incusResponse: "incus-response-that-must-not-leak",
        incusPayload: "incus-payload-that-must-not-leak",
        sshKey: "ssh-key-that-must-not-leak",
        sshPublicKey: "ssh-public-key-that-must-not-leak",
        sshPrivateKey: "ssh-private-key-that-must-not-leak",
        privateKeyMaterial: "private-key-material-that-must-not-leak",
        nested: {
          userData: "nested-user-data-that-must-not-leak",
          agentPayload: "nested-agent-payload-that-must-not-leak",
        },
      },
    })

    const entry = store.auditEntries[0]
    assert.ok(entry)
    // Action identity survives.
    assert.equal(entry.action, "vm.create")
    assert.equal(entry.targetType, "vm_instance")
    assert.equal(entry.metadata?.vmInstanceId, "vm-1")
    assert.equal(entry.metadata?.action, "CREATE")
    assert.equal(entry.metadata?.status, "SUCCEEDED")
    assert.equal(entry.metadata?.endpointId, "endpoint-1")
    assert.equal(entry.metadata?.projectId, "project-1")
    assert.equal(entry.metadata?.tenantId, "tenant-1")
    assert.equal(entry.metadata?.cpuCount, 1)
    assert.equal(entry.metadata?.memoryBytes, 268_435_456)
    assert.equal(entry.metadata?.rootDiskBytes, 5_368_709_120)
    assert.equal(entry.metadata?.addressFamily, "IPV4")
    assert.equal(entry.metadata?.networkPoolId, "pool-1")
    assert.equal(entry.metadata?.summary, "create acknowledged by agent lifecycle protocol")
    // Secret material redacted.
    assert.equal(entry.metadata?.vmConfig, "[REDACTED]")
    assert.equal(entry.metadata?.userData, "[REDACTED]")
    assert.equal(entry.metadata?.cloudInit, "[REDACTED]")
    assert.equal(entry.metadata?.agentResponse, "[REDACTED]")
    assert.equal(entry.metadata?.agentPayload, "[REDACTED]")
    assert.equal(entry.metadata?.incusResponse, "[REDACTED]")
    assert.equal(entry.metadata?.incusPayload, "[REDACTED]")
    assert.equal(entry.metadata?.sshKey, "[REDACTED]")
    assert.equal(entry.metadata?.sshPublicKey, "[REDACTED]")
    assert.equal(entry.metadata?.sshPrivateKey, "[REDACTED]")
    assert.equal(entry.metadata?.privateKeyMaterial, "[REDACTED]")
    assert.equal(
      (entry.metadata?.nested as Record<string, unknown> | undefined)?.userData,
      "[REDACTED]"
    )
    assert.equal(
      (entry.metadata?.nested as Record<string, unknown> | undefined)?.agentPayload,
      "[REDACTED]"
    )

    const serialized = JSON.stringify(store.auditEntries)
    assert.equal(serialized.includes("vm-config-that-must-not-leak"), false)
    assert.equal(serialized.includes("password: must-not-leak"), false)
    assert.equal(serialized.includes("cloud-init-that-must-not-leak"), false)
    assert.equal(serialized.includes("agent-response-that-must-not-leak"), false)
    assert.equal(serialized.includes("agent-payload-that-must-not-leak"), false)
    assert.equal(serialized.includes("incus-response-that-must-not-leak"), false)
    assert.equal(serialized.includes("incus-payload-that-must-not-leak"), false)
    assert.equal(serialized.includes("ssh-key-that-must-not-leak"), false)
    assert.equal(serialized.includes("ssh-public-key-that-must-not-leak"), false)
    assert.equal(serialized.includes("ssh-private-key-that-must-not-leak"), false)
    assert.equal(serialized.includes("private-key-material-that-must-not-leak"), false)
    assert.equal(serialized.includes("nested-user-data-that-must-not-leak"), false)
    assert.equal(serialized.includes("nested-agent-payload-that-must-not-leak"), false)
  })

  test("listAdminAuditEntries redacts lifecycle secret keys before browser output", async () => {
    const store = new TestAuditQueryStore()
    store.addAuditEntry({
      id: "audit-vm-1",
      actor: { id: "admin-1", email: "admin@example.com", name: "Admin User" },
      action: "vm.start",
      targetType: "vm_lifecycle_operation",
      targetId: "op-1",
      metadata: {
        vmInstanceId: "vm-1",
        action: "START",
        status: "SUCCEEDED",
        endpointId: "endpoint-1",
        projectId: "project-1",
        tenantId: "tenant-1",
        vmConfig: "list-vm-config-that-must-not-leak",
        userData: "list-user-data-that-must-not-leak",
        agentPayload: "list-agent-payload-that-must-not-leak",
        incusResponse: "list-incus-response-that-must-not-leak",
        sshPrivateKey: "list-ssh-private-key-that-must-not-leak",
      },
      createdAt: "2026-06-24T00:00:00.000Z",
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
      { targetType: "vm_lifecycle_operation" }
    )

    const entry = result.audit[0]
    assert.ok(entry)
    assert.equal(entry.action, "vm.start")
    assert.equal(entry.metadata?.vmInstanceId, "vm-1")
    assert.equal(entry.metadata?.action, "START")
    assert.equal(entry.metadata?.status, "SUCCEEDED")
    assert.equal(entry.metadata?.vmConfig, "[REDACTED]")
    assert.equal(entry.metadata?.userData, "[REDACTED]")
    assert.equal(entry.metadata?.agentPayload, "[REDACTED]")
    assert.equal(entry.metadata?.incusResponse, "[REDACTED]")
    assert.equal(entry.metadata?.sshPrivateKey, "[REDACTED]")

    const serialized = JSON.stringify(result)
    assert.equal(serialized.includes("list-vm-config-that-must-not-leak"), false)
    assert.equal(serialized.includes("list-user-data-that-must-not-leak"), false)
    assert.equal(serialized.includes("list-agent-payload-that-must-not-leak"), false)
    assert.equal(serialized.includes("list-incus-response-that-must-not-leak"), false)
    assert.equal(serialized.includes("list-ssh-private-key-that-must-not-leak"), false)
  })
})
