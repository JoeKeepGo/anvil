import { PrismaClient } from "@prisma/client"
import type { BrowserAccessSummary } from "./admin/session"
import { AuthConfigError } from "./auth"

export type ResourceVisibilityType = "INSTANCE" | "IMAGE" | "OPERATION"

export interface ResourceVisibilityRecord {
  resourceType: ResourceVisibilityType
  resourceId: string
  endpointId: string
  agentUrl: string
  projectId: string
  tenantId: string
}

export interface ResourceVisibilityStore {
  findVisibleResourceOwnerships(input: {
    agentUrl: string
    resourceType: ResourceVisibilityType
    resourceIds: string[]
    projectTenantScopes: Array<{ projectId: string; tenantId: string }>
  }): Promise<ResourceVisibilityRecord[]>
}

type ResourceVisibilityQuery = {
  where: {
    resourceType: ResourceVisibilityType
    resourceId: { in: string[] }
    endpoint: { url: string; status: "ACTIVE" }
    project: { status: "ACTIVE" }
    tenant: { status: "ACTIVE" }
    projectTenant: { status: "ACTIVE" }
    endpointProjectBinding: { status: "ACTIVE" }
    OR: Array<{ projectId: string; tenantId: string }>
  }
  select: {
    resourceType: true
    resourceId: true
    endpointId: true
    projectId: true
    tenantId: true
    endpoint: {
      select: {
        url: true
      }
    }
  }
}

type ResourceVisibilityPrismaRow = {
  resourceType: ResourceVisibilityType
  resourceId: string
  endpointId: string
  projectId: string
  tenantId: string
  endpoint: {
    url: string
  }
}

interface ResourceVisibilityPrismaClient {
  resourceOwnership: {
    findMany(query: ResourceVisibilityQuery): Promise<ResourceVisibilityPrismaRow[]>
  }
}

export interface ResourceVisibilityPolicy {
  filterVisibleResourceIds(
    resourceType: ResourceVisibilityType,
    resourceIds: string[]
  ): Promise<Set<string>>
  canReadResource(resourceType: ResourceVisibilityType, resourceId: string): Promise<boolean>
}

export class PrismaResourceVisibilityStore implements ResourceVisibilityStore {
  constructor(
    private readonly prisma: ResourceVisibilityPrismaClient = new PrismaClient(),
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  async findVisibleResourceOwnerships(input: {
    agentUrl: string
    resourceType: ResourceVisibilityType
    resourceIds: string[]
    projectTenantScopes: Array<{ projectId: string; tenantId: string }>
  }): Promise<ResourceVisibilityRecord[]> {
    this.assertDatabaseConfigured()
    const resourceIds = uniqueValues(input.resourceIds)
    if (resourceIds.length === 0 || input.projectTenantScopes.length === 0) {
      return []
    }

    const ownerships = await this.prisma.resourceOwnership.findMany({
      where: {
        resourceType: input.resourceType,
        resourceId: { in: resourceIds },
        endpoint: {
          url: input.agentUrl,
          status: "ACTIVE",
        },
        project: {
          status: "ACTIVE",
        },
        tenant: {
          status: "ACTIVE",
        },
        projectTenant: {
          status: "ACTIVE",
        },
        endpointProjectBinding: {
          status: "ACTIVE",
        },
        OR: input.projectTenantScopes.map((scope) => ({
          projectId: scope.projectId,
          tenantId: scope.tenantId,
        })),
      },
      select: {
        resourceType: true,
        resourceId: true,
        endpointId: true,
        projectId: true,
        tenantId: true,
        endpoint: {
          select: {
            url: true,
          },
        },
      },
    })

    return ownerships.map((ownership) => ({
      resourceType: ownership.resourceType,
      resourceId: ownership.resourceId,
      endpointId: ownership.endpointId,
      agentUrl: ownership.endpoint.url,
      projectId: ownership.projectId,
      tenantId: ownership.tenantId,
    }))
  }

  private assertDatabaseConfigured(): void {
    if (!this.env.DATABASE_URL || this.env.DATABASE_URL.trim() === "") {
      throw new AuthConfigError()
    }
  }
}

export function createResourceVisibilityPolicy(input: {
  access: BrowserAccessSummary
  agentUrl: string
  store: ResourceVisibilityStore
}): ResourceVisibilityPolicy {
  return {
    async filterVisibleResourceIds(resourceType, resourceIds) {
      const uniqueResourceIds = uniqueValues(resourceIds)
      if (canBypassResourceVisibility(input.access)) {
        return new Set(uniqueResourceIds)
      }

      const projectTenantScopes = activeProjectTenantScopes(input.access)
      if (projectTenantScopes.length === 0 || uniqueResourceIds.length === 0) {
        return new Set()
      }

      const ownerships = await input.store.findVisibleResourceOwnerships({
        agentUrl: input.agentUrl,
        resourceType,
        resourceIds: uniqueResourceIds,
        projectTenantScopes,
      })

      return new Set(ownerships.map((ownership) => ownership.resourceId))
    },

    async canReadResource(resourceType, resourceId) {
      return (await this.filterVisibleResourceIds(resourceType, [resourceId])).has(resourceId)
    },
  }
}

function canBypassResourceVisibility(access: BrowserAccessSummary): boolean {
  return access.globalActions.includes("resources:read")
}

function activeProjectTenantScopes(
  access: BrowserAccessSummary
): Array<{ projectId: string; tenantId: string }> {
  return access.projects
    .filter((project) => project.actions.includes("resources:read"))
    .map((project) => ({
      projectId: project.projectId,
      tenantId: project.tenantId,
    }))
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values)]
}
