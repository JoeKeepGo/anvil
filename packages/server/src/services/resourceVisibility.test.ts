import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { AuthConfigError } from "./auth"
import {
  PrismaResourceVisibilityStore,
  createResourceVisibilityPolicy,
  type ResourceVisibilityRecord,
} from "./resourceVisibility"
import type { BrowserAccessSummary } from "./admin/session"

describe("resource visibility service", () => {
  test("maps missing database configuration to the auth config error boundary", async () => {
    const store = new PrismaResourceVisibilityStore(undefined, {})

    await assert.rejects(
      store.findVisibleResourceOwnerships({
        agentUrl: "ws://127.0.0.1:19090/ws",
        resourceType: "INSTANCE",
        resourceIds: ["demo"],
        projectTenantScopes: [{ projectId: "project-1", tenantId: "tenant-1" }],
      }),
      AuthConfigError
    )
  })

  test("filters by active endpoint URL, active binding, and project tenant scope", async () => {
    const prisma = new TestPrismaResourceOwnershipClient()
    const store = new PrismaResourceVisibilityStore(prisma, {
      DATABASE_URL: "postgresql://example.invalid/anvil",
    })

    const visible = await store.findVisibleResourceOwnerships({
      agentUrl: "ws://127.0.0.1:19090/ws",
      resourceType: "INSTANCE",
      resourceIds: [
        "visible-instance",
        "wrong-endpoint-url",
        "removed-binding",
        "archived-project",
        "archived-tenant",
        "archived-endpoint",
        "removed-project-tenant",
        "wrong-project",
        "unowned-legacy",
      ],
      projectTenantScopes: [{ projectId: "project-a", tenantId: "tenant-a" }],
    })

    assert.deepEqual(visible, [
      {
        resourceType: "INSTANCE",
        resourceId: "visible-instance",
        endpointId: "endpoint-a",
        agentUrl: "ws://127.0.0.1:19090/ws",
        projectId: "project-a",
        tenantId: "tenant-a",
      },
    ])
  })

  test("platform admin visibility includes unowned legacy resources while scoped users require ownership", async () => {
    const store = {
      async findVisibleResourceOwnerships(): Promise<ResourceVisibilityRecord[]> {
        return [
          {
            resourceType: "IMAGE",
            resourceId: "owned-image",
            endpointId: "endpoint-a",
            agentUrl: "ws://127.0.0.1:19090/ws",
            projectId: "project-a",
            tenantId: "tenant-a",
          },
        ]
      },
    }
    const platformPolicy = createResourceVisibilityPolicy({
      access: accessSummary({ globalActions: ["resources:read"] }),
      agentUrl: "ws://127.0.0.1:19090/ws",
      store,
    })
    const scopedPolicy = createResourceVisibilityPolicy({
      access: accessSummary({
        projects: [{ projectId: "project-a", tenantId: "tenant-a", actions: ["resources:read"] }],
      }),
      agentUrl: "ws://127.0.0.1:19090/ws",
      store,
    })

    assert.deepEqual(
      [...(await platformPolicy.filterVisibleResourceIds("IMAGE", ["owned-image", "legacy-image"]))],
      ["owned-image", "legacy-image"]
    )
    assert.deepEqual(
      [...(await scopedPolicy.filterVisibleResourceIds("IMAGE", ["owned-image", "legacy-image"]))],
      ["owned-image"]
    )
  })
})

class TestPrismaResourceOwnershipClient {
  readonly resourceOwnership = {
    findMany: async (query: {
      where: {
        resourceType: string
        resourceId: { in: string[] }
        endpoint: { url: string; status: string }
        project: { status: string }
        tenant: { status: string }
        projectTenant: { status: string }
        endpointProjectBinding: { status: string }
        OR: Array<{ projectId: string; tenantId: string }>
      }
    }) => {
      return resourceOwnershipRows.filter(
        (row) =>
          row.resourceType === query.where.resourceType &&
          query.where.resourceId.in.includes(row.resourceId) &&
          row.endpoint.url === query.where.endpoint.url &&
          row.endpoint.status === query.where.endpoint.status &&
          row.project.status === query.where.project.status &&
          row.tenant.status === query.where.tenant.status &&
          row.projectTenant.status === query.where.projectTenant.status &&
          row.endpointProjectBinding.status === query.where.endpointProjectBinding.status &&
          query.where.OR.some(
            (scope) => scope.projectId === row.projectId && scope.tenantId === row.tenantId
          )
      )
    },
  }
}

