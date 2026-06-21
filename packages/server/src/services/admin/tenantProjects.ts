import { PrismaClient, type Prisma } from "@prisma/client"
import { recordAdminAudit } from "./audit"
import { canPerformGlobalAction } from "./permissions"
import type { AdminAuditEntry, AdminPrincipal } from "./session"
import { AuthConfigError } from "../auth"

export type ManagedTenantStatus = "ACTIVE" | "ARCHIVED"
export type ManagedProjectStatus = "ACTIVE" | "ARCHIVED"
export type ManagedProjectTenantRole = "OWNER" | "PARTICIPANT"
export type ManagedProjectTenantStatus = "ACTIVE" | "REMOVED"
export type ManagedEndpointProjectBindingStatus = "ACTIVE" | "REMOVED"
export type ManagedResourceType = "INSTANCE" | "IMAGE" | "OPERATION"

export interface ManagedTenant {
  id: string
  name: string
  slug: string
  status: ManagedTenantStatus
  defaultProjectId: string
}

export interface ManagedProject {
  id: string
  name: string
  slug: string
  status: ManagedProjectStatus
  ownerTenantId: string
}

export interface ManagedProjectTenant {
  id: string
  projectId: string
  tenantId: string
  role: ManagedProjectTenantRole
  status: ManagedProjectTenantStatus
}

export interface ProjectQuotaPolicy {
  projectId: string
  maxVcpu: number | null
  maxMemoryBytes: number | null
  maxDiskBytes: number | null
  maxInstances: number | null
  maxIpv6Addresses: number | null
}

export interface ProjectTenantQuotaAllocation {
  projectId: string
  tenantId: string
  maxVcpu: number | null
  maxMemoryBytes: number | null
  maxDiskBytes: number | null
  maxInstances: number | null
  maxIpv6Addresses: number | null
}

export interface ManagedEndpointProjectBinding {
  id: string
  endpointId: string
  projectId: string
  status: ManagedEndpointProjectBindingStatus
}

export interface ManagedResourceOwnership {
  id: string
  resourceType: ManagedResourceType
  resourceId: string
  endpointId: string
  projectId: string
  tenantId: string
  discoveredName: string | null
  externalFingerprint: string | null
}

export interface AdminTenantProjectStore {
  findTenantBySlug(slug: string): Promise<ManagedTenant | null>
  findProjectByOwnerAndSlug(ownerTenantId: string, slug: string): Promise<ManagedProject | null>
  createTenantWithDefaultProjectRecord(input: {
    tenantName: string
    tenantSlug: string
    defaultProjectName: string
    defaultProjectSlug: string
  }): Promise<{ tenant: ManagedTenant; defaultProject: ManagedProject; participation: ManagedProjectTenant }>
  createProjectRecord(input: {
    ownerTenantId: string
    name: string
    slug: string
  }): Promise<{ project: ManagedProject; participation: ManagedProjectTenant }>
  getTenant(tenantId: string): Promise<ManagedTenant | null>
  getProject(projectId: string): Promise<ManagedProject | null>
  findProjectTenant(projectId: string, tenantId: string): Promise<ManagedProjectTenant | null>
  upsertProjectTenantRecord(input: {
    projectId: string
    tenantId: string
    role: ManagedProjectTenantRole
    status: ManagedProjectTenantStatus
  }): Promise<ManagedProjectTenant>
  getProjectQuota(projectId: string): Promise<ProjectQuotaPolicy | null>
  upsertProjectQuotaRecord(input: ProjectQuotaPolicy): Promise<ProjectQuotaPolicy>
  upsertProjectTenantQuotaRecord(
    input: ProjectTenantQuotaAllocation
  ): Promise<ProjectTenantQuotaAllocation>
  getEndpoint(endpointId: string): Promise<{ id: string; status: "ACTIVE" | "ARCHIVED" } | null>
  findEndpointProjectBinding(
    endpointId: string,
    projectId: string
  ): Promise<ManagedEndpointProjectBinding | null>
  upsertEndpointProjectBindingRecord(input: {
    endpointId: string
    projectId: string
    status: ManagedEndpointProjectBindingStatus
  }): Promise<ManagedEndpointProjectBinding>
  upsertResourceOwnershipRecord(input: {
    resourceType: ManagedResourceType
    resourceId: string
    endpointId: string
    projectId: string
    tenantId: string
    discoveredName: string | null
    externalFingerprint: string | null
  }): Promise<ManagedResourceOwnership>
  recordAudit(entry: AdminAuditEntry): Promise<void>
}

