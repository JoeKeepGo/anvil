import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  ArchivedProjectError,
  ArchivedEndpointForBindingError,
  ArchivedTenantError,
  DuplicateProjectSlugError,
  DuplicateTenantSlugError,
  EndpointProjectBindingRequiredError,
  EndpointNotFoundForBindingError,
  InvalidQuotaValueError,
  ProjectQuotaExceededError,
  ProjectTenantMismatchError,
  PrismaAdminTenantProjectStore,
  TenantProjectPermissionDeniedError,
  addTenantToProject,
  assignResourceOwnership,
  bindEndpointToProject,
  createProjectForTenant,
  createTenantWithDefaultProject,
  setProjectQuotaPolicy,
  setProjectTenantQuotaAllocation,
  type AdminTenantProjectStore,
  type ManagedEndpointProjectBinding,
  type ManagedProject,
  type ManagedProjectTenant,
  type ManagedResourceOwnership,
  type ManagedTenant,
  type ProjectQuotaPolicy,
  type ProjectTenantQuotaAllocation,
} from "./tenantProjects"
import { AuthConfigError } from "../auth"
import type { AdminAuditEntry, AdminPrincipal } from "./session"

const admin: AdminPrincipal = {
  id: "admin-1",
  email: "admin@example.com",
  name: "Admin User",
  status: "ACTIVE",
  globalRole: "ADMIN",
  teams: [],
}

const member: AdminPrincipal = {
  id: "member-1",
  email: "member@example.com",
  name: "Member User",
  status: "ACTIVE",
  globalRole: "MEMBER",
  teams: [],
}

