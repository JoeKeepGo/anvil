import type { Context } from "hono"
import type { ServerConfig } from "../config"
import {
  PrismaAdminDataStore,
  resolveCurrentAdminUser,
  type AdminDataStore,
} from "../services/admin/session"
import { readSessionCookie } from "../services/sessionCookie"
import {
  createResourceVisibilityPolicy,
  PrismaResourceVisibilityStore,
  type ResourceVisibilityPolicy,
  type ResourceVisibilityStore,
} from "../services/resourceVisibility"

export interface ResourceVisibilityRouteOptions {
  sessionStore?: AdminDataStore
  resourceVisibilityStore?: ResourceVisibilityStore
}

export async function resolveResourceVisibilityPolicy(
  c: Context,
  input: {
    env: NodeJS.ProcessEnv
    config: ServerConfig
    sessionStore?: AdminDataStore
    resourceVisibilityStore?: ResourceVisibilityStore
  }
): Promise<ResourceVisibilityPolicy | undefined> {
  if (!input.sessionStore && !input.resourceVisibilityStore) {
    return undefined
  }

  const sessionStore = input.sessionStore ?? new PrismaAdminDataStore(undefined, input.env)
  const resourceVisibilityStore =
    input.resourceVisibilityStore ?? new PrismaResourceVisibilityStore(undefined, input.env)
  const { access } = await resolveCurrentAdminUser(
    sessionStore,
    input.env,
    readSessionCookie(c.req.header("cookie"))
  )

  return createResourceVisibilityPolicy({
    access,
    agentUrl: input.config.agent.url,
    store: resourceVisibilityStore,
  })
}
