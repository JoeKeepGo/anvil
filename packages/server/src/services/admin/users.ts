import bcrypt from "bcryptjs"
import { PrismaClient, type Prisma } from "@prisma/client"
import { recordAdminAudit } from "./audit"
import { canPerformGlobalAction } from "./permissions"
import type { AdminAuditEntry, AdminPrincipal, GlobalRole, TeamRole } from "./session"
import { AuthConfigError } from "../auth"

export type ManagedUserStatus = "ACTIVE" | "DISABLED"
export type ManagedTeamStatus = "ACTIVE" | "ARCHIVED"
export type ManagedMembershipStatus = "ACTIVE" | "REMOVED"

export interface ManagedUserTeam {
  id: string
  name: string
  status: ManagedTeamStatus
  role: TeamRole
  membershipStatus: ManagedMembershipStatus
}

export interface ManagedUser {
  id: string
  email: string
  name: string
  status: ManagedUserStatus
  globalRole: GlobalRole
  teams: ManagedUserTeam[]
}

export interface AdminUserManagementStore {
  listUsers(): Promise<ManagedUser[]>
  getUser(userId: string): Promise<ManagedUser | null>
  findUserByEmail(email: string): Promise<ManagedUser | null>
  createUserRecord(input: {
    email: string
    name: string
    passwordHash: string
    globalRole: GlobalRole
    memberships: Array<{ teamId: string; role: TeamRole }>
  }): Promise<ManagedUser>
  updateUserRecord(
    userId: string,
    input: {
      email?: string
      name?: string
      status?: ManagedUserStatus
      globalRole?: GlobalRole
      passwordHash?: string
    }
  ): Promise<ManagedUser>
  getTeam(teamId: string): Promise<{ id: string; name: string; status: ManagedTeamStatus } | null>
  countActiveAdminsExcluding(userId: string): Promise<number>
  recordAudit(entry: AdminAuditEntry): Promise<void>
}

export interface CreateAdminUserInput {
  email: string
  name: string
  password: string
  globalRole: GlobalRole
  memberships?: Array<{ teamId: string; role: TeamRole }>
}

export interface UpdateAdminUserInput {
  email?: string
  name?: string
  globalRole?: GlobalRole
  status?: ManagedUserStatus
}

export interface ResetAdminUserPasswordInput {
  password: string
}

export class AdminPermissionDeniedError extends Error {
  constructor(message = "Admin permission denied.") {
    super(message)
    this.name = "AdminPermissionDeniedError"
  }
}

export class DuplicateUserEmailError extends Error {
  constructor(message = "A user with that email already exists.") {
    super(message)
    this.name = "DuplicateUserEmailError"
  }
}

export class ManagedUserNotFoundError extends Error {
  constructor(message = "User was not found.") {
    super(message)
    this.name = "ManagedUserNotFoundError"
  }
}

export class DisabledManagedUserError extends Error {
  constructor(message = "User is disabled.") {
    super(message)
    this.name = "DisabledManagedUserError"
  }
}

export class ManagedTeamNotFoundError extends Error {
  constructor(message = "Team was not found.") {
    super(message)
    this.name = "ManagedTeamNotFoundError"
  }
}

export class ArchivedManagedTeamError extends Error {
  constructor(message = "Team is archived.") {
    super(message)
    this.name = "ArchivedManagedTeamError"
  }
}

export class LastActiveAdminError extends Error {
  constructor(message = "At least one active admin must remain.") {
    super(message)
    this.name = "LastActiveAdminError"
  }
}

export class SelfDisableError extends Error {
  constructor(message = "Users cannot disable themselves.") {
    super(message)
    this.name = "SelfDisableError"
  }
}

export async function listAdminUsers(
  store: AdminUserManagementStore,
  actor: AdminPrincipal
): Promise<ManagedUser[]> {
  assertGlobalPermission(actor, "users:read")
  return store.listUsers()
}

export async function getAdminUser(
  store: AdminUserManagementStore,
  actor: AdminPrincipal,
  userId: string
): Promise<ManagedUser> {
  assertGlobalPermission(actor, "users:read")
  return getExistingUser(store, userId)
}

