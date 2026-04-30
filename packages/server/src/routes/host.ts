import { Hono } from "hono"
import { ConfigError, parseServerConfig, type ServerConfig } from "../config"
import { AgentClient, type AgentRequest, type AgentResponse } from "../services/agent"
import { getHostHealth, type HostHealthAgent } from "../services/hostHealth"

interface ClosableHostHealthAgent extends HostHealthAgent {
  close?: () => void
}

export interface HostRoutesOptions {
  env?: NodeJS.ProcessEnv
  createClient?: (config: ServerConfig["agent"]) => ClosableHostHealthAgent
}

export function createHostRoutes(options: HostRoutesOptions = {}) {
  const routes = new Hono()
  const env = options.env ?? process.env
  const createClient =
    options.createClient ??
    ((config: ServerConfig["agent"]) => {
      return new AgentClient(config)
    })

  routes.get("/host/health", async (c) => {
    let config: ServerConfig

    try {
      config = parseServerConfig(env)
    } catch (error) {
      if (error instanceof ConfigError) {
        return c.json({ status: "error", error: "agent_config_error" }, 500)
      }

      throw error
    }

    const client = createClient(config.agent)

    try {
      const result = await getHostHealth(config, client)
      return c.json(result.body, result.httpStatus)
    } finally {
      client.close?.()
    }
  })

  return routes
}

export const hostRoutes = createHostRoutes()

export type { AgentRequest, AgentResponse }
