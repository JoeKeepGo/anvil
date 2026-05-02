import {
  CheckCircle2,
  CircleSlash,
  LockKeyhole,
  Settings as SettingsIcon,
  ServerCog,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export function Settings() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Read-only MVP status for the current single-host deployment.
        </p>
      </div>

      <Card>
        <CardHeader className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="flex min-w-0 items-center gap-2 text-lg">
              <SettingsIcon className="h-5 w-5 shrink-0" />
              <span className="break-words">Configuration model</span>
            </CardTitle>
            <Badge variant="outline">Read-only MVP</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            The host connection is environment/config driven. This page reports scope and
            status only; it does not provide editable browser settings.
          </p>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <StatusItem
            icon={ServerCog}
            title="Host connection"
            description="Selected by server-side environment configuration for this deployment."
          />
          <StatusItem
            icon={LockKeyhole}
            title="Credential boundary"
            description="Host credentials remain outside the browser-facing settings surface."
          />
          <StatusItem
            icon={CircleSlash}
            title="No persistence action"
            description="There are no editable fields or browser controls that change deployment settings."
          />
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CheckCircle2 className="h-4 w-4 text-green-400" />
              Available in the MVP
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3 text-sm text-muted-foreground">
              <li>Read-only host visibility through the Anvil API.</li>
              <li>Instance, image, and operation views from the configured host.</li>
              <li>Clear status copy without editable configuration controls.</li>
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CircleSlash className="h-4 w-4 text-muted-foreground" />
              Post-MVP settings
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3 text-sm text-muted-foreground">
              <li>Endpoint inventory and CRUD.</li>
              <li>Auth, SSO, and RBAC administration.</li>
              <li>Write operations for instances, images, and operations.</li>
            </ul>
          </CardContent>
        </Card>
      </div>

      <div className="rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground">
        This settings page is intentionally non-actionable in M6. Operational configuration
        changes remain outside the read-only MVP panel.
      </div>
    </div>
  )
}

type StatusItemProps = {
  icon: typeof ServerCog
  title: string
  description: string
}

function StatusItem({ icon: Icon, title, description }: StatusItemProps) {
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="break-words">{title}</span>
      </div>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  )
}
