export type AiProvider = "openai" | "qwen-cn";
export type AiSettings = {
  enabled: boolean; provider: AiProvider; model: string; baseUrl: string;
  dailyTokenLimit: number | null; dailyBudgetCny: number | null;
  inputPriceCny: number | null; cachedInputPriceCny: number | null; outputPriceCny: number | null;
  dailyLimit: number; revision: string; keyConfigured: boolean;
};
export type AiStatus = { enabled: boolean; canManage: boolean; canWrite: boolean; settings?: AiSettings };
export type AiSource = { id: string; projectId: string; eventId?: string; label: string };
export type AiDraft = { id: string; kind: "project" | "progress"; projectId?: string; title: string; payload: Record<string, unknown>; expiresAt: number };
export type AiReply = { conversationId?: string; message: string; draft?: AiDraft; points?: { text: string; sources: AiSource[] }[]; coverage?: string };
export const aiDefaults = { enabled: false, provider: "qwen-cn" as AiProvider, model: "qwen-plus", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", dailyLimit: 100, dailyTokenLimit: 1_000_000, dailyBudgetCny: null, inputPriceCny: null, cachedInputPriceCny: null, outputPriceCny: null };

export type AiUsageRow = {
  day: string; owner: string; member: string; provider: AiProvider; model: string;
  requests: number; failures: number; running: number; inputTokens: number; outputTokens: number;
  cachedTokens: number; estimatedCny: number; unknownUsage: number; unpriced: number; heldTokens: number; heldCny: number;
};
export type AiUsageReport = { from: string; to: string; rows: AiUsageRow[] };