const resourceOwnershipRows = [
  ownershipRow("visible-instance", {
    endpointUrl: "ws://127.0.0.1:19090/ws",
    endpointStatus: "ACTIVE",
    bindingStatus: "ACTIVE",
    projectStatus: "ACTIVE",
    tenantStatus: "ACTIVE",
    projectTenantStatus: "ACTIVE",
    projectId: "project-a",
    tenantId: "tenant-a",
  }),
  ownershipRow("wrong-endpoint-url", {
    endpointUrl: "ws://127.0.0.1:29090/ws",
    endpointStatus: "ACTIVE",
    bindingStatus: "ACTIVE",
    projectStatus: "ACTIVE",
    tenantStatus: "ACTIVE",
    projectTenantStatus: "ACTIVE",
    projectId: "project-a",
    tenantId: "tenant-a",
  }),
  ownershipRow("removed-binding", {
    endpointUrl: "ws://127.0.0.1:19090/ws",
    endpointStatus: "ACTIVE",
    bindingStatus: "REMOVED",
    projectStatus: "ACTIVE",
    tenantStatus: "ACTIVE",
    projectTenantStatus: "ACTIVE",
    projectId: "project-a",
    tenantId: "tenant-a",
  }),
  ownershipRow("archived-project", {
    endpointUrl: "ws://127.0.0.1:19090/ws",
    endpointStatus: "ACTIVE",
    bindingStatus: "ACTIVE",
    projectStatus: "ARCHIVED",
    tenantStatus: "ACTIVE",
    projectTenantStatus: "ACTIVE",
    projectId: "project-a",
    tenantId: "tenant-a",
  }),
  ownershipRow("archived-tenant", {
    endpointUrl: "ws://127.0.0.1:19090/ws",
    endpointStatus: "ACTIVE",
    bindingStatus: "ACTIVE",
    projectStatus: "ACTIVE",
    tenantStatus: "ARCHIVED",
    projectTenantStatus: "ACTIVE",
    projectId: "project-a",
    tenantId: "tenant-a",
  }),
  ownershipRow("archived-endpoint", {
    endpointUrl: "ws://127.0.0.1:19090/ws",
    endpointStatus: "ARCHIVED",
    bindingStatus: "ACTIVE",
    projectStatus: "ACTIVE",
    tenantStatus: "ACTIVE",
    projectTenantStatus: "ACTIVE",
    projectId: "project-a",
    tenantId: "tenant-a",
  }),
  ownershipRow("removed-project-tenant", {
    endpointUrl: "ws://127.0.0.1:19090/ws",
    endpointStatus: "ACTIVE",
    bindingStatus: "ACTIVE",
    projectStatus: "ACTIVE",
    tenantStatus: "ACTIVE",
    projectTenantStatus: "REMOVED",
    projectId: "project-a",
    tenantId: "tenant-a",
  }),
  ownershipRow("wrong-project", {
    endpointUrl: "ws://127.0.0.1:19090/ws",
    endpointStatus: "ACTIVE",
    bindingStatus: "ACTIVE",
    projectStatus: "ACTIVE",
    tenantStatus: "ACTIVE",
    projectTenantStatus: "ACTIVE",
    projectId: "project-b",
    tenantId: "tenant-b",
  }),
]

type TestResourceOwnershipRow = {
  resourceType: "INSTANCE"
  resourceId: string
  endpointId: string
  projectId: string
  tenantId: string
  endpoint: { url: string; status: "ACTIVE" | "ARCHIVED" }
  project: { status: "ACTIVE" | "ARCHIVED" }
  tenant: { status: "ACTIVE" | "ARCHIVED" }
  projectTenant: { status: "ACTIVE" | "REMOVED" }
  endpointProjectBinding: { status: "ACTIVE" | "REMOVED" }
}

function ownershipRow(
  resourceId: string,
  input: {
    endpointUrl: string
    endpointStatus: "ACTIVE" | "ARCHIVED"
    bindingStatus: "ACTIVE" | "REMOVED"
    projectStatus: "ACTIVE" | "ARCHIVED"
    tenantStatus: "ACTIVE" | "ARCHIVED"
    projectTenantStatus: "ACTIVE" | "REMOVED"
    projectId: string
    tenantId: string
  }
): TestResourceOwnershipRow {
  return {
    resourceType: "INSTANCE",
    resourceId,
    endpointId: "endpoint-a",
    projectId: input.projectId,
    tenantId: input.tenantId,
    endpoint: {
      url: input.endpointUrl,
      status: input.endpointStatus,
    },
    project: {
      status: input.projectStatus,
    },
    tenant: {
      status: input.tenantStatus,
    },
    projectTenant: {
      status: input.projectTenantStatus,
    },
    endpointProjectBinding: {
      status: input.bindingStatus,
    },
  }
}

function accessSummary(input: Partial<BrowserAccessSummary>): BrowserAccessSummary {
  return {
    bootstrapComplete: true,
    canAdmin: true,
    globalActions: [],
    tenants: [],
    projects: [],
    teams: [],
    ...input,
  }
}