export interface CreateTenantInput {
  name: string
  slug: string
}

export interface CreateProjectInput {
  ownerTenantId: string
  name: string
  slug: string
}

export class TenantProjectPermissionDeniedError extends Error {
  constructor(message = "Tenant/project permission denied.") {
    super(message)
    this.name = "TenantProjectPermissionDeniedError"
  }
}

export class DuplicateTenantSlugError extends Error {
  constructor(message = "A tenant with that slug already exists.") {
    super(message)
    this.name = "DuplicateTenantSlugError"
  }
}

export class DuplicateProjectSlugError extends Error {
  constructor(message = "A project with that slug already exists for this tenant.") {
    super(message)
    this.name = "DuplicateProjectSlugError"
  }
}

export class TenantNotFoundError extends Error {
  constructor(message = "Tenant was not found.") {
    super(message)
    this.name = "TenantNotFoundError"
  }
}

export class ProjectNotFoundError extends Error {
  constructor(message = "Project was not found.") {
    super(message)
    this.name = "ProjectNotFoundError"
  }
}

export class ArchivedTenantError extends Error {
  constructor(message = "Tenant is archived.") {
    super(message)
    this.name = "ArchivedTenantError"
  }
}

export class ArchivedProjectError extends Error {
  constructor(message = "Project is archived.") {
    super(message)
    this.name = "ArchivedProjectError"
  }
}

export class InvalidQuotaValueError extends Error {
  constructor(message = "Quota values must be null or positive integers.") {
    super(message)
    this.name = "InvalidQuotaValueError"
  }
}

export class ProjectQuotaExceededError extends Error {
  constructor(message = "Tenant allocation cannot exceed the project quota policy.") {
    super(message)
    this.name = "ProjectQuotaExceededError"
  }
}

export class EndpointNotFoundForBindingError extends Error {
  constructor(message = "Endpoint was not found for project binding.") {
    super(message)
    this.name = "EndpointNotFoundForBindingError"
  }
}

export class ArchivedEndpointForBindingError extends Error {
  constructor(message = "Endpoint is archived.") {
    super(message)
    this.name = "ArchivedEndpointForBindingError"
  }
}

export class EndpointProjectBindingRequiredError extends Error {
  constructor(message = "An active endpoint-project binding is required.") {
    super(message)
    this.name = "EndpointProjectBindingRequiredError"
  }
}

export class ProjectTenantMismatchError extends Error {
  constructor(message = "Tenant does not participate in the project.") {
    super(message)
    this.name = "ProjectTenantMismatchError"
  }
}

export async function createTenantWithDefaultProject(
  store: AdminTenantProjectStore,
  actor: AdminPrincipal,
  input: CreateTenantInput
): Promise<{ tenant: ManagedTenant; defaultProject: ManagedProject }> {
  assertTenantProjectPermission(actor, "tenants:write")
  const slug = normalizeSlug(input.slug)
  if (await store.findTenantBySlug(slug)) {
    throw new DuplicateTenantSlugError()
  }

  const name = normalizeName(input.name)
  const created = await store.createTenantWithDefaultProjectRecord({
    tenantName: name,
    tenantSlug: slug,
    defaultProjectName: `${name} Default`,
    defaultProjectSlug: "default",
  })

  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "tenant.create",
    targetType: "tenant",
    targetId: created.tenant.id,
    metadata: { name: created.tenant.name, slug: created.tenant.slug },
  })
  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "project.create",
    targetType: "project",
    targetId: created.defaultProject.id,
    metadata: {
      name: created.defaultProject.name,
      slug: created.defaultProject.slug,
      ownerTenantId: created.tenant.id,
      defaultProject: true,
    },
  })
  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "project.tenant.add",
    targetType: "projectTenant",
    targetId: created.participation.id,
    metadata: {
      projectId: created.defaultProject.id,
      tenantId: created.tenant.id,
      role: created.participation.role,
    },
  })

  return {
    tenant: created.tenant,
    defaultProject: created.defaultProject,
  }
}

