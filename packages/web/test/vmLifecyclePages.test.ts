import assert from "node:assert/strict"
import { afterEach, describe, test } from "node:test"
import React, { useEffect, useState } from "react"
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
  type ReactTestRendererJSON,
} from "react-test-renderer"
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom"
import { AdminVmCreate } from "../src/pages/admin/AdminVmCreate.tsx"
import { AdminVmDetail } from "../src/pages/admin/AdminVmDetail.tsx"
import { AdminVms } from "../src/pages/admin/AdminVms.tsx"
import type { AdminAccessSummary } from "../src/types/index.ts"

const originalFetch = globalThis.fetch
const testGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
  window?: {
    setTimeout: typeof setTimeout
    clearTimeout: typeof clearTimeout
    requestAnimationFrame: (callback: FrameRequestCallback) => number
    cancelAnimationFrame: (handle: number) => void
    document?: unknown
  }
}

testGlobal.IS_REACT_ACT_ENVIRONMENT = true
testGlobal.window = {
  setTimeout,
  clearTimeout,
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (handle: number) => clearTimeout(handle),
  document: undefined,
}

type FetchCounts = Record<string, number>

type TestResponse = {
  path: string
  body: unknown
}

const adminAccess: AdminAccessSummary = {
  bootstrapComplete: true,
  canAdmin: true,
  globalActions: [
    "vm:read",
    "vm:create",
    "vm:start",
    "vm:stop",
    "vm:restart",
    "vm:delete",
  ],
  tenants: [],
  projects: [],
  teams: [],
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("M13 VM lifecycle pages request stability", () => {
  test("VM list does not repeat fetches after idle render state updates", async () => {
    const counts = installRouteFetch([
      { path: "/api/admin/vms", body: { vms: [browserVm()] } },
    ])

    const renderer = await renderAdminRoute("/admin/vms", "vms", React.createElement(AdminVms))
    await waitForSettledRender()

    assert.equal(counts["/api/admin/vms"], 1)
    await unmount(renderer)
  })

  test("VM detail does not repeat detail or operations fetches after idle render state updates", async () => {
    const counts = installRouteFetch([
      { path: "/api/admin/vms/vm-1", body: { vm: browserVm() } },
      {
        path: "/api/admin/vm-operations?vmInstanceId=vm-1",
        body: { operations: [browserOperation()], total: 1 },
      },
    ])

    const renderer = await renderAdminRoute(
      "/admin/vms/vm-1",
      "vms/:vmId",
      React.createElement(AdminVmDetail)
    )
    await waitForSettledRender()

    assert.equal(counts["/api/admin/vms/vm-1"], 1)
    assert.equal(counts["/api/admin/vm-operations?vmInstanceId=vm-1"], 1)
    await unmount(renderer)
  })

  test("VM create does not repeat prerequisite fetches after idle render state updates", async () => {
    const counts = installRouteFetch([
      { path: "/api/admin/tenants", body: { tenants: [tenant()] } },
      { path: "/api/admin/projects", body: { projects: [project()] } },
      { path: "/api/admin/endpoints", body: { endpoints: [endpoint()] } },
      {
        path: "/api/admin/network/project-pools",
        body: { pools: [networkPool()] },
      },
      { path: "/api/images", body: { images: [eligibleImage()] } },
    ])

    const renderer = await renderAdminRoute(
      "/admin/vms/create",
      "vms/create",
      React.createElement(AdminVmCreate)
    )
    await waitForSettledRender()

    assert.equal(counts["/api/admin/tenants"], 1)
    assert.equal(counts["/api/admin/projects"], 1)
    assert.equal(counts["/api/admin/endpoints"], 1)
    assert.equal(counts["/api/admin/network/project-pools"], 1)
    assert.equal(counts["/api/images"], 1)
    await unmount(renderer)
  })
})

describe("M14 VM create image policy visibility", () => {
  test("renders the selected image runtime policy for an eligible alias", async () => {
    installCreatePageFetch(201, createVmResult())

    const renderer = await renderAdminRoute(
      "/admin/vms/create",
      "vms/create",
      React.createElement(AdminVmCreate)
    )
    await waitForSettledRender()

    fillInput(renderer, "vm-image", "ubuntu/24.04")
    await waitForSettledRender()

    const renderedText = collectText(renderer)
    assert.match(renderedText, /Image policy/)
    assert.match(renderedText, /Secure Boot/)
    assert.match(renderedText, /Unsupported/)
    assert.match(renderedText, /Eligible/)
    assert.doesNotMatch(renderedText, /undefined|null/)
    await unmount(renderer)
  })

  test("blocks an image with unknown runtime policy before posting VM create", async () => {
    const counts = installCreatePageFetch(201, createVmResult(), [unknownPolicyImage()])

    const renderer = await renderAdminRoute(
      "/admin/vms/create",
      "vms/create",
      React.createElement(AdminVmCreate)
    )
    await waitForSettledRender()
    await submitCreateForm(renderer, "broken-image")

    const renderedText = collectText(renderer)
    assert.equal(counts["/api/admin/vms"] ?? 0, 0)
    assert.match(renderedText, /Image policy unknown/)
    assert.match(renderedText, /Blocked/)
    await unmount(renderer)
  })
})

describe("M13 VM create page backend denial states", () => {
  test("shows quota denial from Phase 4 VM_INVALID_REQUEST error shape", async () => {
    const counts = installCreatePageFetch(
      400,
      invalidVmRequest("VM lifecycle denied: QUOTA_EXCEEDED", "QUOTA_EXCEEDED")
    )

    const renderer = await renderAdminRoute(
      "/admin/vms/create",
      "vms/create",
      React.createElement(AdminVmCreate)
    )
    await waitForSettledRender()
    await submitCreateForm(renderer)

    const renderedText = collectText(renderer)
    assert.equal(counts["/api/admin/vms"], 1)
    assert.match(renderedText, /Quota limit reached/)
    assert.doesNotMatch(renderedText, /Network pool is not available/)
    await unmount(renderer)
  })

  test("shows network denial from Phase 4 VM_INVALID_REQUEST error shape", async () => {
    const counts = installCreatePageFetch(
      400,
      invalidVmRequest("VM lifecycle denied: NETWORK_POOL_UNAVAILABLE", "NETWORK_POOL_UNAVAILABLE")
    )

    const renderer = await renderAdminRoute(
      "/admin/vms/create",
      "vms/create",
      React.createElement(AdminVmCreate)
    )
    await waitForSettledRender()
    await submitCreateForm(renderer)

    const renderedText = collectText(renderer)
    assert.equal(counts["/api/admin/vms"], 1)
    assert.match(renderedText, /Network pool is not available/)
    assert.doesNotMatch(renderedText, /Quota limit reached/)
    await unmount(renderer)
  })

  test("shows generic VM_INVALID_REQUEST create errors as non-success form errors", async () => {
    const counts = installCreatePageFetch(
      400,
      invalidVmRequest("VM lifecycle denied: ENDPOINT_NOT_BOUND", "ENDPOINT_NOT_BOUND")
    )

    const renderer = await renderAdminRoute(
      "/admin/vms/create",
      "vms/create",
      React.createElement(AdminVmCreate)
    )
    await waitForSettledRender()
    await submitCreateForm(renderer)

    const renderedText = collectText(renderer)
    assert.equal(counts["/api/admin/vms"], 1)
    assert.match(renderedText, /VM lifecycle denied: ENDPOINT_NOT_BOUND/)
    assert.doesNotMatch(renderedText, /Quota limit reached/)
    assert.doesNotMatch(renderedText, /Network pool is not available/)
    await unmount(renderer)
  })
})

function installRouteFetch(responses: TestResponse[]): FetchCounts {
  const responseMap = new Map(responses.map((response) => [response.path, response.body]))
  const counts: FetchCounts = {}

  globalThis.fetch = ((input: string | URL | Request) => {
    const path = String(input)
    counts[path] = (counts[path] ?? 0) + 1

    const body = responseMap.get(path)
    if (counts[path] > 3) {
      return new Promise<Response>(() => {})
    }
    if (!body) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            error: { code: "TEST_NOT_FOUND", message: `No mock for ${path}`, details: {} },
          }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        )
      )
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )
  }) as typeof fetch

  return counts
}

