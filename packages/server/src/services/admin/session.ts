import bcrypt from "bcryptjs"
import jwt, { type JwtPayload } from "jsonwebtoken"
import { PrismaClient, type Prisma } from "@prisma/client"
import { AuthConfigError, AuthSessionError } from "../auth"
import { buildAccessSummary } from "./permissions"

export type UserStatus = "ACTIVE" | "DISABLED"
export type TeamStatus = "ACTIVE" | "ARCHIVED"
export type GlobalRole = "ADMIN" | "MEMBER"
export type TeamRole = "OWNER" | "MAINTAINER" | "VIEWER"

export type GlobalAction = "users:read" | "users:write" | "teams:read" | "teams:write" | "audit:read"

export type TeamAction =
  | "members:read"
  | "members:write"
  | "endpoints:read"
  | "endpoints:write"
  | "audit:read"

export interface AdminPrincipalTeam {
  id: string
  name: string
  role: TeamRole
  status: TeamStatus
}

export interface AdminPrincipal {
  id: string
  email: string
  name: string
  status: UserStatus
  globalRole: GlobalRole
  teams: AdminPrincipalTeam[]
}

export interface BrowserAccessSummary {
  bootstrapComplete: boolean
  canAdmin: boolean
  globalActions: GlobalAction[]
  teams: Array<{
    teamId: string
    actions: TeamAction[]
  }>
}

export interface CreateBootstrapAdminRecord {
  email: string
  name: string
  passwordHash: string
  teamName: string
}

export interface AdminAuditEntry {
  actorUserId: string
  action: string
  targetType: string
  targetId: string
  teamId?: string
  metadata?: Record<string, unknown>
}

export interface AdminDataStore {
  isBootstrapComplete(): Promise<boolean>
  createBootstrapAdmin(record: CreateBootstrapAdminRecord): Promise<AdminPrincipal>
  findUserByEmail(email: string): Promise<(AdminPrincipal & { passwordHash: string }) | null>
  findUserById(userId: string): Promise<AdminPrincipal | null>
  recordAudit(entry: AdminAuditEntry): Promise<void>
}

export interface AuthResult {
  user: AdminPrincipal
  access: BrowserAccessSummary
  sessionToken: string
}

type PrismaUserWithMemberships = {
  id: string
  email: string
  name: string
  passwordHash: string
  status: UserStatus
  globalRole: GlobalRole
  createdAt?: Date
  updatedAt?: Date
  memberships: Array<{
    id?: string
    userId?: string
    teamId?: string
    role: TeamRole
    status: "ACTIVE" | "REMOVED"
    createdAt?: Date
    updatedAt?: Date
    team: {
      id: string
      name: string
      status: TeamStatus
      createdAt?: Date
      updatedAt?: Date
    }
  }>
}

interface AdminSessionClaims extends JwtPayload {
  sub: string
  email: string
  name: string
  role: GlobalRole
}

export class BootstrapRequiredError extends Error {
  constructor(message = "Bootstrap must be completed before login.") {
    super(message)
    this.name = "BootstrapRequiredError"
  }
}

export class InvalidAdminCredentialsError extends Error {
  constructor(message = "Invalid email or password.") {
    super(message)
    this.name = "InvalidAdminCredentialsError"
  }
}

export class DisabledUserError extends Error {
  constructor(message = "User is disabled.") {
    super(message)
    this.name = "DisabledUserError"
  }
}

export async function authenticateAdminUser(
  store: AdminDataStore,
  env: NodeJS.ProcessEnv,
  email: string,
  password: string
): Promise<AuthResult> {
  if (!(await store.isBootstrapComplete())) {
    throw new BootstrapRequiredError()
  }

  const userWithHash = await store.findUserByEmail(email.trim().toLowerCase())
  if (!userWithHash) {
    throw new InvalidAdminCredentialsError()
  }

  const passwordMatches = await bcrypt.compare(password, userWithHash.passwordHash)
  if (!passwordMatches) {
    throw new InvalidAdminCredentialsError()
  }

  const user = toBrowserSafePrincipal(userWithHash)
  assertActiveUser(user)

  return {
    user,
    access: buildAccessSummary(user, true),
    sessionToken: signAdminSession(env, user),
  }
}

export async function resolveCurrentAdminUser(
  store: AdminDataStore,
  env: NodeJS.ProcessEnv,
  sessionToken: string | undefined
): Promise<Omit<AuthResult, "sessionToken">> {
  const claims = verifyAdminSession(env, sessionToken)
  const user = await store.findUserById(claims.sub)

  if (!user) {
    throw new AuthSessionError()
  }

  const safeUser = toBrowserSafePrincipal(user)
  if (
    claims.email !== safeUser.email ||
    claims.name !== safeUser.name ||
    claims.role !== safeUser.globalRole
  ) {
    throw new AuthSessionError()
  }
  assertActiveUser(safeUser)

  return {
    user: safeUser,
    access: buildAccessSummary(safeUser, await store.isBootstrapComplete()),
  }
}

