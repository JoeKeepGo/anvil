import { NavLink } from "react-router-dom"
import {
  Activity,
  Box,
  ClipboardList,
  Image,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Settings,
  ShieldCheck,
  Users,
  UsersRound,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { canUseAdminConsole } from "@/lib/adminAccess"
import type { AuthSession } from "@/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

const navItems = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/instances", icon: Box, label: "Instances" },
  { to: "/images", icon: Image, label: "Images" },
  { to: "/operations", icon: Activity, label: "Operations" },
  { to: "/settings", icon: Settings, label: "Settings" },
]

const adminNavItems = [
  { to: "/admin", icon: ShieldCheck, label: "Admin" },
  { to: "/admin/users", icon: Users, label: "Users" },
  { to: "/admin/teams", icon: UsersRound, label: "Teams" },
  { to: "/admin/endpoints", icon: KeyRound, label: "Endpoints" },
  { to: "/admin/permissions", icon: ClipboardList, label: "Permissions" },
  { to: "/admin/audit", icon: Activity, label: "Audit" },
]

type SidebarProps = {
  session: AuthSession | null
  onSignOut?: () => void
  signingOut?: boolean
}

export function Sidebar({ session, onSignOut, signingOut = false }: SidebarProps) {
  const showAdmin = session ? canUseAdminConsole(session.access) : false

  return (
    <aside className="border-b border-sidebar-border bg-sidebar lg:fixed lg:left-0 lg:top-0 lg:z-40 lg:h-screen lg:w-56 lg:border-b-0 lg:border-r">
      <div className="flex h-14 items-center border-b border-sidebar-border px-4">
        <span className="text-lg font-semibold tracking-tight">Anvil</span>
        <span className="ml-2 text-xs text-muted-foreground">Control</span>
      </div>
      <nav className="flex gap-1 overflow-x-auto p-2 lg:flex-col lg:overflow-visible">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) =>
              cn(
                "flex shrink-0 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground"
              )
            }
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </NavLink>
        ))}
        {showAdmin ? (
          <div className="contents lg:mt-2 lg:flex lg:flex-col lg:gap-1 lg:border-t lg:border-sidebar-border lg:pt-2">
            {adminNavItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/admin"}
                className={({ isActive }) =>
                  cn(
                    "flex shrink-0 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    isActive
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground"
                  )
                }
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </NavLink>
            ))}
          </div>
        ) : null}
      </nav>
      <div className="border-t border-sidebar-border p-3 lg:absolute lg:bottom-0 lg:left-0 lg:right-0">
        <div className="flex min-w-0 flex-col gap-3 rounded-md bg-sidebar-accent/50 px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium text-sidebar-accent-foreground">
              {session?.user.name ?? "Checking session"}
            </span>
            {session ? <Badge variant="outline">{session.user.globalRole}</Badge> : null}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {session?.user.email ?? "Current user"}
          </p>
          {session && onSignOut ? (
            <Button
              className="h-8 w-full justify-start gap-2 px-2 text-xs"
              disabled={signingOut}
              onClick={onSignOut}
              type="button"
              variant="outline"
            >
              <LogOut className="h-3.5 w-3.5" />
              {signingOut ? "Signing out..." : "Sign out"}
            </Button>
          ) : null}
        </div>
      </div>
    </aside>
  )
}
