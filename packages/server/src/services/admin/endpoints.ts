import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { PrismaClient, type Prisma } from "@prisma/client"
import { recordAdminAudit } from "./audit"
import { canPerformGlobalAction, canPerformTeamAction } from "./permissions"
import type { AdminAuditEntry, AdminPrincipal } from "./session"
import { AuthConfigError } from "../auth"

export type ManagedEndpointStatus = "ACTIVE" | "ARCHIVED"
export type ManagedEndpointTeamStatus = "ACTIVE" | "ARCHIVED"

export interface ManagedEndpoint {
  id: string
  name: string
  url: string
  status: ManagedEndpointStatus
  team: {
    id: string
    name: string
    status: ManagedEndpointTeamStatus
  }
  credentialConfigured: boolean
}

export interface AdminEndpointManagementStore {
  listEndpoints(): Promise<ManagedEndpoint[]>
  getEndpoint(endpointId: string): Promise<ManagedEndpoint | null>
  findEndpointByTeamAndName(teamId: string, name: string): Promise<ManagedEndpoint | null>
  createEndpointRecord(input: {
    name: string
    url: string
    teamId: string
    status?: ManagedEndpointStatus
    tokenCiphertext?: string
  }): Promise<ManagedEndpoint>
  updateEndpointRecord(
    endpointId: string,
    input: {
      name?: string
      url?: string
      teamId?: string
      status?: ManagedEndpointStatus
      tokenCiphertext?: string
    }
  ): Promise<ManagedEndpoint>
  getTeam(teamId: string): Promise<{ id: string; name: string; status: ManagedEndpointTeamStatus } | null>
  recordAudit(entry: AdminAuditEntry): Promise<void>
}

export interface CreateAdminEndpointInput {
  name: string
  url: string
  teamId: string
  token?: string
  status?: ManagedEndpointStatus
}

export interface UpdateAdminEndpointInput {
  name?: string
  url?: string
  teamId?: string
  token?: string
  status?: ManagedEndpointStatus
}

export class AdminEndpointPermissionDeniedError extends Error {
  constructor(message = "Admin endpoint permission denied.") {
    super(message)
    this.name = "AdminEndpointPermissionDeniedError"
  }
}

export class EndpointNotFoundError extends Error {
  constructor(message = "Endpoint was not found.") {
    super(message)
    this.name = "EndpointNotFoundError"
  }
}

export class DuplicateEndpointNameError extends Error {
  constructor(message = "An endpoint with that name already exists for this team.") {
    super(message)
    this.name = "DuplicateEndpointNameError"
  }
}

export class EndpointTeamNotFoundError extends Error {
  constructor(message = "Endpoint team was not found.") {
    super(message)
    this.name = "EndpointTeamNotFoundError"
  }
}

export class ArchivedEndpointTeamError extends Error {
  constructor(message = "Endpoint team is archived.") {
    super(message)
    this.name = "ArchivedEndpointTeamError"
  }
}

export class EndpointTokenKeyError extends Error {
  constructor(message = "Endpoint token encryption key is not configured.") {
    super(message)
    this.name = "EndpointTokenKeyError"
  }
}

export async function listAdminEndpoints(
  store: AdminEndpointManagementStore,
  actor: AdminPrincipal
): Promise<ManagedEndpoint[]> {
  const endpoints = await store.listEndpoints()
  if (canPerformGlobalAction(actor, "endpoints:read")) {
    return endpoints
  }
  return endpoints.filter((endpoint) => canPerformTeamAction(actor, endpoint.team.id, "endpoints:read"))
}

export async function getAdminEndpoint(
  store: AdminEndpointManagementStore,
  actor: AdminPrincipal,
  endpointId: string
): Promise<ManagedEndpoint> {
  const endpoint = await getExistingEndpoint(store, endpointId)
  assertCanReadEndpoint(actor, endpoint.team.id)
  return endpoint
}

export async function createAdminEndpoint(
  store: AdminEndpointManagementStore,
  actor: AdminPrincipal,
  input: CreateAdminEndpointInput,
  env: NodeJS.ProcessEnv
): Promise<ManagedEndpoint> {
  const teamId = input.teamId
  assertCanWriteEndpoint(actor, teamId)
  await assertActiveTeam(store, teamId)
  const name = input.name.trim()
  await assertUniqueEndpointName(store, teamId, name)

  const tokenCiphertext =
    input.token === undefined ? undefined : encryptEndpointToken(env, input.token)
  const endpoint = await store.createEndpointRecord({
    name,
    url: input.url.trim(),
    teamId,
    status: input.status,
    tokenCiphertext,
  })

  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "endpoint.create",
    targetType: "endpoint",
    targetId: endpoint.id,
    teamId: endpoint.team.id,
    metadata: {
      name: endpoint.name,
      url: endpoint.url,
      teamId: endpoint.team.id,
      status: endpoint.status,
      token: input.token,
    },
  })

  return endpoint
}

