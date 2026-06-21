import { useCallback, useState } from "react"
import type { FormEvent, ReactNode } from "react"
import { Link, useOutletContext, useParams } from "react-router-dom"
import {
  addAdminProjectEndpointBinding,
  addAdminProjectTenant,
  archiveAdminProject,
  createAdminProject,
  fetchAdminEndpoints,
  fetchAdminProject,
  fetchAdminProjects,
  fetchAdminTenants,
  removeAdminProjectEndpointBinding,
  removeAdminProjectTenant,
  restoreAdminProject,
  setAdminProjectQuota,
  setAdminProjectTenantQuota,
  updateAdminProject,
  updateAdminProjectTenant,
} from "@/lib/api"
import { hasGlobalAction } from "@/lib/adminAccess"
import { useApi } from "@/hooks/useApi"
import type {
  AdminProjectDetail,
  ManagedEndpoint,
  ManagedEndpointProjectBinding,
  ManagedProject,
  ManagedProjectTenant,
  ManagedTenant,
  ProjectQuotaPolicy,
  ProjectTenantQuotaAllocation,
  QuotaInput,
} from "@/types"
import type { AppShellContext } from "@/components/layout/Layout"
import {
  AdminEmptyState,
  AdminErrorState,
  AdminForbiddenState,
  AdminLoadingRows,
  AdminPageHeader,
  AdminTableShell,
  FormError,
  RefreshButton,
  StatusPill,
  formatError,
} from "./adminPageUtils"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

type QuotaField = keyof QuotaInput

const quotaFields: Array<{ key: QuotaField; label: string; placeholder: string }> = [
  { key: "maxVcpu", label: "vCPU", placeholder: "16" },
  { key: "maxMemoryBytes", label: "Memory bytes", placeholder: "34359738368" },
  { key: "maxDiskBytes", label: "Disk bytes", placeholder: "1099511627776" },
  { key: "maxInstances", label: "Instances", placeholder: "20" },
  { key: "maxIpv6Addresses", label: "IPv6 addresses", placeholder: "64" },
]

export function AdminProjects() {
  const { session } = useOutletContext<AppShellContext>()
  const canRead = hasGlobalAction(session.access, "projects:read")
  const canReadTenants = hasGlobalAction(session.access, "tenants:read")
  const canWrite = hasGlobalAction(session.access, "projects:write")
  const fetchProjects = useCallback(
    () => (canRead ? fetchAdminProjects() : Promise.resolve([])),
    [canRead]
  )
  const fetchTenants = useCallback(
    () => (canRead && canReadTenants ? fetchAdminTenants() : Promise.resolve([])),
    [canRead, canReadTenants]
  )
  const projects = useApi(fetchProjects)
  const tenants = useApi(fetchTenants)

  if (!canRead) {
    return <AdminForbiddenState description="Project administration requires projects:read." />
  }

  return (
    <div className="flex flex-col gap-6">
      <AdminPageHeader
        title="Projects"
        description="Resource grouping and collaboration boundaries across one or more tenants."
        actions={<RefreshButton onClick={projects.refetch} />}
      />

      {canWrite ? (
        <CreateProjectPanel
          tenants={(tenants.data ?? []).filter((tenant) => tenant.status === "ACTIVE")}
          onCreated={projects.refetch}
        />
      ) : null}

      {projects.loading ? (
        <ProjectsTable projects={[]} tenants={[]} loading />
      ) : projects.error ? (
        <AdminErrorState
          message={`Failed to fetch projects: ${projects.error}`}
          onRetry={projects.refetch}
        />
      ) : projects.data && projects.data.length === 0 ? (
        <AdminEmptyState title="No projects found" description="Create a project under an active tenant." />
      ) : projects.data ? (
        <ProjectsTable
          projects={projects.data}
          tenants={tenants.data ?? []}
          canWrite={canWrite}
          onChanged={projects.refetch}
        />
      ) : null}
    </div>
  )
}

