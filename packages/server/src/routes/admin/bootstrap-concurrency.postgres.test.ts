import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { PrismaClient } from "@prisma/client"
import { PrismaAdminDataStore } from "../../services/admin/session"

const databaseUrl = process.env.ANVIL_BOOTSTRAP_CONCURRENCY_DATABASE_URL
const sessionSecret = "test-session-secret-with-enough-entropy"

describe("admin bootstrap PostgreSQL concurrency regression", () => {
  test(
    "allows only one concurrent POST /api/admin/bootstrap on a fresh database",
    { skip: databaseUrl ? false : "set ANVIL_BOOTSTRAP_CONCURRENCY_DATABASE_URL to run the PostgreSQL regression test" },
    async () => {
      assert.ok(databaseUrl)
      process.env.NODE_ENV = "test"
      const { createApp } = await import("../../index")
      const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
      const store = new PrismaAdminDataStore(prisma, { DATABASE_URL: databaseUrl })
      const app = createApp({
        env: {
          DATABASE_URL: databaseUrl,
          ANVIL_SESSION_SECRET: sessionSecret,
          ANVIL_AGENT_URL: "ws://127.0.0.1:19090/ws",
        },
        adminStore: store,
      })

      try {
        await resetAdminTables(prisma)

        const responses = await Promise.all(
          Array.from({ length: 16 }, (_, index) =>
            app.request("/api/admin/bootstrap", {
              method: "POST",
              body: JSON.stringify({
                email: `bootstrap-${index}@example.com`,
                name: `Bootstrap Admin ${index}`,
                password: "correct horse battery staple",
                teamName: `Bootstrap Team ${index}`,
              }),
              headers: { "content-type": "application/json" },
            })
          )
        )

        const statuses = responses.map((response) => response.status)
        assert.equal(statuses.filter((status) => status === 200).length, 1)
        assert.equal(statuses.filter((status) => status === 409).length, 15)

        const rejectedBodies = await Promise.all(
          responses
            .filter((response) => response.status === 409)
            .map((response) => response.json() as Promise<{ error?: { code?: string } }>)
        )
        assert.deepEqual(
          new Set(rejectedBodies.map((body) => body.error?.code)),
          new Set(["BOOTSTRAP_ALREADY_COMPLETED"])
        )

        assert.equal(
          await prisma.user.count({ where: { globalRole: "ADMIN", status: "ACTIVE" } }),
          1
        )
        assert.equal(await prisma.team.count(), 1)
        assert.equal(await prisma.auditLog.count({ where: { action: "bootstrap.create" } }), 1)
      } finally {
        await resetAdminTables(prisma)
        await prisma.$disconnect()
      }
    }
  )
})

async function resetAdminTables(prisma: PrismaClient): Promise<void> {
  await prisma.auditLog.deleteMany()
  await prisma.agentEndpoint.deleteMany()
  await prisma.teamMembership.deleteMany()
  await prisma.user.deleteMany()
  await prisma.team.deleteMany()
}
