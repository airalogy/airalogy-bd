"use client";
import { useEffect, useState } from "react";
import type { AiSettings, AiStatus } from "./lib/ai-types";
import { aiRequest } from "./lib/ai-client";

function Settings({ settings, onSaved }: { settings: AiSettings; onSaved: (status: AiStatus) => void }) {
  const [value, setValue] = useState(settings);
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { onSaved(await aiRequest<AiStatus>({ action: "configure", ...value, apiKey: key, clearKey })); setKey(""); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return <form className="ai-settings" onSubmit={save}>
    <p className="admin-help">开启后，成员发起请求时会将输入文字和本次所需的授权事项资料发送到所选模型服务。系统不自动读取附件原文、电话或微信等联系方式。</p>
    <div className="edit-form-grid">
      <label className="edit-field"><span>模型服务</span><select value={value.provider} onChange={e => { const provider = e.target.value as AiSettings["provider"]; setValue({ ...value, provider, baseUrl: provider === "openai" ? "https://api.openai.com/v1" : "https://dashscope.aliyuncs.com/compatible-mode/v1", model: provider === "openai" ? "" : "qwen-plus", inputPriceCny: null, cachedInputPriceCny: null, outputPriceCny: null, dailyBudgetCny: null, keyConfigured: false, enabled: false }); setKey(""); }}><option value="qwen-cn">Qwen · 阿里云百炼（北京）</option><option value="openai">OpenAI</option></select></label>
      <label className="edit-field"><span>模型名称</span><input required value={value.model} maxLength={120} onChange={e => setValue({ ...value, model: e.target.value, inputPriceCny: null, cachedInputPriceCny: null, outputPriceCny: null, dailyBudgetCny: null })} placeholder="填写服务控制台中已开通的文本模型" /></label>
      <label className="edit-field edit-field-wide"><span>服务地址</span><input required type="url" value={value.baseUrl} onChange={e => setValue({ ...value, baseUrl: e.target.value })} /><small>可使用百炼北京地域的通用地址或业务空间专属地址。</small></label>
      <label className="edit-field"><span>API 密钥</span><input type="password" autoComplete="new-password" value={key} maxLength={500} onChange={e => { setKey(e.target.value); setClearKey(false); }} placeholder={value.keyConfigured ? "已保存，留空保持现有密钥" : "填写对应服务的 API 密钥"} /></label>
      <label className="edit-field"><span>公司每日请求上限</span><input type="number" required min={1} max={1000} value={value.dailyLimit} onChange={e => setValue({ ...value, dailyLimit: Number(e.target.value) })} /><small>按工作区时区计数；失败请求也计入，另受模型服务自身额度限制。</small></label>
      {([{ key: "dailyTokenLimit", label: "公司每日 Token 上限", step: "1", max: 1000000000, hint: "留空不设此项限制，默认 100 万；调用前预留额度。" }, { key: "dailyBudgetCny", label: "公司每日费用上限（人民币元）", step: "0.01", max: 1000000, hint: "选填，需要先填写输入与输出单价。" }, { key: "inputPriceCny", label: "输入单价（元 / 百万 Token）", step: "0.000001", max: 1000000, hint: "按账户实际单价填写；未填写时费用标为未计价。" }, { key: "outputPriceCny", label: "输出单价（元 / 百万 Token）", step: "0.000001", max: 1000000, hint: "美元报价需换算成人民币后填写。" }, { key: "cachedInputPriceCny", label: "缓存输入单价（元 / 百万 Token）", step: "0.000001", max: 1000000, hint: "选填；留空时按普通输入单价估算。" }] as const).map(field => <label className="edit-field" key={field.key}><span>{field.label}</span><input type="number" min={0} max={field.max} step={field.step} value={value[field.key] ?? ""} onChange={e => setValue({ ...value, [field.key]: e.target.value === "" ? null : Number(e.target.value) })} /><small>{field.hint}</small></label>)}
    </div>
    <div className="admin-actions"><label><input type="checkbox" checked={value.enabled} onChange={e => setValue({ ...value, enabled: e.target.checked })} /> 开启 AI 助手</label><label><input type="checkbox" checked={clearKey} onChange={e => { setClearKey(e.target.checked); if (e.target.checked) { setKey(""); setValue({ ...value, enabled: false }); } }} /> 清除已保存密钥</label><button className="admin-button admin-primary" disabled={busy}>{busy ? "保存中…" : "保存 AI 设置"}</button></div>
    {error && <p role="alert" className="admin-alert">{error}</p>}
  </form>;
}
export default function AiSettingsPanel() {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    aiRequest<AiStatus>(undefined, "settings").then(value => { if (active) setStatus(value); }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, []);
  return <section className="panel admin-center-panel"><h2>AI 设置</h2>
    <p>仅管理员可开启 AI、更换密钥、配置模型和使用限额。已保存的密钥不会显示，可替换或清除。</p>
    {error && <p className="admin-alert" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!status && !error && <p>正在读取 AI 设置…</p>}
    {status?.canManage && status.settings && <><p>当前状态：{status.enabled ? "已开启" : "未开启"}</p><Settings key={status.settings.revision} settings={status.settings} onSaved={value => { setStatus(value); setNotice("AI 设置已保存。"); }} /></>}
  </section>;
}
