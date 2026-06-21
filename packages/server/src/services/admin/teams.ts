import { PrismaClient, type Prisma } from "@prisma/client"
import { recordAdminAudit } from "./audit"
import { canPerformGlobalAction, canPerformTeamAction } from "./permissions"
import type { AdminAuditEntry, AdminPrincipal, TeamRole } from "./session"
import { AuthConfigError } from "../auth"

export type ManagedTeamStatus = "ACTIVE" | "ARCHIVED"
export type ManagedMembershipStatus = "ACTIVE" | "REMOVED"

export interface ManagedTeamMember {
  userId: string
  email: string
  role: TeamRole
  status: ManagedMembershipStatus
}

export interface ManagedTeam {
  id: string
  name: string
  status: ManagedTeamStatus
  members: ManagedTeamMember[]
}

export interface AdminTeamManagementStore {
  listTeams(): Promise<ManagedTeam[]>
  getTeam(teamId: string): Promise<ManagedTeam | null>
  findTeamByName(name: string): Promise<ManagedTeam | null>
  createTeamRecord(input: { name: string; status?: ManagedTeamStatus }): Promise<ManagedTeam>
  updateTeamRecord(teamId: string, input: { name?: string; status?: ManagedTeamStatus }): Promise<ManagedTeam>
  getUser(userId: string): Promise<{ id: string; email: string; status: "ACTIVE" | "DISABLED" } | null>
  getMembership(teamId: string, userId: string): Promise<ManagedTeamMember | null>
  addMembershipRecord(input: { teamId: string; userId: string; role: TeamRole }): Promise<ManagedTeamMember>
  updateMembershipRecord(
    teamId: string,
    userId: string,
    input: { role?: TeamRole; status?: ManagedMembershipStatus }
  ): Promise<ManagedTeamMember>
  countActiveOwnersExcluding(teamId: string, userId: string): Promise<number>
  recordAudit(entry: AdminAuditEntry): Promise<void>
}

export class AdminTeamPermissionDeniedError extends Error {
  constructor(message = "Admin team permission denied.") {
    super(message)
    this.name = "AdminTeamPermissionDeniedError"
  }
}

export class DuplicateTeamNameError extends Error {
  constructor(message = "A team with that name already exists.") {
    super(message)
    this.name = "DuplicateTeamNameError"
  }
}

export class ManagedTeamNotFoundError extends Error {
  constructor(message = "Team was not found.") {
    super(message)
    this.name = "ManagedTeamNotFoundError"
  }
}

export class ManagedTeamUserNotFoundError extends Error {
  constructor(message = "User was not found.") {
    super(message)
    this.name = "ManagedTeamUserNotFoundError"
  }
}

export class DisabledTeamMemberError extends Error {
  constructor(message = "User is disabled.") {
    super(message)
    this.name = "DisabledTeamMemberError"
  }
}

export class ArchivedTeamMembershipError extends Error {
  constructor(message = "Team is archived.") {
    super(message)
    this.name = "ArchivedTeamMembershipError"
  }
}

export class TeamMembershipNotFoundError extends Error {
  constructor(message = "Membership was not found.") {
    super(message)
    this.name = "TeamMembershipNotFoundError"
  }
}

export class LastActiveTeamOwnerError extends Error {
  constructor(message = "At least one active team owner must remain.") {
    super(message)
    this.name = "LastActiveTeamOwnerError"
  }
}

export async function listAdminTeams(
  store: AdminTeamManagementStore,
  actor: AdminPrincipal
): Promise<ManagedTeam[]> {
  assertCanReadTeams(actor)
  return store.listTeams()
}

export async function getAdminTeam(
  store: AdminTeamManagementStore,
  actor: AdminPrincipal,
  teamId: string
): Promise<ManagedTeam> {
  assertCanReadTeam(actor, teamId)
  return getExistingTeam(store, teamId)
}

