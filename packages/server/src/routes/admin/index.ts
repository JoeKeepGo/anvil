import { Hono } from "hono"
import { createBootstrapRoutes } from "./bootstrap"
import type { AdminDataStore } from "../../services/admin/session"

export interface AdminRoutesOptions {
  store: AdminDataStore
  env?: NodeJS.ProcessEnv
}

export function createAdminRoutes(options: AdminRoutesOptions) {
  const routes = new Hono()

  routes.route("/", createBootstrapRoutes(options))

  return routes
}
