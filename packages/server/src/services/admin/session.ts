import bcrypt from "bcryptjs"
import jwt, { type JwtPayload } from "jsonwebtoken"
import { PrismaClient, type Prisma } from "@prisma/client"
import { AuthConfigError, AuthSessionError } from "../auth"
import { buildAccessSummary } from "./permissions"
import { BootstrapAlreadyCompletedError } from "./bootstrapErrors"

const bootstrapAdvisoryLockNamespace = 0x416e7669
const bootstrapAdvisoryLockKey = 0x6d394230

export type UserStatus = "ACTIVE" | "DISABLED"
export type TeamStatus = "ACTIVE" | "ARCHIVED"
export type GlobalRole = "ADMIN" | "MEMBER"
export type TeamRole = "OWNER" | "MAINTAINER" | "VIEWER"

export type GlobalAction =
  | "users:read"
  | "users:write"
  | "teams:read"
  | "teams:write"
  | "endpoints:read"
  | "endpoints:write"
  | "audit:read"
  | "tenants:read"
  | "tenants:write"
  | "projects:read"
  | "projects:write"
  | "quotas:read"
  | "quotas:write"
  | "resources:read"

export type TeamAction =
  | "members:read"
  | "members:write"
  | "endpoints:read"
  | "endpoints:write"
  | "audit:read"

export type TenantAction = "tenants:read" | "projects:read" | "resources:read"
export type ProjectAction = "projects:read" | "quotas:read" | "resources:read"

export interface TenantProjectAccessScopes {
  tenants: Array<{
    tenantId: string
    status: "ACTIVE" | "ARCHIVED"
  }>
  projects: Array<{
    projectId: string
    tenantId: string
    status: "ACTIVE" | "ARCHIVED"
  }>
}

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
  tenants: Array<{
    tenantId: string
    actions: TenantAction[]
  }>
  projects: Array<{
    projectId: string
    tenantId: string
    actions: ProjectAction[]
  }>
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
  getTenantProjectAccessScopes?(userId: string): Promise<TenantProjectAccessScopes>
  recordAudit(entry: AdminAuditEntry): Promise<void>
}

type TenantProjectScopeQuery = {
  where: {
    status: "ACTIVE"
    project: {
      endpointBindings: {
        some: {
          status: "ACTIVE"
          endpoint: {
            status: "ACTIVE"
            team: {
              status: "ACTIVE"
              memberships: {
                some: {
                  userId: string
                  status: "ACTIVE"
                  team: { status: "ACTIVE" }
                }
              }
            }
          }
        }
      }
    }
    tenant: {
      defaultProject: {
        is: {
          endpointBindings: {
            some: TenantProjectEndpointBindingFilter
          }
        }
      }
    }
  }
  select: {
    projectId: true
    tenantId: true
    project: {
      select: {
        status: true
      }
    }
    tenant: {
      select: {
        status: true
      }
    }
  }
  orderBy: Array<{ tenantId?: "asc"; projectId?: "asc" }>
}

type TenantProjectEndpointBindingFilter = {
  status: "ACTIVE"
  endpoint: {
    status: "ACTIVE"
    team: {
      status: "ACTIVE"
      memberships: {
        some: {
          userId: string
          status: "ACTIVE"
          team: { status: "ACTIVE" }
        }
      }
    }
  }
}

type TenantProjectScopeRow = {
  projectId: string
  tenantId: string
  project: {
    status: "ACTIVE" | "ARCHIVED"
  }
  tenant: {
    status: "ACTIVE" | "ARCHIVED"
  }
}