export async function createAdminTeam(
  store: AdminTeamManagementStore,
  actor: AdminPrincipal,
  input: { name: string }
): Promise<ManagedTeam> {
  assertGlobalTeamWrite(actor)
  const name = input.name.trim()
  await assertUniqueTeamName(store, name)

  const team = await store.createTeamRecord({ name })
  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "team.create",
    targetType: "team",
    targetId: team.id,
    teamId: team.id,
    metadata: { name: team.name },
  })

  return team
}

export async function updateAdminTeam(
  store: AdminTeamManagementStore,
  actor: AdminPrincipal,
  teamId: string,
  input: { name?: string }
): Promise<ManagedTeam> {
  assertGlobalTeamWrite(actor)
  await getExistingTeam(store, teamId)
  const name = input.name?.trim()
  if (name !== undefined) {
    await assertUniqueTeamName(store, name, teamId)
  }

  const team = await store.updateTeamRecord(teamId, { name })
  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "team.update",
    targetType: "team",
    targetId: team.id,
    teamId: team.id,
    metadata: { name },
  })

  return team
}

export async function archiveAdminTeam(
  store: AdminTeamManagementStore,
  actor: AdminPrincipal,
  teamId: string
): Promise<ManagedTeam> {
  assertGlobalTeamWrite(actor)
  await getExistingTeam(store, teamId)

  const team = await store.updateTeamRecord(teamId, { status: "ARCHIVED" })
  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "team.archive",
    targetType: "team",
    targetId: team.id,
    teamId: team.id,
    metadata: { status: "ARCHIVED" },
  })

  return team
}

export async function restoreAdminTeam(
  store: AdminTeamManagementStore,
  actor: AdminPrincipal,
  teamId: string
): Promise<ManagedTeam> {
  assertGlobalTeamWrite(actor)
  await getExistingTeam(store, teamId)

  const team = await store.updateTeamRecord(teamId, { status: "ACTIVE" })
  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "team.restore",
    targetType: "team",
    targetId: team.id,
    teamId: team.id,
    metadata: { status: "ACTIVE" },
  })

  return team
}

export async function addTeamMember(
  store: AdminTeamManagementStore,
  actor: AdminPrincipal,
  teamId: string,
  input: { userId: string; role: TeamRole }
): Promise<ManagedTeamMember> {
  assertCanWriteMembers(actor, teamId)
  await assertActiveTeam(store, teamId)
  await assertActiveUser(store, input.userId)

  const existing = await store.getMembership(teamId, input.userId)
  const membership =
    existing === null
      ? await store.addMembershipRecord({ teamId, userId: input.userId, role: input.role })
      : await store.updateMembershipRecord(teamId, input.userId, {
          role: input.role,
          status: "ACTIVE",
        })

  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "team.member.add",
    targetType: "membership",
    targetId: input.userId,
    teamId,
    metadata: { userId: input.userId, role: input.role },
  })

  return membership
}

export async function updateTeamMember(
  store: AdminTeamManagementStore,
  actor: AdminPrincipal,
  teamId: string,
  userId: string,
  input: { role: TeamRole }
): Promise<ManagedTeamMember> {
  assertCanWriteMembers(actor, teamId)
  await assertActiveTeam(store, teamId)
  const membership = await getExistingMembership(store, teamId, userId)
  if (membership.role === "OWNER" && input.role !== "OWNER") {
    await assertOwnerCanChange(store, teamId, userId)
  }

  const updated = await store.updateMembershipRecord(teamId, userId, { role: input.role })
  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "team.member.update",
    targetType: "membership",
    targetId: userId,
    teamId,
    metadata: { userId, role: input.role },
  })

  return updated
}

export async function removeTeamMember(
  store: AdminTeamManagementStore,
  actor: AdminPrincipal,
  teamId: string,
  userId: string
): Promise<ManagedTeamMember> {
  assertCanWriteMembers(actor, teamId)
  await assertActiveTeam(store, teamId)
  const membership = await getExistingMembership(store, teamId, userId)
  if (membership.role === "OWNER") {
    await assertOwnerCanChange(store, teamId, userId)
  }

  const updated = await store.updateMembershipRecord(teamId, userId, { status: "REMOVED" })
  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "team.member.remove",
    targetType: "membership",
    targetId: userId,
    teamId,
    metadata: { userId, status: "REMOVED" },
  })

  return updated
}

