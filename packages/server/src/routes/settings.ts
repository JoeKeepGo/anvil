import { Hono } from "hono"

export const settingsRoutes = new Hono()

settingsRoutes.get("/settings/proxies", async (c) => {
  return c.json({ proxies: [] })
})

settingsRoutes.post("/settings/proxies", async (c) => {
  return c.json({ message: "add proxy not yet implemented" }, 501)
})
