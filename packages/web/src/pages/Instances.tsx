import { Box } from "lucide-react"

export function Instances() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Instances</h1>
      <div className="flex flex-col items-center justify-center rounded-lg border border-border px-6 py-24 text-center">
        <Box className="mb-3 h-8 w-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Instance management will be implemented in the next step.
        </p>
      </div>
    </div>
  )
}
