import "server-only";
import { AiError, type StoredSettings } from "./ai-store";
import { parseTokenUsage, type TokenUsage } from "./ai-meter";
import type { AiProvider } from "./ai-types";

export function providerUrl(provider: AiProvider, raw: string) {
  let url: URL;
  try { url = new URL(raw); } catch { throw new AiError("请填写有效的模型服务地址。"); }
  const openai = url.hostname === "api.openai.com" && url.pathname.replace(/\/$/, "") === "/v1";
  const qwen = (url.hostname === "dashscope.aliyuncs.com" || /^[a-z0-9][a-z0-9-]*\.cn-beijing\.maas\.aliyuncs\.com$/.test(url.hostname)) && url.pathname.replace(/\/$/, "") === "/compatible-mode/v1";
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash || !(provider === "openai" ? openai : provider === "qwen-cn" && qwen)) {
    throw new AiError("请选择 OpenAI 官方地址或百炼北京地域地址。");
  }
  return url.href.replace(/\/$/, "");
}

export async function completeJson(settings: StoredSettings, messages: { role: "system" | "user" | "assistant"; content: string }[], onUsage?: (usage: TokenUsage | null) => void) {
  const url = providerUrl(settings.provider, settings.baseUrl);
  const body = {
    model: settings.model, messages, stream: false, response_format: { type: "json_object" },
    // Qwen's older models accept max_tokens; OpenAI's reasoning models require max_completion_tokens.
    ...(settings.provider === "qwen-cn" ? { max_tokens: 4000, enable_thinking: false } : { max_completion_tokens: 8000, store: false }),
  };
  try {
    const response = await fetch(`${url}/chat/completions`, {
      method: "POST", headers: { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), cache: "no-store", redirect: "error", signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AiError(response.status === 401 || response.status === 403 ? "模型服务认证失败，请管理员检查密钥和模型权限。" : response.status === 429 ? "模型服务额度不足或请求过多，请稍后重试。" : "模型服务请求失败，请管理员检查模型名称和服务状态。", "unavailable");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.length;
        if (size > 256000) { await reader.cancel(); throw new Error(); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    onUsage?.(parseTokenUsage(result.usage));
    const choice = result.choices?.[0];
    if (choice?.finish_reason !== "stop" || choice.message?.refusal || typeof choice.message?.content !== "string") throw new Error();
    return JSON.parse(choice.message.content) as unknown;
  } catch (error) {
    if (error instanceof AiError) throw error;
    // Never reflect provider error bodies, prompts, keys or reasoning traces to clients/logs.
    throw new AiError("模型未返回完整有效的结果，或请求超时。资料未更改，请重试。", "unavailable");
  }
}
