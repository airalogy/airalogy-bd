"use client";
import { useEffect, useState } from "react";
import type { AiUsageReport } from "./lib/ai-types";
async function fetchUsage(from: string, to: string) {
  const response = await fetch(`/api/ai?${new URLSearchParams({ action: "usage", from, to })}`, { cache: "no-store" });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || "无法读取 AI 用量。");
  return data.result as AiUsageReport;
}
const number = (value: number) => value.toLocaleString("zh-CN");
const money = (value: number) => `¥${value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
export default function AiUsage({ initialFrom, initialTo }: { initialFrom: string; initialTo: string }) {
  const [from, setFrom] = useState(initialFrom), [to, setTo] = useState(initialTo);
  const [report, setReport] = useState<AiUsageReport | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    fetchUsage(initialFrom, initialTo).then(value => { if (active) setReport(value); }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [initialFrom, initialTo]);
  async function refresh(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { setReport(await fetchUsage(from, to)); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  const total = report?.rows.reduce((all, row) => ({ requests: all.requests + row.requests, tokens: all.tokens + row.inputTokens + row.outputTokens, cost: all.cost + row.estimatedCny, unknown: all.unknown + row.unknownUsage, unpriced: all.unpriced + row.unpriced, held: all.held + row.heldTokens, heldCost: all.heldCost + row.heldCny }), { requests: 0, tokens: 0, cost: 0, unknown: 0, unpriced: 0, held: 0, heldCost: 0 });
  return <section className="ai-usage">
    <form className="usage-filters" onSubmit={refresh}><label>统计开始<input aria-label="用量统计开始日期" type="date" required value={from} onChange={e => setFrom(e.target.value)} /></label><label>统计结束<input aria-label="用量统计结束日期" type="date" required value={to} onChange={e => setTo(e.target.value)} /></label><button className="admin-button" disabled={busy}>{busy ? "查询中…" : "查询用量"}</button></form>
    {error && <p role="alert" className="admin-alert">{error}</p>}
    {report && total && <><p className="admin-help">{report.from} 至 {report.to}</p><dl className="usage-metrics"><div><dt>请求次数</dt><dd>{number(total.requests)}</dd></div><div><dt>已回传 Token</dt><dd>{number(total.tokens)}</dd></div><div><dt>估算费用</dt><dd>{money(total.cost)}</dd></div></dl>{(total.unknown > 0 || total.unpriced > 0) && <p className="admin-help">其中 {total.unknown} 次未回传用量，{total.unpriced} 次费用尚不能确定；仍占用限额的预留量为 {number(total.held)} Token / {money(total.heldCost)}。这些预留值不是实际消耗，请核对服务商账单。</p>}
      <div className="ai-usage-table"><table><caption>按日期、成员和模型统计</caption><thead><tr><th>日期</th><th>成员</th><th>模型服务 / 模型</th><th>请求</th><th>失败或中断</th><th>输入 Token</th><th>输出 Token</th><th>缓存命中</th><th>估算费用</th></tr></thead><tbody>{report.rows.map((row, i) => <tr key={i}><td>{row.day}</td><td>{row.member}</td><td>{row.provider === "qwen-cn" ? "百炼北京" : "OpenAI"}<br />{row.model}</td><td>{row.requests}{row.running ? `（${row.running} 进行中）` : ""}</td><td>{row.failures}</td><td>{number(row.inputTokens)}{row.unknownUsage > 0 && `（${row.unknownUsage} 次未知）`}</td><td>{number(row.outputTokens)}</td><td>{number(row.cachedTokens)}</td><td>{money(row.estimatedCny)}{row.unpriced > 0 && `（${row.unpriced} 次未计价）`}</td></tr>)}</tbody></table>{!report.rows.length && <p className="settings-empty">所选日期内暂无 AI 请求。</p>}</div></>}
    <details className="usage-notes"><summary>统计口径与费用说明</summary>
    <p className="admin-help">Token 数来自模型接口回传；人民币费用按调用时配置的单价估算，实际账单以服务商为准。缓存 Token 已包含在输入中，不重复计数。统计不记录对话内容。</p>
    </details>
  </section>;
}
