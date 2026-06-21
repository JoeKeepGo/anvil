import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { recordAdminAudit } from "./audit"
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
