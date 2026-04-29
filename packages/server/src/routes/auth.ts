import { Hono } from "hono"

export const authRoutes = new Hono()

authRoutes.post("/login", async (c) => {
  return c.json({ message: "auth not yet implemented" }, 501)
})

authRoutes.get("/me", async (c) => {
  return c.json({ message: "auth not yet implemented" }, 501)
})
