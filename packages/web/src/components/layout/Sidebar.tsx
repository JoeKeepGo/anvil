import { NavLink } from "react-router-dom"
import { LayoutDashboard, Box, Image, Activity, Settings, LogOut } from "lucide-react"
import { cn } from "@/lib/utils"
import type { AuthUser } from "@/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

const navItems = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/instances", icon: Box, label: "Instances" },
  { to: "/images", icon: Image, label: "Images" },
  { to: "/operations", icon: Activity, label: "Operations" },
  { to: "/settings", icon: Settings, label: "Settings" },
]

type SidebarProps = {
  user: AuthUser | null
  onSignOut?: () => void
  signingOut?: boolean
}

export function Sidebar({ user, onSignOut, signingOut = false }: SidebarProps) {
  return (
    <aside className="fixed left-0 top-0 z-40 h-screen w-56 border-r border-border bg-sidebar">
      <div className="flex h-14 items-center border-b border-sidebar-border px-4">
        <span className="text-lg font-semibold tracking-tight">Anvil</span>
        <span className="ml-2 text-xs text-muted-foreground">Dashboard</span>
      </div>
      <nav className="space-y-1 p-2">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
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
      </nav>
      <div className="absolute bottom-0 left-0 right-0 border-t border-sidebar-border p-3">
        <div className="min-w-0 space-y-3 rounded-md bg-sidebar-accent/50 px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium text-sidebar-accent-foreground">
              {user?.name ?? "Checking session"}
            </span>
            {user ? <Badge variant="outline">{user.role}</Badge> : null}
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {user?.email ?? "Current user"}
          </p>
          {user && onSignOut ? (
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
