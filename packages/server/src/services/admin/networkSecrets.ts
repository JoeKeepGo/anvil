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

  const decipher = createDecipheriv(algorithm, networkSecretKey(env), Buffer.from(iv, "base64url"))
  decipher.setAuthTag(Buffer.from(tag, "base64url"))
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8")
  } catch {
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
