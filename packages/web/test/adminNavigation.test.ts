import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, test } from "node:test"

const sidebarSource = readSource("../src/components/layout/Sidebar.tsx")
const overviewSource = readSource("../src/pages/admin/AdminOverview.tsx")
const appSource = readSource("../src/App.tsx")
const adminHostsSource = readOptionalSource("../src/pages/admin/AdminHosts.tsx")
const adminHostsAccessSource = readOptionalSource("../src/pages/admin/AdminHosts.access.ts")
const adminNetworkSource = readOptionalSource("../src/pages/admin/AdminNetwork.tsx")
const adminNetworkAccessSource = readOptionalSource("../src/pages/admin/AdminNetwork.access.ts")

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

  test("does not fetch host state before hosts:read capability is available", () => {
    const readCheckIndex = adminHostsSource.indexOf("const canRead")
    const hostFetchIndex = adminHostsSource.indexOf("useApi(fetchAdminHosts")

    assert.notEqual(readCheckIndex, -1)
    assert.notEqual(hostFetchIndex, -1)
    assert.equal(readCheckIndex < hostFetchIndex, true)
    assert.match(adminHostsSource, /useApi\(fetchAdminHosts,\s*\{\s*enabled:\s*canRead\s*\}\)/)
  })
})

describe("M12 admin network navigation", () => {
  test("exposes network in admin sidebar and overview only through network:read capability", () => {
    assert.match(sidebarSource, /to: "\/admin\/network"/)
    assert.match(sidebarSource, /network:read/)
    assert.match(overviewSource, /to: "\/admin\/network"/)
    assert.match(overviewSource, /network:read/)
  })

  test("mounts the network console route", () => {
    assert.match(appSource, /AdminNetwork/)
    assert.match(appSource, /path="network"/)
  })

  test("keeps the network console in browser-safe scope with no direct Agent/Incus/tunnel access", () => {
    assert.match(adminNetworkSource, /fetchAdminNetworkFabrics/)
    assert.match(adminNetworkSource, /syncAdminNetworkFabric/)
    assert.match(adminNetworkSource, /dryRunAdminNetworkFabric/)
    assert.match(adminNetworkSource, /applyAdminNetworkFabric/)
    assert.match(`${adminNetworkSource}\n${adminNetworkAccessSource}`, /network:apply/)
    assert.match(`${adminNetworkSource}\n${adminNetworkAccessSource}`, /network:read/)

    for (const forbidden of [
      "tokenCiphertext",
      "privateKeyCiphertext",
      "presharedKeyCiphertext",
      "agent token",
      "endpoint token",
      "/1.0/",
      "ws://",
      "wss://",
      "19090",
      "19095",
      "/agent/v1",
      "Create VM",
      "Start VM",
      "Stop VM",
      "Restart VM",
      "Delete VM",
      "/var/lib/incus",
    ]) {
      assert.equal(
        adminNetworkSource.includes(forbidden),
        false,
        `AdminNetwork source contains forbidden network-console scope: ${forbidden}`
      )
    }
  })

  test("never renders raw private keys or preshared keys", () => {
    // The page must only reference the boolean *Configured flags, never the
    // ciphertext fields or raw secret values.
    assert.match(adminNetworkSource, /privateKeyConfigured/)
    assert.match(adminNetworkSource, /presharedKeyConfigured/)
    assert.equal(adminNetworkSource.includes("privateKeyCiphertext"), false)
    assert.equal(adminNetworkSource.includes("presharedKeyCiphertext"), false)
    assert.equal(adminNetworkSource.includes('"privateKey"'), false)
    assert.equal(adminNetworkSource.includes('"presharedKey"'), false)
  })

  test("does not fetch network fabrics before network:read capability is available", () => {
    const readCheckIndex = adminNetworkSource.indexOf("const canRead")
    const networkFetchIndex = adminNetworkSource.indexOf("useApi(fetchAdminNetworkFabrics")

    assert.notEqual(readCheckIndex, -1)
    assert.notEqual(networkFetchIndex, -1)
    assert.equal(readCheckIndex < networkFetchIndex, true)
    assert.match(adminNetworkSource, /useApi\(fetchAdminNetworkFabrics,\s*\{\s*enabled:\s*canRead\s*\}\)/)
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
