import { randomUUID } from "node:crypto"
import { PrismaClient, type Prisma } from "@prisma/client"
import { recordAdminAudit } from "./audit"
import {
  ArchivedEndpointForBindingError,
  ArchivedProjectError,
  ArchivedTenantError,
  DuplicateProjectSlugError,
  DuplicateTenantSlugError,
  EndpointNotFoundForBindingError,
  InvalidQuotaValueError,
  ProjectNotFoundError,
  ProjectQuotaExceededError,
  ProjectTenantMismatchError,
  TenantNotFoundError,
  TenantProjectPermissionDeniedError,
  addTenantToProject,
  createProjectForTenant,
  createTenantWithDefaultProject,
  setProjectQuotaPolicy,
  setProjectTenantQuotaAllocation,
  type AdminTenantProjectStore,
  type CreateProjectInput,
  type CreateTenantInput,
  type ManagedEndpointProjectBinding,
  type ManagedEndpointProjectBindingStatus,
  type ManagedProject,
  type ManagedProjectStatus,
  type ManagedProjectTenant,
  type ManagedProjectTenantRole,
  type ManagedProjectTenantStatus,
  type ManagedTenant,
  type ManagedTenantStatus,
  type ProjectQuotaPolicy,
  type ProjectTenantQuotaAllocation,
} from "./tenantProjects"
import { canPerformGlobalAction } from "./permissions"
import type { AdminAuditEntry, AdminPrincipal } from "./session"
import { AuthConfigError } from "../auth"

export interface AdminTenantProjectAdminStore extends AdminTenantProjectStore {
  listTenantRecords(): Promise<ManagedTenant[]>
  listProjectRecords(): Promise<ManagedProject[]>
  listProjectTenantRecords(projectId: string): Promise<ManagedProjectTenant[]>
  listEndpointProjectBindingRecords(projectId: string): Promise<ManagedEndpointProjectBinding[]>
  updateTenantRecord(
    tenantId: string,
    input: Partial<Pick<ManagedTenant, "name" | "slug" | "status">>
  ): Promise<ManagedTenant>
  updateProjectRecord(
    projectId: string,
    input: Partial<Pick<ManagedProject, "name" | "slug" | "status">>
  ): Promise<ManagedProject>
}

export interface UpdateTenantInput {
  name?: string
  slug?: string
}

export interface UpdateProjectInput {
  name?: string
  slug?: string
}

export interface AdminProjectDetail {
  project: ManagedProject
  participants: ManagedProjectTenant[]
  quota: ProjectQuotaPolicy | null
  tenantQuotas: ProjectTenantQuotaAllocation[]
  endpointBindings: ManagedEndpointProjectBinding[]
}

export async function listAdminTenants(
  store: AdminTenantProjectAdminStore,
  actor: AdminPrincipal
): Promise<ManagedTenant[]> {
  assertGlobalTenantProjectAction(actor, "tenants:read")
  return store.listTenantRecords()
}

export async function getAdminTenant(
  store: AdminTenantProjectAdminStore,
  actor: AdminPrincipal,
  tenantId: string
): Promise<ManagedTenant> {
  assertGlobalTenantProjectAction(actor, "tenants:read")
  return getExistingTenant(store, tenantId)
}

export async function createAdminTenantWithDefaultProject(
  store: AdminTenantProjectAdminStore,
  actor: AdminPrincipal,
  input: CreateTenantInput
): Promise<{ tenant: ManagedTenant; defaultProject: ManagedProject }> {
  return createTenantWithDefaultProject(store, actor, input)
}

