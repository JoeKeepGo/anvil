import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  canUseAdminConsole,
  hasProjectAction,
  hasGlobalAction,
  hasTenantAction,
  hasTeamAction,
} from "../src/lib/adminAccess.ts"
import type { AdminAccessSummary } from "../src/types/index.ts"

describe("admin access helpers", () => {
  test("allows admin console access from the same capability summary fields returned by /api/auth/me", () => {
    const access: AdminAccessSummary = {
      bootstrapComplete: true,
      canAdmin: true,
      globalActions: ["users:read", "audit:read", "tenants:read"],
      tenants: [{ tenantId: "tenant-1", actions: ["tenants:read", "projects:read"] }],
      projects: [{ projectId: "project-1", tenantId: "tenant-1", actions: ["projects:read"] }],
      teams: [{ teamId: "team-1", actions: ["endpoints:read"] }],
    }

    assert.equal(canUseAdminConsole(access), true)
    assert.equal(hasGlobalAction(access, "users:read"), true)
    assert.equal(hasGlobalAction(access, "users:write"), false)
    assert.equal(hasTenantAction(access, "tenant-1", "projects:read"), true)
    assert.equal(hasTenantAction(access, "tenant-2", "projects:read"), false)
    assert.equal(hasProjectAction(access, "project-1", "projects:read"), true)
    assert.equal(hasProjectAction(access, "project-2", "projects:read"), false)
    assert.equal(hasTeamAction(access, "team-1", "endpoints:read"), true)
    assert.equal(hasTeamAction(access, "team-2", "endpoints:read"), false)
  })

  test("denies admin console access when the backend capability summary denies it", () => {
    const access: AdminAccessSummary = {
      bootstrapComplete: true,
      canAdmin: false,
      globalActions: [],
      tenants: [],
      projects: [],
      teams: [],
    }

    assert.equal(canUseAdminConsole(access), false)
  })
})
