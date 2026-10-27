import { customLogo } from "./lib/branding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function Icon() {
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" };
  try {
    const logo = await customLogo();
    if (logo) return new Response(logo.data, { headers: { ...headers, "Content-Type": logo.type } });
  } catch { /* Use the bundled icon when custom branding is unavailable. */ }
  return new Response(null, { status: 307, headers: { ...headers, Location: "/airalogy-logo.svg" } });
}
