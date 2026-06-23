import { Link, useOutletContext } from "react-router-dom"
import {
  ClipboardList,
  KeyRound,
  Network,
  PanelsTopLeft,
  Server,
  ShieldCheck,
  Users,
  UsersRound,
  Waypoints,
} from "lucide-react"
import type { AppShellContext } from "@/components/layout/Layout"
import { hasAnyGlobalAction, hasAnyTeamAction } from "@/lib/adminAccess"
import { AdminPageHeader } from "./adminPageUtils"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

const sections = [
  {
    to: "/admin/users",
    title: "Users",
    detail: "Create users, manage status, and reset passwords.",
    icon: Users,
    enabled: (context: AppShellContext) =>
      hasAnyGlobalAction(context.session.access, ["users:read", "users:write"]),
  },
  {
    to: "/admin/teams",
    title: "Teams",
    detail: "Review teams and manage memberships.",
    icon: UsersRound,
    enabled: (context: AppShellContext) =>
      hasAnyGlobalAction(context.session.access, ["teams:read", "teams:write"]) ||
      hasAnyTeamAction(context.session.access, "members:read"),
  },
  {
    to: "/admin/endpoints",
    title: "Endpoints",
    detail: "Manage agent endpoints without exposing tokens.",
    icon: KeyRound,
    enabled: (context: AppShellContext) =>
      hasAnyGlobalAction(context.session.access, ["endpoints:read", "endpoints:write"]) ||
      hasAnyTeamAction(context.session.access, "endpoints:read"),
  },
  {
    to: "/admin/hosts",
    title: "Hosts",
    detail: "Review persisted host state and trigger safe sync actions.",
    icon: Server,
    enabled: (context: AppShellContext) =>
      hasAnyGlobalAction(context.session.access, ["hosts:read"]) ||
      hasAnyTeamAction(context.session.access, "hosts:read"),
  },
  {
    to: "/admin/network",
    title: "Network",
    detail: "Review managed WireGuard fabrics and run safe sync, dry-run, and apply actions.",
    icon: Waypoints,
    enabled: (context: AppShellContext) =>
      hasAnyGlobalAction(context.session.access, ["network:read"]),
  },
  {
    to: "/admin/tenants",
    title: "Tenants",
    detail: "Manage customer boundaries and default projects.",
    icon: Network,
    enabled: (context: AppShellContext) =>
      hasAnyGlobalAction(context.session.access, ["tenants:read", "tenants:write"]),
  },
  {
    to: "/admin/projects",
    title: "Projects",
    detail: "Manage participation, quota policy, allocations, and endpoint bindings.",
    icon: PanelsTopLeft,
    enabled: (context: AppShellContext) =>
      hasAnyGlobalAction(context.session.access, ["projects:read", "projects:write"]),
  },
  {
    to: "/admin/permissions",
    title: "Permissions",
    detail: "Inspect the backend permission matrix.",
    icon: ShieldCheck,
    enabled: () => true,
  },
  {
    to: "/admin/audit",
    title: "Audit",
    detail: "Review management activity and redacted metadata.",
    icon: ClipboardList,
    enabled: (context: AppShellContext) =>
      hasAnyGlobalAction(context.session.access, ["audit:read"]) ||
      hasAnyTeamAction(context.session.access, "audit:read"),
  },
]

export function AdminOverview() {
  const context = useOutletContext<AppShellContext>()
  const visibleSections = sections.filter((section) => section.enabled(context))

  return (
    <div className="flex flex-col gap-6">
      <AdminPageHeader
        title="Admin"
        description="Management surface for users, teams, endpoints, tenants, projects, permissions, and audit history."
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {visibleSections.map((section) => (
          <Link key={section.to} to={section.to}>
            <Card className="h-full transition-colors hover:bg-muted/40">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <section.icon className="h-4 w-4 text-muted-foreground" />
                  {section.title}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">{section.detail}</CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  )
}
