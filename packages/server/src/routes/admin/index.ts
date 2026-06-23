import { Hono } from "hono"
import { createAuditRoutes } from "./audit"
import { createBootstrapRoutes } from "./bootstrap"
import { createEndpointRoutes } from "./endpoints"
import { createEndpointAgentStateSyncRoutes, createHostRoutes } from "./hosts"
import { createNetworkRoutes } from "./network"
import { createPermissionRoutes } from "./permissions"
import { createProjectRoutes } from "./projects"
import { createTeamRoutes } from "./teams"
import { createTenantRoutes } from "./tenants"
import { createUserRoutes } from "./users"
import type { AdminDataStore } from "../../services/admin/session"

export interface AdminRoutesOptions {
  store: AdminDataStore
  env?: NodeJS.ProcessEnv
}

export function createAdminRoutes(options: AdminRoutesOptions) {
  const routes = new Hono()

  routes.route("/audit", createAuditRoutes())
  routes.route("/", createBootstrapRoutes(options))
  routes.route("/endpoints", createEndpointRoutes())
  routes.route(
    "/endpoints",
    createEndpointAgentStateSyncRoutes({ env: options.env, sessionStore: options.store })
  )
  routes.route("/hosts", createHostRoutes({ env: options.env, sessionStore: options.store }))
  routes.route("/network", createNetworkRoutes({ env: options.env, sessionStore: options.store }))
  routes.route("/permissions", createPermissionRoutes())
  routes.route("/projects", createProjectRoutes())
  routes.route("/teams", createTeamRoutes())
  routes.route("/tenants", createTenantRoutes())
  routes.route("/users", createUserRoutes())

  return routes
}
