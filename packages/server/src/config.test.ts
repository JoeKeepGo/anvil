import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ConfigError, parseServerConfig } from "./config"

describe("parseServerConfig", () => {
  test("accepts a ws agent URL with /ws path", () => {
    assert.deepEqual(parseServerConfig({ ANVIL_AGENT_URL: "ws://127.0.0.1:19090/ws" }), {
      agent: {
        url: "ws://127.0.0.1:19090/ws",
        requestTimeoutMs: 5000,
      },
    })
  })

  test("accepts wss agent URLs and preserves a configured token", () => {
    assert.deepEqual(
      parseServerConfig({
        ANVIL_AGENT_URL: "wss://agent.example.test/ws",
        ANVIL_AGENT_TOKEN: "server-token",
        ANVIL_AGENT_REQUEST_TIMEOUT_MS: "7000",
      }),
      {
        agent: {
          url: "wss://agent.example.test/ws",
          token: "server-token",
          requestTimeoutMs: 7000,
        },
      }
    )
  })

  test("treats an empty token as absent", () => {
    const config = parseServerConfig({
      ANVIL_AGENT_URL: "ws://127.0.0.1:19090/ws",
      ANVIL_AGENT_TOKEN: "",
    })
    assert.equal("token" in config.agent, false)
  })

  test("rejects missing or invalid agent URLs", () => {
    assert.throws(() => parseServerConfig({}), ConfigError)
    assert.throws(
      () => parseServerConfig({ ANVIL_AGENT_URL: "http://127.0.0.1:19090/ws" }),
      ConfigError
    )
    assert.throws(
      () => parseServerConfig({ ANVIL_AGENT_URL: "ws://127.0.0.1:19090" }),
      ConfigError
    )
  })

  test("rejects non-positive, decimal, and non-numeric timeouts", () => {
    for (const timeout of ["0", "-1", "1.5", "abc"]) {
      assert.throws(
        () =>
          parseServerConfig({
            ANVIL_AGENT_URL: "ws://127.0.0.1:19090/ws",
            ANVIL_AGENT_REQUEST_TIMEOUT_MS: timeout,
          }),
        ConfigError
      )
    }
  })

  test("does not use legacy PROXY environment aliases", () => {
    const legacyHost = ["PROXY", "HOST"].join("_")
    const legacyPort = ["PROXY", "PORT"].join("_")
    const legacyAuthToken = ["PROXY", "AUTH", "TOKEN"].join("_")

    assert.throws(
      () =>
        parseServerConfig({
          [legacyHost]: "127.0.0.1",
          [legacyPort]: "19090",
          [legacyAuthToken]: "legacy-token",
        }),
      ConfigError
    )

    assert.deepEqual(
      parseServerConfig({
        ANVIL_AGENT_URL: "ws://127.0.0.1:19090/ws",
        [legacyAuthToken]: "legacy-token",
      }),
      {
        agent: {
          url: "ws://127.0.0.1:19090/ws",
          requestTimeoutMs: 5000,
        },
      }
    )
  })
})
