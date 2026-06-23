import type { AdminAuditEntry } from "./session"
import { canPerformGlobalAction, canPerformTeamAction } from "./permissions"
import type { AdminPrincipal } from "./session"
import { PrismaClient, type Prisma } from "@prisma/client"
import { AuthConfigError } from "../auth"

export interface AdminAuditStore {
  recordAudit(entry: AdminAuditEntry): Promise<void>
}

export interface BrowserAuditEntry {
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
}

export interface AdminAuditQuery {
  actorUserId?: string
  targetType?: string
  targetId?: string
  teamId?: string
  action?: string
  from?: string
  to?: string
  limit?: number
  offset?: number
}

export interface AdminAuditQueryStore {
  listAuditEntries(query: {
    actorUserId?: string
    targetType?: string
    targetId?: string
    teamId?: string
    teamIds?: string[]
    action?: string
    from?: Date
    to?: Date
    limit: number
    offset: number
  }): Promise<{
    entries: BrowserAuditEntry[]
    total: number
  }>
}

export class AdminAuditPermissionDeniedError extends Error {
  constructor(message = "Admin audit permission denied.") {
    super(message)
    this.name = "AdminAuditPermissionDeniedError"
  }
}

export class PrismaAdminAuditQueryStore implements AdminAuditQueryStore {
  constructor(
    private readonly prisma = new PrismaClient(),
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  async listAuditEntries(query: {
    actorUserId?: string
    targetType?: string
    targetId?: string
    teamId?: string
    teamIds?: string[]
    action?: string
    from?: Date
    to?: Date
    limit: number
    offset: number
  }): Promise<{ entries: BrowserAuditEntry[]; total: number }> {
    this.assertDatabaseConfigured()
    const where: Prisma.AuditLogWhereInput = {
      actorId: query.actorUserId,
      targetType: query.targetType,
      targetId: query.targetId,
      teamId: query.teamIds ? { in: query.teamIds } : query.teamId,
      action: query.action,
      createdAt: dateRange(query.from, query.to),
    }
    const [entries, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        include: {
          actor: {
            select: {
              id: true,
              email: true,
              name: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip: query.offset,
        take: query.limit,
      }),
      this.prisma.auditLog.count({ where }),
    ])

    return {
      entries: entries.map(mapPrismaAuditToBrowserAudit),
      total,
    }
  }

  private assertDatabaseConfigured(): void {
    if (!this.env.DATABASE_URL || this.env.DATABASE_URL.trim() === "") {
      throw new AuthConfigError()
    }
  }
}

const redactedValue = "[REDACTED]"
const sensitiveMetadataKeys = new Set([
  "authorization",
  "password",
  "passwordHash",
  "privateConfig",
  "secret",
  "session",
  "sessionSecret",
  "token",
  "privateKey",
  "privateKeyCiphertext",
  "presharedKey",
  "presharedKeyCiphertext",
  "endpointToken",
  "networkSecretKey",
  "wireGuardPrivateKey",
])

export async function recordAdminAudit(
  store: AdminAuditStore,
  entry: AdminAuditEntry
): Promise<void> {
  await store.recordAudit({
    ...entry,
    metadata: redactAuditMetadata(entry.metadata),
  })
}

export async function listAdminAuditEntries(
  store: AdminAuditQueryStore,
  actor: AdminPrincipal,
  query: AdminAuditQuery
): Promise<{
  audit: BrowserAuditEntry[]
  page: {
    limit: number
    offset: number
    total: number
  }
}> {
  const visibility = auditVisibility(actor)
  const limit = normalizeLimit(query.limit)
  const offset = normalizeOffset(query.offset)
  const result = await store.listAuditEntries({
    actorUserId: query.actorUserId,
    targetType: emptyToUndefined(query.targetType),
    targetId: emptyToUndefined(query.targetId),
    ...teamVisibilityQuery(visibility, emptyToUndefined(query.teamId)),
    action: emptyToUndefined(query.action),
    from: parseDate(query.from),
    to: parseDate(query.to),
    limit,
    offset,
  })

  return {
    audit: result.entries.map((entry) => ({
      ...entry,
      metadata: redactAuditMetadata(entry.metadata),
    })),
    page: {
      limit,
      offset,
      total: result.total,
    },
  }
}

function redactAuditMetadata(
  value: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined
  }

  return redactObject(value)
}

function redactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, childValue]) => [
      key,
      sensitiveMetadataKeys.has(key) ? redactedValue : redactValue(childValue),
    ])
  )
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item))
  }

  if (value && typeof value === "object") {
    return redactObject(value as Record<string, unknown>)
  }

  return value
}

function auditVisibility(actor: AdminPrincipal): { teamIds?: string[] } {
  if (canPerformGlobalAction(actor, "audit:read")) {
    return {}
  }
  const teamIds = actor.teams
    .filter((team) => canPerformTeamAction(actor, team.id, "audit:read"))
    .map((team) => team.id)
  if (teamIds.length === 0) {
    throw new AdminAuditPermissionDeniedError()
  }
  return { teamIds }
}

function teamVisibilityQuery(
  visibility: { teamIds?: string[] },
  requestedTeamId: string | undefined
): { teamId?: string; teamIds?: string[] } {
  if (visibility.teamIds === undefined) {
    return { teamId: requestedTeamId }
  }
  if (requestedTeamId === undefined) {
    return { teamIds: visibility.teamIds }
  }
  return {
    teamIds: visibility.teamIds.includes(requestedTeamId) ? [requestedTeamId] : [],
  }
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit < 1) {
    return 50
  }
  return Math.min(limit, 100)
}

function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isInteger(offset) || offset < 0) {
    return 0
  }
  return offset
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.trim() !== "" ? value.trim() : undefined
}

function dateRange(from: Date | undefined, to: Date | undefined): Prisma.DateTimeFilter | undefined {
  if (!from && !to) {
    return undefined
  }
  return {
    gte: from,
    lte: to,
  }
}

type PrismaAuditWithActor = {
  id: string
  actor: {
    id: string
    email: string
    name: string
  }
  action: string
  targetType: string
  targetId: string
  teamId: string | null
  metadata: Prisma.JsonValue | null
  createdAt: Date
}

function mapPrismaAuditToBrowserAudit(entry: PrismaAuditWithActor): BrowserAuditEntry {
  return {
    id: entry.id,
    actor: {
      id: entry.actor.id,
      email: entry.actor.email.trim().toLowerCase(),
      name: entry.actor.name,
    },
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    teamId: entry.teamId ?? undefined,
    metadata: isRecord(entry.metadata) ? entry.metadata : undefined,
    createdAt: entry.createdAt.toISOString(),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