export async function updateAdminEndpoint(
  store: AdminEndpointManagementStore,
  actor: AdminPrincipal,
  endpointId: string,
  input: UpdateAdminEndpointInput,
  env: NodeJS.ProcessEnv
): Promise<ManagedEndpoint> {
  const existing = await getExistingEndpoint(store, endpointId)
  assertCanWriteEndpoint(actor, existing.team.id)
  const teamId = input.teamId ?? existing.team.id
  if (teamId !== existing.team.id) {
    assertCanWriteEndpoint(actor, teamId)
  }
  await assertActiveTeam(store, teamId)
  const name = input.name?.trim()
  if (name !== undefined) {
    await assertUniqueEndpointName(store, teamId, name, endpointId)
  }

  const tokenCiphertext =
    input.token === undefined ? undefined : encryptEndpointToken(env, input.token)
  const endpoint = await store.updateEndpointRecord(endpointId, {
    name,
    url: input.url?.trim(),
    teamId: input.teamId,
    status: input.status,
    tokenCiphertext,
  })

  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "endpoint.update",
    targetType: "endpoint",
    targetId: endpoint.id,
    teamId: endpoint.team.id,
    metadata: {
      name,
      url: input.url?.trim(),
      teamId: input.teamId,
      status: input.status,
      token: input.token,
    },
  })

  return endpoint
}

export async function archiveAdminEndpoint(
  store: AdminEndpointManagementStore,
  actor: AdminPrincipal,
  endpointId: string
): Promise<ManagedEndpoint> {
  const existing = await getExistingEndpoint(store, endpointId)
  assertCanWriteEndpoint(actor, existing.team.id)
  const endpoint = await store.updateEndpointRecord(endpointId, { status: "ARCHIVED" })

  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "endpoint.archive",
    targetType: "endpoint",
    targetId: endpoint.id,
    teamId: endpoint.team.id,
    metadata: { status: "ARCHIVED" },
  })

  return endpoint
}

export async function restoreAdminEndpoint(
  store: AdminEndpointManagementStore,
  actor: AdminPrincipal,
  endpointId: string
): Promise<ManagedEndpoint> {
  const existing = await getExistingEndpoint(store, endpointId)
  assertCanWriteEndpoint(actor, existing.team.id)
  const endpoint = await store.updateEndpointRecord(endpointId, { status: "ACTIVE" })

  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "endpoint.restore",
    targetType: "endpoint",
    targetId: endpoint.id,
    teamId: endpoint.team.id,
    metadata: { status: "ACTIVE" },
  })

  return endpoint
}

