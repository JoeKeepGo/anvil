import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, test } from "node:test"

const sidebarSource = readSource("../src/components/layout/Sidebar.tsx")
const overviewSource = readSource("../src/pages/admin/AdminOverview.tsx")
const appSource = readSource("../src/App.tsx")
const adminHostsSource = readOptionalSource("../src/pages/admin/AdminHosts.tsx")
const adminHostsAccessSource = readOptionalSource("../src/pages/admin/AdminHosts.access.ts")

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

describe("M11 admin hosts navigation", () => {
  test("exposes hosts in admin sidebar and overview only through hosts:read capability", () => {
    assert.match(sidebarSource, /to: "\/admin\/hosts"/)
    assert.match(sidebarSource, /hosts:read/)
    assert.match(overviewSource, /to: "\/admin\/hosts"/)
    assert.match(overviewSource, /hosts:read/)
  })

  test("mounts the host status console route", () => {
    assert.match(appSource, /AdminHosts/)
    assert.match(appSource, /path="hosts"/)
  })

  test("keeps the host status console in browser-safe read and sync scope", () => {
    assert.match(adminHostsSource, /fetchAdminHosts/)
    assert.match(adminHostsSource, /syncAdminHostState/)
    assert.match(`${adminHostsSource}\n${adminHostsAccessSource}`, /hosts:sync/)

    for (const forbidden of [
      "tokenCiphertext",
      "agent token",
      "endpoint token",
      "rawIncus",
      "/1.0/",
      "ws://",
      "wss://",
      "19090",
      "Create VM",
      "Start",
      "Stop",
      "Restart",
      "Delete",
      "WireGuard",
      "IPv6",
    ]) {
      assert.equal(
        adminHostsSource.includes(forbidden),
        false,
        `AdminHosts source contains forbidden host-console scope: ${forbidden}`
      )
    }
  })
})

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8")
}

function readOptionalSource(relativePath: string): string {
  try {
    return readSource(relativePath)
  } catch {
    return ""
  }
}