export function AdminProjectDetail() {
  const { session } = useOutletContext<AppShellContext>()
  const { projectId = "" } = useParams()
  const canRead = hasGlobalAction(session.access, "projects:read")
  const canReadTenants = hasGlobalAction(session.access, "tenants:read")
  const canReadEndpoints = hasGlobalAction(session.access, "endpoints:read")
  const canProjectWrite = hasGlobalAction(session.access, "projects:write")
  const canQuotaWrite = hasGlobalAction(session.access, "quotas:write")
  const fetchProject = useCallback(
    () => (canRead ? fetchAdminProject(projectId) : Promise.resolve(null)),
    [canRead, projectId]
  )
  const fetchTenants = useCallback(
    () => (canRead && canReadTenants ? fetchAdminTenants() : Promise.resolve([])),
    [canRead, canReadTenants]
  )
  const fetchEndpoints = useCallback(
    () => (canRead && canReadEndpoints ? fetchAdminEndpoints() : Promise.resolve([])),
    [canRead, canReadEndpoints]
  )
  const detail = useApi(fetchProject)
  const tenants = useApi(fetchTenants)
  const endpoints = useApi(fetchEndpoints)

  if (!canRead) {
    return <AdminForbiddenState description="Project detail requires projects:read." />
  }

  if (detail.loading) {
    return <AdminEmptyState title="Loading project" description="Project detail is loading." />
  }

  if (detail.error) {
    return <AdminErrorState message={`Failed to fetch project: ${detail.error}`} onRetry={detail.refetch} />
  }

  if (!detail.data) {
    return null
  }

  const tenantById = new Map((tenants.data ?? []).map((tenant) => [tenant.id, tenant]))
  const endpointById = new Map((endpoints.data ?? []).map((endpoint) => [endpoint.id, endpoint]))
  const ownerTenant = tenantById.get(detail.data.project.ownerTenantId)

  return (
    <div className="flex flex-col gap-6">
      <AdminPageHeader
        title={detail.data.project.name}
        description="Project participants, quota policy, tenant allocations, and endpoint visibility binding."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild type="button" variant="outline">
              <Link to="/admin/projects">All projects</Link>
            </Button>
            <RefreshButton
              onClick={() => {
                detail.refetch()
                tenants.refetch()
                endpoints.refetch()
              }}
            />
          </div>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Project profile</CardTitle>
          <CardDescription>Project status does not create, resize, or mutate host resources.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <DetailItem label="Slug" value={detail.data.project.slug} />
          <DetailItem label="Status" value={<StatusPill status={detail.data.project.status} />} />
          <DetailItem
            label="Owner tenant"
            value={
              ownerTenant ? (
                <Link className="underline-offset-4 hover:underline" to={`/admin/tenants/${ownerTenant.id}`}>
                  {ownerTenant.name}
                </Link>
              ) : (
                detail.data.project.ownerTenantId
              )
            }
          />
          <DetailItem label="Project ID" value={detail.data.project.id} />
        </CardContent>
      </Card>

      {canProjectWrite ? (
        <ProjectEditPanel project={detail.data.project} onChanged={detail.refetch} />
      ) : null}

      <ParticipantsPanel
        detail={detail.data}
        tenants={tenants.data ?? []}
        canWrite={canProjectWrite}
        onChanged={detail.refetch}
      />

      <QuotaPolicyPanel
        quota={detail.data.quota}
        canWrite={canQuotaWrite}
        projectId={detail.data.project.id}
        onChanged={detail.refetch}
      />

      <TenantAllocationPanel
        participants={detail.data.participants}
        tenantQuotas={detail.data.tenantQuotas}
        tenants={tenants.data ?? []}
        canWrite={canQuotaWrite}
        projectId={detail.data.project.id}
        onChanged={detail.refetch}
      />

      <EndpointBindingsPanel
        bindings={detail.data.endpointBindings}
        endpoints={endpoints.data ?? []}
        endpointById={endpointById}
        canWrite={canProjectWrite}
        projectId={detail.data.project.id}
        onChanged={detail.refetch}
      />
    </div>
  )
}

