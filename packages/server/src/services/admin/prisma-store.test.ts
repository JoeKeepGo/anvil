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
})
