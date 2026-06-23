-- M13 Phase 2: tenant-scoped VM lifecycle v1 ownership and operation records.
-- VmInstance is the tenant-scoped lifecycle record bound to a project, tenant,
-- endpoint, and project network pool. VmLifecycleOperation tracks each
-- create/start/stop/restart/delete action. No agent call and no Incus mutation.

CREATE TYPE "VmInstanceStatus" AS ENUM ('PROVISIONING', 'RUNNING', 'STOPPED', 'FAILED', 'DELETED');
CREATE TYPE "VmLifecycleAction" AS ENUM ('CREATE', 'START', 'STOP', 'RESTART', 'DELETE');
CREATE TYPE "VmLifecycleOperationStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');
CREATE TYPE "VmAddressFamily" AS ENUM ('IPV4', 'IPV6', 'DUAL');

CREATE TABLE "VmInstance" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "endpointId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "networkPoolId" TEXT,
  "imageReference" TEXT NOT NULL,
  "status" "VmInstanceStatus" NOT NULL DEFAULT 'PROVISIONING',
  "cpuCount" INTEGER NOT NULL,
  "memoryBytes" BIGINT NOT NULL,
  "rootDiskBytes" BIGINT NOT NULL,
  "addressFamily" "VmAddressFamily" NOT NULL DEFAULT 'IPV4',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "VmInstance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VmInstance_endpointId_name_key" ON "VmInstance"("endpointId", "name");
CREATE INDEX "VmInstance_projectId_idx" ON "VmInstance"("projectId");
CREATE INDEX "VmInstance_tenantId_idx" ON "VmInstance"("tenantId");
CREATE INDEX "VmInstance_endpointId_idx" ON "VmInstance"("endpointId");
CREATE INDEX "VmInstance_networkPoolId_idx" ON "VmInstance"("networkPoolId");
CREATE INDEX "VmInstance_status_idx" ON "VmInstance"("status");

ALTER TABLE "VmInstance" ADD CONSTRAINT "VmInstance_endpointId_fkey"
  FOREIGN KEY ("endpointId") REFERENCES "AgentEndpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "VmInstance" ADD CONSTRAINT "VmInstance_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "VmInstance" ADD CONSTRAINT "VmInstance_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "VmInstance" ADD CONSTRAINT "VmInstance_networkPoolId_fkey"
  FOREIGN KEY ("networkPoolId") REFERENCES "ProjectNetworkPool"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "VmInstance" ADD CONSTRAINT "VmInstance_positive_limits_check"
  CHECK (
    "cpuCount" >= 1 AND
    "memoryBytes" >= 1 AND "memoryBytes" <= 9007199254740991 AND
    "rootDiskBytes" >= 1 AND "rootDiskBytes" <= 9007199254740991
  );

CREATE TABLE "VmLifecycleOperation" (
  "id" TEXT NOT NULL,
  "vmInstanceId" TEXT NOT NULL,
  "action" "VmLifecycleAction" NOT NULL,
  "status" "VmLifecycleOperationStatus" NOT NULL DEFAULT 'QUEUED',
  "requestedByUserId" TEXT NOT NULL,
  "summary" TEXT,
  "errorSummary" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "VmLifecycleOperation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VmLifecycleOperation_vmInstanceId_idx" ON "VmLifecycleOperation"("vmInstanceId");
CREATE INDEX "VmLifecycleOperation_requestedByUserId_idx" ON "VmLifecycleOperation"("requestedByUserId");
CREATE INDEX "VmLifecycleOperation_status_idx" ON "VmLifecycleOperation"("status");
CREATE INDEX "VmLifecycleOperation_action_idx" ON "VmLifecycleOperation"("action");

ALTER TABLE "VmLifecycleOperation" ADD CONSTRAINT "VmLifecycleOperation_vmInstanceId_fkey"
  FOREIGN KEY ("vmInstanceId") REFERENCES "VmInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VmLifecycleOperation" ADD CONSTRAINT "VmLifecycleOperation_requestedByUserId_fkey"
  FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
