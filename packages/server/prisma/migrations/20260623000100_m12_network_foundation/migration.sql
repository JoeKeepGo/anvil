-- M12 Phase 2 establishes the Anvil-managed WireGuard/VPC network foundation.
-- Fabrics, hubs, host peers, prefixes, project pools, and apply operations.
-- WireGuard private keys and preshared keys are stored only as ciphertext.

CREATE TYPE "NetworkFabricStatus" AS ENUM ('PLANNED', 'ACTIVE', 'ARCHIVED');
CREATE TYPE "NetworkFabricMode" AS ENUM ('HUB_SPOKE', 'MESH');
CREATE TYPE "WireGuardHubStatus" AS ENUM ('PLANNED', 'ACTIVE', 'ARCHIVED');
CREATE TYPE "NetworkPresharedKeyMode" AS ENUM ('DISABLED', 'PAIRWISE', 'FABRIC');
CREATE TYPE "HostNetworkPeerStatus" AS ENUM ('PLANNED', 'ACTIVE', 'ARCHIVED');
CREATE TYPE "HostNetworkPeerRole" AS ENUM ('MEMBER', 'RELAY');
CREATE TYPE "FabricPrefixKind" AS ENUM ('SUBNET', 'ROUTE', 'RESERVED');
CREATE TYPE "FabricPrefixStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "ProjectNetworkPoolStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "NetworkPoolAllocationMode" AS ENUM ('STATIC', 'DYNAMIC', 'RESERVED');
CREATE TYPE "NetworkApplyTargetType" AS ENUM ('FABRIC', 'HUB', 'PEER', 'PREFIX', 'POOL');
CREATE TYPE "NetworkApplyMode" AS ENUM ('DRY_RUN', 'APPLY');
CREATE TYPE "NetworkApplyStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

CREATE TABLE "NetworkFabric" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "status" "NetworkFabricStatus" NOT NULL DEFAULT 'PLANNED',
  "mode" "NetworkFabricMode" NOT NULL DEFAULT 'HUB_SPOKE',
  "overlayIpv4Cidr" TEXT NOT NULL,
  "overlayIpv6Cidr" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "NetworkFabric_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NetworkFabric_slug_key" ON "NetworkFabric"("slug");
CREATE INDEX "NetworkFabric_status_idx" ON "NetworkFabric"("status");

