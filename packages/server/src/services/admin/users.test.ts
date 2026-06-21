import assert from "node:assert/strict"
import { describe, test } from "node:test"
import bcrypt from "bcryptjs"
import {
  AdminPermissionDeniedError,
  DuplicateUserEmailError,
  LastActiveAdminError,
  SelfDisableError,
  createAdminUser,
  disableAdminUser,
  listAdminUsers,
  resetAdminUserPassword,
  restoreAdminUser,
  updateAdminUser,
  type AdminUserManagementStore,
  type ManagedUser,
} from "./users"
import type { AdminAuditEntry, AdminPrincipal } from "./session"

const adminActor: AdminPrincipal = {
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

const memberActor: AdminPrincipal = {
  id: "member-1",
  email: "member@example.com",
  name: "Member User",
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

describe("admin user management service", () => {
  test("creates users with normalized email, hashed password, safe response, initial memberships, and audit", async () => {
    const store = new TestAdminUserStore()
    store.addTeam({ id: "team-1", name: "Primary Team", status: "ACTIVE" })

    const result = await createAdminUser(store, adminActor, {
      email: " New.User@Example.com ",
      name: " New User ",
      password: "correct horse battery staple",
      globalRole: "MEMBER",
      memberships: [{ teamId: "team-1", role: "VIEWER" }],
    })

    assert.deepEqual(result, {
      id: "user-1",
      email: "new.user@example.com",
      name: "New User",
      status: "ACTIVE",
      globalRole: "MEMBER",
      teams: [
        {
          id: "team-1",
          name: "Primary Team",
          status: "ACTIVE",
          role: "VIEWER",
          membershipStatus: "ACTIVE",
        },
      ],
    })
    assert.equal(await bcrypt.compare("correct horse battery staple", store.passwordHashFor("user-1")), true)
    assert.deepEqual(store.auditEntries.map((entry) => entry.action), ["user.create"])
    assert.deepEqual(store.auditEntries[0], {
      actorUserId: "admin-1",
      action: "user.create",
      targetType: "user",
      targetId: "user-1",
      metadata: {
        email: "new.user@example.com",
        globalRole: "MEMBER",
        memberships: [{ teamId: "team-1", role: "VIEWER" }],
      },
    })

    const serialized = JSON.stringify(result)
    assert.equal(serialized.includes("correct horse battery staple"), false)
    assert.equal(serialized.includes(store.passwordHashFor("user-1")), false)
    assert.equal(serialized.includes("passwordHash"), false)
    assert.equal(serialized.includes("session"), false)
    assert.equal(serialized.includes("token"), false)
    assert.equal(serialized.includes("privateConfig"), false)
  })

  test("denies user writes without the global users:write capability and blocks duplicate emails", async () => {
    const store = new TestAdminUserStore()
    await store.createUserRecord({
      email: "existing@example.com",
      name: "Existing User",
      passwordHash: "hash",
      globalRole: "MEMBER",
      memberships: [],
    })

    await assert.rejects(
      createAdminUser(store, memberActor, {
        email: "new@example.com",
        name: "New User",
        password: "correct horse battery staple",
        globalRole: "MEMBER",
        memberships: [],
      }),
      AdminPermissionDeniedError
    )
    await assert.rejects(
      createAdminUser(store, adminActor, {
        email: " Existing@Example.com ",
        name: "Duplicate User",
        password: "correct horse battery staple",
        globalRole: "MEMBER",
        memberships: [],
      }),
      DuplicateUserEmailError
    )
    assert.deepEqual(store.auditEntries, [])
  })

  test("lists and updates users without leaking password hashes and audits updates", async () => {
    const store = new TestAdminUserStore()
    await store.createUserRecord({
      email: "member@example.com",
      name: "Member User",
      passwordHash: "hash",
      globalRole: "MEMBER",
      memberships: [],
    })

    const listed = await listAdminUsers(store, adminActor)
    const updated = await updateAdminUser(store, adminActor, "user-1", {
      email: " Renamed@Example.com ",
      name: " Renamed User ",
      globalRole: "ADMIN",
    })

    assert.deepEqual(listed.map((user) => user.email), ["member@example.com"])
    assert.deepEqual(updated, {
      id: "user-1",
      email: "renamed@example.com",
      name: "Renamed User",
      status: "ACTIVE",
      globalRole: "ADMIN",
      teams: [],
    })
    assert.deepEqual(store.auditEntries.map((entry) => entry.action), ["user.update"])
    assert.equal(JSON.stringify(updated).includes("hash"), false)
    assert.equal(JSON.stringify(listed).includes("passwordHash"), false)
  })

  test("protects the last active admin and forbids self-disable while auditing valid disable and restore", async () => {
    const store = new TestAdminUserStore()
    await store.createUserRecord({
      id: "admin-1",
      email: "admin@example.com",
      name: "Admin User",
      passwordHash: "hash",
      globalRole: "ADMIN",
      memberships: [],
    })

    await assert.rejects(disableAdminUser(store, adminActor, "admin-1"), SelfDisableError)
    await assert.rejects(disableAdminUser(store, { ...adminActor, id: "admin-2" }, "admin-1"), LastActiveAdminError)

    await store.createUserRecord({
      id: "admin-2",
      email: "other-admin@example.com",
      name: "Other Admin",
      passwordHash: "hash",
      globalRole: "ADMIN",
      memberships: [],
    })

    const disabled = await disableAdminUser(store, { ...adminActor, id: "admin-2" }, "admin-1")
    const restored = await restoreAdminUser(store, { ...adminActor, id: "admin-2" }, "admin-1")

    assert.equal(disabled.status, "DISABLED")
    assert.equal(restored.status, "ACTIVE")
    assert.deepEqual(store.auditEntries.map((entry) => entry.action), ["user.disable", "user.restore"])
  })

  test("prevents demoting the last active admin", async () => {
    const store = new TestAdminUserStore()
    await store.createUserRecord({
      id: "admin-1",
      email: "admin@example.com",
      name: "Admin User",
      passwordHash: "hash",
      globalRole: "ADMIN",
      memberships: [],
    })

    await assert.rejects(
      updateAdminUser(store, { ...adminActor, id: "admin-2" }, "admin-1", {
        globalRole: "MEMBER",
      }),
      LastActiveAdminError
    )
    assert.deepEqual(store.auditEntries, [])
  })

  test("resets passwords for active users only and redacts reset metadata", async () => {
    const store = new TestAdminUserStore()
    await store.createUserRecord({
      email: "member@example.com",
      name: "Member User",
      passwordHash: await bcrypt.hash("old password value", 4),
      globalRole: "MEMBER",
      memberships: [],
    })

    const result = await resetAdminUserPassword(store, adminActor, "user-1", {
      password: "new correct horse battery staple",
    })

    assert.deepEqual(result, { ok: true })
    assert.equal(await bcrypt.compare("new correct horse battery staple", store.passwordHashFor("user-1")), true)
    assert.deepEqual(store.auditEntries, [
      {
        actorUserId: "admin-1",
        action: "user.resetPassword",
        targetType: "user",
        targetId: "user-1",
        metadata: { password: "[REDACTED]" },
      },
    ])

    await disableAdminUser(store, adminActor, "user-1")
    await assert.rejects(
      resetAdminUserPassword(store, adminActor, "user-1", {
        password: "another correct horse battery staple",
      }),
      { name: "DisabledManagedUserError" }
    )
  })
})

interface TestTeam {
  id: string
  name: string
  status: "ACTIVE" | "ARCHIVED"
}

class TestAdminUserStore implements AdminUserManagementStore {
  private users = new Map<string, ManagedUser & { passwordHash: string }>()
  private teams = new Map<string, TestTeam>()
  private nextUserNumber = 1
  readonly auditEntries: AdminAuditEntry[] = []

  async listUsers(): Promise<ManagedUser[]> {
    return [...this.users.values()]
      .map(stripPasswordHash)
      .sort((left, right) => left.email.localeCompare(right.email))
  }

  async getUser(userId: string): Promise<ManagedUser | null> {
    const user = this.users.get(userId)
    return user ? stripPasswordHash(user) : null
  }

  async findUserByEmail(email: string): Promise<ManagedUser | null> {
    const normalized = email.trim().toLowerCase()
    const user = [...this.users.values()].find((candidate) => candidate.email === normalized)
    return user ? stripPasswordHash(user) : null
  }

  async createUserRecord(input: {
    id?: string
    email: string
    name: string
    passwordHash: string
    globalRole: "ADMIN" | "MEMBER"
    memberships: Array<{ teamId: string; role: "OWNER" | "MAINTAINER" | "VIEWER" }>
  }): Promise<ManagedUser> {
    const id = input.id ?? `user-${this.nextUserNumber++}`
    const user: ManagedUser & { passwordHash: string } = {
      id,
      email: input.email.trim().toLowerCase(),
      name: input.name.trim(),
      status: "ACTIVE",
      globalRole: input.globalRole,
      teams: input.memberships.map((membership) => {
        const team = this.teams.get(membership.teamId)
        assert.ok(team)
        return {
          id: team.id,
          name: team.name,
          status: team.status,
          role: membership.role,
          membershipStatus: "ACTIVE",
        }
      }),
      passwordHash: input.passwordHash,
    }
    this.users.set(id, user)
    return stripPasswordHash(user)
  }

  async updateUserRecord(
    userId: string,
    input: {
      email?: string
      name?: string
      status?: "ACTIVE" | "DISABLED"
      globalRole?: "ADMIN" | "MEMBER"
      passwordHash?: string
    }
  ): Promise<ManagedUser> {
    const user = this.users.get(userId)
    assert.ok(user)
    const updated = {
      ...user,
      email: input.email ?? user.email,
      name: input.name ?? user.name,
      status: input.status ?? user.status,
      globalRole: input.globalRole ?? user.globalRole,
      passwordHash: input.passwordHash ?? user.passwordHash,
    }
    this.users.set(userId, updated)
    return stripPasswordHash(updated)
  }

  async getTeam(teamId: string) {
    return this.teams.get(teamId) ?? null
  }

  async countActiveAdminsExcluding(userId: string): Promise<number> {
    return [...this.users.values()].filter(
      (user) => user.id !== userId && user.status === "ACTIVE" && user.globalRole === "ADMIN"
    ).length
  }

  async recordAudit(entry: AdminAuditEntry): Promise<void> {
    this.auditEntries.push(entry)
  }

  addTeam(team: TestTeam): void {
    this.teams.set(team.id, team)
  }

  passwordHashFor(userId: string): string {
    const user = this.users.get(userId)
    assert.ok(user)
    return user.passwordHash
  }
}

function stripPasswordHash(user: ManagedUser & { passwordHash: string }): ManagedUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    status: user.status,
    globalRole: user.globalRole,
    teams: user.teams.map((team) => ({ ...team })),
  }
}