export async function updateAdminTenant(
  store: AdminTenantProjectAdminStore,
  actor: AdminPrincipal,
  tenantId: string,
  input: UpdateTenantInput
): Promise<ManagedTenant> {
  assertGlobalTenantProjectAction(actor, "tenants:write")
  await getExistingTenant(store, tenantId)
  const slug = input.slug === undefined ? undefined : normalizeSlug(input.slug)
  if (slug !== undefined) {
    const existing = await store.findTenantBySlug(slug)
    if (existing && existing.id !== tenantId) {
      throw new DuplicateTenantSlugError()
    }
  }
  const tenant = await store.updateTenantRecord(tenantId, {
    name: input.name === undefined ? undefined : normalizeName(input.name),
    slug,
  })
  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "tenant.update",
    targetType: "tenant",
    targetId: tenant.id,
    metadata: { name: input.name, slug },
  })
  return tenant
}

export async function archiveAdminTenant(
  store: AdminTenantProjectAdminStore,
  actor: AdminPrincipal,
  tenantId: string
): Promise<ManagedTenant> {
  assertGlobalTenantProjectAction(actor, "tenants:write")
  await getExistingTenant(store, tenantId)
  const tenant = await store.updateTenantRecord(tenantId, { status: "ARCHIVED" })
  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "tenant.archive",
    targetType: "tenant",
    targetId: tenant.id,
    metadata: { status: "ARCHIVED" },
  })
  return tenant
}

export async function restoreAdminTenant(
  store: AdminTenantProjectAdminStore,
  actor: AdminPrincipal,
  tenantId: string
): Promise<ManagedTenant> {
  assertGlobalTenantProjectAction(actor, "tenants:write")
  await getExistingTenant(store, tenantId)
  const tenant = await store.updateTenantRecord(tenantId, { status: "ACTIVE" })
  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "tenant.restore",
    targetType: "tenant",
    targetId: tenant.id,
    metadata: { status: "ACTIVE" },
  })
  return tenant
}

export async function listAdminProjects(
  store: AdminTenantProjectAdminStore,
  actor: AdminPrincipal
): Promise<ManagedProject[]> {
  assertGlobalTenantProjectAction(actor, "projects:read")
  return store.listProjectRecords()
}

export async function getAdminProject(
  store: AdminTenantProjectAdminStore,
  actor: AdminPrincipal,
  projectId: string
): Promise<ManagedProject> {
  assertGlobalTenantProjectAction(actor, "projects:read")
  return getExistingProject(store, projectId)
}

export async function getAdminProjectDetail(
  store: AdminTenantProjectAdminStore,
  actor: AdminPrincipal,
  projectId: string
): Promise<AdminProjectDetail> {
  assertGlobalTenantProjectAction(actor, "projects:read")
  const project = await getExistingProject(store, projectId)
  const [participants, quota, tenantQuotas, endpointBindings] = await Promise.all([
    store.listProjectTenantRecords(projectId),
    store.getProjectQuota(projectId),
    store.listProjectTenantQuotaAllocations(projectId),
    store.listEndpointProjectBindingRecords(projectId),
  ])

  return { project, participants, quota, tenantQuotas, endpointBindings }
}

export async function createAdminProject(
  store: AdminTenantProjectAdminStore,
  actor: AdminPrincipal,
  input: CreateProjectInput
): Promise<ManagedProject> {
  return createProjectForTenant(store, actor, input)
}

export async function updateAdminProject(
  store: AdminTenantProjectAdminStore,
  actor: AdminPrincipal,
  projectId: string,
  input: UpdateProjectInput
): Promise<ManagedProject> {
  assertGlobalTenantProjectAction(actor, "projects:write")
  const existing = await getExistingProject(store, projectId)
  const slug = input.slug === undefined ? undefined : normalizeSlug(input.slug)
  if (slug !== undefined) {
    const duplicate = await store.findProjectByOwnerAndSlug(existing.ownerTenantId, slug)
    if (duplicate && duplicate.id !== projectId) {
      throw new DuplicateProjectSlugError()
    }
  }
  const project = await store.updateProjectRecord(projectId, {
    name: input.name === undefined ? undefined : normalizeName(input.name),
    slug,
  })
  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "project.update",
    targetType: "project",
    targetId: project.id,
    metadata: { name: input.name, slug },
  })
  return project
}

