import { Image } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { ErrorAlert } from "@/components/ErrorAlert"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useApi } from "@/hooks/useApi"
import { fetchImages } from "@/lib/api"
import type { ImageSummary } from "@/types"

interface ImagesViewState {
  data: ImageSummary[] | null
  loading: boolean
  error: string | null
  refetch: () => void
}

export function Images() {
  const images = useApi(fetchImages)

  return <ImagesView images={images} />
}

export function ImagesView({ images }: { images: ImagesViewState }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Images</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Read-only image inventory from the configured host.
        </p>
      </div>

      {images.loading ? (
        <ImagesSkeleton />
      ) : images.error ? (
        <ErrorAlert message={`Failed to fetch images: ${images.error}`} onRetry={images.refetch} />
      ) : images.data && images.data.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-border px-6 py-24 text-center">
          <Image className="mb-3 h-8 w-8 text-muted-foreground" />
          <p className="text-sm font-medium">No images found</p>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            The configured host returned an empty image list.
          </p>
        </div>
      ) : images.data ? (
        <ImagesTable images={images.data} />
      ) : null}
    </div>
  )
}

function ImagesTable({ images }: { images: ImageSummary[] }) {
  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Fingerprint</TableHead>
            <TableHead>Description</TableHead>
            <TableHead>Aliases</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Architecture</TableHead>
            <TableHead>Size</TableHead>
            <TableHead>Flags</TableHead>
            <TableHead>Created</TableHead>
            <TableHead>Expires</TableHead>
            <TableHead>Last used</TableHead>
            <TableHead>Uploaded</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {images.map((image) => (
            <TableRow key={image.fingerprint}>
              <TableCell className="max-w-[18rem] whitespace-normal font-mono text-xs">
                <span className="block break-all">{image.fingerprint}</span>
              </TableCell>
              <TableCell className="max-w-[18rem] whitespace-normal">
                <span className="block break-words">{image.description || "None"}</span>
              </TableCell>
              <TableCell>
                {image.aliases.length > 0 ? (
                  <div className="flex max-w-[14rem] flex-wrap gap-1">
                    {image.aliases.map((alias) => (
                      <Badge key={alias.name} variant="outline">
                        {alias.name}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <span className="text-muted-foreground">None</span>
                )}
              </TableCell>
              <TableCell>{image.type}</TableCell>
              <TableCell className="text-muted-foreground">
                {image.architecture ?? "Unknown"}
              </TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">
                {formatBytes(image.sizeBytes)}
              </TableCell>
              <TableCell>
                <ImageFlags image={image} />
              </TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">
                {formatTimestamp(image.createdAt)}
              </TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">
                {formatTimestamp(image.expiresAt)}
              </TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">
                {formatTimestamp(image.lastUsedAt)}
              </TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">
                {formatTimestamp(image.uploadedAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function ImageFlags({ image }: { image: ImageSummary }) {
  const flags = [
    image.cached ? "Cached" : null,
    image.public ? "Public" : "Private",
    image.autoUpdate ? "Auto update" : null,
  ].filter((flag): flag is string => Boolean(flag))

  return (
    <div className="flex max-w-[12rem] flex-wrap gap-1">
      {flags.map((flag) => (
        <Badge key={flag} variant="outline">
          {flag}
        </Badge>
      ))}
    </div>
  )
}

function ImagesSkeleton() {
  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Fingerprint</TableHead>
            <TableHead>Description</TableHead>
            <TableHead>Aliases</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Architecture</TableHead>
            <TableHead>Size</TableHead>
            <TableHead>Flags</TableHead>
            <TableHead>Created</TableHead>
            <TableHead>Expires</TableHead>
            <TableHead>Last used</TableHead>
            <TableHead>Uploaded</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 3 }).map((_, index) => (
            <TableRow key={index}>
              {Array.from({ length: 11 }).map((__, cellIndex) => (
                <TableCell key={cellIndex}>
                  <Skeleton className="h-4 w-24" />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B"
  }

  const units = ["B", "KiB", "MiB", "GiB", "TiB"]
  let value = bytes
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

function formatTimestamp(value: string | null): string {
  return value ?? "Unknown"
}
