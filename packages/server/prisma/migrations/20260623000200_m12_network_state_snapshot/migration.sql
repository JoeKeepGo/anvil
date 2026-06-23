-- M12 Phase 4: latest observed network state snapshot per endpoint.
-- Pulled from the trusted agent /agent/v1/network/state report during sync.
-- Browser-safe only; never stores WireGuard private keys or preshared keys.

CREATE TYPE "NetworkStateSnapshotStatus" AS ENUM ('ONLINE', 'OFFLINE', 'ERROR');

CREATE TABLE "NetworkStateSnapshot" (
  "id" TEXT NOT NULL,
  "endpointId" TEXT NOT NULL,
  "fabricId" TEXT,
  "agentId" TEXT NOT NULL,
  "stateSchemaVersion" INTEGER NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "wireGuardAvailable" BOOLEAN NOT NULL,
  "ipCommandAvailable" BOOLEAN NOT NULL,
  "iptablesAvailable" BOOLEAN NOT NULL,
  "ip6tablesAvailable" BOOLEAN NOT NULL,
  "ipv4Forwarding" BOOLEAN NOT NULL,
  "ipv6Forwarding" BOOLEAN NOT NULL,
  "managedInterfaceCount" INTEGER NOT NULL,
  "status" "NetworkStateSnapshotStatus" NOT NULL DEFAULT 'ONLINE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "NetworkStateSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NetworkStateSnapshot_endpointId_key" ON "NetworkStateSnapshot"("endpointId");
CREATE INDEX "NetworkStateSnapshot_fabricId_idx" ON "NetworkStateSnapshot"("fabricId");

ALTER TABLE "NetworkStateSnapshot" ADD CONSTRAINT "NetworkStateSnapshot_endpointId_fkey"
  FOREIGN KEY ("endpointId") REFERENCES "AgentEndpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "NetworkStateSnapshot" ADD CONSTRAINT "NetworkStateSnapshot_fabricId_fkey"
  FOREIGN KEY ("fabricId") REFERENCES "NetworkFabric"("id") ON DELETE SET NULL ON UPDATE CASCADE;
