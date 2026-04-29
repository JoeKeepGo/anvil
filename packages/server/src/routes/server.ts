import { Hono } from "hono"

export const serverRoutes = new Hono()

serverRoutes.get("/server", async (c) => {
  return c.json({
    version: "0.1.0",
    api_version: "1.0",
    environment: {
      server_name: "Anvil Dashboard",
      kernel: "",
      os_name: "",
    },
  })
})
