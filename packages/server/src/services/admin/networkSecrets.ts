import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"

// M12 Phase 2: server-side encryption boundary for Anvil-managed WireGuard
// private keys and preshared keys. Secrets are stored only as ciphertext in
// the database and are never returned to the browser.
//
// The encryption key is dedicated to network secrets and intentionally
// separate from ANVIL_ENDPOINT_TOKEN_KEY so that rotating one boundary does
// not implicitly rekey the other.

const ciphertextVersion = "v1"
const algorithm = "aes-256-gcm"
const ivByteLength = 12

export class NetworkSecretKeyError extends Error {
  constructor(message = "Network secret encryption key is not configured.") {
    super(message)
    this.name = "NetworkSecretKeyError"
  }
}

export class NetworkSecretCiphertextError extends Error {
  constructor(message = "Network secret ciphertext is invalid.") {
    super(message)
    this.name = "NetworkSecretCiphertextError"
  }
}

/**
 * Encrypt a WireGuard private key or preshared key using AES-256-GCM.
 * Returns a versioned envelope string: `v1:<iv-base64url>:<tag-base64url>:<ciphertext-base64url>`.
 */
export function encryptNetworkSecret(env: NodeJS.ProcessEnv, secret: string): string {
  const iv = randomBytes(ivByteLength)
  const cipher = createCipheriv(algorithm, networkSecretKey(env), iv)
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${ciphertextVersion}:${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`
}

/**
 * Decrypt a WireGuard private key or preshared key produced by {@link encryptNetworkSecret}.
 * Throws visibly when the key is wrong, the ciphertext is malformed, or the
 * authenticated tag does not verify.
 */
export function decryptNetworkSecret(env: NodeJS.ProcessEnv, encryptedSecret: string): string {
  const parts = encryptedSecret.split(":")
  const [version, iv, tag, ciphertext] = parts
  if (version !== ciphertextVersion || parts.length !== 4 || !iv || !tag || !ciphertext) {
    throw new NetworkSecretCiphertextError()
  }

  // Resolve the key first so a missing/unconfigured key still surfaces as the
  // dedicated key error rather than being masked as a ciphertext error.
  const key = networkSecretKey(env)

  try {
    const ivBuffer = Buffer.from(iv, "base64url")
    const tagBuffer = Buffer.from(tag, "base64url")
    const ciphertextBuffer = Buffer.from(ciphertext, "base64url")
    if (ivBuffer.length !== ivByteLength) {
      throw new NetworkSecretCiphertextError()
    }
    const decipher = createDecipheriv(algorithm, key, ivBuffer)
    decipher.setAuthTag(tagBuffer)
    return Buffer.concat([decipher.update(ciphertextBuffer), decipher.final()]).toString("utf8")
  } catch (error) {
    if (error instanceof NetworkSecretCiphertextError) {
      throw error
    }
    // Raw crypto failures (invalid IV/tag/ciphertext, GCM auth mismatch, bad key)
    // must surface as a single typed error so callers never see a leaked stack.
    throw new NetworkSecretCiphertextError()
  }
}

/**
 * Returns whether a private key / preshared key ciphertext envelope is configured.
 * Used by browser-safe serializers instead of ever returning the ciphertext itself.
 */
export function isNetworkSecretConfigured(encryptedSecret: string | null | undefined): boolean {
  return typeof encryptedSecret === "string" && encryptedSecret.trim() !== ""
}

function networkSecretKey(env: NodeJS.ProcessEnv): Buffer {
  const key = env.ANVIL_NETWORK_SECRET_KEY
  if (!key || key.trim() === "") {
    throw new NetworkSecretKeyError()
  }
  return createHash("sha256").update(key).digest()
}
