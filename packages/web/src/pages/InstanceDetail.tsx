import { useParams, useNavigate } from "react-router-dom"
import { ArrowLeft } from "lucide-react"
import { Button } from "@/components/ui/button"

export function InstanceDetail() {
  const { name } = useParams<{ name: string }>()
  const navigate = useNavigate()

  return (
    <div className="space-y-6">
      <Button variant="ghost" onClick={() => navigate("/instances")} className="gap-2">
        <ArrowLeft className="h-4 w-4" />
        Back to Instances
      </Button>
      <h1 className="text-2xl font-semibold tracking-tight">{name}</h1>
      <p className="text-sm text-muted-foreground">Detail view coming soon.</p>
    </div>
  )
}
