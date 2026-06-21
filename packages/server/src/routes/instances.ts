import { Hono } from "hono"
import { ConfigError, parseServerConfig, type ServerConfig } from "../config"
import { AgentClient } from "../services/agent"
import {
  getInstanceDetail,
  instanceDetailAgentConfigError,
  type InstanceDetailAgent,
} from "../services/instanceDetail"
import { agentConfigError, getInstances, type InstancesAgent } from "../services/instances"
import {
  resolveResourceVisibilityPolicy,
  type ResourceVisibilityRouteOptions,
} from "./resourceVisibility"

interface ClosableInstancesAgent extends InstancesAgent {
  close?: () => void
}

interface ClosableInstanceDetailAgent extends InstanceDetailAgent {
  close?: () => void
}

export interface InstanceRoutesOptions extends ResourceVisibilityRouteOptions {
  env?: NodeJS.ProcessEnv
  createClient?: (config: ServerConfig["agent"]) => ClosableInstancesAgent & ClosableInstanceDetailAgent
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
      const visibility = await resolveResourceVisibilityPolicy(c, {
        env,
        config,
        sessionStore: options.sessionStore,
        resourceVisibilityStore: options.resourceVisibilityStore,
      })
      const result = await getInstances(client, visibility)
      return c.json(result.body, result.httpStatus)
    } finally {
      client.close?.()
    }
  })

  routes.get("/instances/:name", async (c) => {
    let config: ServerConfig

    try {
      config = parseServerConfig(env)
    } catch (error) {
      if (error instanceof ConfigError) {
        const result = instanceDetailAgentConfigError()
        return c.json(result.body, result.httpStatus)
      }

      throw error
    }

    const client = createClient(config.agent)

    try {
      const visibility = await resolveResourceVisibilityPolicy(c, {
        env,
        config,
        sessionStore: options.sessionStore,
        resourceVisibilityStore: options.resourceVisibilityStore,
      })
      const result = await getInstanceDetail(client, c.req.param("name"), visibility)
      return c.json(result.body, result.httpStatus)
    } finally {
      client.close?.()
    }
  })

  mountUnsupportedInstanceMutationRoutes(routes)
  return routes
}

export const instanceRoutes = createInstanceRoutes()

function mountUnsupportedInstanceMutationRoutes(routes: Hono): void {
  routes.post("/instances/:name/start", async (c) => {
    return c.json({ message: "start not yet implemented" }, 501)
  })

  routes.post("/instances/:name/stop", async (c) => {
    return c.json({ message: "stop not yet implemented" }, 501)
  })

  routes.post("/instances/:name/restart", async (c) => {
    return c.json({ message: "restart not yet implemented" }, 501)
  })

  routes.delete("/instances/:name", async (c) => {
    return c.json({ message: "delete not yet implemented" }, 501)
  })

  routes.post("/instances", async (c) => {
    return c.json({ message: "create not yet implemented" }, 501)
  })
}