interface PrismaAdminSessionClient {
  user: PrismaClient["user"]
  team: PrismaClient["team"]
  auditLog: PrismaClient["auditLog"]
  $transaction: PrismaClient["$transaction"]
  $executeRaw: PrismaClient["$executeRaw"]
  projectTenant: {
    findMany(query: TenantProjectScopeQuery): Promise<TenantProjectScopeRow[]>
  }
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
    access: buildAccessSummary(user, true, await getTenantProjectAccessScopes(store, user.id)),
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
    access: buildAccessSummary(
      safeUser,
      await store.isBootstrapComplete(),
      await getTenantProjectAccessScopes(store, safeUser.id)
    ),
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
    private readonly prisma: PrismaAdminSessionClient = new PrismaClient(),
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  async isBootstrapComplete(): Promise<boolean> {
    this.assertDatabaseConfigured()
    return isBootstrapCompleteInTransaction(this.prisma)
  }

  async createBootstrapAdmin(record: CreateBootstrapAdminRecord): Promise<AdminPrincipal> {
    this.assertDatabaseConfigured()
    const user = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(
          ${bootstrapAdvisoryLockNamespace}::int,
          ${bootstrapAdvisoryLockKey}::int
        )
      `
      if (await isBootstrapCompleteInTransaction(tx)) {
        throw new BootstrapAlreadyCompletedError()
      }

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

  async getTenantProjectAccessScopes(userId: string): Promise<TenantProjectAccessScopes> {
    this.assertDatabaseConfigured()
    const activeUserEndpointBindingFilter = {
      status: "ACTIVE",
      endpoint: {
        status: "ACTIVE",
        team: {
          status: "ACTIVE",
          memberships: {
            some: {
              userId,
              status: "ACTIVE",
              team: { status: "ACTIVE" },
            },
          },
        },
      },
    } satisfies TenantProjectEndpointBindingFilter
    const rows = await this.prisma.projectTenant.findMany({
      where: {
        status: "ACTIVE",
        project: {
          endpointBindings: {
            some: activeUserEndpointBindingFilter,
          },
        },
        tenant: {
          defaultProject: {
            is: {
              endpointBindings: {
                some: activeUserEndpointBindingFilter,
              },
            },
          },
        },
      },
      select: {
        projectId: true,
        tenantId: true,
        project: {
          select: {
            status: true,
          },
        },
        tenant: {
          select: {
            status: true,
          },
        },
      },
      orderBy: [{ tenantId: "asc" }, { projectId: "asc" }],
    })

    return mapTenantProjectScopeRows(rows)
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

async function getTenantProjectAccessScopes(
  store: AdminDataStore,
  userId: string
): Promise<TenantProjectAccessScopes> {
  return store.getTenantProjectAccessScopes?.(userId) ?? { tenants: [], projects: [] }
}

const userInclude = {
  memberships: {
    include: {
      team: true,
    },
  },
} as const

async function isBootstrapCompleteInTransaction(
  client: Pick<PrismaClient, "user">
): Promise<boolean> {
  const admin = await client.user.findFirst({
    where: {
      globalRole: "ADMIN",
      status: "ACTIVE",
    },
    select: { id: true },
  })

  return admin !== null
}

function assertActiveUser(principal: AdminPrincipal): void {
  if (principal.status !== "ACTIVE") {
    throw new DisabledUserError()
  }
}

function mapTenantProjectScopeRows(rows: TenantProjectScopeRow[]): TenantProjectAccessScopes {
  const tenants = new Map<string, TenantProjectAccessScopes["tenants"][number]>()
  const projects = new Map<string, TenantProjectAccessScopes["projects"][number]>()

  for (const row of rows) {
    if (!tenants.has(row.tenantId)) {
      tenants.set(row.tenantId, {
        tenantId: row.tenantId,
        status: row.tenant.status,
      })
    }

    if (row.project.status === "ACTIVE" && row.tenant.status === "ACTIVE") {
      projects.set(`${row.projectId}:${row.tenantId}`, {
        projectId: row.projectId,
        tenantId: row.tenantId,
        status: row.project.status,
      })
    }
  }

  return {
    tenants: [...tenants.values()],
    projects: [...projects.values()],
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