describe("tenant/project foundation service", () => {
  test("maps missing database configuration to the auth config error boundary", async () => {
    const store = new PrismaAdminTenantProjectStore(undefined, {})

    await assert.rejects(store.findTenantBySlug("acme"), AuthConfigError)
    await assert.rejects(store.getProject("project-1"), AuthConfigError)
    await assert.rejects(store.getEndpoint("endpoint-1"), AuthConfigError)
  })

  test("creates a tenant with an active default project and audit records", async () => {
    const store = new TestTenantProjectStore()

    const result = await createTenantWithDefaultProject(store, admin, {
      name: "Acme Corp",
      slug: "Acme-Corp",
    })

    assert.equal(result.tenant.name, "Acme Corp")
    assert.equal(result.tenant.slug, "acme-corp")
    assert.equal(result.tenant.status, "ACTIVE")
    assert.equal(result.defaultProject.name, "Acme Corp Default")
    assert.equal(result.defaultProject.slug, "default")
    assert.equal(result.defaultProject.status, "ACTIVE")
    assert.equal(result.tenant.defaultProjectId, result.defaultProject.id)
    assert.deepEqual(store.auditActions(), ["tenant.create", "project.create", "project.tenant.add"])
  })

  test("rejects duplicate tenant slugs and duplicate project slugs inside an owner tenant", async () => {
    const store = new TestTenantProjectStore()
    const tenant = await createTenantWithDefaultProject(store, admin, {
      name: "Acme Corp",
      slug: "acme",
    })

    await assert.rejects(
      createTenantWithDefaultProject(store, admin, {
        name: "Acme Duplicate",
        slug: "ACME",
      }),
      DuplicateTenantSlugError
    )
    await assert.rejects(
      createProjectForTenant(store, admin, {
        ownerTenantId: tenant.tenant.id,
        name: "Duplicate Default",
        slug: "default",
      }),
      DuplicateProjectSlugError
    )
  })

  test("supports shared projects and tenant participation in both directions", async () => {
    const store = new TestTenantProjectStore()
    const alpha = await createTenantWithDefaultProject(store, admin, { name: "Alpha", slug: "alpha" })
    const beta = await createTenantWithDefaultProject(store, admin, { name: "Beta", slug: "beta" })
    const shared = await createProjectForTenant(store, admin, {
      ownerTenantId: alpha.tenant.id,
      name: "Shared Build",
      slug: "shared-build",
    })

    const betaParticipation = await addTenantToProject(store, admin, {
      projectId: shared.id,
      tenantId: beta.tenant.id,
      role: "PARTICIPANT",
    })

    assert.equal(betaParticipation.status, "ACTIVE")
    assert.equal(betaParticipation.role, "PARTICIPANT")
    assert.deepEqual(
      store.projectTenants
        .filter((participation) => participation.projectId === shared.id)
        .map((participation) => participation.tenantId)
        .sort(),
      [alpha.tenant.id, beta.tenant.id].sort()
    )
    assert.deepEqual(
      store.projectTenants
        .filter((participation) => participation.tenantId === beta.tenant.id)
        .map((participation) => participation.projectId)
        .sort(),
      [beta.tenant.defaultProjectId, shared.id].sort()
    )
  })

  test("validates project quota and tenant allocations as policy records only", async () => {
    const store = new TestTenantProjectStore()
    const tenant = await createTenantWithDefaultProject(store, admin, { name: "Quota Tenant", slug: "quota" })

    await assert.rejects(
      setProjectQuotaPolicy(store, admin, tenant.defaultProject.id, {
        maxVcpu: 0,
        maxMemoryBytes: null,
        maxDiskBytes: null,
        maxInstances: null,
        maxIpv6Addresses: null,
      }),
      InvalidQuotaValueError
    )

    await setProjectQuotaPolicy(store, admin, tenant.defaultProject.id, {
      maxVcpu: 8,
      maxMemoryBytes: 17_179_869_184,
      maxDiskBytes: null,
      maxInstances: 4,
      maxIpv6Addresses: null,
    })
    const unlimited = await setProjectQuotaPolicy(store, admin, tenant.defaultProject.id, {
      maxVcpu: null,
      maxMemoryBytes: null,
      maxDiskBytes: null,
      maxInstances: null,
      maxIpv6Addresses: null,
    })
    assert.deepEqual(unlimited, {
      projectId: tenant.defaultProject.id,
      maxVcpu: null,
      maxMemoryBytes: null,
      maxDiskBytes: null,
      maxInstances: null,
      maxIpv6Addresses: null,
    })
    await setProjectQuotaPolicy(store, admin, tenant.defaultProject.id, {
      maxVcpu: 8,
      maxMemoryBytes: 17_179_869_184,
      maxDiskBytes: null,
      maxInstances: 4,
      maxIpv6Addresses: null,
    })

    await assert.rejects(
      setProjectTenantQuotaAllocation(store, admin, tenant.defaultProject.id, tenant.tenant.id, {
        maxVcpu: 9,
        maxMemoryBytes: null,
        maxDiskBytes: null,
        maxInstances: 1,
        maxIpv6Addresses: null,
      }),
      ProjectQuotaExceededError
    )
    await assert.rejects(
      setProjectTenantQuotaAllocation(store, admin, tenant.defaultProject.id, tenant.tenant.id, {
        maxVcpu: -1,
        maxMemoryBytes: null,
        maxDiskBytes: null,
        maxInstances: null,
        maxIpv6Addresses: null,
      }),
      InvalidQuotaValueError
    )
    await assert.rejects(
      setProjectQuotaPolicy(store, admin, tenant.defaultProject.id, {
        maxVcpu: 2_147_483_648,
        maxMemoryBytes: null,
        maxDiskBytes: null,
        maxInstances: null,
        maxIpv6Addresses: null,
      }),
      InvalidQuotaValueError
    )

    const allocation = await setProjectTenantQuotaAllocation(
      store,
      admin,
      tenant.defaultProject.id,
      tenant.tenant.id,
      {
        maxVcpu: 4,
        maxMemoryBytes: null,
        maxDiskBytes: null,
        maxInstances: 2,
        maxIpv6Addresses: null,
      }
    )

    assert.deepEqual(allocation, {
      projectId: tenant.defaultProject.id,
      tenantId: tenant.tenant.id,
      maxVcpu: 4,
      maxMemoryBytes: null,
      maxDiskBytes: null,
      maxInstances: 2,
      maxIpv6Addresses: null,
    })
    assert.equal(store.agentWriteCalls, 0)
  })

  test("requires existing active endpoints and active projects for endpoint-project bindings", async () => {
    const store = new TestTenantProjectStore()
    const tenant = await createTenantWithDefaultProject(store, admin, {
      name: "Binding Tenant",
      slug: "binding",
    })

    await assert.rejects(
      bindEndpointToProject(store, admin, {
        endpointId: "missing-endpoint",
        projectId: tenant.defaultProject.id,
      }),
      EndpointNotFoundForBindingError
    )

    const endpoint = store.addEndpoint({ id: "endpoint-1", status: "ARCHIVED" })
    await assert.rejects(
      bindEndpointToProject(store, admin, {
        endpointId: endpoint.id,
        projectId: tenant.defaultProject.id,
      }),
      ArchivedEndpointForBindingError
    )

    store.archiveProject(tenant.defaultProject.id)
    store.restoreEndpoint(endpoint.id)
    await assert.rejects(
      bindEndpointToProject(store, admin, {
        endpointId: endpoint.id,
        projectId: tenant.defaultProject.id,
      }),
      ArchivedProjectError
    )
  })

  test("requires active endpoint binding before assigning resource ownership", async () => {
    const store = new TestTenantProjectStore()
    const tenant = await createTenantWithDefaultProject(store, admin, {
      name: "Resource Tenant",
      slug: "resource",
    })
    const endpoint = store.addEndpoint({ id: "endpoint-1", status: "ACTIVE" })

    await assert.rejects(
      assignResourceOwnership(store, admin, {
        resourceType: "INSTANCE",
        resourceId: "instance-a",
        endpointId: endpoint.id,
        projectId: tenant.defaultProject.id,
        tenantId: tenant.tenant.id,
        discoveredName: "instance-a",
        externalFingerprint: null,
      }),
      EndpointProjectBindingRequiredError
    )

    await bindEndpointToProject(store, admin, {
      endpointId: endpoint.id,
      projectId: tenant.defaultProject.id,
    })
    store.removeEndpointProjectBinding(endpoint.id, tenant.defaultProject.id)
    await assert.rejects(
      assignResourceOwnership(store, admin, {
        resourceType: "INSTANCE",
        resourceId: "instance-a",
        endpointId: endpoint.id,
        projectId: tenant.defaultProject.id,
        tenantId: tenant.tenant.id,
        discoveredName: "instance-a",
        externalFingerprint: null,
      }),
      EndpointProjectBindingRequiredError
    )
    await bindEndpointToProject(store, admin, {
      endpointId: endpoint.id,
      projectId: tenant.defaultProject.id,
    })
    const ownership = await assignResourceOwnership(store, admin, {
      resourceType: "INSTANCE",
      resourceId: "instance-a",
      endpointId: endpoint.id,
      projectId: tenant.defaultProject.id,
      tenantId: tenant.tenant.id,
      discoveredName: "instance-a",
      externalFingerprint: null,
    })

    assert.deepEqual(ownership, {
      id: "ownership-1",
      resourceType: "INSTANCE",
      resourceId: "instance-a",
      endpointId: endpoint.id,
      projectId: tenant.defaultProject.id,
      tenantId: tenant.tenant.id,
      discoveredName: "instance-a",
      externalFingerprint: null,
    })
  })

  test("rejects mismatched tenant/project and archived policy records", async () => {
    const store = new TestTenantProjectStore()
    const tenant = await createTenantWithDefaultProject(store, admin, {
      name: "Active Tenant",
      slug: "active",
    })
    const otherTenant = await createTenantWithDefaultProject(store, admin, {
      name: "Other Tenant",
      slug: "other",
    })
    const endpoint = store.addEndpoint({ id: "endpoint-1", status: "ACTIVE" })
    await bindEndpointToProject(store, admin, {
      endpointId: endpoint.id,
      projectId: tenant.defaultProject.id,
    })

    await assert.rejects(
      assignResourceOwnership(store, admin, {
        resourceType: "IMAGE",
        resourceId: "image-a",
        endpointId: endpoint.id,
        projectId: tenant.defaultProject.id,
        tenantId: otherTenant.tenant.id,
        discoveredName: null,
        externalFingerprint: "image-a",
      }),
      ProjectTenantMismatchError
    )

    store.archiveProject(tenant.defaultProject.id)
    await assert.rejects(
      addTenantToProject(store, admin, {
        projectId: tenant.defaultProject.id,
        tenantId: otherTenant.tenant.id,
        role: "PARTICIPANT",
      }),
      ArchivedProjectError
    )
    store.restoreProject(tenant.defaultProject.id)
    store.archiveTenant(otherTenant.tenant.id)
    await assert.rejects(
      addTenantToProject(store, admin, {
        projectId: tenant.defaultProject.id,
        tenantId: otherTenant.tenant.id,
        role: "PARTICIPANT",
      }),
      ArchivedTenantError
    )
  })

  test("denies tenant/project mutations without global tenant/project permission", async () => {
    const store = new TestTenantProjectStore()

    await assert.rejects(
      createTenantWithDefaultProject(store, member, { name: "Denied", slug: "denied" }),
      TenantProjectPermissionDeniedError
    )
  })
})