export async function createAdminUser(
  store: AdminUserManagementStore,
  actor: AdminPrincipal,
  input: CreateAdminUserInput
): Promise<ManagedUser> {
  assertGlobalPermission(actor, "users:write")

  const email = normalizeEmail(input.email)
  await assertUniqueEmail(store, email)
  const memberships = input.memberships ?? []
  for (const membership of memberships) {
    await assertActiveTeam(store, membership.teamId)
  }

  const user = await store.createUserRecord({
    email,
    name: input.name.trim(),
    passwordHash: await bcrypt.hash(input.password, 12),
    globalRole: input.globalRole,
    memberships,
  })

  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "user.create",
    targetType: "user",
    targetId: user.id,
    metadata: {
      email: user.email,
      globalRole: user.globalRole,
      memberships,
    },
  })

  return user
}

export async function updateAdminUser(
  store: AdminUserManagementStore,
  actor: AdminPrincipal,
  userId: string,
  input: UpdateAdminUserInput
): Promise<ManagedUser> {
  assertGlobalPermission(actor, "users:write")
  const existingUser = await getExistingUser(store, userId)

  const email = input.email === undefined ? undefined : normalizeEmail(input.email)
  if (email !== undefined) {
    await assertUniqueEmail(store, email, userId)
  }

  const demotesActiveAdmin = existingUserBecomesNonAdmin(existingUser, input)
  if (input.status === "DISABLED" || demotesActiveAdmin) {
    await assertCanDisableUser(store, actor, userId)
  }

  const user = await store.updateUserRecord(userId, {
    email,
    name: input.name?.trim(),
    status: input.status,
    globalRole: input.globalRole,
  })

  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "user.update",
    targetType: "user",
    targetId: user.id,
    metadata: {
      email,
      name: input.name?.trim(),
      status: input.status,
      globalRole: input.globalRole,
    },
  })

  return user
}

export async function disableAdminUser(
  store: AdminUserManagementStore,
  actor: AdminPrincipal,
  userId: string
): Promise<ManagedUser> {
  assertGlobalPermission(actor, "users:write")
  await getExistingUser(store, userId)
  await assertCanDisableUser(store, actor, userId)

  const user = await store.updateUserRecord(userId, { status: "DISABLED" })
  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "user.disable",
    targetType: "user",
    targetId: user.id,
    metadata: { status: "DISABLED" },
  })

  return user
}

export async function restoreAdminUser(
  store: AdminUserManagementStore,
  actor: AdminPrincipal,
  userId: string
): Promise<ManagedUser> {
  assertGlobalPermission(actor, "users:write")
  await getExistingUser(store, userId)

  const user = await store.updateUserRecord(userId, { status: "ACTIVE" })
  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "user.restore",
    targetType: "user",
    targetId: user.id,
    metadata: { status: "ACTIVE" },
  })

  return user
}

export async function resetAdminUserPassword(
  store: AdminUserManagementStore,
  actor: AdminPrincipal,
  userId: string,
  input: ResetAdminUserPasswordInput
): Promise<{ ok: true }> {
  assertGlobalPermission(actor, "users:write")
  const user = await getExistingUser(store, userId)
  if (user.status !== "ACTIVE") {
    throw new DisabledManagedUserError()
  }

  await store.updateUserRecord(userId, {
    passwordHash: await bcrypt.hash(input.password, 12),
  })
  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "user.resetPassword",
    targetType: "user",
    targetId: userId,
    metadata: { password: input.password },
  })

  return { ok: true }
}

