import bcrypt from "bcryptjs"
import type { AdminDataStore, AuthResult, BrowserAccessSummary } from "./session"
import { toBrowserSafePrincipal } from "./session"
import { buildAccessSummary } from "./permissions"
import { recordAdminAudit } from "./audit"

export interface BootstrapStatus {
  bootstrapComplete: boolean
  available: boolean
}

export interface BootstrapCreateInput {
  email: string
  name: string
  password: string
  teamName: string
}

export class BootstrapAlreadyCompletedError extends Error {
  constructor(message = "Bootstrap has already been completed.") {
    super(message)
    this.name = "BootstrapAlreadyCompletedError"
  }
}

export async function getBootstrapStatus(store: AdminDataStore): Promise<BootstrapStatus> {
  const bootstrapComplete = await store.isBootstrapComplete()
  return {
    bootstrapComplete,
    available: !bootstrapComplete,
  }
}

export async function createBootstrapAdmin(
  store: AdminDataStore,
  input: BootstrapCreateInput
): Promise<Omit<AuthResult, "sessionToken">> {
  if (await store.isBootstrapComplete()) {
    throw new BootstrapAlreadyCompletedError()
  }

  const user = await store.createBootstrapAdmin({
    email: input.email.trim().toLowerCase(),
    name: input.name.trim(),
    passwordHash: await bcrypt.hash(input.password, 12),
    teamName: input.teamName.trim(),
  })
  const safeUser = toBrowserSafePrincipal(user)
  const access: BrowserAccessSummary = buildAccessSummary(safeUser, true)

  await recordAdminAudit(store, {
    actorUserId: safeUser.id,
    action: "bootstrap.create",
    targetType: "user",
    targetId: safeUser.id,
    teamId: safeUser.teams[0]?.id,
    metadata: {
      email: safeUser.email,
      teamName: safeUser.teams[0]?.name,
    },
  })

  return { user: safeUser, access }
}
