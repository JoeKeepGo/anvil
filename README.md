# Anvil Dashboard

Anvil Dashboard is the web control plane for Anvil. It provides a browser interface and backend API for managing Incus hosts through Anvil host agents.

The Dashboard owns product-level concerns that do not belong in the host agent: users, sessions, teams, endpoint inventory, authorization, audit logs, and multi-host orchestration.

## What It Does

- Presents a web UI for Incus instances, images, operations, and host settings.
- Connects the backend control plane to one or more Anvil host agents.
- Keeps host credentials and Incus access out of the browser.
- Provides a stable API for fleet-level management.
- Creates a path for RBAC, audit logging, and future SSO.

## Architecture

```text
Browser
  -> Dashboard API
    -> Anvil host agent
      -> Incus Unix socket
        -> Incus daemon
```

The browser talks only to the Dashboard API. The Dashboard backend decides which host agent to use, applies control-plane policy, and records state-changing operations.

## Why a Backend

Incus has an official REST API, but exposing that API directly to browsers or every operator creates operational friction around TLS, credentials, CORS, authorization, and auditing.

Anvil Dashboard keeps those concerns in the backend. The backend may talk to host agents or, in a different deployment model, directly to Incus remote API. The current design uses host agents so Incus Unix socket access stays local to each host.

## Use Cases

- Single-pane management for one or more Incus hosts.
- Team-based access to host endpoints.
- Audited lifecycle operations such as start, stop, restart, and delete.
- Aggregated instance and operation views across hosts.
- Browser-safe management without exposing Incus credentials client-side.

## Stack

| Layer | Technology |
|---|---|
| Frontend | React, TypeScript, Vite, Tailwind CSS |
| API | Node.js, Hono, WebSocket client |
| Database | PostgreSQL, Prisma |
| Workspace | pnpm |

## Local Development

```bash
pnpm install
pnpm dev
```

Server package:

```bash
pnpm --filter @anvil/server typecheck
```

Web package:

```bash
pnpm --filter @anvil/web typecheck
```

## Project Status

This repository is in early development. The workspace, frontend shell, Prisma schema, and route structure are present. The main remaining work is the Dashboard backend control plane: host-agent connection management, auth, endpoint persistence, authorization, audit logging, and real Incus data flows.

## License

MIT
