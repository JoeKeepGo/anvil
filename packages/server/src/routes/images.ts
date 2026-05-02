import { Hono } from "hono"
import { ConfigError, parseServerConfig, type ServerConfig } from "../config"
import { AgentClient } from "../services/agent"
import { getImages, imagesAgentConfigError, type ImagesAgent } from "../services/images"

interface ClosableImagesAgent extends ImagesAgent {
  close?: () => void
}

export interface ImageRoutesOptions {
  env?: NodeJS.ProcessEnv
  createClient?: (config: ServerConfig["agent"]) => ClosableImagesAgent
}

export function createImageRoutes(options: ImageRoutesOptions = {}) {
  const routes = new Hono()
  const env = options.env ?? process.env
  const createClient =
    options.createClient ??
    ((config: ServerConfig["agent"]) => {
      return new AgentClient(config)
    })

  routes.get("/images", async (c) => {
    let config: ServerConfig

    try {
      config = parseServerConfig(env)
    } catch (error) {
      if (error instanceof ConfigError) {
        const result = imagesAgentConfigError()
        return c.json(result.body, result.httpStatus)
      }

      throw error
    }

    const client = createClient(config.agent)

    try {
      const result = await getImages(client)
      return c.json(result.body, result.httpStatus)
    } finally {
      client.close?.()
    }
  })

  return routes
}

export const imageRoutes = createImageRoutes()
