import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  buildVmLifecycleAuditMetadata,
  toBrowserVmInstance,
  toBrowserVmLifecycleOperation,
  type PersistedVmInstance,
  type PersistedVmLifecycleOperation,
} from "./vmLifecycleModels"

const now = new Date("2026-06-24T00:00:00.000Z")

describe("browser-safe VM lifecycle serialization", () => {
  test("toBrowserVmInstance preserves identity, limits, and network shape without secret material", () => {
    const record: PersistedVmInstance = {
      id: "vm-1",
      name: "anvil-m13-smoke-001",
      endpointId: "endpoint-1",
      projectId: "project-1",
      tenantId: "tenant-1",
      networkPoolId: "pool-1",
      imageReference: "images:debian/12",
      status: "PROVISIONING",
      cpuCount: 1,
      memoryBytes: 268_435_456n,
      rootDiskBytes: 5_368_709_120n,
      addressFamily: "IPV4",
      createdAt: now,
      updatedAt: now,
    }

    const serialized = toBrowserVmInstance(record)

    assert.deepEqual(serialized, {
      id: "vm-1",
      name: "anvil-m13-smoke-001",
      endpointId: "endpoint-1",
      projectId: "project-1",
      tenantId: "tenant-1",
      imageReference: "images:debian/12",
      status: "PROVISIONING",
      limits: {
        cpu: 1,
        memoryBytes: 268_435_456,
        rootDiskBytes: 5_368_709_120,
      },
      network: {
        poolId: "pool-1",
        addressFamily: "IPV4",
      },
      createdAt: "2026-06-24T00:00:00.000Z",
      updatedAt: "2026-06-24T00:00:00.000Z",
    })

    const json = JSON.stringify(serialized)
    assert.equal(json.includes("token"), false)
    assert.equal(json.includes("Ciphertext"), false)
    assert.equal(json.includes("privateKey"), false)
    assert.equal(json.includes("presharedKey"), false)
    assert.equal(json.includes("passwordHash"), false)
    assert.equal(json.includes("session"), false)
  })

  test("toBrowserVmInstance handles a missing network pool and accepts numeric byte limits", () => {
    const record: PersistedVmInstance = {
      id: "vm-2",
      name: "vm-without-pool",
      endpointId: "endpoint-2",
      projectId: "project-2",
      tenantId: "tenant-2",
      networkPoolId: null,
      imageReference: "images:ubuntu/22.04",
      status: "STOPPED",
      cpuCount: 2,
      memoryBytes: 536_870_912,
      rootDiskBytes: 10_737_418_240,
      addressFamily: "DUAL",
      createdAt: now,
      updatedAt: now,
    }

    const serialized = toBrowserVmInstance(record)
    assert.equal(serialized.network.poolId, null)
    assert.equal(serialized.network.addressFamily, "DUAL")
    assert.equal(serialized.limits.memoryBytes, 536_870_912)
    assert.equal(serialized.limits.rootDiskBytes, 10_737_418_240)
  })

  test("toBrowserVmLifecycleOperation preserves action identity and never exposes secret material", () => {
    const record: PersistedVmLifecycleOperation = {
      id: "op-1",
      vmInstanceId: "vm-1",
      action: "CREATE",
      status: "QUEUED",
      requestedByUserId: "user-1",
      summary: "queued create for anvil-m13-smoke-001",
      errorSummary: null,
      createdAt: now,
      updatedAt: now,
    }

    assert.deepEqual(toBrowserVmLifecycleOperation(record), {
      id: "op-1",
      vmInstanceId: "vm-1",
      action: "CREATE",
      status: "QUEUED",
      requestedByUserId: "user-1",
      summary: "queued create for anvil-m13-smoke-001",
      errorSummary: null,
      createdAt: "2026-06-24T00:00:00.000Z",
      updatedAt: "2026-06-24T00:00:00.000Z",
    })
  })
})

describe("vm lifecycle audit metadata", () => {
  test("builds redaction-safe metadata that preserves action identity and declared limits", () => {
    const metadata = buildVmLifecycleAuditMetadata({
      vmInstance: {
        id: "vm-1",
        endpointId: "endpoint-1",
        projectId: "project-1",
        tenantId: "tenant-1",
        cpuCount: 1,
        memoryBytes: 268_435_456n,
        rootDiskBytes: 5_368_709_120n,
        addressFamily: "IPV4",
        networkPoolId: "pool-1",
      },
      operation: { action: "CREATE", status: "SUCCEEDED" },
      summary: "create acknowledged by agent lifecycle protocol",
    })

    assert.deepEqual(metadata, {
      vmInstanceId: "vm-1",
      action: "CREATE",
      status: "SUCCEEDED",
      endpointId: "endpoint-1",
      projectId: "project-1",
      tenantId: "tenant-1",
      cpuCount: 1,
      memoryBytes: 268_435_456,
      rootDiskBytes: 5_368_709_120,
      addressFamily: "IPV4",
      networkPoolId: "pool-1",
      summary: "create acknowledged by agent lifecycle protocol",
    })

    const json = JSON.stringify(metadata)
    assert.equal(json.includes("token"), false)
    assert.equal(json.includes("privateKey"), false)
    assert.equal(json.includes("presharedKey"), false)
    assert.equal(json.includes("passwordHash"), false)
    assert.equal(json.includes("session"), false)
    assert.equal(json.includes("Ciphertext"), false)
  })

  test("omits the summary key when no summary is provided", () => {
    const metadata = buildVmLifecycleAuditMetadata({
      vmInstance: {
        id: "vm-2",
        endpointId: "endpoint-2",
        projectId: "project-2",
        tenantId: "tenant-2",
        cpuCount: 2,
        memoryBytes: 536_870_912,
        rootDiskBytes: 10_737_418_240,
        addressFamily: "DUAL",
        networkPoolId: null,
      },
      operation: { action: "DELETE", status: "FAILED" },
    })

    assert.equal("summary" in metadata, false)
    assert.equal(metadata.networkPoolId, null)
    assert.equal(metadata.action, "DELETE")
    assert.equal(metadata.status, "FAILED")
  })
})
