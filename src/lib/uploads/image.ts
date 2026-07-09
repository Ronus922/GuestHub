// Shared image-upload validation (extracted so room photos AND the business logo
// use one allow-list + one magic-byte check). Raster only — SVG is deliberately
// excluded: the app has no SVG sanitizer, and image/svg+xml executes script when
// served, so a stored SVG would be an XSS surface.
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15MiB

// MIME → file extension allow-list. A type absent here is rejected outright.
export const IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

// The client-declared MIME is not trusted on its own — verify the leading bytes.
export function isRealImage(buf: Buffer, mime: string): boolean {
  if (buf.length < 12) return false;
  switch (mime) {
    case "image/jpeg":
      return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case "image/png":
      return buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/webp":
      return buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP";
    default:
      return false;
  }
}
