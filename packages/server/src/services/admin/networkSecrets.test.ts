import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  NetworkSecretCiphertextError,
  NetworkSecretKeyError,
  decryptNetworkSecret,
  encryptNetworkSecret,
  isNetworkSecretConfigured,
} from "./networkSecrets"

const networkSecretKey = "m12-network-secret-key-with-enough-entropy"
const env = { ANVIL_NETWORK_SECRET_KEY: networkSecretKey }

describe("network secret encryption boundary", () => {
  test("encrypts and decrypts WireGuard private keys and preshared keys round-trip", () => {
    const privateKey = "wireguard-private-key-that-must-not-leak-to-browser"
    const presharedKey = "wireguard-preshared-key-that-must-not-leak-to-browser"

    const privateCiphertext = encryptNetworkSecret(env, privateKey)
    const presharedCiphertext = encryptNetworkSecret(env, presharedKey)

    assert.notEqual(privateCiphertext, privateKey)
    assert.notEqual(presharedCiphertext, presharedKey)
    assert.equal(decryptNetworkSecret(env, privateCiphertext), privateKey)
    assert.equal(decryptNetworkSecret(env, presharedCiphertext), presharedKey)
  })

  test("produces distinct ciphertext envelopes for repeated encryption (random IV)", () => {
    const secret = "wireguard-private-key-that-must-not-leak-to-browser"
    const first = encryptNetworkSecret(env, secret)
    const second = encryptNetworkSecret(env, secret)
    assert.notEqual(first, second)
    assert.equal(decryptNetworkSecret(env, first), secret)
    assert.equal(decryptNetworkSecret(env, second), secret)
  })

  test("requires ANVIL_NETWORK_SECRET_KEY to be configured", () => {
    assert.throws(() => encryptNetworkSecret({}, "secret"), NetworkSecretKeyError)
    assert.throws(() => encryptNetworkSecret({ ANVIL_NETWORK_SECRET_KEY: "  " }, "secret"), NetworkSecretKeyError)
    assert.throws(
      () => decryptNetworkSecret({}, "v1:aaaa:bbbb:cccc"),
      NetworkSecretKeyError
    )
  })

  test("fails visibly when the key is wrong or the ciphertext is tampered", () => {
    const secret = "wireguard-private-key-that-must-not-leak-to-browser"
    const ciphertext = encryptNetworkSecret(env, secret)

    assert.throws(
      () => decryptNetworkSecret({ ANVIL_NETWORK_SECRET_KEY: "wrong-network-secret-key-entropy" }, ciphertext),
      NetworkSecretCiphertextError
    )

    const parts = ciphertext.split(":")
    const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${Buffer.from(
      Buffer.from(parts[3], "base64url")
    ).reverse()
      .toString("base64url")}`
    assert.throws(() => decryptNetworkSecret(env, tampered), NetworkSecretCiphertextError)
  })

  test("rejects malformed ciphertext envelopes", () => {
    assert.throws(() => decryptNetworkSecret(env, "not-a-valid-envelope"), NetworkSecretCiphertextError)
    assert.throws(() => decryptNetworkSecret(env, "v2:aaaa:bbbb:cccc"), NetworkSecretCiphertextError)
    assert.throws(() => decryptNetworkSecret(env, "v1:aaaa:bbbb"), NetworkSecretCiphertextError)
    assert.throws(() => decryptNetworkSecret(env, "v1::bbbb:cccc"), NetworkSecretCiphertextError)
  })

  test("isNetworkSecretConfigured reports presence without exposing the ciphertext", () => {
    assert.equal(isNetworkSecretConfigured(undefined), false)
    assert.equal(isNetworkSecretConfigured(null), false)
    assert.equal(isNetworkSecretConfigured(""), false)
    assert.equal(isNetworkSecretConfigured("   "), false)
    assert.equal(isNetworkSecretConfigured(encryptNetworkSecret(env, "secret")), true)
  })

  test("never returns the raw secret through the ciphertext or helper surface", () => {
    const secret = "wireguard-private-key-that-must-not-leak-to-browser"
    const ciphertext = encryptNetworkSecret(env, secret)
    const serialized = JSON.stringify({ ciphertext, configured: isNetworkSecretConfigured(ciphertext) })
    assert.equal(serialized.includes(secret), false)
    assert.equal(isNetworkSecretConfigured(ciphertext), true)
  })
})
