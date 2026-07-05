import path from "node:path";

// Durable room-image storage (D49 closure audit). Files live OUTSIDE the app
// checkout/build tree so they survive deploys, fresh checkouts, rebuilds,
// rollbacks and restarts — and are shared by every checkout on the host
// (dev + production serve the same store). `next start` snapshots public/ at
// boot, so runtime uploads under public/ 404 until the next restart — that is
// why serving goes through app/uploads/rooms/[roomId]/[name]/route.ts instead
// of the public dir. URL shape (/uploads/rooms/<roomId>/<file>) is unchanged,
// so room_images.url rows stay valid across releases.
export const UPLOADS_DIR = process.env.UPLOADS_DIR ?? "/var/www/guesthub-uploads";

export const roomUploadsDir = (roomId: string) => path.join(UPLOADS_DIR, "rooms", roomId);
export const roomUploadPath = (roomId: string, name: string) => path.join(roomUploadsDir(roomId), name);

export const ROOM_ID_RE = /^[0-9a-f-]{36}$/i;
export const IMAGE_NAME_RE = /^[0-9a-f-]{36}\.(jpg|png|webp)$/i;

export const IMAGE_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};