function installCreatePageFetch(
  createStatus: number,
  createBody: unknown,
  images = [eligibleImage()]
): FetchCounts {
  const counts: FetchCounts = {}

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const path = String(input)
    counts[path] = (counts[path] ?? 0) + 1

    if (path === "/api/admin/vms" && init?.method === "POST") {
      return Promise.resolve(
        new Response(JSON.stringify(createBody), {
          status: createStatus,
          headers: { "Content-Type": "application/json" },
        })
      )
    }

    const body = createPageReferenceData(path, images)
    if (!body) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            error: { code: "TEST_NOT_FOUND", message: `No mock for ${path}`, details: {} },
          }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        )
      )
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )
  }) as typeof fetch

  return counts
}

function createPageReferenceData(path: string, images = [eligibleImage()]): unknown {
  switch (path) {
    case "/api/admin/tenants":
      return { tenants: [tenant()] }
    case "/api/admin/projects":
      return { projects: [project()] }
    case "/api/admin/endpoints":
      return { endpoints: [endpoint()] }
    case "/api/admin/network/project-pools":
      return { pools: [networkPool()] }
    case "/api/images":
      return { images }
    default:
      return null
  }
}

async function renderAdminRoute(
  initialEntry: string,
  path: string,
  element: React.ReactElement
): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined

  await act(async () => {
    renderer = create(
      React.createElement(
        MemoryRouter,
        { initialEntries: [initialEntry] },
        React.createElement(
          Routes,
          null,
          React.createElement(
            Route,
            { path: "/admin", element: React.createElement(AdminShell) },
            React.createElement(Route, { path, element })
          )
        )
      )
    )
  })

  assert.ok(renderer)
  return renderer
}

