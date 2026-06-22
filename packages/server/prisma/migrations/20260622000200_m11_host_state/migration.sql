-- M11 Phase 3 stores the latest browser-safe state report pulled from each
-- accepted AgentEndpoint. It is visibility-only and does not mutate Incus.

CREATE TYPE "HostStateStatus" AS ENUM ('ONLINE');

CREATE TABLE "HostState" (
  "id" TEXT NOT NULL,
  "endpointId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "agentVersion" TEXT NOT NULL,
  "agentStateSchemaVersion" INTEGER NOT NULL,
  "agentStartedAt" TIMESTAMP(3) NOT NULL,
  "agentReportedAt" TIMESTAMP(3) NOT NULL,
  "hostHostname" TEXT NOT NULL,
  "hostOs" TEXT NOT NULL,
  "hostArch" TEXT NOT NULL,
  "incusAvailable" BOOLEAN NOT NULL,
  "incusStatusCode" INTEGER NOT NULL,
  "incusServerVersion" TEXT,
  "incusApiVersion" TEXT,
  "capabilityIncusProxy" BOOLEAN NOT NULL,
  "capabilityEvents" BOOLEAN NOT NULL,
  "capabilityStateReport" BOOLEAN NOT NULL,
  "capabilityWireGuard" BOOLEAN NOT NULL,
  "capabilityVmLifecycle" BOOLEAN NOT NULL,
  "snapshotInstancesTotal" INTEGER NOT NULL,
  "snapshotImagesTotal" INTEGER NOT NULL,
  "snapshotOperationsTotal" INTEGER NOT NULL,
  "status" "HostStateStatus" NOT NULL DEFAULT 'ONLINE',
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "HostState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HostState_endpointId_key" ON "HostState"("endpointId");
CREATE INDEX "HostState_agentId_idx" ON "HostState"("agentId");
CREATE INDEX "HostState_lastSeenAt_idx" ON "HostState"("lastSeenAt");

ALTER TABLE "HostState" ADD CONSTRAINT "HostState_endpointId_fkey"
  FOREIGN KEY ("endpointId") REFERENCES "AgentEndpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
