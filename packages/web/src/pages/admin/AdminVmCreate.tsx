import { useState } from "react"
import { Link, useNavigate, useOutletContext } from "react-router-dom"
import { ArrowLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { AppShellContext } from "@/components/layout/Layout"
import { useApi } from "@/hooks/useApi"
import {
  createAdminVm,
  fetchAdminEndpoints,
  fetchAdminProjects,
  fetchAdminProjectNetworkPools,
  fetchAdminTenants,
} from "@/lib/api"
import type { VmAddressFamily } from "@/types"
import { ApiRequestError } from "@/lib/api"
import { canWriteVms } from "./AdminVms.access"
import {
  AdminForbiddenState,
  AdminPageHeader,
  FormError,
  formatError,
} from "./adminPageUtils"

export function AdminVmCreate() {
  const { session } = useOutletContext<AppShellContext>()
  const canWrite = canWriteVms(session.access)
  const navigate = useNavigate()

  // Fetch reference data for the form
  const tenantsApi = useApi(() => fetchAdminTenants(), { enabled: canWrite })
  const projectsApi = useApi(() => fetchAdminProjects(), { enabled: canWrite })
  const endpointsApi = useApi(() => fetchAdminEndpoints(), { enabled: canWrite })
  const poolsApi = useApi(() => fetchAdminProjectNetworkPools(), { enabled: canWrite })

  // Form state
  const [name, setName] = useState("")
  const [tenantId, setTenantId] = useState("")
  const [projectId, setProjectId] = useState("")
  const [endpointId, setEndpointId] = useState("")
  const [networkPoolId, setNetworkPoolId] = useState("")
  const [imageReference, setImageReference] = useState("")
  const [cpuCount, setCpuCount] = useState("1")
  const [memoryBytes, setMemoryBytes] = useState("268435456")
  const [rootDiskBytes, setRootDiskBytes] = useState("5368709120")
  const [addressFamily, setAddressFamily] = useState<VmAddressFamily>("IPV4")

  // Submission state
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [quotaDenied, setQuotaDenied] = useState(false)
  const [networkUnavailable, setNetworkUnavailable] = useState(false)

  if (!canWrite) {
    return (
      <AdminForbiddenState
        title="VM creation unavailable"
        description="Your current capability summary does not include VM lifecycle write access."
      />
    )
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitError(null)
    setQuotaDenied(false)
    setNetworkUnavailable(false)

    if (!name.trim() || !projectId || !tenantId || !endpointId || !imageReference.trim()) {
      setSubmitError("Please fill in all required fields.")
      return
    }

    const cpu = Number(cpuCount)
    const mem = Number(memoryBytes)
    const disk = Number(rootDiskBytes)

    if (!Number.isFinite(cpu) || cpu < 1) {
      setSubmitError("CPU count must be at least 1.")
      return
    }
    if (!Number.isFinite(mem) || mem < 1) {
      setSubmitError("Memory must be at least 1 byte.")
      return
    }
    if (!Number.isFinite(disk) || disk < 1) {
      setSubmitError("Root disk must be at least 1 byte.")
      return
    }

    setSubmitting(true)
    try {
      await createAdminVm({
        name: name.trim(),
        endpointId,
        projectId,
        tenantId,
        networkPoolId: networkPoolId || null,
        imageReference: imageReference.trim(),
        cpuCount: cpu,
        memoryBytes: mem,
        rootDiskBytes: disk,
        addressFamily,
      })
      navigate("/admin/vms")
    } catch (error) {
      if (error instanceof ApiRequestError) {
        if (error.code === "VM_QUOTA_DENIED") {
          setQuotaDenied(true)
          setSubmitError(
            "Quota limit reached: the project or tenant does not have enough capacity for this VM."
          )
          return
        }
        if (error.code === "VM_NETWORK_UNAVAILABLE") {
          setNetworkUnavailable(true)
          setSubmitError(
            "Network unavailable: the selected network pool is not ready for allocation."
          )
          return
        }
      }
      setSubmitError(formatError(error))
    } finally {
      setSubmitting(false)
    }
  }

  const tenants = tenantsApi.data ?? []
  const projects = projectsApi.data ?? []
  const endpoints = endpointsApi.data ?? []
  const pools = poolsApi.data ?? []

  return (
    <div className="flex flex-col gap-6">
      <AdminPageHeader
        title="Create VM Instance"
        description="Provision a new tenant-scoped VM instance with resource limits and network allocation."
        actions={
          <Button type="button" variant="outline" asChild>
            <Link to="/admin/vms">
              <ArrowLeft className="mr-1 h-4 w-4" />
              Back to VMs
            </Link>
          </Button>
        }
      />

      {quotaDenied ? (
        <div className="rounded-md border border-orange-500/30 bg-orange-500/10 px-3 py-2 text-sm text-orange-600">
          Quota limit reached. The selected project or tenant does not have enough capacity.
          Review project quotas or contact an administrator.
        </div>
      ) : null}

      {networkUnavailable ? (
        <div className="rounded-md border border-orange-500/30 bg-orange-500/10 px-3 py-2 text-sm text-orange-600">
          Network pool is not available for allocation. Select a different pool or verify the
          network fabric is active.
        </div>
      ) : null}

      {submitError && !quotaDenied && !networkUnavailable ? (
        <FormError message={submitError} />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>VM Configuration</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            {/* Name */}
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium" htmlFor="vm-name">
                Name <span className="text-destructive">*</span>
              </label>
              <Input
                id="vm-name"
                placeholder="my-vm-instance"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={submitting}
                required
              />
            </div>

            {/* Tenant */}
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium" htmlFor="vm-tenant">
                Tenant <span className="text-destructive">*</span>
              </label>
              {tenantsApi.loading ? (
                <div className="text-sm text-muted-foreground">Loading tenants...</div>
              ) : (
                <Select value={tenantId} onValueChange={setTenantId} disabled={submitting}>
                  <SelectTrigger id="vm-tenant">
                    <SelectValue placeholder="Select a tenant" />
                  </SelectTrigger>
                  <SelectContent>
                    {tenants.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name} ({t.slug})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {/* Project */}
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium" htmlFor="vm-project">
                Project <span className="text-destructive">*</span>
              </label>
              {projectsApi.loading ? (
                <div className="text-sm text-muted-foreground">Loading projects...</div>
              ) : (
                <Select value={projectId} onValueChange={setProjectId} disabled={submitting}>
                  <SelectTrigger id="vm-project">
                    <SelectValue placeholder="Select a project" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name} ({p.slug})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {/* Endpoint */}
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium" htmlFor="vm-endpoint">
                Endpoint <span className="text-destructive">*</span>
              </label>
              {endpointsApi.loading ? (
                <div className="text-sm text-muted-foreground">Loading endpoints...</div>
              ) : (
                <Select value={endpointId} onValueChange={setEndpointId} disabled={submitting}>
                  <SelectTrigger id="vm-endpoint">
                    <SelectValue placeholder="Select an endpoint" />
                  </SelectTrigger>
                  <SelectContent>
                    {endpoints.map((e) => (
                      <SelectItem key={e.id} value={e.id}>
                        {e.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {/* Network pool */}
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium" htmlFor="vm-pool">
                Network pool
              </label>
              {poolsApi.loading ? (
                <div className="text-sm text-muted-foreground">Loading pools...</div>
              ) : (
                <Select
                  value={networkPoolId}
                  onValueChange={setNetworkPoolId}
                  disabled={submitting}
                >
                  <SelectTrigger id="vm-pool">
                    <SelectValue placeholder="No pool (optional)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">No pool</SelectItem>
                    {pools.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.ipv4Cidr ?? p.ipv6Cidr ?? p.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <p className="text-xs text-muted-foreground">
                Optional network pool for address allocation.
              </p>
            </div>

            {/* Address family */}
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium" htmlFor="vm-address-family">
                Address family
              </label>
              <Select value={addressFamily} onValueChange={(v: string) => setAddressFamily(v as VmAddressFamily)} disabled={submitting}>
                <SelectTrigger id="vm-address-family">
                  <SelectValue placeholder="IPV4" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="IPV4">IPv4</SelectItem>
                  <SelectItem value="IPV6">IPv6</SelectItem>
                  <SelectItem value="DUAL">Dual-stack</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Image reference */}
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium" htmlFor="vm-image">
                Image reference <span className="text-destructive">*</span>
              </label>
              <Input
                id="vm-image"
                placeholder="e.g. ubuntu/24.04 or a fingerprint"
                value={imageReference}
                onChange={(e) => setImageReference(e.target.value)}
                disabled={submitting}
                required
              />
            </div>

            {/* CPU */}
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium" htmlFor="vm-cpu">
                vCPU count
              </label>
              <Input
                id="vm-cpu"
                type="number"
                min={1}
                step={1}
                value={cpuCount}
                onChange={(e) => setCpuCount(e.target.value)}
                disabled={submitting}
              />
            </div>

            {/* Memory */}
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium" htmlFor="vm-memory">
                Memory (bytes)
              </label>
              <Input
                id="vm-memory"
                type="number"
                min={1}
                step={1048576}
                value={memoryBytes}
                onChange={(e) => setMemoryBytes(e.target.value)}
                disabled={submitting}
              />
              <p className="text-xs text-muted-foreground">
                {formatBytes(Number(memoryBytes))}
              </p>
            </div>

            {/* Root disk */}
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium" htmlFor="vm-disk">
                Root disk (bytes)
              </label>
              <Input
                id="vm-disk"
                type="number"
                min={1}
                step={1048576}
                value={rootDiskBytes}
                onChange={(e) => setRootDiskBytes(e.target.value)}
                disabled={submitting}
              />
              <p className="text-xs text-muted-foreground">
                {formatBytes(Number(rootDiskBytes))}
              </p>
            </div>

            <div className="flex flex-wrap gap-3 pt-2">
              <Button type="submit" disabled={submitting}>
                {submitting ? "Creating VM..." : "Create VM"}
              </Button>
              <Button type="button" variant="outline" asChild>
                <Link to="/admin/vms">Cancel</Link>
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(0)} MB`
  return `${bytes} B`
}