export async function createProjectForTenant(
  store: AdminTenantProjectStore,
  actor: AdminPrincipal,
  input: CreateProjectInput
): Promise<ManagedProject> {
  assertTenantProjectPermission(actor, "projects:write")
  const tenant = await getActiveTenant(store, input.ownerTenantId)
  const slug = normalizeSlug(input.slug)
  if (await store.findProjectByOwnerAndSlug(tenant.id, slug)) {
    throw new DuplicateProjectSlugError()
  }

  const created = await store.createProjectRecord({
    ownerTenantId: tenant.id,
    name: normalizeName(input.name),
    slug,
  })

  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "project.create",
    targetType: "project",
    targetId: created.project.id,
    metadata: {
      name: created.project.name,
      slug: created.project.slug,
      ownerTenantId: tenant.id,
    },
  })
  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "project.tenant.add",
    targetType: "projectTenant",
    targetId: created.participation.id,
    metadata: {
      projectId: created.project.id,
      tenantId: tenant.id,
      role: created.participation.role,
    },
  })

  return created.project
}

export async function addTenantToProject(
  store: AdminTenantProjectStore,
  actor: AdminPrincipal,
  input: { projectId: string; tenantId: string; role: ManagedProjectTenantRole }
): Promise<ManagedProjectTenant> {
  assertTenantProjectPermission(actor, "projects:write")
  await getActiveProject(store, input.projectId)
  await getActiveTenant(store, input.tenantId)

  const participation = await store.upsertProjectTenantRecord({
    projectId: input.projectId,
    tenantId: input.tenantId,
    role: input.role,
    status: "ACTIVE",
  })

  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "project.tenant.add",
    targetType: "projectTenant",
    targetId: participation.id,
    metadata: {
      projectId: input.projectId,
      tenantId: input.tenantId,
      role: input.role,
    },
  })

  return participation
}

export async function setProjectQuotaPolicy(
  store: AdminTenantProjectStore,
  actor: AdminPrincipal,
  projectId: string,
  quota: Omit<ProjectQuotaPolicy, "projectId">
): Promise<ProjectQuotaPolicy> {
  assertTenantProjectPermission(actor, "quotas:write")
  await getActiveProject(store, projectId)
  assertQuotaPolicy(quota)

  const saved = await store.upsertProjectQuotaRecord({ projectId, ...quota })
  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "project.quota.update",
    targetType: "projectQuota",
    targetId: projectId,
    metadata: { ...saved },
  })

  return saved
}

export async function setProjectTenantQuotaAllocation(
  store: AdminTenantProjectStore,
  actor: AdminPrincipal,
  projectId: string,
  tenantId: string,
  quota: Omit<ProjectTenantQuotaAllocation, "projectId" | "tenantId">
): Promise<ProjectTenantQuotaAllocation> {
  assertTenantProjectPermission(actor, "quotas:write")
  await getActiveProject(store, projectId)
  await getActiveTenant(store, tenantId)
  await assertActiveProjectTenant(store, projectId, tenantId)
  assertQuotaPolicy(quota)

  const projectQuota = await store.getProjectQuota(projectId)
  assertAllocationWithinProjectQuota(quota, projectQuota)
  const saved = await store.upsertProjectTenantQuotaRecord({ projectId, tenantId, ...quota })
  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "project.tenantQuota.update",
    targetType: "projectTenantQuota",
    targetId: `${projectId}:${tenantId}`,
    metadata: { ...saved },
  })

  return saved
}

export async function bindEndpointToProject(
  store: AdminTenantProjectStore,
  actor: AdminPrincipal,
  input: { endpointId: string; projectId: string }
): Promise<ManagedEndpointProjectBinding> {
  assertTenantProjectPermission(actor, "projects:write")
  await getActiveProject(store, input.projectId)
  await getActiveEndpoint(store, input.endpointId)

  const binding = await store.upsertEndpointProjectBindingRecord({
    endpointId: input.endpointId,
    projectId: input.projectId,
    status: "ACTIVE",
  })

  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "endpointProjectBinding.upsert",
    targetType: "endpointProjectBinding",
    targetId: binding.id,
    metadata: {
      endpointId: input.endpointId,
      projectId: input.projectId,
      status: binding.status,
    },
  })

  return binding
}