function CreateProjectPanel({
  tenants,
  onCreated,
}: {
  tenants: ManagedTenant[]
  onCreated: () => void
}) {
  const [ownerTenantId, setOwnerTenantId] = useState("")
  const [name, setName] = useState("")
  const [slug, setSlug] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await createAdminProject({
        ownerTenantId,
        name: name.trim(),
        slug: slug.trim(),
      })
      setOwnerTenantId("")
      setName("")
      setSlug("")
      onCreated()
    } catch (err) {
      setError(formatError(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Create project</CardTitle>
        <CardDescription>Projects can later include more tenant participants.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3 lg:grid-cols-[minmax(12rem,1fr)_1fr_14rem_auto]" onSubmit={onSubmit}>
          <Select value={ownerTenantId} onValueChange={setOwnerTenantId}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Owner tenant" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {tenants.map((tenant) => (
                  <SelectItem key={tenant.id} value={tenant.id}>
                    {tenant.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Input
            placeholder="Project name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={submitting}
          />
          <Input
            placeholder="project-slug"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            disabled={submitting}
          />
          <Button type="submit" disabled={submitting || !ownerTenantId}>
            {submitting ? "Creating..." : "Create"}
          </Button>
          <div className="lg:col-span-4">
            <FormError message={error} />
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function ProjectEditPanel({ project, onChanged }: { project: ManagedProject; onChanged: () => void }) {
  const [name, setName] = useState(project.name)
  const [slug, setSlug] = useState(project.slug)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await updateAdminProject(project.id, { name: name.trim(), slug: slug.trim() })
      onChanged()
    } catch (err) {
      setError(formatError(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Edit project</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3 sm:grid-cols-[1fr_14rem_auto_auto]" onSubmit={onSubmit}>
          <Input value={name} onChange={(event) => setName(event.target.value)} disabled={submitting} />
          <Input value={slug} onChange={(event) => setSlug(event.target.value)} disabled={submitting} />
          <Button type="submit" disabled={submitting}>
            {submitting ? "Saving..." : "Save"}
          </Button>
          <ProjectStatusButton project={project} onChanged={onChanged} />
          <div className="sm:col-span-4">
            <FormError message={error} />
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function ProjectsTable({
  projects,
  tenants,
  loading = false,
  canWrite = false,
  onChanged,
}: {
  projects: ManagedProject[]
  tenants: ManagedTenant[]
  loading?: boolean
  canWrite?: boolean
  onChanged?: () => void
}) {
  const tenantById = new Map(tenants.map((tenant) => [tenant.id, tenant]))

  return (
    <AdminTableShell>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Project</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Owner tenant</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <AdminLoadingRows columns={4} />
          ) : (
            projects.map((project) => {
              const ownerTenant = tenantById.get(project.ownerTenantId)
              return (
                <TableRow key={project.id}>
                  <TableCell className="max-w-[22rem] whitespace-normal">
                    <Link className="font-medium underline-offset-4 hover:underline" to={`/admin/projects/${project.id}`}>
                      {project.name}
                    </Link>
                    <div className="break-all text-xs text-muted-foreground">{project.slug}</div>
                  </TableCell>
                  <TableCell>
                    <StatusPill status={project.status} />
                  </TableCell>
                  <TableCell className="max-w-[18rem] whitespace-normal">
                    {ownerTenant ? (
                      <Link className="text-sm underline-offset-4 hover:underline" to={`/admin/tenants/${ownerTenant.id}`}>
                        {ownerTenant.name}
                      </Link>
                    ) : (
                      <span className="break-all text-sm text-muted-foreground">{project.ownerTenantId}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {canWrite ? <ProjectStatusButton project={project} onChanged={onChanged} /> : null}
                  </TableCell>
                </TableRow>
              )
            })
          )}
        </TableBody>
      </Table>
    </AdminTableShell>
  )
}

function ParticipantsPanel({
  detail,
  tenants,
  canWrite,
  onChanged,
}: {
  detail: AdminProjectDetail
  tenants: ManagedTenant[]
  canWrite: boolean
  onChanged: () => void
}) {
  const tenantById = new Map(tenants.map((tenant) => [tenant.id, tenant]))
  const activeParticipantIds = new Set(
    detail.participants
      .filter((participant) => participant.status === "ACTIVE")
      .map((participant) => participant.tenantId)
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Tenant participants</CardTitle>
        <CardDescription>Projects can include multiple tenants for collaboration.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {canWrite ? (
          <AddParticipantForm
            projectId={detail.project.id}
            tenants={tenants.filter(
              (tenant) => tenant.status === "ACTIVE" && !activeParticipantIds.has(tenant.id)
            )}
            onChanged={onChanged}
          />
        ) : null}
        <ParticipantsTable
          participants={detail.participants}
          tenantById={tenantById}
          canWrite={canWrite}
          onChanged={onChanged}
        />
      </CardContent>
    </Card>
  )
}

function AddParticipantForm({
  projectId,
  tenants,
  onChanged,
}: {
  projectId: string
  tenants: ManagedTenant[]
  onChanged: () => void
}) {
  const [tenantId, setTenantId] = useState("")
  const [role, setRole] = useState<ManagedProjectTenant["role"]>("PARTICIPANT")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await addAdminProjectTenant(projectId, { tenantId, role })
      setTenantId("")
      setRole("PARTICIPANT")
      onChanged()
    } catch (err) {
      setError(formatError(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="grid gap-3 md:grid-cols-[1fr_12rem_auto]" onSubmit={onSubmit}>
      <Select value={tenantId} onValueChange={setTenantId}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Tenant" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {tenants.map((tenant) => (
              <SelectItem key={tenant.id} value={tenant.id}>
                {tenant.name}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <RoleSelect value={role} onChange={setRole} />
      <Button type="submit" disabled={submitting || !tenantId}>
        {submitting ? "Adding..." : "Add tenant"}
      </Button>
      <div className="md:col-span-3">
        <FormError message={error} />
      </div>
    </form>
  )
}

function ParticipantsTable({
  participants,
  tenantById,
  canWrite,
  onChanged,
}: {
  participants: ManagedProjectTenant[]
  tenantById: Map<string, ManagedTenant>
  canWrite: boolean
  onChanged: () => void
}) {
  if (participants.length === 0) {
    return <AdminEmptyState title="No tenant participants" description="No tenants participate in this project." />
  }

  return (
    <AdminTableShell>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Tenant</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {participants.map((participant) => {
            const tenant = tenantById.get(participant.tenantId)
            return (
              <TableRow key={participant.id}>
                <TableCell className="max-w-[20rem] whitespace-normal">
                  {tenant ? (
                    <Link className="font-medium underline-offset-4 hover:underline" to={`/admin/tenants/${tenant.id}`}>
                      {tenant.name}
                    </Link>
                  ) : (
                    <span className="break-all">{participant.tenantId}</span>
                  )}
                </TableCell>
                <TableCell>{participant.role}</TableCell>
                <TableCell>
                  <StatusPill status={participant.status} />
                </TableCell>
                <TableCell>
                  {canWrite && participant.status === "ACTIVE" ? (
                    <ParticipantActions participant={participant} onChanged={onChanged} />
                  ) : null}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </AdminTableShell>
  )
}

function ParticipantActions({
  participant,
  onChanged,
}: {
  participant: ManagedProjectTenant
  onChanged: () => void
}) {
  const [loading, setLoading] = useState(false)
  const nextRole = participant.role === "OWNER" ? "PARTICIPANT" : "OWNER"

  async function updateRole() {
    setLoading(true)
    try {
      await updateAdminProjectTenant(participant.projectId, participant.tenantId, { role: nextRole })
      onChanged()
    } finally {
      setLoading(false)
    }
  }

  async function remove() {
    setLoading(true)
    try {
      await removeAdminProjectTenant(participant.projectId, participant.tenantId)
      onChanged()
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" onClick={updateRole} disabled={loading}>
        {loading ? "Updating..." : `Make ${nextRole}`}
      </Button>
      {participant.status === "ACTIVE" ? (
        <Button type="button" variant="outline" onClick={remove} disabled={loading}>
          Remove
        </Button>
      ) : null}
    </div>
  )
}

function QuotaPolicyPanel({
  quota,
  canWrite,
  projectId,
  onChanged,
}: {
  quota: ProjectQuotaPolicy | null
  canWrite: boolean
  projectId: string
  onChanged: () => void
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Project quota policy</CardTitle>
        <CardDescription>Policy record only; saving here does not mutate Incus resources.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <QuotaValues quota={quota} emptyLabel="No project quota policy saved." />
        {canWrite ? (
          <QuotaForm
            buttonLabel="Save project quota"
            initialQuota={quota}
            onSubmitQuota={async (input) => {
              await setAdminProjectQuota(projectId, input)
              onChanged()
            }}
          />
        ) : null}
      </CardContent>
    </Card>
  )
}

function TenantAllocationPanel({
  participants,
  tenantQuotas,
  tenants,
  canWrite,
  projectId,
  onChanged,
}: {
  participants: ManagedProjectTenant[]
  tenantQuotas: ProjectTenantQuotaAllocation[]
  tenants: ManagedTenant[]
  canWrite: boolean
  projectId: string
  onChanged: () => void
}) {
  const tenantById = new Map(tenants.map((tenant) => [tenant.id, tenant]))
  const activeParticipants = participants.filter((participant) => participant.status === "ACTIVE")

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Per-tenant allocations</CardTitle>
        <CardDescription>Allocations are bounded by the project quota policy when one is present.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {tenantQuotas.length === 0 ? (
          <AdminEmptyState title="No tenant allocations" description="No per-tenant allocation records exist." />
        ) : (
          <AdminTableShell>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tenant</TableHead>
                  <TableHead>vCPU</TableHead>
                  <TableHead>Memory bytes</TableHead>
                  <TableHead>Disk bytes</TableHead>
                  <TableHead>Instances</TableHead>
                  <TableHead>IPv6 addresses</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tenantQuotas.map((quota) => (
                  <TableRow key={`${quota.projectId}:${quota.tenantId}`}>
                    <TableCell className="max-w-[18rem] whitespace-normal">
                      {tenantById.get(quota.tenantId)?.name ?? quota.tenantId}
                    </TableCell>
                    <TableCell>{formatQuotaValue(quota.maxVcpu)}</TableCell>
                    <TableCell>{formatQuotaValue(quota.maxMemoryBytes)}</TableCell>
                    <TableCell>{formatQuotaValue(quota.maxDiskBytes)}</TableCell>
                    <TableCell>{formatQuotaValue(quota.maxInstances)}</TableCell>
                    <TableCell>{formatQuotaValue(quota.maxIpv6Addresses)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </AdminTableShell>
        )}
        {canWrite ? (
          <TenantAllocationForm
            participants={activeParticipants}
            tenantById={tenantById}
            tenantQuotas={tenantQuotas}
            projectId={projectId}
            onChanged={onChanged}
          />
        ) : null}
      </CardContent>
    </Card>
  )
}

function TenantAllocationForm({
  participants,
  tenantById,
  tenantQuotas,
  projectId,
  onChanged,
}: {
  participants: ManagedProjectTenant[]
  tenantById: Map<string, ManagedTenant>
  tenantQuotas: ProjectTenantQuotaAllocation[]
  projectId: string
  onChanged: () => void
}) {
  const [tenantId, setTenantId] = useState("")
  const selectedQuota = tenantQuotas.find((quota) => quota.tenantId === tenantId) ?? null

  return (
    <div className="flex flex-col gap-3">
      <Select value={tenantId} onValueChange={setTenantId}>
        <SelectTrigger className="w-full md:max-w-sm">
          <SelectValue placeholder="Tenant allocation target" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {participants.map((participant) => (
              <SelectItem key={participant.tenantId} value={participant.tenantId}>
                {tenantById.get(participant.tenantId)?.name ?? participant.tenantId}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {tenantId ? (
        <QuotaForm
          key={tenantId}
          buttonLabel="Save tenant allocation"
          initialQuota={selectedQuota}
          onSubmitQuota={async (input) => {
            await setAdminProjectTenantQuota(projectId, tenantId, input)
            onChanged()
          }}
        />
      ) : null}
    </div>
  )
}

function EndpointBindingsPanel({
  bindings,
  endpoints,
  endpointById,
  canWrite,
  projectId,
  onChanged,
}: {
  bindings: ManagedEndpointProjectBinding[]
  endpoints: ManagedEndpoint[]
  endpointById: Map<string, ManagedEndpoint>
  canWrite: boolean
  projectId: string
  onChanged: () => void
}) {
  const activeEndpointIds = new Set(
    bindings.filter((binding) => binding.status === "ACTIVE").map((binding) => binding.endpointId)
  )
  const bindableEndpoints = endpoints.filter(
    (endpoint) => endpoint.status === "ACTIVE" && !activeEndpointIds.has(endpoint.id)
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Endpoint bindings</CardTitle>
        <CardDescription>Endpoint-project binding defines read-only visibility. Tokens stay hidden.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {canWrite ? (
          <AddEndpointBindingForm
            projectId={projectId}
            endpoints={bindableEndpoints}
            onChanged={onChanged}
          />
        ) : null}
        {bindings.length === 0 ? (
          <AdminEmptyState title="No endpoint bindings" description="No endpoints are bound to this project." />
        ) : (
          <AdminTableShell>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Endpoint</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Credential</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {bindings.map((binding) => {
                  const endpoint = endpointById.get(binding.endpointId)
                  return (
                    <TableRow key={binding.id}>
                      <TableCell className="max-w-[24rem] whitespace-normal">
                        <div className="font-medium">{endpoint?.name ?? binding.endpointId}</div>
                        <div className="break-all text-xs text-muted-foreground">
                          {endpoint?.url ?? "Endpoint detail unavailable"}
                        </div>
                      </TableCell>
                      <TableCell>
                        <StatusPill status={binding.status} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {endpoint ? (endpoint.credentialConfigured ? "Configured" : "Not configured") : "Unknown"}
                      </TableCell>
                      <TableCell>
                        {canWrite && binding.status === "ACTIVE" ? (
                          <RemoveEndpointBindingButton binding={binding} onChanged={onChanged} />
                        ) : null}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </AdminTableShell>
        )}
      </CardContent>
    </Card>
  )
}

function AddEndpointBindingForm({
  projectId,
  endpoints,
  onChanged,
}: {
  projectId: string
  endpoints: ManagedEndpoint[]
  onChanged: () => void
}) {
  const [endpointId, setEndpointId] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await addAdminProjectEndpointBinding(projectId, endpointId)
      setEndpointId("")
      onChanged()
    } catch (err) {
      setError(formatError(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="grid gap-3 md:grid-cols-[1fr_auto]" onSubmit={onSubmit}>
      <Select value={endpointId} onValueChange={setEndpointId}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Endpoint" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {endpoints.map((endpoint) => (
              <SelectItem key={endpoint.id} value={endpoint.id}>
                {endpoint.name}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <Button type="submit" disabled={submitting || !endpointId}>
        {submitting ? "Binding..." : "Bind endpoint"}
      </Button>
      <div className="md:col-span-2">
        <FormError message={error} />
      </div>
    </form>
  )
}

function QuotaValues({
  quota,
  emptyLabel,
}: {
  quota: QuotaInput | null
  emptyLabel: string
}) {
  if (!quota) {
    return <AdminEmptyState title={emptyLabel} description="Blank quota fields are unlimited policy values." />
  }

  return (
    <div className="grid gap-3 md:grid-cols-5">
      {quotaFields.map((field) => (
        <div key={field.key} className="rounded-lg border border-border px-3 py-2">
          <div className="text-xs font-medium text-muted-foreground">{field.label}</div>
          <div className="mt-1 break-all text-sm">{formatQuotaValue(quota[field.key])}</div>
        </div>
      ))}
    </div>
  )
}

function QuotaForm({
  initialQuota,
  buttonLabel,
  onSubmitQuota,
}: {
  initialQuota: QuotaInput | null
  buttonLabel: string
  onSubmitQuota: (input: QuotaInput) => Promise<void>
}) {
  const [values, setValues] = useState<Record<QuotaField, string>>(() => quotaToFormValues(initialQuota))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await onSubmitQuota(formValuesToQuota(values))
    } catch (err) {
      setError(formatError(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="grid gap-3 md:grid-cols-5" onSubmit={onSubmit}>
      {quotaFields.map((field) => (
        <Input
          key={field.key}
          min={0}
          placeholder={field.placeholder}
          type="number"
          value={values[field.key]}
          onChange={(event) =>
            setValues((current) => ({ ...current, [field.key]: event.target.value }))
          }
          disabled={submitting}
          aria-label={field.label}
        />
      ))}
      <Button className="md:col-span-5 md:w-fit" type="submit" disabled={submitting}>
        {submitting ? "Saving..." : buttonLabel}
      </Button>
      <div className="md:col-span-5">
        <FormError message={error} />
      </div>
    </form>
  )
}

function ProjectStatusButton({
  project,
  onChanged,
}: {
  project: ManagedProject
  onChanged?: () => void
}) {
  const [loading, setLoading] = useState(false)
  const action = project.status === "ACTIVE" ? archiveAdminProject : restoreAdminProject

  async function onClick() {
    setLoading(true)
    try {
      await action(project.id)
      onChanged?.()
    } finally {
      setLoading(false)
    }
  }

  return (
    <Button type="button" variant="outline" onClick={onClick} disabled={loading}>
      {loading ? "Updating..." : project.status === "ACTIVE" ? "Archive" : "Restore"}
    </Button>
  )
}

function RemoveEndpointBindingButton({
  binding,
  onChanged,
}: {
  binding: ManagedEndpointProjectBinding
  onChanged: () => void
}) {
  const [loading, setLoading] = useState(false)

  async function onClick() {
    setLoading(true)
    try {
      await removeAdminProjectEndpointBinding(binding.projectId, binding.endpointId)
      onChanged()
    } finally {
      setLoading(false)
    }
  }

  return (
    <Button type="button" variant="outline" onClick={onClick} disabled={loading}>
      {loading ? "Removing..." : "Remove"}
    </Button>
  )
}

function RoleSelect({
  value,
  onChange,
}: {
  value: ManagedProjectTenant["role"]
  onChange: (role: ManagedProjectTenant["role"]) => void
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as ManagedProjectTenant["role"])}>
      <SelectTrigger className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value="PARTICIPANT">Participant</SelectItem>
          <SelectItem value="OWNER">Owner</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

function DetailItem({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-medium uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 break-words text-sm">{value}</div>
    </div>
  )
}

function quotaToFormValues(quota: QuotaInput | null): Record<QuotaField, string> {
  return quotaFields.reduce(
    (accumulator, field) => {
      const value = quota?.[field.key]
      accumulator[field.key] = value === null || value === undefined ? "" : String(value)
      return accumulator
    },
    {} as Record<QuotaField, string>
  )
}

function formValuesToQuota(values: Record<QuotaField, string>): QuotaInput {
  return quotaFields.reduce(
    (accumulator, field) => {
      const value = values[field.key].trim()
      accumulator[field.key] = value === "" ? null : Number(value)
      return accumulator
    },
    {} as QuotaInput
  )
}

function formatQuotaValue(value: number | null): string {
  return value === null ? "Unlimited" : value.toLocaleString()
}
