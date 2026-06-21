import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, test } from "node:test"

const sidebarSource = readSource("../src/components/layout/Sidebar.tsx")
const overviewSource = readSource("../src/pages/admin/AdminOverview.tsx")
const appSource = readSource("../src/App.tsx")

describe("M10 admin navigation", () => {
  test("exposes tenants and projects in the admin sidebar", () => {
    assert.match(sidebarSource, /to: "\/admin\/tenants"/)
    assert.match(sidebarSource, /to: "\/admin\/projects"/)
  })

  test("exposes tenants and projects in the admin overview", () => {
    assert.match(overviewSource, /to: "\/admin\/tenants"/)
    assert.match(overviewSource, /to: "\/admin\/projects"/)
  })

  test("mounts tenants, project list, and project detail admin routes", () => {
    assert.match(appSource, /path="tenants"/)
    assert.match(appSource, /path="tenants\/:tenantId"/)
    assert.match(appSource, /path="projects"/)
    assert.match(appSource, /path="projects\/:projectId"/)
  })
})

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8")
}