export class PrismaAdminUserManagementStore implements AdminUserManagementStore {
  constructor(
    private readonly prisma = new PrismaClient(),
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  async listUsers(): Promise<ManagedUser[]> {
    this.assertDatabaseConfigured()
    const users = await this.prisma.user.findMany({
      include: userManagementInclude,
      orderBy: { email: "asc" },
    })
    return users.map(mapPrismaUserToManagedUser)
  }

  async getUser(userId: string): Promise<ManagedUser | null> {
    this.assertDatabaseConfigured()
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: userManagementInclude,
    })
    return user ? mapPrismaUserToManagedUser(user) : null
  }

  async findUserByEmail(email: string): Promise<ManagedUser | null> {
    this.assertDatabaseConfigured()
    const user = await this.prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
      include: userManagementInclude,
    })
    return user ? mapPrismaUserToManagedUser(user) : null
  }

  async createUserRecord(input: {
    email: string
    name: string
    passwordHash: string
    globalRole: GlobalRole
    memberships: Array<{ teamId: string; role: TeamRole }>
  }): Promise<ManagedUser> {
    this.assertDatabaseConfigured()
    const user = await this.prisma.user.create({
      data: {
        email: normalizeEmail(input.email),
        name: input.name,
        passwordHash: input.passwordHash,
        globalRole: input.globalRole,
        status: "ACTIVE",
        memberships: {
          create: input.memberships.map((membership) => ({
            teamId: membership.teamId,
            role: membership.role,
            status: "ACTIVE",
          })),
        },
      },
      include: userManagementInclude,
    })
    return mapPrismaUserToManagedUser(user)
  }

  async updateUserRecord(
    userId: string,
    input: {
      email?: string
      name?: string
      status?: ManagedUserStatus
      globalRole?: GlobalRole
      passwordHash?: string
    }
  ): Promise<ManagedUser> {
    this.assertDatabaseConfigured()
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        email: input.email,
        name: input.name,
        status: input.status,
        globalRole: input.globalRole,
        passwordHash: input.passwordHash,
      },
      include: userManagementInclude,
    })
    return mapPrismaUserToManagedUser(user)
  }

  async getTeam(teamId: string): Promise<{ id: string; name: string; status: ManagedTeamStatus } | null> {
    this.assertDatabaseConfigured()
    return this.prisma.team.findUnique({
      where: { id: teamId },
      select: { id: true, name: true, status: true },
    })
  }

  async countActiveAdminsExcluding(userId: string): Promise<number> {
    this.assertDatabaseConfigured()
    return this.prisma.user.count({
      where: {
        id: { not: userId },
        status: "ACTIVE",
        globalRole: "ADMIN",
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
        targetUserId: entry.targetType === "user" ? entry.targetId : undefined,
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

const userManagementInclude = {
  memberships: {
    include: {
      team: true,
    },
    orderBy: {
      createdAt: "asc",
    },
  },
} as const

type PrismaManagedUser = {
  id: string
  email: string
  name: string
  status: ManagedUserStatus
  globalRole: GlobalRole
  memberships: Array<{
    role: TeamRole
    status: ManagedMembershipStatus
    team: {
      id: string
      name: string
      status: ManagedTeamStatus
    }
  }>
}

function mapPrismaUserToManagedUser(user: PrismaManagedUser): ManagedUser {
  return {
    id: user.id,
    email: normalizeEmail(user.email),
    name: user.name,
    status: user.status,
    globalRole: user.globalRole,
    teams: user.memberships.map((membership) => ({
      id: membership.team.id,
      name: membership.team.name,
      status: membership.team.status,
      role: membership.role,
      membershipStatus: membership.status,
    })),
  }
}

async function getExistingUser(
  store: AdminUserManagementStore,
  userId: string
): Promise<ManagedUser> {
  const user = await store.getUser(userId)
  if (!user) {
    throw new ManagedUserNotFoundError()
  }
  return user
}

async function assertUniqueEmail(
  store: AdminUserManagementStore,
  email: string,
  allowedUserId?: string
): Promise<void> {
  const existing = await store.findUserByEmail(email)
  if (existing && existing.id !== allowedUserId) {
    throw new DuplicateUserEmailError()
  }
}

async function assertActiveTeam(
  store: AdminUserManagementStore,
  teamId: string
): Promise<void> {
  const team = await store.getTeam(teamId)
  if (!team) {
    throw new ManagedTeamNotFoundError()
  }
  if (team.status !== "ACTIVE") {
    throw new ArchivedManagedTeamError()
  }
}

async function assertCanDisableUser(
  store: AdminUserManagementStore,
  actor: AdminPrincipal,
  userId: string
): Promise<void> {
  if (actor.id === userId) {
    throw new SelfDisableError()
  }
  if ((await store.countActiveAdminsExcluding(userId)) === 0) {
    const target = await store.getUser(userId)
    if (target?.globalRole === "ADMIN" && target.status === "ACTIVE") {
      throw new LastActiveAdminError()
    }
  }
}

function assertGlobalPermission(actor: AdminPrincipal, action: "users:read" | "users:write"): void {
  if (!canPerformGlobalAction(actor, action)) {
    throw new AdminPermissionDeniedError()
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function existingUserBecomesNonAdmin(
  user: ManagedUser | null,
  input: UpdateAdminUserInput
): boolean {
  return (
    user?.status === "ACTIVE" &&
    user.globalRole === "ADMIN" &&
    input.globalRole === "MEMBER"
  )
}