export class PrismaAdminTeamManagementStore implements AdminTeamManagementStore {
  constructor(
    private readonly prisma = new PrismaClient(),
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  async listTeams(): Promise<ManagedTeam[]> {
    this.assertDatabaseConfigured()
    const teams = await this.prisma.team.findMany({
      include: teamManagementInclude,
      orderBy: { name: "asc" },
    })
    return teams.map(mapPrismaTeamToManagedTeam)
  }

  async getTeam(teamId: string): Promise<ManagedTeam | null> {
    this.assertDatabaseConfigured()
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      include: teamManagementInclude,
    })
    return team ? mapPrismaTeamToManagedTeam(team) : null
  }

  async findTeamByName(name: string): Promise<ManagedTeam | null> {
    this.assertDatabaseConfigured()
    const team = await this.prisma.team.findUnique({
      where: { name: name.trim() },
      include: teamManagementInclude,
    })
    return team ? mapPrismaTeamToManagedTeam(team) : null
  }

  async createTeamRecord(input: { name: string; status?: ManagedTeamStatus }): Promise<ManagedTeam> {
    this.assertDatabaseConfigured()
    const team = await this.prisma.team.create({
      data: {
        name: input.name,
        status: input.status ?? "ACTIVE",
      },
      include: teamManagementInclude,
    })
    return mapPrismaTeamToManagedTeam(team)
  }

  async updateTeamRecord(
    teamId: string,
    input: { name?: string; status?: ManagedTeamStatus }
  ): Promise<ManagedTeam> {
    this.assertDatabaseConfigured()
    const team = await this.prisma.team.update({
      where: { id: teamId },
      data: {
        name: input.name,
        status: input.status,
      },
      include: teamManagementInclude,
    })
    return mapPrismaTeamToManagedTeam(team)
  }

  async getUser(userId: string): Promise<{ id: string; email: string; status: "ACTIVE" | "DISABLED" } | null> {
    this.assertDatabaseConfigured()
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, status: true },
    })
  }

  async getMembership(teamId: string, userId: string): Promise<ManagedTeamMember | null> {
    this.assertDatabaseConfigured()
    const membership = await this.prisma.teamMembership.findUnique({
      where: { userId_teamId: { userId, teamId } },
      include: { user: { select: { email: true } } },
    })
    return membership ? mapPrismaMembershipToManagedTeamMember(membership) : null
  }

  async addMembershipRecord(input: {
    teamId: string
    userId: string
    role: TeamRole
  }): Promise<ManagedTeamMember> {
    this.assertDatabaseConfigured()
    const membership = await this.prisma.teamMembership.create({
      data: {
        teamId: input.teamId,
        userId: input.userId,
        role: input.role,
        status: "ACTIVE",
      },
      include: { user: { select: { email: true } } },
    })
    return mapPrismaMembershipToManagedTeamMember(membership)
  }

  async updateMembershipRecord(
    teamId: string,
    userId: string,
    input: { role?: TeamRole; status?: ManagedMembershipStatus }
  ): Promise<ManagedTeamMember> {
    this.assertDatabaseConfigured()
    const membership = await this.prisma.teamMembership.update({
      where: { userId_teamId: { userId, teamId } },
      data: {
        role: input.role,
        status: input.status,
      },
      include: { user: { select: { email: true } } },
    })
    return mapPrismaMembershipToManagedTeamMember(membership)
  }

  async countActiveOwnersExcluding(teamId: string, userId: string): Promise<number> {
    this.assertDatabaseConfigured()
    return this.prisma.teamMembership.count({
      where: {
        teamId,
        userId: { not: userId },
        status: "ACTIVE",
        role: "OWNER",
      },
    })
  }

  async recordAudit(entry: AdminAuditEntry): Promise<void> {
    this.assertDatabaseConfigured()
    await this.prisma.auditLog.create({
      data: {
        actorId: entry.actorUserId,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        teamId: entry.teamId,
        metadata: entry.metadata as Prisma.InputJsonValue | undefined,
      },
    })
  }

  private assertDatabaseConfigured(): void {
    if (!this.env.DATABASE_URL || this.env.DATABASE_URL.trim() === "") {
      throw new AuthConfigError()
    }
  }
}

