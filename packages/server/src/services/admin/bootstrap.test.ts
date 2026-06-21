import assert from "node:assert/strict"
import { describe, test } from "node:test"
import bcrypt from "bcryptjs"
import {
  BootstrapAlreadyCompletedError,
  createBootstrapAdmin,
  getBootstrapStatus,
} from "./bootstrap"
import type {
  AdminAuditEntry,
  AdminDataStore,
  AdminPrincipal,
  CreateBootstrapAdminRecord,
} from "./session"

describe("admin bootstrap service", () => {
  test("reports bootstrap availability before and after first admin creation", async () => {
    const store = new TestAdminStore()

    assert.deepEqual(await getBootstrapStatus(store), {
      bootstrapComplete: false,
      available: true,
    })

    await createBootstrapAdmin(store, {
      email: "admin@example.com",
      name: "Admin User",
      password: "correct horse battery staple",
      teamName: "Primary Team",
    })

    assert.deepEqual(await getBootstrapStatus(store), {
      bootstrapComplete: true,
      available: false,
    })
  })

  test("creates the first admin, default team, owner membership, and audit record without exposing secrets", async () => {
    const store = new TestAdminStore()

    const result = await createBootstrapAdmin(store, {
      email: "Admin@Example.com",
      name: "Admin User",
      password: "correct horse battery staple",
      teamName: "Primary Team",
    })

    assert.deepEqual(result.user, {
      id: "user-1",
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
    })
    assert.equal(result.access.canAdmin, true)
    assert.equal(result.access.globalActions.includes("users:write"), true)
    assert.equal(result.access.teams[0]?.actions.includes("endpoints:write"), true)
    assert.equal(await bcrypt.compare("correct horse battery staple", store.passwordHashFor("user-1")), true)
    assert.deepEqual(store.auditEntries.map((entry) => entry.action), ["bootstrap.create"])

    const serialized = JSON.stringify(result)
    assert.equal(serialized.includes("correct horse battery staple"), false)
    assert.equal(serialized.includes(store.passwordHashFor("user-1")), false)
    assert.equal(serialized.includes("passwordHash"), false)
    assert.equal(serialized.includes("session"), false)
    assert.equal(serialized.includes("token"), false)
  })

  test("blocks repeated bootstrap after the first admin exists", async () => {
    const store = new TestAdminStore()

    await createBootstrapAdmin(store, {
      email: "admin@example.com",
      name: "Admin User",
      password: "correct horse battery staple",
      teamName: "Primary Team",
    })

    await assert.rejects(
      createBootstrapAdmin(store, {
        email: "other@example.com",
        name: "Other Admin",
        password: "correct horse battery staple",
        teamName: "Other Team",
      }),
      BootstrapAlreadyCompletedError
    )
    assert.equal(store.userCount(), 1)
    assert.deepEqual(store.auditEntries.map((entry) => entry.action), ["bootstrap.create"])
  })
})

class TestAdminStore implements AdminDataStore {
  private users = new Map<string, AdminPrincipal & { passwordHash: string }>()
  private bootstrapComplete = false
  readonly auditEntries: AdminAuditEntry[] = []

  async isBootstrapComplete(): Promise<boolean> {
    return this.bootstrapComplete
  }

  async createBootstrapAdmin(record: CreateBootstrapAdminRecord): Promise<AdminPrincipal> {
    if (this.bootstrapComplete) {
      throw new Error("test store bootstrap already complete")
    }

    const user: AdminPrincipal & { passwordHash: string } = {
      id: "user-1",
      email: record.email,
      name: record.name,
      status: "ACTIVE",
      globalRole: "ADMIN",
      teams: [
        {
          id: "team-1",
          name: record.teamName,
          role: "OWNER",
          status: "ACTIVE",
        },
      ],
      passwordHash: record.passwordHash,
    }

    this.users.set(user.id, user)
    this.bootstrapComplete = true
    return user
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

  passwordHashFor(userId: string): string {
    const user = this.users.get(userId)
    assert.ok(user)
    return user.passwordHash
  }

  userCount(): number {
    return this.users.size
  }
}
