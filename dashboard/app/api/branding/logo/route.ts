import { customLogo } from "../../../lib/branding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" };
  try {
    const logo = await customLogo();
    if (logo) return new Response(logo.data, { headers: { ...headers, "Content-Type": logo.type } });
  } catch { /* Missing or invalid custom branding must not expose filesystem details. */ }
  return new Response(null, { status: 404, headers });
}
