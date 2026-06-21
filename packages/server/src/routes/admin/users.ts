import { Hono, type Context } from "hono"
import { z } from "zod"
import {
  DisabledUserError,
  PrismaAdminDataStore,
  resolveCurrentAdminUser,
  type AdminDataStore,
  type AdminPrincipal,
} from "../../services/admin/session"
import { AuthConfigError, AuthSessionError } from "../../services/auth"
import { readSessionCookie } from "../../services/sessionCookie"
import {
  AdminPermissionDeniedError,
  ArchivedManagedTeamError,
  DisabledManagedUserError,
  DuplicateUserEmailError,
  LastActiveAdminError,
  ManagedTeamNotFoundError,
  ManagedUserNotFoundError,
  PrismaAdminUserManagementStore,
  SelfDisableError,
  createAdminUser,
  disableAdminUser,
  getAdminUser,
  listAdminUsers,
  resetAdminUserPassword,
  restoreAdminUser,
  updateAdminUser,
  type AdminUserManagementStore,
} from "../../services/admin/users"

const roleSchema = z.enum(["ADMIN", "MEMBER"])
const teamRoleSchema = z.enum(["OWNER", "MAINTAINER", "VIEWER"])
const userStatusSchema = z.enum(["ACTIVE", "DISABLED"])

const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  password: z.string().min(12),
  globalRole: roleSchema,
  memberships: z
    .array(
      z.object({
        teamId: z.string().min(1),
        role: teamRoleSchema,
      })
    )
    .optional(),
})

const updateUserSchema = z.object({
  email: z.string().email().optional(),
  name: z.string().min(1).optional(),
  globalRole: roleSchema.optional(),
  status: userStatusSchema.optional(),
})

const resetPasswordSchema = z.object({
  password: z.string().min(12),
})

export interface UserRoutesOptions {
  env?: NodeJS.ProcessEnv
  sessionStore?: AdminDataStore
  userStore?: AdminUserManagementStore
}

export function createUserRoutes(options: UserRoutesOptions = {}) {
  const routes = new Hono()
  const env = options.env ?? process.env
  const sessionStore = options.sessionStore ?? new PrismaAdminDataStore(undefined, env)
  const userStore = options.userStore ?? new PrismaAdminUserManagementStore(undefined, env)

  routes.get("/", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      return c.json({ users: await listAdminUsers(userStore, actor) })
    })
  })

  routes.post("/", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      const requestBody = await readJsonBody(c.req.raw)
      const parsed = createUserSchema.safeParse(requestBody)
      if (!parsed.success) {
        return invalidRequest(c, "INVALID_USER_REQUEST", "Email, name, password, and global role are required.")
      }

      return c.json({ user: await createAdminUser(userStore, actor, parsed.data) }, 201)
    })
  })

  routes.get("/:userId", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      return c.json({ user: await getAdminUser(userStore, actor, c.req.param("userId")) })
    })
  })

  routes.patch("/:userId", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      const requestBody = await readJsonBody(c.req.raw)
      const parsed = updateUserSchema.safeParse(requestBody)
      if (!parsed.success) {
        return invalidRequest(c, "INVALID_USER_REQUEST", "Email, name, role, or status is invalid.")
      }

      return c.json({
        user: await updateAdminUser(userStore, actor, c.req.param("userId"), parsed.data),
      })
    })
  })

  routes.post("/:userId/disable", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      return c.json({ user: await disableAdminUser(userStore, actor, c.req.param("userId")) })
    })
  })

  routes.post("/:userId/restore", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      return c.json({ user: await restoreAdminUser(userStore, actor, c.req.param("userId")) })
    })
  })

  routes.post("/:userId/reset-password", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      const requestBody = await readJsonBody(c.req.raw)
      const parsed = resetPasswordSchema.safeParse(requestBody)
      if (!parsed.success) {
        return invalidRequest(c, "INVALID_PASSWORD_RESET_REQUEST", "A valid replacement password is required.")
      }

      return c.json(
        await resetAdminUserPassword(userStore, actor, c.req.param("userId"), parsed.data)
      )
    })
  })

  return routes
}

async function resolveActor(
  env: NodeJS.ProcessEnv,
  store: AdminDataStore,
  cookieHeader: string | undefined
): Promise<AdminPrincipal> {
  return (await resolveCurrentAdminUser(store, env, readSessionCookie(cookieHeader))).user
}

async function handleAdminRoute(
  c: Context,
  env: NodeJS.ProcessEnv,
  store: AdminDataStore,
  handler: (actor: AdminPrincipal) => Promise<Response>
): Promise<Response> {
  try {
    return await handler(await resolveActor(env, store, c.req.header("cookie")))
  } catch (error) {
    return mapUserRouteError(c, error)
  }
}

function mapUserRouteError(
  c: Context,
  error: unknown
): Response {
  if (error instanceof AuthSessionError) {
    return c.json(
      { error: { code: "UNAUTHENTICATED", message: "Authentication is required.", details: {} } },
      401
    )
  }
  if (error instanceof AuthConfigError) {
    return c.json(
      { error: { code: "AUTH_CONFIG_ERROR", message: "Authentication is not configured.", details: {} } },
      500
    )
  }
  if (error instanceof DisabledUserError) {
    return c.json(
      { error: { code: "USER_DISABLED", message: "User is disabled.", details: {} } },
      403
    )
  }
  if (error instanceof AdminPermissionDeniedError) {
    return c.json(
      { error: { code: "ADMIN_FORBIDDEN", message: "Admin permission denied.", details: {} } },
      403
    )
  }
  if (error instanceof DuplicateUserEmailError) {
    return c.json(
      { error: { code: "USER_EMAIL_EXISTS", message: "A user with that email already exists.", details: {} } },
      409
    )
  }
  if (error instanceof ManagedUserNotFoundError) {
    return c.json(
      { error: { code: "USER_NOT_FOUND", message: "User was not found.", details: {} } },
      404
    )
  }
  if (error instanceof ManagedTeamNotFoundError) {
    return c.json(
      { error: { code: "TEAM_NOT_FOUND", message: "Team was not found.", details: {} } },
      404
    )
  }
  if (error instanceof ArchivedManagedTeamError) {
    return c.json(
      { error: { code: "TEAM_ARCHIVED", message: "Team is archived.", details: {} } },
      409
    )
  }
  if (error instanceof DisabledManagedUserError) {
    return c.json(
      { error: { code: "USER_DISABLED", message: "User is disabled.", details: {} } },
      409
    )
  }
  if (error instanceof LastActiveAdminError) {
    return c.json(
      {
        error: {
          code: "LAST_ACTIVE_ADMIN",
          message: "At least one active admin must remain.",
          details: {},
        },
      },
      409
    )
  }
  if (error instanceof SelfDisableError) {
    return c.json(
      {
        error: {
          code: "SELF_DISABLE_FORBIDDEN",
          message: "Users cannot disable themselves.",
          details: {},
        },
      },
      409
    )
  }
  throw error
}

function invalidRequest(
  c: Context,
  code: string,
  message: string
): Response {
  return c.json({ error: { code, message, details: {} } }, 400)
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}
