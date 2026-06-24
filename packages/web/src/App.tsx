import { BrowserRouter, Routes, Route } from "react-router-dom"
import { Layout } from "@/components/layout/Layout"
import { Dashboard } from "@/pages/Dashboard"
import { Instances } from "@/pages/Instances"
import { InstanceDetail } from "@/pages/InstanceDetail"
import { Images } from "@/pages/Images"
import { Operations } from "@/pages/Operations"
import { Settings } from "@/pages/Settings"
import { Login } from "@/pages/Login"
import { AdminAudit } from "@/pages/admin/AdminAudit"
import { AdminBootstrap } from "@/pages/admin/AdminBootstrap"
import { AdminEndpoints } from "@/pages/admin/AdminEndpoints"
import { AdminHosts } from "@/pages/admin/AdminHosts"
import { AdminNetwork } from "@/pages/admin/AdminNetwork"
import { AdminOverview } from "@/pages/admin/AdminOverview"
import { AdminPermissions } from "@/pages/admin/AdminPermissions"
import { AdminProjectDetail, AdminProjects } from "@/pages/admin/AdminProjects"
import { AdminRoute } from "@/pages/admin/AdminRoute"
import { AdminTeams } from "@/pages/admin/AdminTeams"
import { AdminTenantDetail, AdminTenants } from "@/pages/admin/AdminTenants"
import { AdminUsers } from "@/pages/admin/AdminUsers"
import { AdminVmCreate } from "@/pages/admin/AdminVmCreate"
import { AdminVmDetail } from "@/pages/admin/AdminVmDetail"
import { AdminVms } from "@/pages/admin/AdminVms"

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/admin/bootstrap" element={<AdminBootstrap />} />
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="/instances" element={<Instances />} />
          <Route path="/instances/:name" element={<InstanceDetail />} />
          <Route path="/images" element={<Images />} />
          <Route path="/operations" element={<Operations />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/admin" element={<AdminRoute />}>
            <Route index element={<AdminOverview />} />
            <Route path="users" element={<AdminUsers />} />
            <Route path="teams" element={<AdminTeams />} />
            <Route path="endpoints" element={<AdminEndpoints />} />
            <Route path="hosts" element={<AdminHosts />} />
            <Route path="network" element={<AdminNetwork />} />
            <Route path="tenants" element={<AdminTenants />} />
            <Route path="tenants/:tenantId" element={<AdminTenantDetail />} />
            <Route path="projects" element={<AdminProjects />} />
            <Route path="projects/:projectId" element={<AdminProjectDetail />} />
            <Route path="permissions" element={<AdminPermissions />} />
            <Route path="audit" element={<AdminAudit />} />
            <Route path="vms" element={<AdminVms />} />
            <Route path="vms/create" element={<AdminVmCreate />} />
            <Route path="vms/:vmId" element={<AdminVmDetail />} />
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