const teamManagementInclude = {
  memberships: {
    include: {
      user: {
        select: {
          email: true,
        },
      },
    },
    orderBy: {
      createdAt: "asc",
    },
  },
} as const

type PrismaManagedTeam = {
  id: string
  name: string
  status: ManagedTeamStatus
  memberships: Array<{
    userId: string
    role: TeamRole
    status: ManagedMembershipStatus
    user: {
      email: string
    }
  }>
}

type PrismaManagedMembership = {
  userId: string
  role: TeamRole
  status: ManagedMembershipStatus
  user: {
    email: string
  }
}

function mapPrismaTeamToManagedTeam(team: PrismaManagedTeam): ManagedTeam {
  return {
    id: team.id,
    name: team.name,
    status: team.status,
    members: team.memberships.map(mapPrismaMembershipToManagedTeamMember),
  }
}

function mapPrismaMembershipToManagedTeamMember(
  membership: PrismaManagedMembership
): ManagedTeamMember {
  return {
    userId: membership.userId,
    email: membership.user.email.trim().toLowerCase(),
    role: membership.role,
    status: membership.status,
  }
}

async function getExistingTeam(
  store: AdminTeamManagementStore,
  teamId: string
): Promise<ManagedTeam> {
  const team = await store.getTeam(teamId)
  if (!team) {
    throw new ManagedTeamNotFoundError()
  }
  return team
}

async function getExistingMembership(
  store: AdminTeamManagementStore,
  teamId: string,
  userId: string
): Promise<ManagedTeamMember> {
  const membership = await store.getMembership(teamId, userId)
  if (!membership) {
    throw new TeamMembershipNotFoundError()
  }
  return membership
}

async function assertUniqueTeamName(
  store: AdminTeamManagementStore,
  name: string,
  allowedTeamId?: string
): Promise<void> {
  const existing = await store.findTeamByName(name)
  if (existing && existing.id !== allowedTeamId) {
    throw new DuplicateTeamNameError()
  }
}

async function assertActiveTeam(
  store: AdminTeamManagementStore,
  teamId: string
): Promise<void> {
  const team = await getExistingTeam(store, teamId)
  if (team.status !== "ACTIVE") {
    throw new ArchivedTeamMembershipError()
  }
}

async function assertActiveUser(
  store: AdminTeamManagementStore,
  userId: string
): Promise<void> {
  const user = await store.getUser(userId)
  if (!user) {
    throw new ManagedTeamUserNotFoundError()
  }
  if (user.status !== "ACTIVE") {
    throw new DisabledTeamMemberError()
  }
}

async function assertOwnerCanChange(
  store: AdminTeamManagementStore,
  teamId: string,
  userId: string
): Promise<void> {
  if ((await store.countActiveOwnersExcluding(teamId, userId)) === 0) {
    throw new LastActiveTeamOwnerError()
  }
}

function assertCanReadTeams(actor: AdminPrincipal): void {
  if (canPerformGlobalAction(actor, "teams:read")) {
    return
  }
  if (actor.teams.some((team) => canPerformTeamAction(actor, team.id, "members:read"))) {
    return
  }
  throw new AdminTeamPermissionDeniedError()
}

function assertCanReadTeam(actor: AdminPrincipal, teamId: string): void {
  if (canPerformGlobalAction(actor, "teams:read") || canPerformTeamAction(actor, teamId, "members:read")) {
    return
  }
  throw new AdminTeamPermissionDeniedError()
}

function assertGlobalTeamWrite(actor: AdminPrincipal): void {
  if (!canPerformGlobalAction(actor, "teams:write")) {
    throw new AdminTeamPermissionDeniedError()
  }
}

function assertCanWriteMembers(actor: AdminPrincipal, teamId: string): void {
  if (canPerformGlobalAction(actor, "teams:write") || canPerformTeamAction(actor, teamId, "members:write")) {
    return
  }
  throw new AdminTeamPermissionDeniedError()
}
