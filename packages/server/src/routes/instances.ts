import { Hono } from "hono"
import { ConfigError, parseServerConfig, type ServerConfig } from "../config"
import { AgentClient } from "../services/agent"
import { agentConfigError, getInstances, type InstancesAgent } from "../services/instances"

interface ClosableInstancesAgent extends InstancesAgent {
  close?: () => void
}

export interface InstanceRoutesOptions {
  env?: NodeJS.ProcessEnv
  createClient?: (config: ServerConfig["agent"]) => ClosableInstancesAgent
}

export function createInstanceRoutes(options: InstanceRoutesOptions = {}) {
  const routes = new Hono()
  const env = options.env ?? process.env
  const createClient =
    options.createClient ??
    ((config: ServerConfig["agent"]) => {
      return new AgentClient(config)
    })

  routes.get("/instances", async (c) => {
    let config: ServerConfig

    try {
      config = parseServerConfig(env)
    } catch (error) {
      if (error instanceof ConfigError) {
        const result = agentConfigError()
        return c.json(result.body, result.httpStatus)
      }

      throw error
    }

    const client = createClient(config.agent)

    try {
      const result = await getInstances(client)
      return c.json(result.body, result.httpStatus)
    } finally {
      client.close?.()
    }
  })

  return routes
}

export const instanceRoutes = createInstanceRoutes()

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
