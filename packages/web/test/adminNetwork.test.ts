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
  test("read requires network:read and sync requires network:apply", () => {
    const withoutRead = accessWith(["users:read"])
    assert.equal(canReadNetwork(withoutRead), false)
    assert.equal(canSyncNetwork(withoutRead), false)

    const withRead = accessWith(["network:read"])
    assert.equal(canReadNetwork(withRead), true)
    // sync routes through the backend syncFabric service, which asserts
    // network:apply; it is not a read-adjacent action.
    assert.equal(canSyncNetwork(withRead), false)
  })

  test("sync requires network:apply and not just network:read", () => {
    assert.equal(canSyncNetwork(accessWith(["network:read", "network:write"])), false)
    assert.equal(canSyncNetwork(accessWith(["network:read", "network:apply"])), true)
  })

  test("dry-run requires network:apply and not just network:read or network:write", () => {
    // dry-run shares the applyFabric service with apply, so it requires
    // network:apply just like apply.
    assert.equal(canDryRunNetwork(accessWith(["network:read"])), false)
    assert.equal(canDryRunNetwork(accessWith(["network:read", "network:write"])), false)
    assert.equal(canDryRunNetwork(accessWith(["network:read", "network:apply"])), true)
  })

  test("apply requires network:apply and not just network:write", () => {
    assert.equal(canApplyNetwork(accessWith(["network:read", "network:write"])), false)
    assert.equal(canApplyNetwork(accessWith(["network:read", "network:apply"])), true)
  })

  test("network:apply alone does not grant read", () => {
    // Read stays gated on network:read; apply rights do not imply visibility.
    const applyOnly = accessWith(["network:apply"])
    assert.equal(canReadNetwork(applyOnly), false)
    assert.equal(canSyncNetwork(applyOnly), true)
    assert.equal(canDryRunNetwork(applyOnly), true)
    assert.equal(canApplyNetwork(applyOnly), true)
  })

  test("full network capability grants every action", () => {
    const full = accessWith(["network:read", "network:apply"])
    assert.equal(canReadNetwork(full), true)
    assert.equal(canSyncNetwork(full), true)
    assert.equal(canDryRunNetwork(full), true)
    assert.equal(canApplyNetwork(full), true)
  })
})