export async function archiveAdminProject(
  store: AdminTenantProjectAdminStore,
  actor: AdminPrincipal,
  projectId: string
): Promise<ManagedProject> {
  assertGlobalTenantProjectAction(actor, "projects:write")
  await getExistingProject(store, projectId)
  const project = await store.updateProjectRecord(projectId, { status: "ARCHIVED" })
  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "project.archive",
    targetType: "project",
    targetId: project.id,
    metadata: { status: "ARCHIVED" },
  })
  return project
}

export async function restoreAdminProject(
  store: AdminTenantProjectAdminStore,
  actor: AdminPrincipal,
  projectId: string
): Promise<ManagedProject> {
  assertGlobalTenantProjectAction(actor, "projects:write")
  await getExistingProject(store, projectId)
  const project = await store.updateProjectRecord(projectId, { status: "ACTIVE" })
  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "project.restore",
    targetType: "project",
    targetId: project.id,
    metadata: { status: "ACTIVE" },
  })
  return project
}

export async function updateProjectTenantParticipation(
  store: AdminTenantProjectAdminStore,
  actor: AdminPrincipal,
  input: { projectId: string; tenantId: string; role: ManagedProjectTenantRole }
): Promise<ManagedProjectTenant> {
  assertGlobalTenantProjectAction(actor, "projects:write")
  await getActiveProject(store, input.projectId)
  await getActiveTenant(store, input.tenantId)
  const existing = await store.findProjectTenant(input.projectId, input.tenantId)
  if (!existing) {
    throw new ProjectTenantMismatchError()
  }
  const participation = await store.upsertProjectTenantRecord({
    projectId: input.projectId,
    tenantId: input.tenantId,
    role: input.role,
    status: "ACTIVE",
  })
  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "project.tenant.update",
    targetType: "projectTenant",
    targetId: participation.id,
    metadata: { projectId: input.projectId, tenantId: input.tenantId, role: input.role },
  })
  return participation
}

export async function removeProjectTenantParticipation(
  store: AdminTenantProjectAdminStore,
  actor: AdminPrincipal,
  projectId: string,
  tenantId: string
): Promise<ManagedProjectTenant> {
  assertGlobalTenantProjectAction(actor, "projects:write")
  await getExistingProject(store, projectId)
  await getExistingTenant(store, tenantId)
  const existing = await store.findProjectTenant(projectId, tenantId)
  if (!existing) {
    throw new ProjectTenantMismatchError()
  }
  const participation = await store.upsertProjectTenantRecord({
    projectId,
    tenantId,
    role: existing.role,
    status: "REMOVED",
  })
  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "project.tenant.remove",
    targetType: "projectTenant",
    targetId: participation.id,
    metadata: { projectId, tenantId, role: participation.role, status: "REMOVED" },
  })
  return participation
}

export async function addAdminTenantToProject(
  store: AdminTenantProjectAdminStore,
  actor: AdminPrincipal,
  input: { projectId: string; tenantId: string; role: ManagedProjectTenantRole }
): Promise<ManagedProjectTenant> {
  return addTenantToProject(store, actor, input)
}

export async function setAdminProjectQuotaPolicy(
  store: AdminTenantProjectAdminStore,
  actor: AdminPrincipal,
  projectId: string,
  quota: Omit<ProjectQuotaPolicy, "projectId">
): Promise<ProjectQuotaPolicy> {
  return setProjectQuotaPolicy(store, actor, projectId, quota)
}

export async function setAdminProjectTenantQuotaAllocation(
  store: AdminTenantProjectAdminStore,
  actor: AdminPrincipal,
  projectId: string,
  tenantId: string,
  quota: Omit<ProjectTenantQuotaAllocation, "projectId" | "tenantId">
): Promise<ProjectTenantQuotaAllocation> {
  return setProjectTenantQuotaAllocation(store, actor, projectId, tenantId, quota)
}