export async function assignResourceOwnership(
  store: AdminTenantProjectStore,
  actor: AdminPrincipal,
  input: {
    resourceType: ManagedResourceType
    resourceId: string
    endpointId: string
    projectId: string
    tenantId: string
    discoveredName: string | null
    externalFingerprint: string | null
  }
): Promise<ManagedResourceOwnership> {
  assertTenantProjectPermission(actor, "projects:write")
  await getActiveProject(store, input.projectId)
  await getActiveTenant(store, input.tenantId)
  await assertActiveProjectTenant(store, input.projectId, input.tenantId)
  await assertActiveEndpointProjectBinding(store, input.endpointId, input.projectId)

  const ownership = await store.upsertResourceOwnershipRecord(input)
  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "resourceOwnership.upsert",
    targetType: "resourceOwnership",
    targetId: ownership.id,
    metadata: {
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      endpointId: input.endpointId,
      projectId: input.projectId,
      tenantId: input.tenantId,
      discoveredName: input.discoveredName,
      externalFingerprint: input.externalFingerprint,
    },
  })

  return ownership
}

export class PrismaAdminTenantProjectStore implements AdminTenantProjectStore {
  constructor(
    private readonly prisma = new PrismaClient(),
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  async findTenantBySlug(slug: string): Promise<ManagedTenant | null> {
    this.assertDatabaseConfigured()
    const tenant = await this.prisma.tenant.findUnique({ where: { slug: normalizeSlug(slug) } })
    return tenant ? mapTenant(tenant) : null
  }

  async findProjectByOwnerAndSlug(
    ownerTenantId: string,
    slug: string
  ): Promise<ManagedProject | null> {
    this.assertDatabaseConfigured()
    const project = await this.prisma.project.findUnique({
      where: { ownerTenantId_slug: { ownerTenantId, slug: normalizeSlug(slug) } },
    })
    return project ? mapProject(project) : null
  }

  async createTenantWithDefaultProjectRecord(input: {
    tenantName: string
    tenantSlug: string
    defaultProjectName: string
    defaultProjectSlug: string
  }): Promise<{ tenant: ManagedTenant; defaultProject: ManagedProject; participation: ManagedProjectTenant }> {
    this.assertDatabaseConfigured()
    const created = await this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          name: input.tenantName,
          slug: input.tenantSlug,
          status: "ACTIVE",
        },
      })
      const defaultProject = await tx.project.create({
        data: {
          name: input.defaultProjectName,
          slug: input.defaultProjectSlug,
          ownerTenantId: tenant.id,
          status: "ACTIVE",
        },
      })
      const updatedTenant = await tx.tenant.update({
        where: { id: tenant.id },
        data: { defaultProjectId: defaultProject.id },
      })
      const participation = await tx.projectTenant.create({
        data: {
          projectId: defaultProject.id,
          tenantId: tenant.id,
          role: "OWNER",
          status: "ACTIVE",
        },
      })
      return { tenant: updatedTenant, defaultProject, participation }
    })

    return {
      tenant: mapTenant(created.tenant),
      defaultProject: mapProject(created.defaultProject),
      participation: mapProjectTenant(created.participation),
    }
  }

  async createProjectRecord(input: {
    ownerTenantId: string
    name: string
    slug: string
  }): Promise<{ project: ManagedProject; participation: ManagedProjectTenant }> {
    this.assertDatabaseConfigured()
    const created = await this.prisma.$transaction(async (tx) => {
      const project = await tx.project.create({
        data: {
          ownerTenantId: input.ownerTenantId,
          name: input.name,
          slug: input.slug,
          status: "ACTIVE",
        },
      })
      const participation = await tx.projectTenant.create({
        data: {
          projectId: project.id,
          tenantId: input.ownerTenantId,
          role: "OWNER",
          status: "ACTIVE",
        },
      })
      return { project, participation }
    })

    return {
      project: mapProject(created.project),
      participation: mapProjectTenant(created.participation),
    }
  }

  async getTenant(tenantId: string): Promise<ManagedTenant | null> {
    this.assertDatabaseConfigured()
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } })
    return tenant ? mapTenant(tenant) : null
  }

  async getProject(projectId: string): Promise<ManagedProject | null> {
    this.assertDatabaseConfigured()
    const project = await this.prisma.project.findUnique({ where: { id: projectId } })
    return project ? mapProject(project) : null
  }

  async findProjectTenant(projectId: string, tenantId: string): Promise<ManagedProjectTenant | null> {
    this.assertDatabaseConfigured()
    const participation = await this.prisma.projectTenant.findUnique({
      where: { projectId_tenantId: { projectId, tenantId } },
    })
    return participation ? mapProjectTenant(participation) : null
  }

  async upsertProjectTenantRecord(input: {
    projectId: string
    tenantId: string
    role: ManagedProjectTenantRole
    status: ManagedProjectTenantStatus
  }): Promise<ManagedProjectTenant> {
    this.assertDatabaseConfigured()
    const participation = await this.prisma.projectTenant.upsert({
      where: { projectId_tenantId: { projectId: input.projectId, tenantId: input.tenantId } },
      update: { role: input.role, status: input.status },
      create: input,
    })
    return mapProjectTenant(participation)
  }

  async getProjectQuota(projectId: string): Promise<ProjectQuotaPolicy | null> {
    this.assertDatabaseConfigured()
    const quota = await this.prisma.projectQuota.findUnique({ where: { projectId } })
    return quota ? mapProjectQuota(quota) : null
  }

  async upsertProjectQuotaRecord(input: ProjectQuotaPolicy): Promise<ProjectQuotaPolicy> {
    this.assertDatabaseConfigured()
    const quota = await this.prisma.projectQuota.upsert({
      where: { projectId: input.projectId },
      update: quotaData(input),
      create: quotaData(input),
    })
    return mapProjectQuota(quota)
  }

  async upsertProjectTenantQuotaRecord(
    input: ProjectTenantQuotaAllocation
  ): Promise<ProjectTenantQuotaAllocation> {
    this.assertDatabaseConfigured()
    const quota = await this.prisma.projectTenantQuota.upsert({
      where: { projectId_tenantId: { projectId: input.projectId, tenantId: input.tenantId } },
      update: tenantQuotaData(input),
      create: tenantQuotaData(input),
    })
    return mapProjectTenantQuota(quota)
  }

  async getEndpoint(endpointId: string): Promise<{ id: string; status: "ACTIVE" | "ARCHIVED" } | null> {
    this.assertDatabaseConfigured()
    return this.prisma.agentEndpoint.findUnique({
      where: { id: endpointId },
      select: { id: true, status: true },
    })
  }

  async findEndpointProjectBinding(
    endpointId: string,
    projectId: string
  ): Promise<ManagedEndpointProjectBinding | null> {
    this.assertDatabaseConfigured()
    const binding = await this.prisma.endpointProjectBinding.findUnique({
      where: { endpointId_projectId: { endpointId, projectId } },
    })
    return binding ? mapEndpointProjectBinding(binding) : null
  }

  async upsertEndpointProjectBindingRecord(input: {
    endpointId: string
    projectId: string
    status: ManagedEndpointProjectBindingStatus
  }): Promise<ManagedEndpointProjectBinding> {
    this.assertDatabaseConfigured()
    const binding = await this.prisma.endpointProjectBinding.upsert({
      where: { endpointId_projectId: { endpointId: input.endpointId, projectId: input.projectId } },
      update: { status: input.status },
      create: input,
    })
    return mapEndpointProjectBinding(binding)
  }

  async upsertResourceOwnershipRecord(input: {
    resourceType: ManagedResourceType
    resourceId: string
    endpointId: string
    projectId: string
    tenantId: string
    discoveredName: string | null
    externalFingerprint: string | null
  }): Promise<ManagedResourceOwnership> {
    this.assertDatabaseConfigured()
    const ownership = await this.prisma.resourceOwnership.upsert({
      where: {
        resourceType_endpointId_resourceId: {
          resourceType: input.resourceType,
          endpointId: input.endpointId,
          resourceId: input.resourceId,
        },
      },
      update: {
        projectId: input.projectId,
        tenantId: input.tenantId,
        discoveredName: input.discoveredName,
        externalFingerprint: input.externalFingerprint,
      },
      create: input,
    })
    return mapResourceOwnership(ownership)
  }

  async recordAudit(entry: AdminAuditEntry): Promise<void> {
    this.assertDatabaseConfigured()
    await this.prisma.auditLog.create({
      data: {
        actorId: entry.actorUserId,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
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

async function getActiveTenant(
  store: AdminTenantProjectStore,
  tenantId: string
): Promise<ManagedTenant> {
  const tenant = await store.getTenant(tenantId)
  if (!tenant) {
    throw new TenantNotFoundError()
  }
  if (tenant.status !== "ACTIVE") {
    throw new ArchivedTenantError()
  }
  return tenant
}

async function getActiveProject(
  store: AdminTenantProjectStore,
  projectId: string
): Promise<ManagedProject> {
  const project = await store.getProject(projectId)
  if (!project) {
    throw new ProjectNotFoundError()
  }
  if (project.status !== "ACTIVE") {
    throw new ArchivedProjectError()
  }
  return project
}

async function getActiveEndpoint(
  store: AdminTenantProjectStore,
  endpointId: string
): Promise<{ id: string; status: "ACTIVE" | "ARCHIVED" }> {
  const endpoint = await store.getEndpoint(endpointId)
  if (!endpoint) {
    throw new EndpointNotFoundForBindingError()
  }
  if (endpoint.status !== "ACTIVE") {
    throw new ArchivedEndpointForBindingError()
  }
  return endpoint
}

async function assertActiveProjectTenant(
  store: AdminTenantProjectStore,
  projectId: string,
  tenantId: string
): Promise<void> {
  const participation = await store.findProjectTenant(projectId, tenantId)
  if (!participation || participation.status !== "ACTIVE") {
    throw new ProjectTenantMismatchError()
  }
}

async function assertActiveEndpointProjectBinding(
  store: AdminTenantProjectStore,
  endpointId: string,
  projectId: string
): Promise<void> {
  await getActiveEndpoint(store, endpointId)
  const binding = await store.findEndpointProjectBinding(endpointId, projectId)
  if (!binding || binding.status !== "ACTIVE") {
    throw new EndpointProjectBindingRequiredError()
  }
}

function assertTenantProjectPermission(
  actor: AdminPrincipal,
  action: "tenants:write" | "projects:write" | "quotas:write"
): void {
  if (!canPerformGlobalAction(actor, action)) {
    throw new TenantProjectPermissionDeniedError()
  }
}

function assertQuotaPolicy(quota: Omit<ProjectQuotaPolicy, "projectId">): void {
  for (const [key, value] of Object.entries(quota)) {
    if (!isValidQuotaValue(key as QuotaKey, value)) {
      throw new InvalidQuotaValueError()
    }
  }
}

function assertAllocationWithinProjectQuota(
  allocation: Omit<ProjectTenantQuotaAllocation, "projectId" | "tenantId">,
  projectQuota: ProjectQuotaPolicy | null
): void {
  if (!projectQuota) {
    return
  }
  for (const key of quotaKeys) {
    const projectValue = projectQuota[key]
    const allocationValue = allocation[key]
    if (projectValue !== null && allocationValue !== null && allocationValue > projectValue) {
      throw new ProjectQuotaExceededError()
    }
  }
}

const quotaKeys = [
  "maxVcpu",
  "maxMemoryBytes",
  "maxDiskBytes",
  "maxInstances",
  "maxIpv6Addresses",
] as const
type QuotaKey = (typeof quotaKeys)[number]
const postgresIntMax = 2_147_483_647

function isValidQuotaValue(key: QuotaKey, value: number | null): boolean {
  if (value === null) {
    return true
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    return false
  }
  if (key === "maxMemoryBytes" || key === "maxDiskBytes") {
    return true
  }
  return value <= postgresIntMax
}

function normalizeSlug(slug: string): string {
  return slug.trim().toLowerCase()
}

function normalizeName(name: string): string {
  return name.trim()
}

function quotaData(input: ProjectQuotaPolicy): ProjectQuotaPolicy {
  return {
    projectId: input.projectId,
    maxVcpu: input.maxVcpu,
    maxMemoryBytes: input.maxMemoryBytes,
    maxDiskBytes: input.maxDiskBytes,
    maxInstances: input.maxInstances,
    maxIpv6Addresses: input.maxIpv6Addresses,
  }
}

function tenantQuotaData(input: ProjectTenantQuotaAllocation): ProjectTenantQuotaAllocation {
  return {
    projectId: input.projectId,
    tenantId: input.tenantId,
    maxVcpu: input.maxVcpu,
    maxMemoryBytes: input.maxMemoryBytes,
    maxDiskBytes: input.maxDiskBytes,
    maxInstances: input.maxInstances,
    maxIpv6Addresses: input.maxIpv6Addresses,
  }
}

type PrismaTenant = {
  id: string
  name: string
  slug: string
  status: ManagedTenantStatus
  defaultProjectId: string | null
}

function mapTenant(tenant: PrismaTenant): ManagedTenant {
  if (!tenant.defaultProjectId) {
    throw new ProjectNotFoundError("Tenant default project is missing.")
  }
  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    status: tenant.status,
    defaultProjectId: tenant.defaultProjectId,
  }
}

type PrismaProject = {
  id: string
  name: string
  slug: string
  status: ManagedProjectStatus
  ownerTenantId: string
}

function mapProject(project: PrismaProject): ManagedProject {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    status: project.status,
    ownerTenantId: project.ownerTenantId,
  }
}

type PrismaProjectTenant = {
  id: string
  projectId: string
  tenantId: string
  role: ManagedProjectTenantRole
  status: ManagedProjectTenantStatus
}

function mapProjectTenant(participation: PrismaProjectTenant): ManagedProjectTenant {
  return {
    id: participation.id,
    projectId: participation.projectId,
    tenantId: participation.tenantId,
    role: participation.role,
    status: participation.status,
  }
}

type PrismaQuota = {
  projectId: string
  maxVcpu: number | null
  maxMemoryBytes: bigint | number | null
  maxDiskBytes: bigint | number | null
  maxInstances: number | null
  maxIpv6Addresses: number | null
}

function mapProjectQuota(quota: PrismaQuota): ProjectQuotaPolicy {
  return {
    projectId: quota.projectId,
    maxVcpu: quota.maxVcpu,
    maxMemoryBytes: numberFromBigInt(quota.maxMemoryBytes),
    maxDiskBytes: numberFromBigInt(quota.maxDiskBytes),
    maxInstances: quota.maxInstances,
    maxIpv6Addresses: quota.maxIpv6Addresses,
  }
}

type PrismaTenantQuota = PrismaQuota & { tenantId: string }

function mapProjectTenantQuota(quota: PrismaTenantQuota): ProjectTenantQuotaAllocation {
  return {
    projectId: quota.projectId,
    tenantId: quota.tenantId,
    maxVcpu: quota.maxVcpu,
    maxMemoryBytes: numberFromBigInt(quota.maxMemoryBytes),
    maxDiskBytes: numberFromBigInt(quota.maxDiskBytes),
    maxInstances: quota.maxInstances,
    maxIpv6Addresses: quota.maxIpv6Addresses,
  }
}

type PrismaEndpointProjectBinding = {
  id: string
  endpointId: string
  projectId: string
  status: ManagedEndpointProjectBindingStatus
}

function mapEndpointProjectBinding(
  binding: PrismaEndpointProjectBinding
): ManagedEndpointProjectBinding {
  return {
    id: binding.id,
    endpointId: binding.endpointId,
    projectId: binding.projectId,
    status: binding.status,
  }
}

type PrismaResourceOwnership = {
  id: string
  resourceType: ManagedResourceType
  resourceId: string
  endpointId: string
  projectId: string
  tenantId: string
  discoveredName: string | null
  externalFingerprint: string | null
}

function mapResourceOwnership(ownership: PrismaResourceOwnership): ManagedResourceOwnership {
  return {
    id: ownership.id,
    resourceType: ownership.resourceType,
    resourceId: ownership.resourceId,
    endpointId: ownership.endpointId,
    projectId: ownership.projectId,
    tenantId: ownership.tenantId,
    discoveredName: ownership.discoveredName,
    externalFingerprint: ownership.externalFingerprint,
  }
}

function numberFromBigInt(value: bigint | number | null): number | null {
  return typeof value === "bigint" ? Number(value) : value
}