CREATE TABLE "WireGuardHub" (
  "id" TEXT NOT NULL,
  "fabricId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" "WireGuardHubStatus" NOT NULL DEFAULT 'PLANNED',
  "listenPort" INTEGER NOT NULL,
  "endpointHost" TEXT NOT NULL,
  "publicKey" TEXT NOT NULL,
  "privateKeyCiphertext" TEXT NOT NULL,
  "presharedKeyMode" "NetworkPresharedKeyMode" NOT NULL DEFAULT 'DISABLED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WireGuardHub_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WireGuardHub_publicKey_key" ON "WireGuardHub"("publicKey");
CREATE UNIQUE INDEX "WireGuardHub_fabricId_name_key" ON "WireGuardHub"("fabricId", "name");
CREATE INDEX "WireGuardHub_fabricId_idx" ON "WireGuardHub"("fabricId");
CREATE INDEX "WireGuardHub_status_idx" ON "WireGuardHub"("status");

CREATE TABLE "HostNetworkPeer" (
  "id" TEXT NOT NULL,
  "fabricId" TEXT NOT NULL,
  "endpointId" TEXT,
  "name" TEXT NOT NULL,
  "status" "HostNetworkPeerStatus" NOT NULL DEFAULT 'PLANNED',
  "role" "HostNetworkPeerRole" NOT NULL DEFAULT 'MEMBER',
  "publicKey" TEXT NOT NULL,
  "privateKeyCiphertext" TEXT NOT NULL,
  "presharedKeyCiphertext" TEXT,
  "overlayIpv4Address" TEXT,
  "overlayIpv6Address" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "HostNetworkPeer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HostNetworkPeer_publicKey_key" ON "HostNetworkPeer"("publicKey");
CREATE UNIQUE INDEX "HostNetworkPeer_fabricId_name_key" ON "HostNetworkPeer"("fabricId", "name");
CREATE INDEX "HostNetworkPeer_fabricId_idx" ON "HostNetworkPeer"("fabricId");
CREATE INDEX "HostNetworkPeer_endpointId_idx" ON "HostNetworkPeer"("endpointId");
CREATE INDEX "HostNetworkPeer_status_idx" ON "HostNetworkPeer"("status");

CREATE TABLE "FabricPrefix" (
  "id" TEXT NOT NULL,
  "fabricId" TEXT NOT NULL,
  "kind" "FabricPrefixKind" NOT NULL,
  "cidr" TEXT NOT NULL,
  "family" INTEGER NOT NULL,
  "status" "FabricPrefixStatus" NOT NULL DEFAULT 'ACTIVE',
  "ownerPeerId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "FabricPrefix_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FabricPrefix_fabricId_cidr_key" ON "FabricPrefix"("fabricId", "cidr");
CREATE INDEX "FabricPrefix_fabricId_idx" ON "FabricPrefix"("fabricId");
CREATE INDEX "FabricPrefix_ownerPeerId_idx" ON "FabricPrefix"("ownerPeerId");
CREATE INDEX "FabricPrefix_status_idx" ON "FabricPrefix"("status");

CREATE TABLE "ProjectNetworkPool" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "fabricId" TEXT NOT NULL,
  "ipv4Cidr" TEXT,
  "ipv6Cidr" TEXT,
  "status" "ProjectNetworkPoolStatus" NOT NULL DEFAULT 'ACTIVE',
  "allocationMode" "NetworkPoolAllocationMode" NOT NULL DEFAULT 'STATIC',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProjectNetworkPool_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProjectNetworkPool_projectId_fabricId_key" ON "ProjectNetworkPool"("projectId", "fabricId");
CREATE INDEX "ProjectNetworkPool_projectId_idx" ON "ProjectNetworkPool"("projectId");
CREATE INDEX "ProjectNetworkPool_fabricId_idx" ON "ProjectNetworkPool"("fabricId");
CREATE INDEX "ProjectNetworkPool_status_idx" ON "ProjectNetworkPool"("status");

CREATE TABLE "NetworkApplyOperation" (
  "id" TEXT NOT NULL,
  "targetType" "NetworkApplyTargetType" NOT NULL,
  "targetId" TEXT NOT NULL,
  "mode" "NetworkApplyMode" NOT NULL,
  "status" "NetworkApplyStatus" NOT NULL DEFAULT 'PENDING',
  "requestedByUserId" TEXT NOT NULL,
  "summary" TEXT,
  "errorSummary" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "NetworkApplyOperation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "NetworkApplyOperation_targetType_targetId_idx" ON "NetworkApplyOperation"("targetType", "targetId");
CREATE INDEX "NetworkApplyOperation_requestedByUserId_idx" ON "NetworkApplyOperation"("requestedByUserId");
CREATE INDEX "NetworkApplyOperation_status_idx" ON "NetworkApplyOperation"("status");

ALTER TABLE "WireGuardHub" ADD CONSTRAINT "WireGuardHub_fabricId_fkey"
  FOREIGN KEY ("fabricId") REFERENCES "NetworkFabric"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "HostNetworkPeer" ADD CONSTRAINT "HostNetworkPeer_fabricId_fkey"
  FOREIGN KEY ("fabricId") REFERENCES "NetworkFabric"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "HostNetworkPeer" ADD CONSTRAINT "HostNetworkPeer_endpointId_fkey"
  FOREIGN KEY ("endpointId") REFERENCES "AgentEndpoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "FabricPrefix" ADD CONSTRAINT "FabricPrefix_fabricId_fkey"
  FOREIGN KEY ("fabricId") REFERENCES "NetworkFabric"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FabricPrefix" ADD CONSTRAINT "FabricPrefix_ownerPeerId_fkey"
  FOREIGN KEY ("ownerPeerId") REFERENCES "HostNetworkPeer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ProjectNetworkPool" ADD CONSTRAINT "ProjectNetworkPool_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ProjectNetworkPool" ADD CONSTRAINT "ProjectNetworkPool_fabricId_fkey"
  FOREIGN KEY ("fabricId") REFERENCES "NetworkFabric"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "NetworkApplyOperation" ADD CONSTRAINT "NetworkApplyOperation_requestedByUserId_fkey"
  FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
