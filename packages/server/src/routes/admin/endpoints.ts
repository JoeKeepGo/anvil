import { Hono, type Context } from "hono"

export function createEndpointRoutes() {
  const routes = new Hono()

  routes.all("/", notImplemented)
  routes.all("/*", notImplemented)

  return routes
}

function notImplemented(c: Context) {
  return c.json(
    {
      error: {
        code: "ADMIN_ROUTE_NOT_IMPLEMENTED",
        message: "This admin route is not implemented yet.",
        details: {},
      },
    },
    501
  )
}
