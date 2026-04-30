import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"
import { authRoutes } from "./routes/auth"
import { serverRoutes } from "./routes/server"
import { instanceRoutes } from "./routes/instances"
import { imageRoutes } from "./routes/images"
import { operationRoutes } from "./routes/operations"
import { settingsRoutes } from "./routes/settings"

const app = new Hono()

app.use("*", cors({ origin: "http://localhost:5173", credentials: true }))
app.use("*", logger())

app.route("/api/auth", authRoutes)
app.route("/api", serverRoutes)
app.route("/api", instanceRoutes)
app.route("/api", imageRoutes)
app.route("/api", operationRoutes)
app.route("/api", settingsRoutes)

app.get("/api/health", (c) => c.json({ status: "ok" }))

const port = parseInt(process.env.PORT || "3000")
console.log(`Anvil API starting on port ${port}`)

export default {
  port,
  fetch: app.fetch,
}
