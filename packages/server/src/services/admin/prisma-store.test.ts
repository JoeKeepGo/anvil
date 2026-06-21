import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { AuthConfigError } from "../auth"
import { mapPrismaUserToAdminPrincipal, PrismaAdminDataStore } from "./session"

describe("Prisma admin identity mapping", () => {
  test("maps missing database configuration to the auth config error boundary before Prisma queries", async () => {
    const store = new PrismaAdminDataStore(undefined, {})

    await assert.rejects(store.isBootstrapComplete(), AuthConfigError)
    await assert.rejects(store.findUserByEmail("admin@example.com"), AuthConfigError)
    await assert.rejects(store.findUserById("user-1"), AuthConfigError)
  })

  test("maps a user with active and archived team memberships into the browser-safe principal shape", () => {
    const principal = mapPrismaUserToAdminPrincipal({
      id: "user-1",
      email: "Admin@Example.com",
      name: "Admin User",
      passwordHash: "hash-that-must-not-appear",
      status: "ACTIVE",
      globalRole: "ADMIN",
      createdAt: new Date("2026-06-21T00:00:00.000Z"),
      updatedAt: new Date("2026-06-21T00:00:00.000Z"),
      memberships: [
        {
          id: "membership-1",
          userId: "user-1",
          teamId: "team-1",
          role: "OWNER",
          status: "ACTIVE",
          createdAt: new Date("2026-06-21T00:00:00.000Z"),
          updatedAt: new Date("2026-06-21T00:00:00.000Z"),
          team: {
            id: "team-1",
            name: "Primary Team",
            status: "ACTIVE",
            createdAt: new Date("2026-06-21T00:00:00.000Z"),
            updatedAt: new Date("2026-06-21T00:00:00.000Z"),
          },
        },
        {
          id: "membership-2",
          userId: "user-1",
          teamId: "team-2",
          role: "VIEWER",
          status: "REMOVED",
          createdAt: new Date("2026-06-21T00:00:00.000Z"),
          updatedAt: new Date("2026-06-21T00:00:00.000Z"),
          team: {
            id: "team-2",
            name: "Removed Team",
            status: "ACTIVE",
            createdAt: new Date("2026-06-21T00:00:00.000Z"),
            updatedAt: new Date("2026-06-21T00:00:00.000Z"),
          },
        },
      ],
    })

    assert.deepEqual(principal, {
      id: "user-1",
      email: "admin@example.com",
      name: "Admin User",
      status: "ACTIVE",
      globalRole: "ADMIN",
      teams: [
        {
          id: "team-1",
          name: "Primary Team",
          role: "OWNER",
          status: "ACTIVE",
        },
      ],
    })
    assert.equal(JSON.stringify(principal).includes("hash-that-must-not-appear"), false)
  })

  test("derives tenant/project scopes from active team endpoint project bindings", async () => {
    const store = new PrismaAdminDataStore(new TestPrismaAdminScopesClient(), {
      DATABASE_URL: "postgresql://example.invalid/anvil",
    })

    const scopes = await store.getTenantProjectAccessScopes("user-1")

    assert.deepEqual(scopes, {
      tenants: [
        { tenantId: "tenant-a", status: "ACTIVE" },
        { tenantId: "tenant-b", status: "ACTIVE" },
        { tenantId: "tenant-archived", status: "ARCHIVED" },
      ],
      projects: [
        { projectId: "project-a", tenantId: "tenant-a", status: "ACTIVE" },
        { projectId: "project-b", tenantId: "tenant-b", status: "ACTIVE" },
      ],
    })
  })
})

class TestPrismaAdminScopesClient {
  readonly user = {} as never
  readonly team = {} as never
  readonly auditLog = {} as never
  readonly $transaction = {} as never
  readonly $executeRaw = {} as never
  readonly projectTenant = {
    findMany: async (query: {
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
      }
    }) => {
      assert.equal(query.where.project.endpointBindings.some.endpoint.team.memberships.some.userId, "user-1")
      return [
        projectTenantScopeRow("project-a", "tenant-a", "ACTIVE", "ACTIVE"),
        projectTenantScopeRow("project-b", "tenant-b", "ACTIVE", "ACTIVE"),
        projectTenantScopeRow("project-archived", "tenant-a", "ARCHIVED", "ACTIVE"),
        projectTenantScopeRow("project-c", "tenant-archived", "ACTIVE", "ARCHIVED"),
        projectTenantScopeRow("project-a", "tenant-a", "ACTIVE", "ACTIVE"),
      ]
    },
  }
}

function projectTenantScopeRow(
  projectId: string,
  tenantId: string,
  projectStatus: "ACTIVE" | "ARCHIVED",
  tenantStatus: "ACTIVE" | "ARCHIVED"
) {
  return {
    projectId,
    tenantId,
    project: {
      status: projectStatus,
    },
    tenant: {
      status: tenantStatus,
    },
  }
}
