import path from "node:path";
import { UPLOADS_DIR } from "@/lib/rooms/uploads";

// Business logo storage. Reuses the same durable, outside-the-build-tree store as
// room images (UPLOADS_DIR) — logos are a tenant-level brand asset, namespaced by
// tenantId. Served via app/uploads/logos/[tenantId]/[name]/route.ts (public/ can't
// serve runtime uploads). No parallel storage mechanism.
export const logoUploadsDir = (tenantId: string) => path.join(UPLOADS_DIR, "logos", tenantId);
export const logoUploadPath = (tenantId: string, name: string) => path.join(logoUploadsDir(tenantId), name);

export const TENANT_ID_RE = /^[0-9a-f-]{36}$/i;
export const LOGO_NAME_RE = /^[0-9a-f-]{36}\.(jpg|png|webp)$/i;

// /uploads/logos/<tenantId>/<name> — the stable served URL stored in
// tenants.settings.business_profile.logo.
export const logoUrl = (tenantId: string, name: string) => `/uploads/logos/${tenantId}/${name}`;
