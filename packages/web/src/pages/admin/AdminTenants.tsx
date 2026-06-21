import { useCallback, useState } from "react"
import type { FormEvent, ReactNode } from "react"
import { Link, useOutletContext, useParams } from "react-router-dom"
import {
  archiveAdminTenant,
  createAdminTenant,
  fetchAdminProjects,
  fetchAdminTenant,
  fetchAdminTenants,
  restoreAdminTenant,
  updateAdminTenant,
} from "@/lib/api"
import { hasGlobalAction } from "@/lib/adminAccess"
import { useApi } from "@/hooks/useApi"
import type { ManagedProject, ManagedTenant } from "@/types"
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

export function AdminTenants() {
  const { session } = useOutletContext<AppShellContext>()
  const canRead = hasGlobalAction(session.access, "tenants:read")
  const canReadProjects = hasGlobalAction(session.access, "projects:read")
  const canWrite = hasGlobalAction(session.access, "tenants:write")
  const fetchTenants = useCallback(
    () => (canRead ? fetchAdminTenants() : Promise.resolve([])),
    [canRead]
  )
  const fetchProjects = useCallback(
    () => (canRead && canReadProjects ? fetchAdminProjects() : Promise.resolve([])),
    [canRead, canReadProjects]
  )
  const tenants = useApi(fetchTenants)
  const projects = useApi(fetchProjects)

  if (!canRead) {
    return <AdminForbiddenState description="Tenant administration requires tenants:read." />
  }

  return (
    <div className="flex flex-col gap-6">
      <AdminPageHeader
        title="Tenants"
        description="Customer boundaries with default projects for ordinary single-tenant use."
        actions={<RefreshButton onClick={tenants.refetch} />}
      />

      {canWrite ? (
        <CreateTenantPanel
          onCreated={() => {
            tenants.refetch()
            projects.refetch()
          }}
        />
      ) : null}

      {tenants.loading ? (
        <TenantsTable tenants={[]} projects={[]} loading />
      ) : tenants.error ? (
        <AdminErrorState
          message={`Failed to fetch tenants: ${tenants.error}`}
          onRetry={tenants.refetch}
        />
      ) : tenants.data && tenants.data.length === 0 ? (
        <AdminEmptyState title="No tenants found" description="Create a tenant to get its default project." />
      ) : tenants.data ? (
        <TenantsTable
          tenants={tenants.data}
          projects={projects.data ?? []}
          canWrite={canWrite}
          onChanged={() => {
            tenants.refetch()
            projects.refetch()
          }}
        />
      ) : null}
    </div>
  )
}

export function AdminTenantDetail() {
  const { session } = useOutletContext<AppShellContext>()
  const { tenantId = "" } = useParams()
  const canRead = hasGlobalAction(session.access, "tenants:read")
  const canReadProjects = hasGlobalAction(session.access, "projects:read")
  const canWrite = hasGlobalAction(session.access, "tenants:write")
  const fetchTenant = useCallback(
    () => (canRead ? fetchAdminTenant(tenantId) : Promise.resolve(null)),
    [canRead, tenantId]
  )
  const fetchProjects = useCallback(
    () => (canRead && canReadProjects ? fetchAdminProjects() : Promise.resolve([])),
    [canRead, canReadProjects]
  )
  const tenant = useApi(fetchTenant)
  const projects = useApi(fetchProjects)

  if (!canRead) {
    return <AdminForbiddenState description="Tenant detail requires tenants:read." />
  }

  if (tenant.loading) {
    return <AdminEmptyState title="Loading tenant" description="Tenant detail is loading." />
  }

  if (tenant.error) {
    return <AdminErrorState message={`Failed to fetch tenant: ${tenant.error}`} onRetry={tenant.refetch} />
  }

  if (!tenant.data) {
    return null
  }

  const currentTenant = tenant.data
  const ownedProjects = (projects.data ?? []).filter((project) => project.ownerTenantId === currentTenant.id)
  const defaultProject = ownedProjects.find((project) => project.id === currentTenant.defaultProjectId)

  return (
    <div className="flex flex-col gap-6">
      <AdminPageHeader
        title={currentTenant.name}
        description="Tenant customer boundary, default project, and owner project records."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild type="button" variant="outline">
              <Link to="/admin/tenants">All tenants</Link>
            </Button>
            <RefreshButton
              onClick={() => {
                tenant.refetch()
                projects.refetch()
              }}
            />
          </div>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tenant profile</CardTitle>
          <CardDescription>Status and default project are policy records only.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <DetailItem label="Slug" value={currentTenant.slug} />
          <DetailItem label="Status" value={<StatusPill status={currentTenant.status} />} />
          <DetailItem
            label="Default project"
            value={
              defaultProject ? (
                <Link className="underline-offset-4 hover:underline" to={`/admin/projects/${defaultProject.id}`}>
                  {defaultProject.name}
                </Link>
              ) : (
                currentTenant.defaultProjectId
              )
            }
          />
          <DetailItem label="Tenant ID" value={currentTenant.id} />
        </CardContent>
      </Card>

      {canWrite ? (
        <TenantEditPanel
          tenant={currentTenant}
          onChanged={() => {
            tenant.refetch()
            projects.refetch()
          }}
        />
      ) : null}

      {projects.loading ? (
        <ProjectsForTenantTable projects={[]} loading />
      ) : projects.error ? (
        <AdminErrorState
          message={`Failed to fetch projects: ${projects.error}`}
          onRetry={projects.refetch}
        />
      ) : ownedProjects.length === 0 ? (
        <AdminEmptyState title="No owned projects" description="No project records are owned by this tenant." />
      ) : (
        <ProjectsForTenantTable projects={ownedProjects} />
      )}
    </div>
  )
}

