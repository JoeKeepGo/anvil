import { NavLink } from "react-router-dom"
import { LayoutDashboard, Box, Image, Activity, Settings } from "lucide-react"
import { cn } from "@/lib/utils"

const navItems = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/instances", icon: Box, label: "Instances" },
  { to: "/images", icon: Image, label: "Images" },
  { to: "/operations", icon: Activity, label: "Operations" },
  { to: "/settings", icon: Settings, label: "Settings" },
]

export function Sidebar() {
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
    </aside>
  )
}
