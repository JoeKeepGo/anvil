import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  AdminTeamPermissionDeniedError,
  ArchivedTeamMembershipError,
  DuplicateTeamNameError,
  LastActiveTeamOwnerError,
  addTeamMember,
  archiveAdminTeam,
  createAdminTeam,
  listAdminTeams,
  removeTeamMember,
  restoreAdminTeam,
  updateAdminTeam,
  updateTeamMember,
  type AdminTeamManagementStore,
  type ManagedTeam,
} from "./teams"
import type { AdminAuditEntry, AdminPrincipal, TeamRole } from "./session"

const globalAdmin: AdminPrincipal = {
  id: "admin-1",
  email: "admin@example.com",
  name: "Admin User",
  status: "ACTIVE",
  globalRole: "ADMIN",
  teams: [],
}

const teamOwner: AdminPrincipal = {
  id: "owner-1",
  email: "owner@example.com",
  name: "Team Owner",
  status: "ACTIVE",
  globalRole: "MEMBER",
  teams: [
    {
      id: "team-1",
      name: "Primary Team",
      status: "ACTIVE",
      role: "OWNER",
    },
  ],
}

const teamViewer: AdminPrincipal = {
  id: "viewer-1",
  email: "viewer@example.com",
  name: "Team Viewer",
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

describe("admin team management service", () => {
  test("creates, lists, updates, archives, and restores teams with global permission and audit", async () => {
    const store = new TestAdminTeamStore()

    const created = await createAdminTeam(store, globalAdmin, { name: " Primary Team " })
    const listed = await listAdminTeams(store, globalAdmin)
    const updated = await updateAdminTeam(store, globalAdmin, created.id, { name: " Renamed Team " })
    const archived = await archiveAdminTeam(store, globalAdmin, created.id)
    const restored = await restoreAdminTeam(store, globalAdmin, created.id)

    assert.equal(created.name, "Primary Team")
    assert.deepEqual(listed.map((team) => team.name), ["Primary Team"])
    assert.equal(updated.name, "Renamed Team")
    assert.equal(archived.status, "ARCHIVED")
    assert.equal(restored.status, "ACTIVE")
    assert.deepEqual(store.auditEntries.map((entry) => entry.action), [
      "team.create",
      "team.update",
      "team.archive",
      "team.restore",
    ])
  })

  test("denies team writes without global teams:write and blocks duplicate team names", async () => {
    const store = new TestAdminTeamStore()
    await store.createTeamRecord({ name: "Primary Team" })

    await assert.rejects(createAdminTeam(store, teamViewer, { name: "Other Team" }), AdminTeamPermissionDeniedError)
    await assert.rejects(createAdminTeam(store, globalAdmin, { name: " primary team " }), DuplicateTeamNameError)
    assert.deepEqual(store.auditEntries, [])
  })

  test("allows team owners to add, update, and softly remove members with audit", async () => {
    const store = new TestAdminTeamStore()
    await store.createTeamRecord({ id: "team-1", name: "Primary Team" })
    store.addUser({ id: "owner-1", email: "owner@example.com", status: "ACTIVE" })
    store.addUser({ id: "member-1", email: "member@example.com", status: "ACTIVE" })
    await store.addMembershipRecord({ teamId: "team-1", userId: "owner-1", role: "OWNER" })

    const added = await addTeamMember(store, teamOwner, "team-1", {
      userId: "member-1",
      role: "VIEWER",
    })
    const updated = await updateTeamMember(store, teamOwner, "team-1", "member-1", {
      role: "MAINTAINER",
    })
    const removed = await removeTeamMember(store, teamOwner, "team-1", "member-1")

    assert.deepEqual(added, {
      userId: "member-1",
      email: "member@example.com",
      role: "VIEWER",
      status: "ACTIVE",
    })
    assert.equal(updated.role, "MAINTAINER")
    assert.equal(removed.status, "REMOVED")
    assert.deepEqual(store.auditEntries.map((entry) => entry.action), [
      "team.member.add",
      "team.member.update",
      "team.member.remove",
    ])
    assert.deepEqual(store.auditEntries.map((entry) => entry.teamId), ["team-1", "team-1", "team-1"])
  })

  test("denies scoped member writes for viewers and archived teams", async () => {
    const store = new TestAdminTeamStore()
    await store.createTeamRecord({ id: "team-1", name: "Primary Team" })
    await store.createTeamRecord({ id: "team-2", name: "Archived Team", status: "ARCHIVED" })
    store.addUser({ id: "member-1", email: "member@example.com", status: "ACTIVE" })

    await assert.rejects(
      addTeamMember(store, teamViewer, "team-1", { userId: "member-1", role: "VIEWER" }),
      AdminTeamPermissionDeniedError
    )
    await assert.rejects(
      addTeamMember(store, globalAdmin, "team-2", { userId: "member-1", role: "VIEWER" }),
      ArchivedTeamMembershipError
    )
    assert.deepEqual(store.auditEntries, [])
  })

  test("protects the last active owner membership", async () => {
    const store = new TestAdminTeamStore()
    await store.createTeamRecord({ id: "team-1", name: "Primary Team" })
    store.addUser({ id: "owner-1", email: "owner@example.com", status: "ACTIVE" })
    await store.addMembershipRecord({ teamId: "team-1", userId: "owner-1", role: "OWNER" })

    await assert.rejects(
      updateTeamMember(store, globalAdmin, "team-1", "owner-1", { role: "VIEWER" }),
      LastActiveTeamOwnerError
    )
    await assert.rejects(removeTeamMember(store, globalAdmin, "team-1", "owner-1"), LastActiveTeamOwnerError)
    assert.deepEqual(store.auditEntries, [])
  })
})

interface TestUser {
  id: string
  email: string
  status: "ACTIVE" | "DISABLED"
}

interface TestMembership {
  teamId: string
  userId: string
  email: string
  role: TeamRole
  status: "ACTIVE" | "REMOVED"
}

class TestAdminTeamStore implements AdminTeamManagementStore {
  private teams = new Map<string, ManagedTeam>()
  private users = new Map<string, TestUser>()
  private memberships = new Map<string, TestMembership>()
  private nextTeamNumber = 1
  readonly auditEntries: AdminAuditEntry[] = []

  async listTeams(): Promise<ManagedTeam[]> {
    return [...this.teams.values()]
      .map((team) => ({ ...team }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  async getTeam(teamId: string): Promise<ManagedTeam | null> {
    const team = this.teams.get(teamId)
    return team ? { ...team } : null
  }

  async findTeamByName(name: string): Promise<ManagedTeam | null> {
    const normalized = name.trim().toLowerCase()
    const team = [...this.teams.values()].find((candidate) => candidate.name.toLowerCase() === normalized)
    return team ? { ...team } : null
  }

  async createTeamRecord(input: {
    id?: string
    name: string
    status?: "ACTIVE" | "ARCHIVED"
  }): Promise<ManagedTeam> {
    const team: ManagedTeam = {
      id: input.id ?? `team-${this.nextTeamNumber++}`,
      name: input.name.trim(),
      status: input.status ?? "ACTIVE",
      members: [],
    }
    this.teams.set(team.id, team)
    return { ...team }
  }

  async updateTeamRecord(
    teamId: string,
    input: { name?: string; status?: "ACTIVE" | "ARCHIVED" }
  ): Promise<ManagedTeam> {
    const team = this.teams.get(teamId)
    assert.ok(team)
    const updated = {
      ...team,
      name: input.name ?? team.name,
      status: input.status ?? team.status,
    }
    this.teams.set(teamId, updated)
    return { ...updated }
  }

  async getUser(userId: string): Promise<TestUser | null> {
    return this.users.get(userId) ?? null
  }

  async getMembership(teamId: string, userId: string) {
    const membership = this.memberships.get(membershipKey(teamId, userId))
    return membership ? stripTeamId(membership) : null
  }

  async addMembershipRecord(input: {
    teamId: string
    userId: string
    role: TeamRole
  }): Promise<Omit<TestMembership, "teamId">> {
    const user = this.users.get(input.userId)
    assert.ok(user)
    const membership: TestMembership = {
      teamId: input.teamId,
      userId: input.userId,
      email: user.email,
      role: input.role,
      status: "ACTIVE",
    }
    this.memberships.set(membershipKey(input.teamId, input.userId), membership)
    return stripTeamId(membership)
  }

  async updateMembershipRecord(
    teamId: string,
    userId: string,
    input: { role?: TeamRole; status?: "ACTIVE" | "REMOVED" }
  ): Promise<Omit<TestMembership, "teamId">> {
    const membership = this.memberships.get(membershipKey(teamId, userId))
    assert.ok(membership)
    const updated = {
      ...membership,
      role: input.role ?? membership.role,
      status: input.status ?? membership.status,
    }
    this.memberships.set(membershipKey(teamId, userId), updated)
    return stripTeamId(updated)
  }

  async countActiveOwnersExcluding(teamId: string, userId: string): Promise<number> {
    return [...this.memberships.values()].filter(
      (membership) =>
        membership.teamId === teamId &&
        membership.userId !== userId &&
        membership.status === "ACTIVE" &&
        membership.role === "OWNER"
    ).length
  }

  async recordAudit(entry: AdminAuditEntry): Promise<void> {
    this.auditEntries.push(entry)
  }

  addUser(user: TestUser): void {
    this.users.set(user.id, user)
  }
}

function membershipKey(teamId: string, userId: string): string {
  return `${teamId}:${userId}`
}

function stripTeamId(membership: TestMembership): Omit<TestMembership, "teamId"> {
  return {
    userId: membership.userId,
    email: membership.email,
    role: membership.role,
    status: membership.status,
  }
}
