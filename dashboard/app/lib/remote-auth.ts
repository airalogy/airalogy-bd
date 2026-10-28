import { serverMode, trustedRequest, denied } from "./server-auth";
export function remoteCredential(request: Request): string | Response {
  // Cookies cannot authenticate MCP, and bearer credentials cannot authenticate the web API.
  if (!serverMode()) return denied("远程接入仅在团队模式中提供。", 404);
  if (!trustedRequest(request)) return denied("请求来源未获授权。", 403);
  const authorization = request.headers.get("authorization") || "";
  if (!/^Bearer bdr_[A-Za-z0-9_-]{43}$/.test(authorization)) {
    const response = denied("请提供有效的个人远程凭据。", 401);
    response.headers.set("WWW-Authenticate", 'Bearer realm="Airalogy BD"');
    return response;
  }
  return authorization.slice(7);
}