export async function addEndpointProjectBinding(
  store: AdminTenantProjectAdminStore,
  actor: AdminPrincipal,
  input: { endpointId: string; projectId: string }
): Promise<ManagedEndpointProjectBinding> {
  assertGlobalTenantProjectAction(actor, "projects:write")
  await getActiveProject(store, input.projectId)
  await getActiveEndpoint(store, input.endpointId)
  const binding = await store.upsertEndpointProjectBindingRecord({
    endpointId: input.endpointId,
    projectId: input.projectId,
    status: "ACTIVE",
  })
  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "endpointProjectBinding.add",
    targetType: "endpointProjectBinding",
    targetId: binding.id,
    metadata: { endpointId: input.endpointId, projectId: input.projectId, status: "ACTIVE" },
  })
  return binding
}

export async function removeEndpointProjectBinding(
  store: AdminTenantProjectAdminStore,
  actor: AdminPrincipal,
  input: { endpointId: string; projectId: string }
): Promise<ManagedEndpointProjectBinding> {
  assertGlobalTenantProjectAction(actor, "projects:write")
  await getExistingProject(store, input.projectId)
  const existing = await store.findEndpointProjectBinding(input.endpointId, input.projectId)
  if (!existing) {
    throw new ProjectTenantMismatchError("Endpoint is not bound to the project.")
  }
  const binding = await store.upsertEndpointProjectBindingRecord({
    endpointId: input.endpointId,
    projectId: input.projectId,
    status: "REMOVED",
  })
  await recordAdminAudit(store, {
    actorUserId: actor.id,
    action: "endpointProjectBinding.remove",
    targetType: "endpointProjectBinding",
    targetId: binding.id,
    metadata: { endpointId: input.endpointId, projectId: input.projectId, status: "REMOVED" },
  })
  return binding
}

