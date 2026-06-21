import type { AdminAuditEntry, AdminDataStore } from "./session"

const redactedValue = "[REDACTED]"
const sensitiveMetadataKeys = new Set([
  "authorization",
  "password",
  "passwordHash",
  "privateConfig",
  "secret",
  "session",
  "sessionSecret",
  "token",
])

export async function recordAdminAudit(
  store: AdminDataStore,
  entry: AdminAuditEntry
): Promise<void> {
  await store.recordAudit({
    ...entry,
    metadata: redactAuditMetadata(entry.metadata),
  })
}

function redactAuditMetadata(
  value: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined
  }

  return redactObject(value)
}

function redactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, childValue]) => [
      key,
      sensitiveMetadataKeys.has(key) ? redactedValue : redactValue(childValue),
    ])
  )
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item))
  }

  if (value && typeof value === "object") {
    return redactObject(value as Record<string, unknown>)
  }

  return value
}
