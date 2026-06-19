import assert from "node:assert/strict"
import { describe, test } from "node:test"
import bcrypt from "bcryptjs"
import {
  authenticateBootstrapUser,
  AuthConfigError,
  AuthCredentialsError,
  AuthSessionError,
  verifySession,
} from "./auth"

const sessionSecret = "test-session-secret-with-enough-entropy"
const adminPassword = "correct horse battery staple"

async function authEnv(overrides: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> {
  return {
    ANVIL_BOOTSTRAP_ADMIN_EMAIL: "admin@example.com",
    ANVIL_BOOTSTRAP_ADMIN_NAME: "Admin",
    ANVIL_BOOTSTRAP_ADMIN_PASSWORD_HASH: await bcrypt.hash(adminPassword, 10),
    ANVIL_SESSION_SECRET: sessionSecret,
    ...overrides,
  }
}

describe("auth service", () => {
  test("rejects missing auth configuration", async () => {
    await assert.rejects(
      authenticateBootstrapUser({}, "admin@example.com", adminPassword),
      AuthConfigError
    )
  })

  test("rejects an invalid bootstrap password hash", async () => {
    await assert.rejects(
      authenticateBootstrapUser(
        await authEnv({ ANVIL_BOOTSTRAP_ADMIN_PASSWORD_HASH: "not-a-bcrypt-hash" }),
        "admin@example.com",
        adminPassword
      ),
      AuthConfigError
    )
  })

  test("authenticates the bootstrap admin and returns a browser-safe user plus session", async () => {
    const result = await authenticateBootstrapUser(await authEnv(), "admin@example.com", adminPassword)

    assert.deepEqual(result.user, {
      id: "bootstrap-admin",
      email: "admin@example.com",
      name: "Admin",
      role: "ADMIN",
    })
    assert.equal(typeof result.sessionToken, "string")
    assert.equal(result.sessionToken.length > 20, true)
    assert.equal(JSON.stringify(result).includes(adminPassword), false)
    assert.equal(JSON.stringify(result).includes(sessionSecret), false)
    assert.equal(JSON.stringify(result).includes("PASSWORD_HASH"), false)
  })

  test("rejects invalid credentials without exposing which field failed", async () => {
    await assert.rejects(
      authenticateBootstrapUser(await authEnv(), "admin@example.com", "wrong-password"),
      AuthCredentialsError
    )
    await assert.rejects(
      authenticateBootstrapUser(await authEnv(), "other@example.com", adminPassword),
      AuthCredentialsError
    )
  })

  test("verifies a valid session token into a browser-safe current user", async () => {
    const login = await authenticateBootstrapUser(await authEnv(), "admin@example.com", adminPassword)

    const user = verifySession(await authEnv(), login.sessionToken)

    assert.deepEqual(user, login.user)
  })

  test("rejects missing, tampered, or misconfigured sessions", async () => {
    await assert.rejects(async () => verifySession(await authEnv(), undefined), AuthSessionError)
    await assert.rejects(async () => verifySession(await authEnv(), "tampered"), AuthSessionError)
    await assert.rejects(async () => verifySession({}, "anything"), AuthConfigError)
  })
})
