import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  buildAccessSummary,
  canPerformGlobalAction,
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
      teams: [
        {
          teamId: "team-1",
          actions: teamOwnerActions,
        },
      ],
    })
    assert.equal(canPerformGlobalAction(principal, "users:write"), true)
    assert.equal(access.globalActions.includes("users:write"), true)
    assert.equal(canPerformTeamAction(principal, "team-1", "endpoints:write"), true)
    assert.equal(access.teams[0]?.actions.includes("endpoints:write"), true)
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

    assert.deepEqual(buildAccessSummary(disabled, true), {
      bootstrapComplete: true,
      canAdmin: false,
      globalActions: [],
      teams: [],
    })
    assert.equal(canPerformGlobalAction(disabled, "users:read"), false)
    assert.equal(canPerformTeamAction(disabled, "team-1", "members:read"), false)
    assert.deepEqual(buildAccessSummary(archivedTeam, true), {
      bootstrapComplete: true,
      canAdmin: false,
      globalActions: [],
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
          actions: ["members:read", "endpoints:read", "endpoints:write", "audit:read"],
        },
        {
          role: "VIEWER",
          actions: ["members:read", "endpoints:read", "audit:read"],
        },
      ],
    })
    assert.equal(JSON.stringify(getPermissionMatrix()).includes("password"), false)
    assert.equal(JSON.stringify(getPermissionMatrix()).includes("token"), false)
    assert.equal(JSON.stringify(getPermissionMatrix()).includes("session"), false)
  })
})
