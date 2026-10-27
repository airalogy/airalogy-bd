"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { aiRequest, initialDates } from "./lib/ai-client";
import type { DashboardData } from "./lib/types";
import type { AiReply, AiSource, AiStatus } from "./lib/ai-types";
import type { SavedResponse } from "./lib/workspace-types";
import { fieldLabels, readable } from "./RecordForms";

const extraLabels: Record<string, string> = { new_counterparty: "新建对接方", counterparty_ids: "关联对接方", primary_counterparty_id: "归档对接方", initial_event: "首条进展", body: "正文", participants: "参与人档案", location: "地点", new_contacts: "新增联系人关系", contacts: "事项联系人", kind: "对接方类型", source_certainty: "来源依据", first_contact_certainty: "首次接触日期依据" };
function Preview({ payload, data }: { payload: Record<string, unknown>; data: DashboardData }) {
  const display = (value: unknown): string => {
    if (value === null || value === "") return "未填写";
    if (Array.isArray(value)) return value.length ? value.map(display).join("、") : "未指定";
    const raw = String(value);
    return data.counterparties.find(p => p.id === raw)?.name || data.people.find(p => p.id === raw)?.name || ({ organization: "机构 / 单位", person: "个人", unknown: "未知", confirmed: "有明确依据", provisional: "暂定", normal: "普通", medium: "中", high: "高", low: "低" }[raw]) || readable(raw);
  };
  return <dl className="ai-preview">{Object.entries(payload).map(([key, value]) => <div key={key}><dt>{extraLabels[key] || fieldLabels[key] || key}</dt><dd>{value && typeof value === "object" && !Array.isArray(value) ? <Preview payload={value as Record<string, unknown>} data={data} /> : <span>{display(value)}</span>}</dd></div>)}</dl>;
}
export default function AiAssistant({ data, onSaved, onSource, initialScope = "" }: { data: DashboardData; onSaved: (result: SavedResponse) => void; onSource: (source: AiSource) => void; initialScope?: string }) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [mode, setMode] = useState<"record" | "summary">(data.access?.role === "viewer" ? "summary" : "record");
  const [scope, setScope] = useState(initialScope);
  const [dates, setDates] = useState<{ from: string; to: string } | null>(null);
  const [message, setMessage] = useState("");
  const [conversation, setConversation] = useState("");
  const [turns, setTurns] = useState<{ role: string; text: string }[]>([]);
  const [reply, setReply] = useState<AiReply | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    let cancelled = false;
    aiRequest<AiStatus>().then(value => { if (!cancelled) { setStatus(value); setDates(initialDates(data.workspace.timezone)); } }).catch(err => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [data.workspace.timezone]);
  const reset = () => { generation.current++; setConversation(""); setTurns([]); setReply(null); setError(""); setNotice(""); };
  async function send(event: React.FormEvent) {
    event.preventDefault(); if (busy || !message.trim()) return;
    setBusy(true); setError(""); setNotice(""); setReply(null);
    const stamp = generation.current, submitted = message.trim();
    try {
      const result = await aiRequest<AiReply>({ action: "chat", mode, scope, message: submitted, ...(mode === "record" && conversation ? { conversationId: conversation } : {}), ...dates });
      if (stamp !== generation.current) return;
      setConversation(result.conversationId || ""); setReply(result); setMessage("");
      setTurns(previous => mode === "record" ? [...previous, { role: "你", text: submitted }, { role: "AI", text: result.message }] : [{ role: "你", text: submitted }, { role: "AI", text: result.message }]);
    } catch (err) { if (stamp === generation.current) setError((err as Error).message); }
    finally { setBusy(false); }
  }
  async function confirm() {
    if (!reply?.draft || busy) return;
    setBusy(true); setError("");
    try {
      const result = await aiRequest<SavedResponse>({ action: "confirm", draftId: reply.draft.id, confirmed: true });
      reset(); setNotice("已保存，并留存可恢复版本。"); onSaved(result);
    } catch (err) { setReply(null); setConversation(""); setError(`${(err as Error).message} 请重新整理草稿后确认。`); }
    finally { setBusy(false); }
  }
  return <section className="panel ai-assistant" aria-labelledby="ai-title">
    <div className="section-heading page-heading"><div><div className="eyebrow">AI 助手</div><h1 id="ai-title">对话录入与进展总结</h1><p>整理实际进展，核对后保存；总结可以追溯到原始记录。</p></div></div>
    {error && <p className="admin-alert" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!status && !error && <p>正在读取 AI 状态…</p>}
    {status?.canManage && <p className="admin-help"><Link href="/admin?section=ai">前往管理中心配置 AI</Link></p>}
    {status && !status.enabled && <p className="panel-empty-state">AI 助手尚未开启。{status.canManage ? "请在管理中心配置模型服务并开启。" : "请联系管理员开启。"}</p>}
    {status?.enabled && <>
      <fieldset disabled={busy} className="ai-controls"><div className="admin-tabs" role="group" aria-label="AI 功能">{status.canWrite && <button type="button" aria-pressed={mode === "record"} onClick={() => { reset(); setMode("record"); }}>对话录入</button>}<button type="button" aria-pressed={mode === "summary"} onClick={() => { reset(); setMode("summary"); if (scope === "new") setScope(""); }}>进展总结</button></div>
      <div className="edit-form-grid"><label className="edit-field"><span>事项范围</span><select value={scope} onChange={e => { reset(); setScope(e.target.value); }}><option value="">全部可访问事项{mode === "record" ? "（从对话中识别）" : ""}</option>{mode === "record" && status.canManage && <option value="new">新建事项</option>}{data.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>{mode === "summary" && dates && <><label className="edit-field"><span>开始日期</span><input type="date" required value={dates.from} onChange={e => { reset(); setDates({ ...dates, from: e.target.value }); }} /></label><label className="edit-field"><span>结束日期</span><input type="date" required value={dates.to} onChange={e => { reset(); setDates({ ...dates, to: e.target.value }); }} /></label></>}</div></fieldset>
      <p className="admin-help">仅使用你有权查看的资料。当前对话关闭页面后不保留在界面中，未确认草稿在 30 分钟后失效。</p>
      <div className="ai-dialogue" aria-live="polite">{turns.map((turn, index) => <article key={index}><strong>{turn.role}</strong><p>{turn.text}</p></article>)}</div>
      {reply?.coverage && <p className="admin-help">{reply.coverage}</p>}
      {reply?.points?.map((point, index) => <article className="ai-summary-point" key={index}><p>{point.text}</p><div className="admin-actions">{point.sources.map(source => <button type="button" className="admin-button" key={source.id} onClick={() => onSource(source)}>{source.label}</button>)}</div></article>)}
      {reply?.draft && <section className="ai-draft"><h2>{reply.draft.title}</h2><p>以下内容尚未保存。请核对日期、事实和归属；需要调整可继续对话。</p><Preview payload={reply.draft.payload} data={data} />{reply.draft.kind === "project" && <p className="admin-help">新事项的负责人默认待确认、优先级默认中；参与人保留在正文，人员档案关系可在保存后补充。</p>}<div className="admin-actions"><button type="button" className="admin-button admin-primary" disabled={busy} onClick={() => void confirm()}>确认无误并保存</button><button type="button" className="admin-button" disabled={busy} onClick={reset}>放弃草稿</button></div></section>}
      <form onSubmit={send}><label className="edit-field"><span>{mode === "record" ? "描述实际发生的进展，或补充、修改上方草稿" : "想了解哪些进展？"}</span><textarea rows={4} required maxLength={6000} disabled={busy} value={message} onChange={e => setMessage(e.target.value)} placeholder={mode === "record" ? "例如：今天和某公司线上交流，对方希望先看介绍资料。日期、参与人和下一步有明确安排时请一并说明。" : "例如：总结所选日期内的重要进展，列出已确定的下一步。"} /></label><div className="admin-actions"><button className="admin-button admin-primary" disabled={busy || !message.trim()}>{busy ? "正在处理…" : mode === "record" ? "整理草稿" : "生成总结"}</button><button type="button" className="admin-button" disabled={busy} onClick={reset}>新建对话</button></div></form>
    </>}
  </section>;
}
