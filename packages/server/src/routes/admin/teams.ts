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
  AdminTeamPermissionDeniedError,
  ArchivedTeamMembershipError,
  DisabledTeamMemberError,
  DuplicateTeamNameError,
  LastActiveTeamOwnerError,
  ManagedTeamNotFoundError,
  ManagedTeamUserNotFoundError,
  PrismaAdminTeamManagementStore,
  TeamMembershipNotFoundError,
  addTeamMember,
  archiveAdminTeam,
  createAdminTeam,
  getAdminTeam,
  listAdminTeams,
  removeTeamMember,
  restoreAdminTeam,
  updateAdminTeam,
  updateTeamMember,
  type AdminTeamManagementStore,
} from "../../services/admin/teams"

const teamRoleSchema = z.enum(["OWNER", "MAINTAINER", "VIEWER"])

const createTeamSchema = z.object({
  name: z.string().min(1),
})

const updateTeamSchema = z.object({
  name: z.string().min(1),
})

const memberSchema = z.object({
  userId: z.string().min(1),
  role: teamRoleSchema,
})

const updateMemberSchema = z.object({
  role: teamRoleSchema,
})

export interface TeamRoutesOptions {
  env?: NodeJS.ProcessEnv
  sessionStore?: AdminDataStore
  teamStore?: AdminTeamManagementStore
}

export function createTeamRoutes(options: TeamRoutesOptions = {}) {
  const routes = new Hono()
  const env = options.env ?? process.env
  const sessionStore = options.sessionStore ?? new PrismaAdminDataStore(undefined, env)
  const teamStore = options.teamStore ?? new PrismaAdminTeamManagementStore(undefined, env)

  routes.get("/", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      return c.json({ teams: await listAdminTeams(teamStore, actor) })
    })
  })

  routes.post("/", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      const requestBody = await readJsonBody(c.req.raw)
      const parsed = createTeamSchema.safeParse(requestBody)
      if (!parsed.success) {
        return invalidRequest(c, "INVALID_TEAM_REQUEST", "Team name is required.")
      }

      return c.json({ team: await createAdminTeam(teamStore, actor, parsed.data) }, 201)
    })
  })

  routes.get("/:teamId", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      return c.json({ team: await getAdminTeam(teamStore, actor, c.req.param("teamId")) })
    })
  })

  routes.patch("/:teamId", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      const requestBody = await readJsonBody(c.req.raw)
      const parsed = updateTeamSchema.safeParse(requestBody)
      if (!parsed.success) {
        return invalidRequest(c, "INVALID_TEAM_REQUEST", "Team name is required.")
      }

      return c.json({ team: await updateAdminTeam(teamStore, actor, c.req.param("teamId"), parsed.data) })
    })
  })

  routes.post("/:teamId/archive", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      return c.json({ team: await archiveAdminTeam(teamStore, actor, c.req.param("teamId")) })
    })
  })

  routes.post("/:teamId/restore", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      return c.json({ team: await restoreAdminTeam(teamStore, actor, c.req.param("teamId")) })
    })
  })

  routes.post("/:teamId/members", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      const requestBody = await readJsonBody(c.req.raw)
      const parsed = memberSchema.safeParse(requestBody)
      if (!parsed.success) {
        return invalidRequest(c, "INVALID_TEAM_MEMBER_REQUEST", "User id and role are required.")
      }

      return c.json(
        { member: await addTeamMember(teamStore, actor, c.req.param("teamId"), parsed.data) },
        201
      )
    })
  })

  routes.patch("/:teamId/members/:userId", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      const requestBody = await readJsonBody(c.req.raw)
      const parsed = updateMemberSchema.safeParse(requestBody)
      if (!parsed.success) {
        return invalidRequest(c, "INVALID_TEAM_MEMBER_REQUEST", "A valid role is required.")
      }

      return c.json({
        member: await updateTeamMember(
          teamStore,
          actor,
          c.req.param("teamId"),
          c.req.param("userId"),
          parsed.data
        ),
      })
    })
  })

  routes.post("/:teamId/members/:userId/remove", async (c) => {
    return handleAdminRoute(c, env, sessionStore, async (actor) => {
      return c.json({
        member: await removeTeamMember(teamStore, actor, c.req.param("teamId"), c.req.param("userId")),
      })
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
    return mapTeamRouteError(c, error)
  }
}

function mapTeamRouteError(c: Context, error: unknown): Response {
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
  if (error instanceof AdminTeamPermissionDeniedError) {
    return c.json(
      { error: { code: "ADMIN_FORBIDDEN", message: "Admin permission denied.", details: {} } },
      403
    )
  }
  if (error instanceof DuplicateTeamNameError) {
    return c.json(
      { error: { code: "TEAM_NAME_EXISTS", message: "A team with that name already exists.", details: {} } },
      409
    )
  }
  if (error instanceof ManagedTeamNotFoundError) {
    return c.json(
      { error: { code: "TEAM_NOT_FOUND", message: "Team was not found.", details: {} } },
      404
    )
  }
  if (error instanceof ManagedTeamUserNotFoundError) {
    return c.json(
      { error: { code: "USER_NOT_FOUND", message: "User was not found.", details: {} } },
      404
    )
  }
  if (error instanceof TeamMembershipNotFoundError) {
    return c.json(
      { error: { code: "TEAM_MEMBERSHIP_NOT_FOUND", message: "Membership was not found.", details: {} } },
      404
    )
  }
  if (error instanceof DisabledTeamMemberError) {
    return c.json(
      { error: { code: "USER_DISABLED", message: "User is disabled.", details: {} } },
      409
    )
  }
  if (error instanceof ArchivedTeamMembershipError) {
    return c.json(
      { error: { code: "TEAM_ARCHIVED", message: "Team is archived.", details: {} } },
      409
    )
  }
  if (error instanceof LastActiveTeamOwnerError) {
    return c.json(
      {
        error: {
          code: "LAST_ACTIVE_TEAM_OWNER",
          message: "At least one active team owner must remain.",
          details: {},
        },
      },
      409
    )
  }
  throw error
}

function invalidRequest(c: Context, code: string, message: string): Response {
  return c.json({ error: { code, message, details: {} } }, 400)
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}