class TestTenantProjectStore implements AdminTenantProjectStore {
  tenants: ManagedTenant[] = []
  projects: ManagedProject[] = []
  projectTenants: ManagedProjectTenant[] = []
  projectQuotas: ProjectQuotaPolicy[] = []
  tenantQuotas: ProjectTenantQuotaAllocation[] = []
  endpointBindings: ManagedEndpointProjectBinding[] = []
  resourceOwnerships: ManagedResourceOwnership[] = []
  endpoints: Array<{ id: string; status: "ACTIVE" | "ARCHIVED" }> = []
  audits: AdminAuditEntry[] = []
  agentWriteCalls = 0

  async findTenantBySlug(slug: string): Promise<ManagedTenant | null> {
    return this.tenants.find((tenant) => tenant.slug === slug) ?? null
  }

  async findProjectByOwnerAndSlug(
    ownerTenantId: string,
    slug: string
  ): Promise<ManagedProject | null> {
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
    const project: ManagedProject = {
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
    this.projects.push(project)
    this.projectTenants.push(participation)
    return { tenant, defaultProject: project, participation }
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

  async getTenant(tenantId: string): Promise<ManagedTenant | null> {
    return this.tenants.find((tenant) => tenant.id === tenantId) ?? null
  }

  async getProject(projectId: string): Promise<ManagedProject | null> {
    return this.projects.find((project) => project.id === projectId) ?? null
  }

  async findProjectTenant(projectId: string, tenantId: string): Promise<ManagedProjectTenant | null> {
    return (
      this.projectTenants.find(
        (participation) => participation.projectId === projectId && participation.tenantId === tenantId
      ) ?? null
    )
  }

  async upsertProjectTenantRecord(input: {
    projectId: string
    tenantId: string
    role: "OWNER" | "PARTICIPANT"
    status: "ACTIVE" | "REMOVED"
  }): Promise<ManagedProjectTenant> {
    const existing = await this.findProjectTenant(input.projectId, input.tenantId)
    if (existing) {
      Object.assign(existing, { role: input.role, status: input.status })
      return existing
    }
    const participation: ManagedProjectTenant = {
      id: `project-tenant-${this.projectTenants.length + 1}`,
      projectId: input.projectId,
      tenantId: input.tenantId,
      role: input.role,
      status: input.status,
    }
    this.projectTenants.push(participation)
    return participation
  }

  async getProjectQuota(projectId: string): Promise<ProjectQuotaPolicy | null> {
    return this.projectQuotas.find((quota) => quota.projectId === projectId) ?? null
  }

  async upsertProjectQuotaRecord(input: ProjectQuotaPolicy): Promise<ProjectQuotaPolicy> {
    this.projectQuotas = this.projectQuotas.filter((quota) => quota.projectId !== input.projectId)
    this.projectQuotas.push(input)
    return input
  }

  async upsertProjectTenantQuotaRecord(
    input: ProjectTenantQuotaAllocation
  ): Promise<ProjectTenantQuotaAllocation> {
    this.tenantQuotas = this.tenantQuotas.filter(
      (quota) => quota.projectId !== input.projectId || quota.tenantId !== input.tenantId
    )
    this.tenantQuotas.push(input)
    return input
  }

  async getEndpoint(endpointId: string): Promise<{ id: string; status: "ACTIVE" | "ARCHIVED" } | null> {
    return this.endpoints.find((endpoint) => endpoint.id === endpointId) ?? null
  }

  async findEndpointProjectBinding(
    endpointId: string,
    projectId: string
  ): Promise<ManagedEndpointProjectBinding | null> {
    return (
      this.endpointBindings.find(
        (binding) => binding.endpointId === endpointId && binding.projectId === projectId
      ) ?? null
    )
  }

  async upsertEndpointProjectBindingRecord(input: {
    endpointId: string
    projectId: string
    status: "ACTIVE" | "REMOVED"
  }): Promise<ManagedEndpointProjectBinding> {
    const existing = await this.findEndpointProjectBinding(input.endpointId, input.projectId)
    if (existing) {
      Object.assign(existing, { status: input.status })
      return existing
    }
    const binding: ManagedEndpointProjectBinding = {
      id: `endpoint-binding-${this.endpointBindings.length + 1}`,
      ...input,
    }
    this.endpointBindings.push(binding)
    return binding
  }

  async upsertResourceOwnershipRecord(input: {
    resourceType: "INSTANCE" | "IMAGE" | "OPERATION"
    resourceId: string
    endpointId: string
    projectId: string
    tenantId: string
    discoveredName: string | null
    externalFingerprint: string | null
  }): Promise<ManagedResourceOwnership> {
    const ownership: ManagedResourceOwnership = {
      id: `ownership-${this.resourceOwnerships.length + 1}`,
      ...input,
    }
    this.resourceOwnerships.push(ownership)
    return ownership
  }

  async recordAudit(entry: AdminAuditEntry): Promise<void> {
    this.audits.push(entry)
  }

  addEndpoint(endpoint: { id: string; status: "ACTIVE" | "ARCHIVED" }): { id: string; status: "ACTIVE" | "ARCHIVED" } {
    this.endpoints.push(endpoint)
    return endpoint
  }

  archiveTenant(tenantId: string): void {
    const tenant = this.tenants.find((item) => item.id === tenantId)
    assert.ok(tenant)
    tenant.status = "ARCHIVED"
  }

  archiveProject(projectId: string): void {
    const project = this.projects.find((item) => item.id === projectId)
    assert.ok(project)
    project.status = "ARCHIVED"
  }

  restoreProject(projectId: string): void {
    const project = this.projects.find((item) => item.id === projectId)
    assert.ok(project)
    project.status = "ACTIVE"
  }

  restoreEndpoint(endpointId: string): void {
    const endpoint = this.endpoints.find((item) => item.id === endpointId)
    assert.ok(endpoint)
    endpoint.status = "ACTIVE"
  }

  removeEndpointProjectBinding(endpointId: string, projectId: string): void {
    const binding = this.endpointBindings.find(
      (item) => item.endpointId === endpointId && item.projectId === projectId
    )
    assert.ok(binding)
    binding.status = "REMOVED"
  }

  auditActions(): string[] {
    return this.audits.map((audit) => audit.action)
  }
}
