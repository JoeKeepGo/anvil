import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  buildAccessSummary,
  canPerformGlobalAction,
  canPerformProjectAction,
  canPerformTenantAction,
  canPerformTeamAction,
  getPermissionMatrix,
  globalAdminActions,
  teamOwnerActions,
  type AdminPrincipal,
} from "./permissions"

describe("admin permission evaluator", () => {
  test("derives the bootstrap admin capability summary from the same evaluator used for checks", () => {
    const principal: AdminPrincipal = {
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
    }

    const access = buildAccessSummary(principal, true)

    assert.deepEqual(access, {
      bootstrapComplete: true,
      canAdmin: true,
      globalActions: globalAdminActions,
      tenants: [],
      projects: [],
      teams: [
        {
          teamId: "team-1",
          actions: teamOwnerActions,
        },
      ],
    })
    assert.equal(canPerformGlobalAction(principal, "users:write"), true)
    assert.equal(canPerformGlobalAction(principal, "hosts:read"), true)
    assert.equal(canPerformGlobalAction(principal, "hosts:sync"), true)
    assert.equal(access.globalActions.includes("users:write"), true)
    assert.equal(access.globalActions.includes("hosts:read"), true)
    assert.equal(access.globalActions.includes("hosts:sync"), true)
    assert.equal(canPerformTeamAction(principal, "team-1", "endpoints:write"), true)
    assert.equal(canPerformTeamAction(principal, "team-1", "hosts:sync"), true)
    assert.equal(access.teams[0]?.actions.includes("endpoints:write"), true)
    assert.equal(access.teams[0]?.actions.includes("hosts:read"), true)
  })

  test("derives active tenant and project capability scopes without leaking archived scopes", () => {
    const principal: AdminPrincipal = {
      id: "user-1",
      email: "member@example.com",
      name: "Member User",
      status: "ACTIVE",
      globalRole: "MEMBER",
      teams: [],
    }

    const access = buildAccessSummary(principal, true, {
      tenants: [
        { tenantId: "tenant-1", status: "ACTIVE" },
        { tenantId: "tenant-archived", status: "ARCHIVED" },
      ],
      projects: [
        { projectId: "project-1", tenantId: "tenant-1", status: "ACTIVE" },
        { projectId: "project-archived", tenantId: "tenant-1", status: "ARCHIVED" },
      ],
    })

    assert.deepEqual(access.tenants, [
      {
        tenantId: "tenant-1",
        actions: ["tenants:read", "projects:read", "resources:read"],
      },
    ])
    assert.deepEqual(access.projects, [
      {
        projectId: "project-1",
        tenantId: "tenant-1",
        actions: ["projects:read", "quotas:read", "resources:read"],
      },
    ])
    assert.equal(access.canAdmin, true)
    assert.equal(canPerformTenantAction(access, "tenant-1", "resources:read"), true)
    assert.equal(canPerformTenantAction(access, "tenant-archived", "resources:read"), false)
    assert.equal(canPerformProjectAction(access, "project-1", "quotas:read"), true)
    assert.equal(canPerformProjectAction(access, "project-archived", "quotas:read"), false)
  })

  test("does not grant capabilities to disabled users or archived memberships", () => {
    const disabled: AdminPrincipal = {
      id: "user-1",
      email: "admin@example.com",
      name: "Admin User",
      status: "DISABLED",
      globalRole: "ADMIN",
      teams: [
        {
          id: "team-1",
          name: "Primary Team",
          role: "OWNER",
          status: "ACTIVE",
        },
      ],
    }
    const archivedTeam: AdminPrincipal = {
      id: "user-2",
      email: "owner@example.com",
      name: "Owner User",
      status: "ACTIVE",
      globalRole: "MEMBER",
      teams: [
        {
          id: "team-2",
          name: "Archived Team",
          role: "OWNER",
          status: "ARCHIVED",
        },
      ],
    }

    assert.deepEqual(
      buildAccessSummary(disabled, true, {
        tenants: [{ tenantId: "tenant-1", status: "ACTIVE" }],
        projects: [{ projectId: "project-1", tenantId: "tenant-1", status: "ACTIVE" }],
      }),
      {
        bootstrapComplete: true,
        canAdmin: false,
        globalActions: [],
        tenants: [],
        projects: [],
        teams: [],
      }
    )
    assert.equal(canPerformGlobalAction(disabled, "users:read"), false)
    assert.equal(canPerformTeamAction(disabled, "team-1", "members:read"), false)
    assert.deepEqual(buildAccessSummary(archivedTeam, true), {
      bootstrapComplete: true,
      canAdmin: false,
      globalActions: [],
      tenants: [],
      projects: [],
      teams: [],
    })
    assert.equal(canPerformTeamAction(archivedTeam, "team-2", "members:read"), false)
  })

  test("exposes a browser-safe permission matrix from the evaluator action sets", () => {
    assert.deepEqual(getPermissionMatrix(), {
      global: [
        {
          role: "ADMIN",
          actions: globalAdminActions,
        },
        {
          role: "MEMBER",
          actions: [],
        },
      ],
      team: [
        {
          role: "OWNER",
          actions: teamOwnerActions,
        },
        {
          role: "MAINTAINER",
          actions: ["members:read", "endpoints:read", "endpoints:write", "audit:read", "hosts:read", "hosts:sync"],
        },
        {
          role: "VIEWER",
          actions: ["members:read", "endpoints:read", "audit:read", "hosts:read"],
        },
      ],
      tenant: [
        {
          scope: "ACTIVE_TENANT",
          actions: ["tenants:read", "projects:read", "resources:read"],
        },
      ],
      project: [
        {
          scope: "ACTIVE_PROJECT",
          actions: ["projects:read", "quotas:read", "resources:read"],
        },
      ],
    })
    assert.equal(JSON.stringify(getPermissionMatrix()).includes("password"), false)
    assert.equal(JSON.stringify(getPermissionMatrix()).includes("token"), false)
    assert.equal(JSON.stringify(getPermissionMatrix()).includes("session"), false)
  })
})

describe("network permission actions", () => {
  test("exposes network:read, network:write, and network:apply as global admin actions only", () => {
    const principal: AdminPrincipal = {
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
      teams: [
        { id: "team-1", name: "Primary Team", role: "OWNER", status: "ACTIVE" },
      ],
    }

    assert.equal(canPerformGlobalAction(principal, "network:read"), true)
    assert.equal(canPerformGlobalAction(principal, "network:write"), true)
    assert.equal(canPerformGlobalAction(principal, "network:apply"), true)
    assert.equal(globalAdminActions.includes("network:read"), true)
    assert.equal(globalAdminActions.includes("network:write"), true)
    assert.equal(globalAdminActions.includes("network:apply"), true)

    // Network management is a global admin foundation concern in Phase 2.
    // Team-scoped network action assignment is deferred to the API phase.
    assert.equal(canPerformGlobalAction(member, "network:read"), false)
    assert.equal(canPerformGlobalAction(member, "network:write"), false)
    assert.equal(canPerformGlobalAction(member, "network:apply"), false)
    assert.equal(teamOwnerActions.includes("network:read" as never), false)

    const matrix = getPermissionMatrix()
    const adminActions = matrix.global.find((entry) => entry.role === "ADMIN")?.actions ?? []
    assert.equal(adminActions.includes("network:read"), true)
    assert.equal(adminActions.includes("network:write"), true)
    assert.equal(adminActions.includes("network:apply"), true)
  })
})
