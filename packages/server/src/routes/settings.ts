import { Hono } from "hono"

export const settingsRoutes = new Hono()

settingsRoutes.get("/settings/agent-endpoints", async (c) => {
  return c.json({ agent_endpoints: [] })
})

settingsRoutes.post("/settings/agent-endpoints", async (c) => {
  return c.json({ message: "add agent endpoint not yet implemented" }, 501)
})
