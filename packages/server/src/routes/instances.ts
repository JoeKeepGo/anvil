import { Hono } from "hono"

export const instanceRoutes = new Hono()

instanceRoutes.get("/instances", async (c) => {
  return c.json({ message: "instances not yet implemented" }, 501)
})

instanceRoutes.get("/instances/:name", async (c) => {
  return c.json({ message: "instance detail not yet implemented" }, 501)
})

instanceRoutes.post("/instances/:name/start", async (c) => {
  return c.json({ message: "start not yet implemented" }, 501)
})

instanceRoutes.post("/instances/:name/stop", async (c) => {
  return c.json({ message: "stop not yet implemented" }, 501)
})

instanceRoutes.post("/instances/:name/restart", async (c) => {
  return c.json({ message: "restart not yet implemented" }, 501)
})

instanceRoutes.delete("/instances/:name", async (c) => {
  return c.json({ message: "delete not yet implemented" }, 501)
})

instanceRoutes.post("/instances", async (c) => {
  return c.json({ message: "create not yet implemented" }, 501)
})
