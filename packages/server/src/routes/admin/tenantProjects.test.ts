import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createProjectRoutes } from "./projects"
import { createTenantRoutes } from "./tenants"
import { signAdminSession } from "../../services/admin/session"
import type {
  AdminAuditEntry,
  AdminDataStore,
  AdminPrincipal,
  CreateBootstrapAdminRecord,
} from "../../services/admin/session"
import type {
  ManagedEndpointProjectBinding,
  ManagedProject,
  ManagedProjectTenant,
  ManagedTenant,
  ManagedResourceOwnership,
  ManagedResourceType,
  ProjectQuotaPolicy,
  ProjectTenantQuotaAllocation,
} from "../../services/admin/tenantProjects"

const sessionSecret = "test-session-secret-with-enough-entropy"

const globalAdmin: AdminPrincipal = {
  id: "admin-1",
  email: "admin@example.com",
  name: "Admin User",
  status: "ACTIVE",
  globalRole: "ADMIN",
  teams: [],
}

const memberPrincipal: AdminPrincipal = {
  id: "member-1",
  email: "member@example.com",
  name: "Member User",
  status: "ACTIVE",
  globalRole: "MEMBER",
  teams: [],
}

describe("admin tenant/project routes", () => {
  test("runs tenant route contract with default project and safe response shapes", async () => {
    const store = new TestTenantProjectRouteStore()
    const routes = createTenantRoutes({
      env: { ANVIL_SESSION_SECRET: sessionSecret },
      sessionStore: new TestSessionStore(globalAdmin),
      tenantProjectStore: store,
    })
    const cookie = sessionCookie(globalAdmin)

    const created = await routes.request("/", {
      method: "POST",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ name: " Acme Corp ", slug: "Acme-Corp" }),
    })
    const listed = await routes.request("/", { headers: { cookie } })
    const detail = await routes.request("/tenant-1", { headers: { cookie } })
    const updated = await routes.request("/tenant-1", {
      method: "PATCH",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ name: "Acme Renamed", slug: "acme-renamed" }),
    })
    const archived = await routes.request("/tenant-1/archive", {
      method: "POST",
      headers: { cookie },
    })
    const restored = await routes.request("/tenant-1/restore", {
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
      tenant: {
        id: "tenant-1",
        name: "Acme Corp",
        slug: "acme-corp",
        status: "ACTIVE",
        defaultProjectId: "project-1",
      },
      defaultProject: {
        id: "project-1",
        name: "Acme Corp Default",
        slug: "default",
        status: "ACTIVE",
        ownerTenantId: "tenant-1",
      },
    })
    assert.deepEqual(await readJson(listed), {
      tenants: [
        {
          id: "tenant-1",
          name: "Acme Corp",
          slug: "acme-corp",
          status: "ACTIVE",
          defaultProjectId: "project-1",
        },
      ],
    })
    const detailJson = await readJson(detail)
    const updatedJson = await readJson(updated)
    const archivedJson = await readJson(archived)
    const restoredJson = await readJson(restored)

    assert.deepEqual(restoredJson, {
      tenant: {
        id: "tenant-1",
        name: "Acme Renamed",
        slug: "acme-renamed",
        status: "ACTIVE",
        defaultProjectId: "project-1",
      },
    })
    assert.deepEqual(store.auditActions(), [
      "tenant.create",
      "project.create",
      "project.tenant.add",
      "tenant.update",
      "tenant.archive",
      "tenant.restore",
    ])

    const serialized = JSON.stringify([detailJson, updatedJson, archivedJson, restoredJson, store.audits])
    assert.equal(serialized.includes("passwordHash"), false)
    assert.equal(serialized.includes("tokenCiphertext"), false)
    assert.equal(serialized.includes("anvil_session"), false)
    assert.equal(serialized.includes(sessionSecret), false)
    assert.equal(serialized.includes("privateConfig"), false)
  })

  test("maps tenant/project permission denial to safe forbidden errors", async () => {
    const routes = createTenantRoutes({
      env: { ANVIL_SESSION_SECRET: sessionSecret },
      sessionStore: new TestSessionStore(memberPrincipal),
      tenantProjectStore: new TestTenantProjectRouteStore(),
    })

    const response = await routes.request("/", {
      method: "POST",
      headers: jsonHeaders(sessionCookie(memberPrincipal)),
      body: JSON.stringify({ name: "Denied", slug: "denied" }),
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await readJson(response), {
      error: {
        code: "ADMIN_FORBIDDEN",
        message: "Admin permission denied.",
        details: {},
      },
    })
  })

  test("runs project participation, quota, allocation, and binding routes", async () => {
    const store = new TestTenantProjectRouteStore()
    const owner = await seedTenant(store, "Owner Tenant", "owner")
    const participant = await seedTenant(store, "Participant Tenant", "participant")
    store.addEndpoint({ id: "endpoint-1", status: "ACTIVE" })
    const routes = createProjectRoutes({
      env: { ANVIL_SESSION_SECRET: sessionSecret },
      sessionStore: new TestSessionStore(globalAdmin),
      tenantProjectStore: store,
    })
    const cookie = sessionCookie(globalAdmin)

    const created = await routes.request("/", {
      method: "POST",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({
        ownerTenantId: owner.tenant.id,
        name: " Shared Build ",
        slug: "Shared-Build",
      }),
    })
    const participantAdded = await routes.request("/project-3/tenants", {
      method: "POST",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ tenantId: participant.tenant.id, role: "PARTICIPANT" }),
    })
    const participantUpdated = await routes.request(`/project-3/tenants/${participant.tenant.id}`, {
      method: "PATCH",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ role: "OWNER" }),
    })
    const quota = await routes.request("/project-3/quota", {
      method: "PUT",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({
        maxVcpu: 8,
        maxMemoryBytes: null,
        maxDiskBytes: null,
        maxInstances: 4,
        maxIpv6Addresses: null,
      }),
    })
    const allocation = await routes.request(`/project-3/tenants/${participant.tenant.id}/quota`, {
      method: "PUT",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({
        maxVcpu: 4,
        maxMemoryBytes: null,
        maxDiskBytes: null,
        maxInstances: 2,
        maxIpv6Addresses: null,
      }),
    })
    const binding = await routes.request("/project-3/endpoints", {
      method: "POST",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ endpointId: "endpoint-1" }),
    })
    const bindingRemoved = await routes.request("/project-3/endpoints/endpoint-1/remove", {
      method: "POST",
      headers: { cookie },
    })
    const participantRemoved = await routes.request(`/project-3/tenants/${participant.tenant.id}/remove`, {
      method: "POST",
      headers: { cookie },
    })
    const updated = await routes.request("/project-3", {
      method: "PATCH",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ name: " Shared Build Renamed ", slug: "Shared-Build-Renamed" }),
    })
    const archived = await routes.request("/project-3/archive", {
      method: "POST",
      headers: { cookie },
    })
    const restored = await routes.request("/project-3/restore", {
      method: "POST",
      headers: { cookie },
    })
    const listed = await routes.request("/", { headers: { cookie } })
    const detail = await routes.request("/project-3", { headers: { cookie } })

    assert.equal(created.status, 201)
    assert.equal(participantAdded.status, 201)
    assert.equal(participantUpdated.status, 200)
    assert.equal(quota.status, 200)
    assert.equal(allocation.status, 200)
    assert.equal(binding.status, 201)
    assert.equal(bindingRemoved.status, 200)
    assert.equal(participantRemoved.status, 200)
    assert.equal(updated.status, 200)
    assert.equal(archived.status, 200)
    assert.equal(restored.status, 200)
    assert.equal(listed.status, 200)
    assert.equal(detail.status, 200)

    assert.deepEqual(await readJson(created), {
      project: {
        id: "project-3",
        name: "Shared Build",
        slug: "shared-build",
        status: "ACTIVE",
        ownerTenantId: owner.tenant.id,
      },
    })
    assert.deepEqual(await readJson(participantAdded), {
      participant: {
        id: "project-tenant-4",
        projectId: "project-3",
        tenantId: participant.tenant.id,
        role: "PARTICIPANT",
        status: "ACTIVE",
      },
    })
    assert.deepEqual(await readJson(participantUpdated), {
      participant: {
        id: "project-tenant-4",
        projectId: "project-3",
        tenantId: participant.tenant.id,
        role: "OWNER",
        status: "ACTIVE",
      },
    })
    assert.deepEqual(await readJson(bindingRemoved), {
      binding: {
        id: "endpoint-binding-1",
        endpointId: "endpoint-1",
        projectId: "project-3",
        status: "REMOVED",
      },
    })
    assert.deepEqual(await readJson(participantRemoved), {
      participant: {
        id: "project-tenant-4",
        projectId: "project-3",
        tenantId: participant.tenant.id,
        role: "OWNER",
        status: "REMOVED",
      },
    })
    assert.deepEqual(await readJson(restored), {
      project: {
        id: "project-3",
        name: "Shared Build Renamed",
        slug: "shared-build-renamed",
        status: "ACTIVE",
        ownerTenantId: owner.tenant.id,
      },
    })
    assert.deepEqual(await readJson(detail), {
      project: {
        id: "project-3",
        name: "Shared Build Renamed",
        slug: "shared-build-renamed",
        status: "ACTIVE",
        ownerTenantId: owner.tenant.id,
      },
      participants: [
        {
          id: "project-tenant-3",
          projectId: "project-3",
          tenantId: owner.tenant.id,
          role: "OWNER",
          status: "ACTIVE",
        },
        {
          id: "project-tenant-4",
          projectId: "project-3",
          tenantId: participant.tenant.id,
          role: "OWNER",
          status: "REMOVED",
        },
      ],
      quota: {
        projectId: "project-3",
        maxVcpu: 8,
        maxMemoryBytes: null,
        maxDiskBytes: null,
        maxInstances: 4,
        maxIpv6Addresses: null,
      },
      tenantQuotas: [
        {
          projectId: "project-3",
          tenantId: participant.tenant.id,
          maxVcpu: 4,
          maxMemoryBytes: null,
          maxDiskBytes: null,
          maxInstances: 2,
          maxIpv6Addresses: null,
        },
      ],
      endpointBindings: [
        {
          id: "endpoint-binding-1",
          endpointId: "endpoint-1",
          projectId: "project-3",
          status: "REMOVED",
        },
      ],
    })
    assert.deepEqual(store.auditActions().slice(-12), [
      "project.create",
      "project.tenant.add",
      "project.tenant.add",
      "project.tenant.update",
      "project.quota.update",
      "project.tenantQuota.update",
      "endpointProjectBinding.add",
      "endpointProjectBinding.remove",
      "project.tenant.remove",
      "project.update",
      "project.archive",
      "project.restore",
    ])

    const serialized = JSON.stringify([await readJson(listed), store.audits])
    assert.equal(serialized.includes("passwordHash"), false)
    assert.equal(serialized.includes("tokenCiphertext"), false)
    assert.equal(serialized.includes("endpoint-token"), false)
    assert.equal(serialized.includes("anvil_session"), false)
    assert.equal(serialized.includes(sessionSecret), false)
  })

  test("maps quota and archived endpoint conflicts to safe route errors", async () => {
    const store = new TestTenantProjectRouteStore()
    const tenant = await seedTenant(store, "Quota Tenant", "quota")
    store.addEndpoint({ id: "endpoint-archived", status: "ARCHIVED" })
    const routes = createProjectRoutes({
      env: { ANVIL_SESSION_SECRET: sessionSecret },
      sessionStore: new TestSessionStore(globalAdmin),
      tenantProjectStore: store,
    })
    const cookie = sessionCookie(globalAdmin)

    await routes.request(`/${tenant.defaultProject.id}/quota`, {
      method: "PUT",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({
        maxVcpu: 8,
        maxMemoryBytes: null,
        maxDiskBytes: null,
        maxInstances: null,
        maxIpv6Addresses: null,
      }),
    })
    await routes.request(`/${tenant.defaultProject.id}/tenants/${tenant.tenant.id}/quota`, {
      method: "PUT",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({
        maxVcpu: 4,
        maxMemoryBytes: null,
        maxDiskBytes: null,
        maxInstances: null,
        maxIpv6Addresses: null,
      }),
    })

    const shrink = await routes.request(`/${tenant.defaultProject.id}/quota`, {
      method: "PUT",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({
        maxVcpu: 3,
        maxMemoryBytes: null,
        maxDiskBytes: null,
        maxInstances: null,
        maxIpv6Addresses: null,
      }),
    })
    const archivedBinding = await routes.request(`/${tenant.defaultProject.id}/endpoints`, {
      method: "POST",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ endpointId: "endpoint-archived" }),
    })

    assert.equal(shrink.status, 409)
    assert.deepEqual(await readJson(shrink), {
      error: {
        code: "PROJECT_QUOTA_EXCEEDED",
        message: "Tenant allocation cannot exceed the project quota policy.",
        details: {},
      },
    })
    assert.equal(archivedBinding.status, 409)
    assert.deepEqual(await readJson(archivedBinding), {
      error: {
        code: "ENDPOINT_ARCHIVED",
        message: "Endpoint is archived.",
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

interface TenantProjectAdminRouteStore {
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
  listTenantRecords(): Promise<ManagedTenant[]>
  listProjectRecords(): Promise<ManagedProject[]>
  listProjectTenantRecords(projectId: string): Promise<ManagedProjectTenant[]>
  listEndpointProjectBindingRecords(projectId: string): Promise<ManagedEndpointProjectBinding[]>
  getTenant(tenantId: string): Promise<ManagedTenant | null>
  getProject(projectId: string): Promise<ManagedProject | null>
  updateTenantRecord(tenantId: string, input: Partial<Pick<ManagedTenant, "name" | "slug" | "status">>): Promise<ManagedTenant>
  updateProjectRecord(projectId: string, input: Partial<Pick<ManagedProject, "name" | "slug" | "status">>): Promise<ManagedProject>
  findProjectTenant(projectId: string, tenantId: string): Promise<ManagedProjectTenant | null>
  upsertProjectTenantRecord(input: {
    projectId: string
    tenantId: string
    role: "OWNER" | "PARTICIPANT"
    status: "ACTIVE" | "REMOVED"
  }): Promise<ManagedProjectTenant>
  getProjectQuota(projectId: string): Promise<ProjectQuotaPolicy | null>
  listProjectTenantQuotaAllocations(projectId: string): Promise<ProjectTenantQuotaAllocation[]>
  upsertProjectQuotaRecord(input: ProjectQuotaPolicy): Promise<ProjectQuotaPolicy>
  upsertProjectTenantQuotaRecord(input: ProjectTenantQuotaAllocation): Promise<ProjectTenantQuotaAllocation>
  getEndpoint(endpointId: string): Promise<{ id: string; status: "ACTIVE" | "ARCHIVED" } | null>
  findEndpointProjectBinding(endpointId: string, projectId: string): Promise<ManagedEndpointProjectBinding | null>
  upsertEndpointProjectBindingRecord(input: {
    endpointId: string
    projectId: string
    status: "ACTIVE" | "REMOVED"
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

class TestTenantProjectRouteStore implements TenantProjectAdminRouteStore {
  tenants: ManagedTenant[] = []
  projects: ManagedProject[] = []
  projectTenants: ManagedProjectTenant[] = []
  projectQuotas: ProjectQuotaPolicy[] = []
  tenantQuotas: ProjectTenantQuotaAllocation[] = []
  endpointBindings: ManagedEndpointProjectBinding[] = []
  endpoints: Array<{ id: string; status: "ACTIVE" | "ARCHIVED" }> = []
  audits: AdminAuditEntry[] = []

  async findTenantBySlug(slug: string): Promise<ManagedTenant | null> {
    return this.tenants.find((tenant) => tenant.slug === slug) ?? null
  }

  async findProjectByOwnerAndSlug(ownerTenantId: string, slug: string): Promise<ManagedProject | null> {
    return (
      this.projects.find((project) => project.ownerTenantId === ownerTenantId && project.slug === slug) ??
      null
    )
  }

  async createTenantWithDefaultProjectRecord(input: {
    tenantName: string
    tenantSlug: string
    defaultProjectName: string
    defaultProjectSlug: string
  }): Promise<{ tenant: ManagedTenant; defaultProject: ManagedProject; participation: ManagedProjectTenant }> {
    const tenantId = `tenant-${this.tenants.length + 1}`
    const projectId = `project-${this.projects.length + 1}`
    const tenant: ManagedTenant = {
      id: tenantId,
      name: input.tenantName,
      slug: input.tenantSlug,
      status: "ACTIVE",
      defaultProjectId: projectId,
    }
    const defaultProject: ManagedProject = {
      id: projectId,
      name: input.defaultProjectName,
      slug: input.defaultProjectSlug,
      status: "ACTIVE",
      ownerTenantId: tenantId,
    }
    const participation: ManagedProjectTenant = {
      id: `project-tenant-${this.projectTenants.length + 1}`,
      projectId,
      tenantId,
      role: "OWNER",
      status: "ACTIVE",
    }
    this.tenants.push(tenant)
    this.projects.push(defaultProject)
    this.projectTenants.push(participation)
    return { tenant, defaultProject, participation }
  }

  async createProjectRecord(input: {
    ownerTenantId: string
    name: string
    slug: string
  }): Promise<{ project: ManagedProject; participation: ManagedProjectTenant }> {
    const project: ManagedProject = {
      id: `project-${this.projects.length + 1}`,
      name: input.name,
      slug: input.slug,
      status: "ACTIVE",
      ownerTenantId: input.ownerTenantId,
    }
    const participation: ManagedProjectTenant = {
      id: `project-tenant-${this.projectTenants.length + 1}`,
      projectId: project.id,
      tenantId: input.ownerTenantId,
      role: "OWNER",
      status: "ACTIVE",
    }
    this.projects.push(project)
    this.projectTenants.push(participation)
    return { project, participation }
  }

  async listTenantRecords(): Promise<ManagedTenant[]> {
    return this.tenants.map((tenant) => ({ ...tenant }))
  }

  async listProjectRecords(): Promise<ManagedProject[]> {
    return this.projects.map((project) => ({ ...project }))
  }

  async listProjectTenantRecords(projectId: string): Promise<ManagedProjectTenant[]> {
    return this.projectTenants
      .filter((participation) => participation.projectId === projectId)
      .map((participation) => ({ ...participation }))
  }

  async listEndpointProjectBindingRecords(projectId: string): Promise<ManagedEndpointProjectBinding[]> {
    return this.endpointBindings
      .filter((binding) => binding.projectId === projectId)
      .map((binding) => ({ ...binding }))
  }

  async getTenant(tenantId: string): Promise<ManagedTenant | null> {
    const tenant = this.tenants.find((item) => item.id === tenantId)
    return tenant ? { ...tenant } : null
  }

  async getProject(projectId: string): Promise<ManagedProject | null> {
    const project = this.projects.find((item) => item.id === projectId)
    return project ? { ...project } : null
  }

  async updateTenantRecord(
    tenantId: string,
    input: Partial<Pick<ManagedTenant, "name" | "slug" | "status">>
  ): Promise<ManagedTenant> {
    const tenant = this.tenants.find((item) => item.id === tenantId)
    assert.ok(tenant)
    Object.assign(tenant, input)
    return { ...tenant }
  }

  async updateProjectRecord(
    projectId: string,
    input: Partial<Pick<ManagedProject, "name" | "slug" | "status">>
  ): Promise<ManagedProject> {
    const project = this.projects.find((item) => item.id === projectId)
    assert.ok(project)
    Object.assign(project, input)
    return { ...project }
  }

  async findProjectTenant(projectId: string, tenantId: string): Promise<ManagedProjectTenant | null> {
    const participation = this.projectTenants.find(
      (item) => item.projectId === projectId && item.tenantId === tenantId
    )
    return participation ? { ...participation } : null
  }

  async upsertProjectTenantRecord(input: {
    projectId: string
    tenantId: string
    role: "OWNER" | "PARTICIPANT"
    status: "ACTIVE" | "REMOVED"
  }): Promise<ManagedProjectTenant> {
    const existing = this.projectTenants.find(
      (item) => item.projectId === input.projectId && item.tenantId === input.tenantId
    )
    if (existing) {
      Object.assign(existing, input)
      return { ...existing }
    }
    const participation: ManagedProjectTenant = {
      id: `project-tenant-${this.projectTenants.length + 1}`,
      ...input,
    }
    this.projectTenants.push(participation)
    return { ...participation }
  }

  async getProjectQuota(projectId: string): Promise<ProjectQuotaPolicy | null> {
    const quota = this.projectQuotas.find((item) => item.projectId === projectId)
    return quota ? { ...quota } : null
  }

  async listProjectTenantQuotaAllocations(projectId: string): Promise<ProjectTenantQuotaAllocation[]> {
    return this.tenantQuotas.filter((quota) => quota.projectId === projectId).map((quota) => ({ ...quota }))
  }

  async upsertProjectQuotaRecord(input: ProjectQuotaPolicy): Promise<ProjectQuotaPolicy> {
    this.projectQuotas = this.projectQuotas.filter((quota) => quota.projectId !== input.projectId)
    this.projectQuotas.push({ ...input })
    return { ...input }
  }

  async upsertProjectTenantQuotaRecord(input: ProjectTenantQuotaAllocation): Promise<ProjectTenantQuotaAllocation> {
    this.tenantQuotas = this.tenantQuotas.filter(
      (quota) => quota.projectId !== input.projectId || quota.tenantId !== input.tenantId
    )
    this.tenantQuotas.push({ ...input })
    return { ...input }
  }

  async getEndpoint(endpointId: string): Promise<{ id: string; status: "ACTIVE" | "ARCHIVED" } | null> {
    const endpoint = this.endpoints.find((item) => item.id === endpointId)
    return endpoint ? { ...endpoint } : null
  }

  async findEndpointProjectBinding(
    endpointId: string,
    projectId: string
  ): Promise<ManagedEndpointProjectBinding | null> {
    const binding = this.endpointBindings.find(
      (item) => item.endpointId === endpointId && item.projectId === projectId
    )
    return binding ? { ...binding } : null
  }

  async upsertEndpointProjectBindingRecord(input: {
    endpointId: string
    projectId: string
    status: "ACTIVE" | "REMOVED"
  }): Promise<ManagedEndpointProjectBinding> {
    const existing = this.endpointBindings.find(
      (item) => item.endpointId === input.endpointId && item.projectId === input.projectId
    )
    if (existing) {
      Object.assign(existing, input)
      return { ...existing }
    }
    const binding: ManagedEndpointProjectBinding = {
      id: `endpoint-binding-${this.endpointBindings.length + 1}`,
      ...input,
    }
    this.endpointBindings.push(binding)
    return { ...binding }
  }

  async upsertResourceOwnershipRecord(): Promise<ManagedResourceOwnership> {
    throw new Error("resource ownership is owned by M10 Phase 4")
  }

  async recordAudit(entry: AdminAuditEntry): Promise<void> {
    this.audits.push(entry)
  }

  addEndpoint(endpoint: { id: string; status: "ACTIVE" | "ARCHIVED" }): void {
    this.endpoints.push(endpoint)
  }

  auditActions(): string[] {
    return this.audits.map((audit) => audit.action)
  }
}

async function seedTenant(
  store: TestTenantProjectRouteStore,
  name: string,
  slug: string
): Promise<{ tenant: ManagedTenant; defaultProject: ManagedProject }> {
  return store.createTenantWithDefaultProjectRecord({
    tenantName: name,
    tenantSlug: slug,
    defaultProjectName: `${name} Default`,
    defaultProjectSlug: "default",
  })
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