function CreateTenantPanel({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("")
  const [slug, setSlug] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)

    try {
      await createAdminTenant({ name: name.trim(), slug: slug.trim() })
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
        <CardTitle className="text-base">Create tenant</CardTitle>
        <CardDescription>Creation also creates the tenant default project.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3 sm:grid-cols-[1fr_14rem_auto]" onSubmit={onSubmit}>
          <Input
            placeholder="Tenant name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={submitting}
          />
          <Input
            placeholder="tenant-slug"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            disabled={submitting}
          />
          <Button type="submit" disabled={submitting}>
            {submitting ? "Creating..." : "Create"}
          </Button>
          <div className="sm:col-span-3">
            <FormError message={error} />
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function TenantEditPanel({ tenant, onChanged }: { tenant: ManagedTenant; onChanged: () => void }) {
  const [name, setName] = useState(tenant.name)
  const [slug, setSlug] = useState(tenant.slug)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await updateAdminTenant(tenant.id, { name: name.trim(), slug: slug.trim() })
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
        <CardTitle className="text-base">Edit tenant</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3 sm:grid-cols-[1fr_14rem_auto_auto]" onSubmit={onSubmit}>
          <Input value={name} onChange={(event) => setName(event.target.value)} disabled={submitting} />
          <Input value={slug} onChange={(event) => setSlug(event.target.value)} disabled={submitting} />
          <Button type="submit" disabled={submitting}>
            {submitting ? "Saving..." : "Save"}
          </Button>
          <TenantStatusButton tenant={tenant} onChanged={onChanged} />
          <div className="sm:col-span-4">
            <FormError message={error} />
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function TenantsTable({
  tenants,
  projects,
  loading = false,
  canWrite = false,
  onChanged,
}: {
  tenants: ManagedTenant[]
  projects: ManagedProject[]
  loading?: boolean
  canWrite?: boolean
  onChanged?: () => void
}) {
  const projectById = new Map(projects.map((project) => [project.id, project]))

  return (
    <AdminTableShell>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Tenant</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Default project</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <AdminLoadingRows columns={4} />
          ) : (
            tenants.map((tenant) => {
              const defaultProject = projectById.get(tenant.defaultProjectId)
              return (
                <TableRow key={tenant.id}>
                  <TableCell className="max-w-[22rem] whitespace-normal">
                    <Link className="font-medium underline-offset-4 hover:underline" to={`/admin/tenants/${tenant.id}`}>
                      {tenant.name}
                    </Link>
                    <div className="break-all text-xs text-muted-foreground">{tenant.slug}</div>
                  </TableCell>
                  <TableCell>
                    <StatusPill status={tenant.status} />
                  </TableCell>
                  <TableCell className="max-w-[20rem] whitespace-normal">
                    {defaultProject ? (
                      <Link className="text-sm underline-offset-4 hover:underline" to={`/admin/projects/${defaultProject.id}`}>
                        {defaultProject.name}
                      </Link>
                    ) : (
                      <span className="text-sm text-muted-foreground">{tenant.defaultProjectId}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {canWrite ? <TenantStatusButton tenant={tenant} onChanged={onChanged} /> : null}
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

function ProjectsForTenantTable({
  projects,
  loading = false,
}: {
  projects: ManagedProject[]
  loading?: boolean
}) {
  return (
    <AdminTableShell>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Project</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Owner tenant</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <AdminLoadingRows columns={3} />
          ) : (
            projects.map((project) => (
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
                <TableCell className="break-all text-muted-foreground">{project.ownerTenantId}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </AdminTableShell>
  )
}

function TenantStatusButton({
  tenant,
  onChanged,
}: {
  tenant: ManagedTenant
  onChanged?: () => void
}) {
  const [loading, setLoading] = useState(false)
  const action = tenant.status === "ACTIVE" ? archiveAdminTenant : restoreAdminTenant

  async function onClick() {
    setLoading(true)
    try {
      await action(tenant.id)
      onChanged?.()
    } finally {
      setLoading(false)
    }
  }

  return (
    <Button type="button" variant="outline" onClick={onClick} disabled={loading}>
      {loading ? "Updating..." : tenant.status === "ACTIVE" ? "Archive" : "Restore"}
    </Button>
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
