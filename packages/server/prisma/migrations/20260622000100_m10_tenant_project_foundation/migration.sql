-- M10 Phase 2 establishes tenant/project/resource ownership foundations.
-- Quota and allocation records are policy-only and do not mutate Incus resources.

CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "ProjectStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "ProjectTenantRole" AS ENUM ('OWNER', 'PARTICIPANT');
CREATE TYPE "ProjectTenantStatus" AS ENUM ('ACTIVE', 'REMOVED');
CREATE TYPE "EndpointProjectBindingStatus" AS ENUM ('ACTIVE', 'REMOVED');
CREATE TYPE "ResourceType" AS ENUM ('INSTANCE', 'IMAGE', 'OPERATION');

CREATE TABLE "Tenant" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
  "defaultProjectId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Project" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "status" "ProjectStatus" NOT NULL DEFAULT 'ACTIVE',
  "ownerTenantId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProjectTenant" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "role" "ProjectTenantRole" NOT NULL,
  "status" "ProjectTenantStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProjectTenant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProjectQuota" (
  "projectId" TEXT NOT NULL,
  "maxVcpu" INTEGER,
  "maxMemoryBytes" BIGINT,
  "maxDiskBytes" BIGINT,
  "maxInstances" INTEGER,
  "maxIpv6Addresses" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProjectQuota_pkey" PRIMARY KEY ("projectId")
);

CREATE TABLE "ProjectTenantQuota" (
  "projectId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "maxVcpu" INTEGER,
  "maxMemoryBytes" BIGINT,
  "maxDiskBytes" BIGINT,
  "maxInstances" INTEGER,
  "maxIpv6Addresses" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProjectTenantQuota_pkey" PRIMARY KEY ("projectId", "tenantId")
);

CREATE TABLE "EndpointProjectBinding" (
  "id" TEXT NOT NULL,
  "endpointId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "status" "EndpointProjectBindingStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "EndpointProjectBinding_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ResourceOwnership" (
  "id" TEXT NOT NULL,
  "resourceType" "ResourceType" NOT NULL,
  "resourceId" TEXT NOT NULL,
  "endpointId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "discoveredName" TEXT,
  "externalFingerprint" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ResourceOwnership_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");
CREATE UNIQUE INDEX "Tenant_defaultProjectId_key" ON "Tenant"("defaultProjectId");
CREATE UNIQUE INDEX "Project_ownerTenantId_slug_key" ON "Project"("ownerTenantId", "slug");
CREATE INDEX "Project_ownerTenantId_idx" ON "Project"("ownerTenantId");
CREATE UNIQUE INDEX "ProjectTenant_projectId_tenantId_key" ON "ProjectTenant"("projectId", "tenantId");
CREATE INDEX "ProjectTenant_tenantId_idx" ON "ProjectTenant"("tenantId");
CREATE INDEX "ProjectTenantQuota_tenantId_idx" ON "ProjectTenantQuota"("tenantId");
CREATE UNIQUE INDEX "EndpointProjectBinding_endpointId_projectId_key" ON "EndpointProjectBinding"("endpointId", "projectId");
CREATE INDEX "EndpointProjectBinding_projectId_idx" ON "EndpointProjectBinding"("projectId");
CREATE UNIQUE INDEX "ResourceOwnership_resourceType_endpointId_resourceId_key" ON "ResourceOwnership"("resourceType", "endpointId", "resourceId");
CREATE INDEX "ResourceOwnership_projectId_idx" ON "ResourceOwnership"("projectId");
CREATE INDEX "ResourceOwnership_tenantId_idx" ON "ResourceOwnership"("tenantId");

ALTER TABLE "ProjectQuota" ADD CONSTRAINT "ProjectQuota_positive_values_check"
  CHECK (
    ("maxVcpu" IS NULL OR "maxVcpu" >= 1) AND
    ("maxMemoryBytes" IS NULL OR ("maxMemoryBytes" >= 1 AND "maxMemoryBytes" <= 9007199254740991)) AND
    ("maxDiskBytes" IS NULL OR ("maxDiskBytes" >= 1 AND "maxDiskBytes" <= 9007199254740991)) AND
    ("maxInstances" IS NULL OR "maxInstances" >= 1) AND
    ("maxIpv6Addresses" IS NULL OR "maxIpv6Addresses" >= 1)
  );

ALTER TABLE "ProjectTenantQuota" ADD CONSTRAINT "ProjectTenantQuota_positive_values_check"
  CHECK (
    ("maxVcpu" IS NULL OR "maxVcpu" >= 1) AND
    ("maxMemoryBytes" IS NULL OR ("maxMemoryBytes" >= 1 AND "maxMemoryBytes" <= 9007199254740991)) AND
    ("maxDiskBytes" IS NULL OR ("maxDiskBytes" >= 1 AND "maxDiskBytes" <= 9007199254740991)) AND
    ("maxInstances" IS NULL OR "maxInstances" >= 1) AND
    ("maxIpv6Addresses" IS NULL OR "maxIpv6Addresses" >= 1)
  );

ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_defaultProjectId_fkey"
  FOREIGN KEY ("defaultProjectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Project" ADD CONSTRAINT "Project_ownerTenantId_fkey"
  FOREIGN KEY ("ownerTenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ProjectTenant" ADD CONSTRAINT "ProjectTenant_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ProjectTenant" ADD CONSTRAINT "ProjectTenant_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ProjectQuota" ADD CONSTRAINT "ProjectQuota_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ProjectTenantQuota" ADD CONSTRAINT "ProjectTenantQuota_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ProjectTenantQuota" ADD CONSTRAINT "ProjectTenantQuota_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ProjectTenantQuota" ADD CONSTRAINT "ProjectTenantQuota_projectId_tenantId_fkey"
  FOREIGN KEY ("projectId", "tenantId") REFERENCES "ProjectTenant"("projectId", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EndpointProjectBinding" ADD CONSTRAINT "EndpointProjectBinding_endpointId_fkey"
  FOREIGN KEY ("endpointId") REFERENCES "AgentEndpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EndpointProjectBinding" ADD CONSTRAINT "EndpointProjectBinding_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ResourceOwnership" ADD CONSTRAINT "ResourceOwnership_endpointId_fkey"
  FOREIGN KEY ("endpointId") REFERENCES "AgentEndpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ResourceOwnership" ADD CONSTRAINT "ResourceOwnership_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ResourceOwnership" ADD CONSTRAINT "ResourceOwnership_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ResourceOwnership" ADD CONSTRAINT "ResourceOwnership_endpointId_projectId_fkey"
  FOREIGN KEY ("endpointId", "projectId") REFERENCES "EndpointProjectBinding"("endpointId", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ResourceOwnership" ADD CONSTRAINT "ResourceOwnership_projectId_tenantId_fkey"
  FOREIGN KEY ("projectId", "tenantId") REFERENCES "ProjectTenant"("projectId", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
