import { Hono } from "hono"

export const imageRoutes = new Hono()

imageRoutes.get("/images", async (c) => {
  return c.json({ message: "images not yet implemented" }, 501)
})
