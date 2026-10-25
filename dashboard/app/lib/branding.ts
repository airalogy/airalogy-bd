import "server-only";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

export function siteBranding() {
  return {
    name: process.env.BD_BRAND_NAME?.trim().slice(0, 80) || "Airalogy BD",
    logo: process.env.BD_BRAND_LOGO_FILE ? "/api/branding/logo" : "/airalogy-logo.svg",
  };
}

export async function customLogo() {
  const file = process.env.BD_BRAND_LOGO_FILE;
  if (!file || !path.isAbsolute(file)) return null;
  // Only an operator-configured file is read. Request parameters never select a path.
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 12 || stat.size > 1024 * 1024) return null;
    const bytes = Buffer.alloc(1024 * 1024 + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 1024 * 1024) return null;
    const data = bytes.subarray(0, bytesRead);
    const type = data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png"
      : data[0] === 255 && data[1] === 216 && data[2] === 255 ? "image/jpeg"
      : data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP" ? "image/webp" : null;
    return type ? { data: new Uint8Array(data), type } : null;
  } finally { await handle.close(); }
}
