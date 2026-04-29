import { Hono } from "hono"

export const operationRoutes = new Hono()

operationRoutes.get("/operations", async (c) => {
  return c.json({ message: "operations not yet implemented" }, 501)
})

operationRoutes.get("/operations/:id", async (c) => {
  return c.json({ message: "operation detail not yet implemented" }, 501)
})