function AdminShell() {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    setTick(1)
  }, [])

  return React.createElement(
    "div",
    { "data-render-tick": tick },
    React.createElement(Outlet, {
      context: {
        session: {
          user: {
            id: "admin-1",
            email: "admin@example.com",
            name: "Admin",
            status: "ACTIVE",
            globalRole: "ADMIN",
            teams: [],
          },
          access: adminAccess,
        },
        reloadSession: async () => undefined,
      },
    })
  )
}

async function waitForSettledRender(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
}

async function unmount(renderer: ReactTestRenderer): Promise<void> {
  await act(async () => {
    renderer.unmount()
  })
}

async function submitCreateForm(
  renderer: ReactTestRenderer,
  imageReference = "ubuntu/24.04"
): Promise<void> {
  fillInput(renderer, "vm-name", "test-vm")
  fillInput(renderer, "vm-image", imageReference)
  setSelectValues(renderer, ["tenant-1", "project-1", "endpoint-1", "pool-1", "IPV4"])

  await act(async () => {
    const form = findByType(renderer.root, "form")
    form.props.onSubmit({
      preventDefault() {},
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

function setSelectValues(renderer: ReactTestRenderer, values: string[]): void {
  const selectNodes = renderer.root.findAll(
    (node) => typeof node.props.onValueChange === "function" && typeof node.props.value === "string"
  )
  const selects = [selectNodes[0], selectNodes[3], selectNodes[6], selectNodes[9], selectNodes[12]]
  assert.ok(selects.length >= values.length, "Expected create form select controls")

  act(() => {
    for (let index = 0; index < values.length; index += 1) {
      selects[index].props.onValueChange(values[index])
    }
  })
}

function fillInput(renderer: ReactTestRenderer, id: string, value: string): void {
  const input = findByProps(renderer.root, { id })
  act(() => {
    input.props.onChange({ target: { value } })
  })
}

function findByType(root: ReactTestInstance, type: string): ReactTestInstance {
  const match = root.findAll((node) => node.type === type)[0]
  assert.ok(match, `Expected to find ${type}`)
  return match
}

function findByProps(
  root: ReactTestInstance,
  props: Record<string, unknown>
): ReactTestInstance {
  const match = root.findAll(
    (node) => Object.entries(props).every(([key, value]) => node.props[key] === value)
  )[0]
  assert.ok(match, `Expected to find node with props ${JSON.stringify(props)}`)
  return match
}

function collectText(renderer: ReactTestRenderer): string {
  const text: string[] = []
  collectTextNodes(renderer.toJSON(), text)
  return text.join(" ")
}

function collectTextNodes(
  node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null,
  text: string[]
): void {
  if (typeof node === "string") {
    text.push(node)
    return
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      collectTextNodes(child, text)
    }
    return
  }
  if (node?.children) {
    collectTextNodes(node.children, text)
  }
}

function invalidVmRequest(message: string, reason: string) {
  return {
    error: {
      code: "VM_INVALID_REQUEST",
      message,
      details: { reason },
    },
  }
}

function browserVm() {
  return {
    id: "vm-1",
    name: "test-vm",
    endpointId: "endpoint-1",
    projectId: "project-1",
    tenantId: "tenant-1",
    imageReference: "ubuntu/24.04",
    status: "STOPPED",
    limits: { cpu: 1, memoryBytes: 268435456, rootDiskBytes: 5368709120 },
    network: { poolId: "pool-1", addressFamily: "IPV4" },
    createdAt: "2026-06-24T00:00:00.000Z",
    updatedAt: "2026-06-24T00:00:00.000Z",
  }
}

function browserOperation() {
  return {
    id: "op-1",
    vmInstanceId: "vm-1",
    action: "CREATE",
    status: "SUCCEEDED",
    requestedByUserId: "admin-1",
    summary: "VM provisioned",
    errorSummary: null,
    createdAt: "2026-06-24T00:00:00.000Z",
    updatedAt: "2026-06-24T00:00:00.000Z",
  }
}

function createVmResult() {
  return {
    vm: browserVm(),
    operation: browserOperation(),
  }
}

function eligibleImage() {
  return {
    fingerprint: "eligible-image-fingerprint",
    aliases: [{ name: "ubuntu/24.04", description: "Ubuntu 24.04" }],
    description: "Ubuntu 24.04 VM image",
    architecture: "x86_64",
    type: "virtual-machine",
    sizeBytes: 536870912,
    cached: true,
    public: false,
    autoUpdate: false,
    createdAt: "2026-06-24T00:00:00.000Z",
    expiresAt: null,
    lastUsedAt: null,
    uploadedAt: "2026-06-24T00:00:00.000Z",
    runtimePolicy: {
      secureBoot: {
        requirement: "UNSUPPORTED",
        source: "incus-image-property",
      },
      createEligible: true,
      createBlockedReason: null,
    },
  }
}

function unknownPolicyImage() {
  return {
    ...eligibleImage(),
    fingerprint: "unknown-policy-fingerprint",
    aliases: [{ name: "broken-image", description: "Broken image" }],
    runtimePolicy: {
      secureBoot: {
        requirement: "UNKNOWN",
        source: "unknown",
      },
      createEligible: false,
      createBlockedReason: "IMAGE_POLICY_UNKNOWN",
    },
  }
}

function tenant() {
  return {
    id: "tenant-1",
    name: "Tenant A",
    slug: "tenant-a",
    status: "ACTIVE",
    defaultProjectId: "project-1",
  }
}

function project() {
  return {
    id: "project-1",
    name: "Project A",
    slug: "project-a",
    status: "ACTIVE",
    ownerTenantId: "tenant-1",
  }
}

function endpoint() {
  return {
    id: "endpoint-1",
    name: "Primary Agent",
    url: "wss://agent.example.com/ws",
    status: "ACTIVE",
    team: { id: "team-1", name: "Team", status: "ACTIVE" },
    credentialConfigured: true,
  }
}

function networkPool() {
  return {
    id: "pool-1",
    projectId: "project-1",
    fabricId: "fabric-1",
    ipv4Cidr: "10.42.100.0/24",
    ipv6Cidr: null,
    status: "ACTIVE",
    allocationMode: "DYNAMIC",
    createdAt: "2026-06-24T00:00:00.000Z",
    updatedAt: "2026-06-24T00:00:00.000Z",
  }
}
