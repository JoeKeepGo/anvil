import bcrypt from "bcryptjs"
import jwt, { type JwtPayload } from "jsonwebtoken"
import { signAdminSession, type AdminPrincipal } from "./admin/session"

export type AuthRole = "ADMIN" | "MEMBER"

export interface BrowserUser {
  id: string
  email: string
  name: string
  role: AuthRole
}

interface AuthConfig {
  user: BrowserUser
  passwordHash: string
  sessionSecret: string
}

interface SessionClaims extends JwtPayload {
  sub: string
  email: string
  name: string
  role: AuthRole
}

export class AuthConfigError extends Error {
  constructor(message = "Authentication is not configured.") {
    super(message)
    this.name = "AuthConfigError"
  }
}

export class AuthCredentialsError extends Error {
  constructor(message = "Invalid email or password.") {
    super(message)
    this.name = "AuthCredentialsError"
  }
}

export class AuthSessionError extends Error {
  constructor(message = "Authentication is required.") {
    super(message)
    this.name = "AuthSessionError"
  }
}

export async function authenticateBootstrapUser(
  env: NodeJS.ProcessEnv,
  email: string,
  password: string
): Promise<{ user: BrowserUser; sessionToken: string }> {
  const config = parseAuthConfig(env)

  if (email.trim().toLowerCase() !== config.user.email.toLowerCase()) {
    throw new AuthCredentialsError()
  }

  const passwordMatches = await bcrypt.compare(password, config.passwordHash)
  if (!passwordMatches) {
    throw new AuthCredentialsError()
  }

  return {
    user: config.user,
    sessionToken: signSession(config),
  }
}

export function verifySession(env: NodeJS.ProcessEnv, sessionToken: string | undefined): BrowserUser {
  if (!sessionToken) {
    throw new AuthSessionError()
  }

  const config = parseAuthConfig(env)
  let claims: string | JwtPayload

  try {
    claims = jwt.verify(sessionToken, config.sessionSecret)
  } catch {
    throw new AuthSessionError()
  }

  if (!isSessionClaims(claims)) {
    throw new AuthSessionError()
  }

  if (
    claims.sub !== config.user.id ||
    claims.email !== config.user.email ||
    claims.name !== config.user.name ||
    claims.role !== config.user.role
  ) {
    throw new AuthSessionError()
  }

  return config.user
}

export function assertAuthConfigured(env: NodeJS.ProcessEnv): void {
  parseAuthConfig(env)
}

export function signSessionForPrincipal(env: NodeJS.ProcessEnv, principal: AdminPrincipal): string {
  return signAdminSession(env, principal)
}

function parseAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  const email = requiredEnv(env, "ANVIL_BOOTSTRAP_ADMIN_EMAIL")
  const name = requiredEnv(env, "ANVIL_BOOTSTRAP_ADMIN_NAME")
  const passwordHash = requiredEnv(env, "ANVIL_BOOTSTRAP_ADMIN_PASSWORD_HASH")
  const sessionSecret = requiredEnv(env, "ANVIL_SESSION_SECRET")

  validatePasswordHash(passwordHash)

  return {
    user: {
      id: "bootstrap-admin",
      email,
      name,
      role: "ADMIN",
    },
    passwordHash,
    sessionSecret,
  }
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]
  if (!value || value.trim() === "") {
    throw new AuthConfigError()
  }

  return value
}

function validatePasswordHash(hash: string): void {
  try {
    const rounds = bcrypt.getRounds(hash)
    if (!Number.isInteger(rounds) || rounds <= 0) {
      throw new AuthConfigError()
    }
  } catch {
    throw new AuthConfigError()
  }
}

function signSession(config: AuthConfig): string {
  const claims: SessionClaims = {
    sub: config.user.id,
    email: config.user.email,
    name: config.user.name,
    role: config.user.role,
  }

  return jwt.sign(claims, config.sessionSecret, { expiresIn: "8h" })
}

function isSessionClaims(value: string | JwtPayload): value is SessionClaims {
  if (typeof value === "string") {
    return false
  }

  return (
    typeof value.sub === "string" &&
    typeof value.email === "string" &&
    typeof value.name === "string" &&
    (value.role === "ADMIN" || value.role === "MEMBER")
  )
}