export function encryptEndpointToken(env: NodeJS.ProcessEnv, token: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", endpointEncryptionKey(env), iv)
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`
}

export function decryptEndpointToken(env: NodeJS.ProcessEnv, encryptedToken: string): string {
  const [version, iv, tag, ciphertext] = encryptedToken.split(":")
  if (version !== "v1" || !iv || !tag || !ciphertext) {
    throw new EndpointTokenKeyError("Endpoint token ciphertext is invalid.")
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    endpointEncryptionKey(env),
    Buffer.from(iv, "base64url")
  )
  decipher.setAuthTag(Buffer.from(tag, "base64url"))
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8")
}

export class PrismaAdminEndpointManagementStore implements AdminEndpointManagementStore {
  constructor(
    private readonly prisma = new PrismaClient(),
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  async listEndpoints(): Promise<ManagedEndpoint[]> {
    this.assertDatabaseConfigured()
    const endpoints = await this.prisma.agentEndpoint.findMany({
      include: endpointInclude,
      orderBy: [{ team: { name: "asc" } }, { name: "asc" }],
    })
    return endpoints.map(mapPrismaEndpointToManagedEndpoint)
  }

  async getEndpoint(endpointId: string): Promise<ManagedEndpoint | null> {
    this.assertDatabaseConfigured()
    const endpoint = await this.prisma.agentEndpoint.findUnique({
      where: { id: endpointId },
      include: endpointInclude,
    })
    return endpoint ? mapPrismaEndpointToManagedEndpoint(endpoint) : null
  }

  async findEndpointByTeamAndName(teamId: string, name: string): Promise<ManagedEndpoint | null> {
    this.assertDatabaseConfigured()
    const endpoint = await this.prisma.agentEndpoint.findUnique({
      where: { teamId_name: { teamId, name: name.trim() } },
      include: endpointInclude,
    })
    return endpoint ? mapPrismaEndpointToManagedEndpoint(endpoint) : null
  }

  async createEndpointRecord(input: {
    name: string
    url: string
    teamId: string
    status?: ManagedEndpointStatus
    tokenCiphertext?: string
  }): Promise<ManagedEndpoint> {
    this.assertDatabaseConfigured()
    const endpoint = await this.prisma.agentEndpoint.create({
      data: {
        name: input.name,
        url: input.url,
        teamId: input.teamId,
        status: input.status ?? "ACTIVE",
        tokenCiphertext: input.tokenCiphertext,
      },
      include: endpointInclude,
    })
    return mapPrismaEndpointToManagedEndpoint(endpoint)
  }

  async updateEndpointRecord(
    endpointId: string,
    input: {
      name?: string
      url?: string
      teamId?: string
      status?: ManagedEndpointStatus
      tokenCiphertext?: string
    }
  ): Promise<ManagedEndpoint> {
    this.assertDatabaseConfigured()
    const endpoint = await this.prisma.agentEndpoint.update({
      where: { id: endpointId },
      data: {
        name: input.name,
        url: input.url,
        teamId: input.teamId,
        status: input.status,
        tokenCiphertext: input.tokenCiphertext,
      },
      include: endpointInclude,
    })
    return mapPrismaEndpointToManagedEndpoint(endpoint)
  }

  async getTeam(teamId: string): Promise<{ id: string; name: string; status: ManagedEndpointTeamStatus } | null> {
    this.assertDatabaseConfigured()
    return this.prisma.team.findUnique({
      where: { id: teamId },
      select: { id: true, name: true, status: true },
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

const endpointInclude = {
  team: {
    select: {
      id: true,
      name: true,
      status: true,
    },
  },
} as const

type PrismaManagedEndpoint = {
  id: string
  name: string
  url: string
  tokenCiphertext: string | null
  status: ManagedEndpointStatus
  team: {
    id: string
    name: string
    status: ManagedEndpointTeamStatus
  }
}

function mapPrismaEndpointToManagedEndpoint(endpoint: PrismaManagedEndpoint): ManagedEndpoint {
  return {
    id: endpoint.id,
    name: endpoint.name,
    url: endpoint.url,
    status: endpoint.status,
    team: endpoint.team,
    credentialConfigured: endpoint.tokenCiphertext !== null,
  }
}

async function getExistingEndpoint(
  store: AdminEndpointManagementStore,
  endpointId: string
): Promise<ManagedEndpoint> {
  const endpoint = await store.getEndpoint(endpointId)
  if (!endpoint) {
    throw new EndpointNotFoundError()
  }
  return endpoint
}

async function assertUniqueEndpointName(
  store: AdminEndpointManagementStore,
  teamId: string,
  name: string,
  allowedEndpointId?: string
): Promise<void> {
  const existing = await store.findEndpointByTeamAndName(teamId, name)
  if (existing && existing.id !== allowedEndpointId) {
    throw new DuplicateEndpointNameError()
  }
}

async function assertActiveTeam(
  store: AdminEndpointManagementStore,
  teamId: string
): Promise<void> {
  const team = await store.getTeam(teamId)
  if (!team) {
    throw new EndpointTeamNotFoundError()
  }
  if (team.status !== "ACTIVE") {
    throw new ArchivedEndpointTeamError()
  }
}

function assertCanReadEndpoint(actor: AdminPrincipal, teamId: string): void {
  if (canPerformGlobalAction(actor, "endpoints:read") || canPerformTeamAction(actor, teamId, "endpoints:read")) {
    return
  }
  throw new AdminEndpointPermissionDeniedError()
}

function assertCanWriteEndpoint(actor: AdminPrincipal, teamId: string): void {
  if (canPerformGlobalAction(actor, "endpoints:write") || canPerformTeamAction(actor, teamId, "endpoints:write")) {
    return
  }
  throw new AdminEndpointPermissionDeniedError()
}

function endpointEncryptionKey(env: NodeJS.ProcessEnv): Buffer {
  const key = env.ANVIL_ENDPOINT_TOKEN_KEY
  if (!key || key.trim() === "") {
    throw new EndpointTokenKeyError()
  }
  return createHash("sha256").update(key).digest()
}
