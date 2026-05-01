export interface ServerInfo {
  version: string
  api_version: string
  environment: {
    server_name: string
    kernel: string
    os_name: string
  }
}

export interface Instance {
  name: string
  type: string
  status: string
  architecture: string | null
  createdAt: string | null
}

export interface InstancesResponse {
  instances: Instance[]
}

export interface Image {
  fingerprint: string
  filename: string
  size: number
  public: boolean
  created_at: string
  expires_at: string
  uploaded_at: string
  type: string
  aliases: ImageAlias[]
  properties: Record<string, string>
}

export interface ImageAlias {
  name: string
  description: string
}

export interface Operation {
  id: string
  class: string
  description: string
  created_at: string
  updated_at: string
  status: string
  status_code: string
  err: string
  may_cancel: boolean
  metadata: Record<string, unknown>
}

export interface ApiError {
  code: string
  message: string
  details: Record<string, unknown>
}