class PrismaTenantProjectFoundationStore implements AdminTenantProjectAdminStore {
  constructor(
    private readonly prisma = new PrismaClient(),
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  async findTenantBySlug(slug: string): Promise<ManagedTenant | null> {
    this.assertDatabaseConfigured()
    const tenant = await this.prisma.tenant.findUnique({ where: { slug: normalizeSlug(slug) } })
    return tenant ? mapTenant(tenant) : null
  }

  async findProjectByOwnerAndSlug(ownerTenantId: string, slug: string): Promise<ManagedProject | null> {
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
        data: { id: randomUUID(), name: input.tenantName, slug: input.tenantSlug, status: "ACTIVE" },
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
        data: { projectId: defaultProject.id, tenantId: tenant.id, role: "OWNER", status: "ACTIVE" },
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
        data: { projectId: project.id, tenantId: input.ownerTenantId, role: "OWNER", status: "ACTIVE" },
      })
      return { project, participation }
    })
    return { project: mapProject(created.project), participation: mapProjectTenant(created.participation) }
  }

  async listTenantRecords(): Promise<ManagedTenant[]> {
    this.assertDatabaseConfigured()
    const tenants = await this.prisma.tenant.findMany({ orderBy: { createdAt: "asc" } })
    return tenants.map(mapTenant)
  }

  async listProjectRecords(): Promise<ManagedProject[]> {
    this.assertDatabaseConfigured()
    const projects = await this.prisma.project.findMany({ orderBy: { createdAt: "asc" } })
    return projects.map(mapProject)
  }

  async listProjectTenantRecords(projectId: string): Promise<ManagedProjectTenant[]> {
    this.assertDatabaseConfigured()
    const participants = await this.prisma.projectTenant.findMany({
      where: { projectId },
      orderBy: { id: "asc" },
    })
    return participants.map(mapProjectTenant)
  }

  async listEndpointProjectBindingRecords(projectId: string): Promise<ManagedEndpointProjectBinding[]> {
    this.assertDatabaseConfigured()
    const bindings = await this.prisma.endpointProjectBinding.findMany({
      where: { projectId },
      orderBy: { id: "asc" },
    })
    return bindings.map(mapEndpointProjectBinding)
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

  async updateTenantRecord(
    tenantId: string,
    input: Partial<Pick<ManagedTenant, "name" | "slug" | "status">>
  ): Promise<ManagedTenant> {
    this.assertDatabaseConfigured()
    const tenant = await this.prisma.tenant.update({ where: { id: tenantId }, data: input })
    return mapTenant(tenant)
  }

  async updateProjectRecord(
    projectId: string,
    input: Partial<Pick<ManagedProject, "name" | "slug" | "status">>
  ): Promise<ManagedProject> {
    this.assertDatabaseConfigured()
    const project = await this.prisma.project.update({ where: { id: projectId }, data: input })
    return mapProject(project)
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

  async listProjectTenantQuotaAllocations(projectId: string): Promise<ProjectTenantQuotaAllocation[]> {
    this.assertDatabaseConfigured()
    const quotas = await this.prisma.projectTenantQuota.findMany({ where: { projectId } })
    return quotas.map(mapProjectTenantQuota)
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

  async upsertProjectTenantQuotaRecord(input: ProjectTenantQuotaAllocation): Promise<ProjectTenantQuotaAllocation> {
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

  async upsertResourceOwnershipRecord(): Promise<never> {
    throw new Error("Resource ownership assignment belongs to M10 Phase 4 routes.")
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

export class PrismaTenantProjectAdminStore
  extends PrismaTenantProjectFoundationStore
  implements AdminTenantProjectAdminStore {}

async function getExistingTenant(
  store: AdminTenantProjectAdminStore,
  tenantId: string
): Promise<ManagedTenant> {
  const tenant = await store.getTenant(tenantId)
  if (!tenant) {
    throw new TenantNotFoundError()
  }
  return tenant
}

async function getExistingProject(
  store: AdminTenantProjectAdminStore,
  projectId: string
): Promise<ManagedProject> {
  const project = await store.getProject(projectId)
  if (!project) {
    throw new ProjectNotFoundError()
  }
  return project
}

async function getActiveTenant(
  store: AdminTenantProjectAdminStore,
  tenantId: string
): Promise<ManagedTenant> {
  const tenant = await getExistingTenant(store, tenantId)
  if (tenant.status !== "ACTIVE") {
    throw new ArchivedTenantError()
  }
  return tenant
}

async function getActiveProject(
  store: AdminTenantProjectAdminStore,
  projectId: string
): Promise<ManagedProject> {
  const project = await getExistingProject(store, projectId)
  if (project.status !== "ACTIVE") {
    throw new ArchivedProjectError()
  }
  return project
}

async function getActiveEndpoint(
  store: AdminTenantProjectAdminStore,
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

function assertGlobalTenantProjectAction(
  actor: AdminPrincipal,
  action: "tenants:read" | "tenants:write" | "projects:read" | "projects:write"
): void {
  if (!canPerformGlobalAction(actor, action)) {
    throw new TenantProjectPermissionDeniedError()
  }
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

function mapEndpointProjectBinding(binding: PrismaEndpointProjectBinding): ManagedEndpointProjectBinding {
  return {
    id: binding.id,
    endpointId: binding.endpointId,
    projectId: binding.projectId,
    status: binding.status,
  }
}

function numberFromBigInt(value: bigint | number | null): number | null {
  if (value === null) {
    return null
  }
  return typeof value === "bigint" ? Number(value) : value
}

export {
  ArchivedEndpointForBindingError,
  ArchivedProjectError,
  ArchivedTenantError,
  DuplicateProjectSlugError,
  DuplicateTenantSlugError,
  EndpointNotFoundForBindingError,
  InvalidQuotaValueError,
  ProjectNotFoundError,
  ProjectQuotaExceededError,
  ProjectTenantMismatchError,
  TenantNotFoundError,
  TenantProjectPermissionDeniedError,
}
