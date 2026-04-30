export interface ServerConfig {
  agent: {
    url: string
    token?: string
    requestTimeoutMs: number
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConfigError"
  }
}

const defaultRequestTimeoutMs = 5000

export function parseServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const agentUrl = env.ANVIL_AGENT_URL
  if (!agentUrl) {
    throw new ConfigError("ANVIL_AGENT_URL is required")
  }

  validateAgentUrl(agentUrl)

  const requestTimeoutMs = parseRequestTimeout(env.ANVIL_AGENT_REQUEST_TIMEOUT_MS)
  const token = env.ANVIL_AGENT_TOKEN === "" ? undefined : env.ANVIL_AGENT_TOKEN

  return {
    agent: {
      url: agentUrl,
      ...(token ? { token } : {}),
      requestTimeoutMs,
    },
  }
}

function validateAgentUrl(value: string): void {
  let url: URL

  try {
    url = new URL(value)
  } catch {
    throw new ConfigError("ANVIL_AGENT_URL must be a valid URL")
  }

  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new ConfigError("ANVIL_AGENT_URL must use ws:// or wss://")
  }

  if (url.pathname !== "/ws") {
    throw new ConfigError("ANVIL_AGENT_URL must include /ws path")
  }
}

function parseRequestTimeout(value: string | undefined): number {
  if (value === undefined) {
    return defaultRequestTimeoutMs
  }

  if (!/^[1-9]\d*$/.test(value)) {
    throw new ConfigError("ANVIL_AGENT_REQUEST_TIMEOUT_MS must be a positive integer")
  }

  return Number(value)
}
