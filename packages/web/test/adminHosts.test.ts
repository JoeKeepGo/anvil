import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { canSyncAdminHost, countSyncableHosts } from "../src/pages/admin/AdminHosts.access.ts"
import type { AdminAccessSummary, AdminHostState } from "../src/types/index.ts"

const hostWithoutTeam: AdminHostState = {
  id: "host-state-1",
  endpoint: {
    id: "endpoint-1",
    name: "Local VM",
    status: "ACTIVE",
  },
  agent: {
    id: "11111111-1111-4111-8111-111111111111",
    version: "dev",
    stateSchemaVersion: 1,
    startedAt: "2026-06-22T00:00:00.000Z",
    reportedAt: "2026-06-22T00:30:00.000Z",
  },
  host: {
    hostname: "anvil-local-vm",
    os: "linux",
    arch: "arm64",
  },
  incus: {
    available: true,
    statusCode: 200,
  },
  capabilities: {
    incusProxy: true,
    events: true,
    stateReport: true,
    wireGuard: false,
    vmLifecycle: false,
  },
  snapshot: {
    instancesTotal: 0,
    imagesTotal: 1,
    operationsTotal: 0,
  },
  status: "ONLINE",
  firstSeenAt: "2026-06-22T01:00:00.000Z",
  lastSeenAt: "2026-06-22T02:00:00.000Z",
}

const hostWithTeam: AdminHostState = {
  ...hostWithoutTeam,
  endpoint: {
    ...hostWithoutTeam.endpoint,
    team: {
      id: "team-1",
      name: "Primary Team",
      status: "ACTIVE",
    },
  },
}

describe("admin host capability helpers", () => {
  test("does not expose sync for team-scoped access when the browser-safe host payload omits team scope", () => {
    const access: AdminAccessSummary = {
      bootstrapComplete: true,
      canAdmin: true,
      globalActions: ["hosts:read"],
      tenants: [],
      projects: [],
      teams: [{ teamId: "team-1", actions: ["hosts:read", "hosts:sync"] }],
    }

    assert.equal(canSyncAdminHost(access, hostWithoutTeam), false)
    assert.equal(canSyncAdminHost(access, hostWithTeam), true)
    assert.equal(countSyncableHosts(access, [hostWithoutTeam, hostWithTeam]), 1)
  })

  test("allows sync for every visible host when the user has global host sync capability", () => {
    const access: AdminAccessSummary = {
      bootstrapComplete: true,
      canAdmin: true,
      globalActions: ["hosts:read", "hosts:sync"],
      tenants: [],
      projects: [],
      teams: [],
    }

    assert.equal(canSyncAdminHost(access, hostWithoutTeam), true)
    assert.equal(canSyncAdminHost(access, hostWithTeam), true)
    assert.equal(countSyncableHosts(access, [hostWithoutTeam, hostWithTeam]), 2)
  })
})