export function signAdminSession(env: NodeJS.ProcessEnv, principal: AdminPrincipal): string {
  return jwt.sign(
    {
      sub: principal.id,
      email: principal.email,
      name: principal.name,
      role: principal.globalRole,
    } satisfies AdminSessionClaims,
    requiredSessionSecret(env),
    { expiresIn: "8h" }
  )
}

export function assertAdminAuthConfigured(env: NodeJS.ProcessEnv): void {
  requiredSessionSecret(env)
}

function verifyAdminSession(env: NodeJS.ProcessEnv, sessionToken: string | undefined): AdminSessionClaims {
  if (!sessionToken) {
    throw new AuthSessionError()
  }

  let claims: string | JwtPayload
  try {
    claims = jwt.verify(sessionToken, requiredSessionSecret(env))
  } catch {
    throw new AuthSessionError()
  }

  if (!isAdminSessionClaims(claims)) {
    throw new AuthSessionError()
  }

  return claims
}

export function toBrowserSafePrincipal(principal: AdminPrincipal): AdminPrincipal {
  return {
    id: principal.id,
    email: principal.email,
    name: principal.name,
    status: principal.status,
    globalRole: principal.globalRole,
    teams: principal.teams.map((team) => ({
      id: team.id,
      name: team.name,
      role: team.role,
      status: team.status,
    })),
  }
}

export function mapPrismaUserToAdminPrincipal(user: PrismaUserWithMemberships): AdminPrincipal {
  return {
    id: user.id,
    email: user.email.trim().toLowerCase(),
    name: user.name,
    status: user.status,
    globalRole: user.globalRole,
    teams: user.memberships
      .filter((membership) => membership.status === "ACTIVE")
      .map((membership) => ({
        id: membership.team.id,
        name: membership.team.name,
        role: membership.role,
        status: membership.team.status,
      })),
  }
}

export class PrismaAdminDataStore implements AdminDataStore {
  constructor(
    private readonly prisma = new PrismaClient(),
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  async isBootstrapComplete(): Promise<boolean> {
    this.assertDatabaseConfigured()
    const admin = await this.prisma.user.findFirst({
      where: {
        globalRole: "ADMIN",
        status: "ACTIVE",
      },
      select: { id: true },
    })

    return admin !== null
  }

  async createBootstrapAdmin(record: CreateBootstrapAdminRecord): Promise<AdminPrincipal> {
    this.assertDatabaseConfigured()
    const user = await this.prisma.$transaction(async (tx) => {
      const team = await tx.team.create({
        data: {
          name: record.teamName,
          status: "ACTIVE",
        },
      })
      const createdUser = await tx.user.create({
        data: {
          email: record.email,
          name: record.name,
          passwordHash: record.passwordHash,
          status: "ACTIVE",
          globalRole: "ADMIN",
          memberships: {
            create: {
              teamId: team.id,
              role: "OWNER",
              status: "ACTIVE",
            },
          },
        },
        include: userInclude,
      })

      return createdUser
    })

    return mapPrismaUserToAdminPrincipal(user)
  }

  async findUserByEmail(email: string): Promise<(AdminPrincipal & { passwordHash: string }) | null> {
    this.assertDatabaseConfigured()
    const user = await this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
      include: userInclude,
    })

    if (!user) {
      return null
    }

    return {
      ...mapPrismaUserToAdminPrincipal(user),
      passwordHash: user.passwordHash,
    }
  }

  async findUserById(userId: string): Promise<AdminPrincipal | null> {
    this.assertDatabaseConfigured()
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: userInclude,
    })

    return user ? mapPrismaUserToAdminPrincipal(user) : null
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

const userInclude = {
  memberships: {
    include: {
      team: true,
    },
  },
} as const

function assertActiveUser(principal: AdminPrincipal): void {
  if (principal.status !== "ACTIVE") {
    throw new DisabledUserError()
  }
}

function requiredSessionSecret(env: NodeJS.ProcessEnv): string {
  const value = env.ANVIL_SESSION_SECRET
  if (!value || value.trim() === "") {
    throw new AuthConfigError()
  }

  return value
}

function isAdminSessionClaims(value: string | JwtPayload): value is AdminSessionClaims {
  if (typeof value === "string") {
    return false
  }

  return (
    typeof value.sub === "string" &&
    typeof value.email === "string" &&
    typeof value.name === "string" &&
    (value.role === "ADMIN" || value.role === "MEMBER")
  )
}
