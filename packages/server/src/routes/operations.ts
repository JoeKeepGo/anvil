import { Hono } from "hono"
import { ConfigError, parseServerConfig, type ServerConfig } from "../config"
import { AgentClient } from "../services/agent"
import {
  getOperations,
  operationsAgentConfigError,
  type OperationsAgent,
} from "../services/operations"
import {
  resolveResourceVisibilityPolicy,
  type ResourceVisibilityRouteOptions,
} from "./resourceVisibility"

interface ClosableOperationsAgent extends OperationsAgent {
  close?: () => void
}

export interface OperationRoutesOptions extends ResourceVisibilityRouteOptions {
  env?: NodeJS.ProcessEnv
  createClient?: (config: ServerConfig["agent"]) => ClosableOperationsAgent
}

export function createOperationRoutes(options: OperationRoutesOptions = {}) {
  const routes = new Hono()
  const env = options.env ?? process.env
  const createClient =
    options.createClient ??
    ((config: ServerConfig["agent"]) => {
      return new AgentClient(config)
    })

  routes.get("/operations", async (c) => {
    let config: ServerConfig

    try {
      config = parseServerConfig(env)
    } catch (error) {
      if (error instanceof ConfigError) {
        const result = operationsAgentConfigError()
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
      const result = await getOperations(client, visibility)
      return c.json(result.body, result.httpStatus)
    } finally {
      client.close?.()
    }
  })

  return routes
}

export const operationRoutes = createOperationRoutes()
