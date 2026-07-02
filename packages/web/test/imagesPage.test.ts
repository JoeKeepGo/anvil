import assert from "node:assert/strict"
import { describe, test } from "node:test"
import React from "react"
import {
  act,
  create,
  type ReactTestRenderer,
  type ReactTestRendererJSON,
} from "react-test-renderer"
import { ImagesView } from "../src/pages/Images.tsx"
import type { ImageSummary } from "../src/types/index.ts"

const testGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}

testGlobal.IS_REACT_ACT_ENVIRONMENT = true

describe("M14 Images page image policy visibility", () => {
  test("renders secure boot requirement and create eligibility for image rows", async () => {
    const renderer = await renderImages([
      imageSummary({
        fingerprint: "required-fingerprint",
        alias: "requires-secure-boot",
        secureBootRequirement: "REQUIRED",
        createEligible: true,
        createBlockedReason: null,
      }),
      imageSummary({
        fingerprint: "unsupported-fingerprint",
        alias: "secure-boot-unsupported",
        secureBootRequirement: "UNSUPPORTED",
        createEligible: true,
        createBlockedReason: null,
      }),
      imageSummary({
        fingerprint: "unknown-fingerprint",
        alias: "unknown-policy",
        secureBootRequirement: "UNKNOWN",
        createEligible: false,
        createBlockedReason: "IMAGE_POLICY_UNKNOWN",
      }),
      imageSummary({
        fingerprint: "container-fingerprint",
        alias: "container-only",
        secureBootRequirement: "UNKNOWN",
        createEligible: false,
        createBlockedReason: "IMAGE_NOT_VM",
        type: "container",
      }),
    ])

    const renderedText = collectText(renderer)
    assert.match(renderedText, /Secure Boot/)
    assert.match(renderedText, /Create/)
    assert.match(renderedText, /Required/)
    assert.match(renderedText, /Unsupported/)
    assert.match(renderedText, /Unknown/)
    assert.match(renderedText, /Eligible/)
    assert.match(renderedText, /Blocked/)
    assert.match(renderedText, /Image policy unknown/)
    assert.match(renderedText, /Not a VM image/)
    assert.doesNotMatch(renderedText, /undefined|null/)

    await unmount(renderer)
  })
})

async function renderImages(images: ImageSummary[]): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined

  await act(async () => {
    renderer = create(
      React.createElement(ImagesView, {
        images: {
          data: images,
          loading: false,
          error: null,
          refetch: () => undefined,
        },
      })
    )
  })

  assert.ok(renderer)
  return renderer
}

async function unmount(renderer: ReactTestRenderer): Promise<void> {
  await act(async () => {
    renderer.unmount()
  })
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

function imageSummary(input: {
  fingerprint: string
  alias: string
  secureBootRequirement: "REQUIRED" | "UNSUPPORTED" | "UNKNOWN"
  createEligible: boolean
  createBlockedReason: "IMAGE_POLICY_UNKNOWN" | "IMAGE_NOT_VM" | null
  type?: string
}): ImageSummary {
  return {
    fingerprint: input.fingerprint,
    aliases: [{ name: input.alias, description: "" }],
    description: `${input.alias} image`,
    architecture: "x86_64",
    type: input.type ?? "virtual-machine",
    sizeBytes: 536870912,
    cached: true,
    public: false,
    autoUpdate: false,
    createdAt: "2026-07-03T00:00:00.000Z",
    expiresAt: null,
    lastUsedAt: null,
    uploadedAt: "2026-07-03T00:00:00.000Z",
    runtimePolicy: {
      secureBoot: {
        requirement: input.secureBootRequirement,
        source:
          input.secureBootRequirement === "UNKNOWN" ? "unknown" : "incus-image-property",
      },
      createEligible: input.createEligible,
      createBlockedReason: input.createBlockedReason,
    },
  }
}
