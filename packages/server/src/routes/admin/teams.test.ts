import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createTeamRoutes } from "./teams"
import { signAdminSession } from "../../services/admin/session"
import type {
  AdminAuditEntry,
  AdminDataStore,
  AdminPrincipal,
  CreateBootstrapAdminRecord,
  TeamRole,
} from "../../services/admin/session"
import type { AdminTeamManagementStore, ManagedTeam } from "../../services/admin/teams"

const sessionSecret = "test-session-secret-with-enough-entropy"

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
      status: "ACTIVE",
      role: "OWNER",
    },
  ],
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

describe("admin team routes", () => {
  test("runs team CRUD routes with audit and safe response shapes", async () => {
    const teamStore = new TestTeamRouteStore()
    const routes = createTeamRoutes({
      env: { ANVIL_SESSION_SECRET: sessionSecret },
      sessionStore: new TestSessionStore(globalAdmin),
      teamStore,
    })
    const cookie = sessionCookie(globalAdmin)

    const created = await routes.request("/", {
      method: "POST",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ name: "Primary Team" }),
    })
    const listed = await routes.request("/", { headers: { cookie } })
    const detail = await routes.request("/team-1", { headers: { cookie } })
    const updated = await routes.request("/team-1", {
      method: "PATCH",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ name: "Renamed Team" }),
    })
    const archived = await routes.request("/team-1/archive", {
      method: "POST",
      headers: { cookie },
    })
    const restored = await routes.request("/team-1/restore", {
      method: "POST",
      headers: { cookie },
    })

    assert.equal(created.status, 201)
    assert.equal(listed.status, 200)
    assert.equal(detail.status, 200)
    assert.equal(updated.status, 200)
    assert.equal(archived.status, 200)
    assert.equal(restored.status, 200)
    assert.deepEqual(await readJson(created), {
      team: {
        id: "team-1",
        name: "Primary Team",
        status: "ACTIVE",
        members: [],
      },
    })
    assert.deepEqual(await readJson(listed), {
      teams: [
        {
          id: "team-1",
          name: "Primary Team",
          status: "ACTIVE",
          members: [],
        },
      ],
    })
    assert.equal(JSON.stringify(await readJson(detail)).includes("password"), false)
    assert.equal(JSON.stringify(await readJson(updated)).includes(sessionSecret), false)
    assert.deepEqual(teamStore.auditEntries.map((entry) => entry.action), [
      "team.create",
      "team.update",
      "team.archive",
      "team.restore",
    ])
  })

  test("allows owner-scoped membership mutations and denies viewers", async () => {
    const teamStore = new TestTeamRouteStore()
    await teamStore.createTeamRecord({ id: "team-1", name: "Primary Team" })
    teamStore.addUser({ id: "owner-1", email: "owner@example.com", status: "ACTIVE" })
    teamStore.addUser({ id: "member-1", email: "member@example.com", status: "ACTIVE" })
    await teamStore.addMembershipRecord({ teamId: "team-1", userId: "owner-1", role: "OWNER" })

    const ownerRoutes = createTeamRoutes({
      env: { ANVIL_SESSION_SECRET: sessionSecret },
      sessionStore: new TestSessionStore(teamOwner),
      teamStore,
    })
    const ownerCookie = sessionCookie(teamOwner)

    const added = await ownerRoutes.request("/team-1/members", {
      method: "POST",
      headers: jsonHeaders(ownerCookie),
      body: JSON.stringify({ userId: "member-1", role: "VIEWER" }),
    })
    const updated = await ownerRoutes.request("/team-1/members/member-1", {
      method: "PATCH",
      headers: jsonHeaders(ownerCookie),
      body: JSON.stringify({ role: "MAINTAINER" }),
    })
    const removed = await ownerRoutes.request("/team-1/members/member-1/remove", {
      method: "POST",
      headers: { cookie: ownerCookie },
    })

    assert.equal(added.status, 201)
    assert.equal(updated.status, 200)
    assert.equal(removed.status, 200)
    assert.deepEqual(await readJson(added), {
      member: {
        userId: "member-1",
        email: "member@example.com",
        role: "VIEWER",
        status: "ACTIVE",
      },
    })
    assert.deepEqual(teamStore.auditEntries.map((entry) => entry.action), [
      "team.member.add",
      "team.member.update",
      "team.member.remove",
    ])

    const viewerRoutes = createTeamRoutes({
      env: { ANVIL_SESSION_SECRET: sessionSecret },
      sessionStore: new TestSessionStore(teamViewer),
      teamStore,
    })
    const denied = await viewerRoutes.request("/team-1/members", {
      method: "POST",
      headers: jsonHeaders(sessionCookie(teamViewer)),
      body: JSON.stringify({ userId: "member-1", role: "VIEWER" }),
    })

    assert.equal(denied.status, 403)
    assert.deepEqual(await readJson(denied), {
      error: {
        code: "ADMIN_FORBIDDEN",
        message: "Admin permission denied.",
        details: {},
      },
    })
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

class TestTeamRouteStore implements AdminTeamManagementStore {
  private teams = new Map<string, ManagedTeam>()
  private users = new Map<string, TestUser>()
  private memberships = new Map<string, TestMembership>()
  readonly auditEntries: AdminAuditEntry[] = []

  async listTeams(): Promise<ManagedTeam[]> {
    return [...this.teams.values()].map((team) => ({ ...team, members: this.membersFor(team.id) }))
  }

  async getTeam(teamId: string): Promise<ManagedTeam | null> {
    const team = this.teams.get(teamId)
    return team ? { ...team, members: this.membersFor(team.id) } : null
  }

  async findTeamByName(name: string): Promise<ManagedTeam | null> {
    const normalized = name.trim().toLowerCase()
    const team = [...this.teams.values()].find((candidate) => candidate.name.toLowerCase() === normalized)
    return team ? { ...team, members: this.membersFor(team.id) } : null
  }

  async createTeamRecord(input: {
    id?: string
    name: string
    status?: "ACTIVE" | "ARCHIVED"
  }): Promise<ManagedTeam> {
    const team: ManagedTeam = {
      id: input.id ?? "team-1",
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
      members: this.membersFor(teamId),
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
  }) {
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
  ) {
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

  private membersFor(teamId: string) {
    return [...this.memberships.values()]
      .filter((membership) => membership.teamId === teamId)
      .map(stripTeamId)
  }
}

function stripTeamId(membership: TestMembership): Omit<TestMembership, "teamId"> {
  return {
    userId: membership.userId,
    email: membership.email,
    role: membership.role,
    status: membership.status,
  }
}

function membershipKey(teamId: string, userId: string): string {
  return `${teamId}:${userId}`
}

function sessionCookie(principal: AdminPrincipal): string {
  return `anvil_session=${signAdminSession({ ANVIL_SESSION_SECRET: sessionSecret }, principal)}`
}

function jsonHeaders(cookie: string): HeadersInit {
  return {
    cookie,
    "content-type": "application/json",
  }
}

async function readJson(response: Response): Promise<unknown> {
  return response.json()
}
