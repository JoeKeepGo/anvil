import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  canApplyNetwork,
  canDryRunNetwork,
  canReadNetwork,
  canSyncNetwork,
} from "../src/pages/admin/AdminNetwork.access.ts"
import type { AdminAccessSummary } from "../src/types/index.ts"

function accessWith(actions: string[]): AdminAccessSummary {
  return {
    bootstrapComplete: true,
    canAdmin: true,
    globalActions: actions as AdminAccessSummary["globalActions"],
    tenants: [],
    projects: [],
    teams: [],
  }
}

describe("admin network capability helpers", () => {
  test("read and sync require network:read", () => {
    const withoutRead = accessWith(["users:read"])
    assert.equal(canReadNetwork(withoutRead), false)
    assert.equal(canSyncNetwork(withoutRead), false)

    const withRead = accessWith(["network:read"])
    assert.equal(canReadNetwork(withRead), true)
    assert.equal(canSyncNetwork(withRead), true)
  })

  test("dry-run requires network:write and not just network:read", () => {
    assert.equal(canDryRunNetwork(accessWith(["network:read"])), false)
    assert.equal(canDryRunNetwork(accessWith(["network:read", "network:write"])), true)
  })

  test("apply requires network:apply and not just network:write", () => {
    assert.equal(canApplyNetwork(accessWith(["network:read", "network:write"])), false)
    assert.equal(canApplyNetwork(accessWith(["network:read", "network:apply"])), true)
  })

  test("full network capability grants every action", () => {
    const full = accessWith(["network:read", "network:write", "network:apply"])
    assert.equal(canReadNetwork(full), true)
    assert.equal(canSyncNetwork(full), true)
    assert.equal(canDryRunNetwork(full), true)
    assert.equal(canApplyNetwork(full), true)
  })
})