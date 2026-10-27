"use client";
import {useEffect,useState} from "react";
import type {AiSettings,AiStatus} from "./lib/ai-types";
import {aiRequest} from "./lib/ai-client";
import {SettingsPanelHeader,SettingsStatus} from "./SettingsUI";

const limits=[{key:"dailyTokenLimit",label:"每日 Token 上限",step:"1",max:1000000000,hint:"留空不设此项限制，默认 100 万；调用前预留额度。"},{key:"dailyBudgetCny",label:"每日费用上限（人民币元）",step:"0.01",max:1000000,hint:"选填，需先填写下方的输入与输出单价。"}] as const;
const prices=[{key:"inputPriceCny",label:"输入单价",hint:"未填写时，费用标为未计价。"},{key:"outputPriceCny",label:"输出单价",hint:"美元报价需先换算成人民币。"},{key:"cachedInputPriceCny",label:"缓存输入单价",hint:"选填；留空时按普通输入单价估算。"}] as const;
function Settings({settings,onSaved}:{settings:AiSettings;onSaved:(status:AiStatus)=>void}) {
  const [value,setValue]=useState(settings),[key,setKey]=useState(""),[clearKey,setClearKey]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  async function save(event:React.FormEvent){
    event.preventDefault();setBusy(true);setError("");
    try{onSaved(await aiRequest<AiStatus>({action:"configure",...value,apiKey:key,clearKey}));setKey("");}
    catch(err){setError((err as Error).message);}finally{setBusy(false);}
  }
  return <form className="ai-settings" onSubmit={save}><fieldset className="edit-fields" disabled={busy}>
    <section className="settings-form-section">
      <div className="settings-row-heading"><div className="settings-toggle-copy"><strong id="ai-enabled-title">AI 助手</strong><p id="ai-enabled-help">开启后，成员可使用对话录入和进展总结。</p></div><label className="backup-switch"><input type="checkbox" role="switch" aria-labelledby="ai-enabled-title" aria-describedby="ai-enabled-help" checked={value.enabled} onChange={e=>setValue({...value,enabled:e.target.checked})}/><span aria-hidden="true"/></label></div>
      <p className="settings-security-note">成员发起请求时，输入文字和本次所需的授权事项资料会发送到所选模型服务。系统不自动读取附件原文、电话或微信等联系方式。</p>
    </section>
    <section className="settings-form-section"><h3>模型与连接</h3><div className="edit-form-grid">
      <label className="edit-field"><span>模型服务</span><select value={value.provider} onChange={e=>{const provider=e.target.value as AiSettings["provider"];setValue({...value,provider,baseUrl:provider==="openai"?"https://api.openai.com/v1":"https://dashscope.aliyuncs.com/compatible-mode/v1",model:provider==="openai"?"":"qwen-plus",inputPriceCny:null,cachedInputPriceCny:null,outputPriceCny:null,dailyBudgetCny:null,keyConfigured:false,enabled:false});setKey("");}}><option value="qwen-cn">Qwen · 阿里云百炼（北京）</option><option value="openai">OpenAI</option></select></label>
      <label className="edit-field"><span>模型名称</span><input required value={value.model} maxLength={120} onChange={e=>setValue({...value,model:e.target.value,inputPriceCny:null,cachedInputPriceCny:null,outputPriceCny:null,dailyBudgetCny:null})} placeholder="填写已开通的文本模型"/></label>
      <label className="edit-field edit-field-wide"><span>服务地址</span><input required type="url" value={value.baseUrl} onChange={e=>setValue({...value,baseUrl:e.target.value})}/><small>百炼可使用北京地域通用地址或业务空间专属地址。</small></label>
      <label className="edit-field edit-field-wide"><span>API 密钥</span><input type="password" autoComplete="new-password" value={key} maxLength={500} onChange={e=>{setKey(e.target.value);setClearKey(false);}} placeholder={value.keyConfigured?"已保存，留空保持现有密钥":"填写对应服务的 API 密钥"}/><small>已保存的密钥不会回显，仅管理员可以替换或清除。</small></label>
    </div>{settings.keyConfigured&&<label className="settings-clear-key"><input type="checkbox" checked={clearKey} onChange={e=>{setClearKey(e.target.checked);if(e.target.checked){setKey("");setValue({...value,enabled:false});}}}/>清除已保存密钥，同时关闭 AI 助手</label>}</section>
    <section className="settings-form-section"><h3>团队每日限额</h3><div className="edit-form-grid"><label className="edit-field"><span>每日请求上限</span><input type="number" required min={1} max={1000} value={value.dailyLimit} onChange={e=>setValue({...value,dailyLimit:Number(e.target.value)})}/><small>按工作区时区计数，失败请求也计入。</small></label>{limits.map(field=><label className="edit-field" key={field.key}><span>{field.label}</span><input type="number" min={0} max={field.max} step={field.step} value={value[field.key]??""} onChange={e=>setValue({...value,[field.key]:e.target.value===""?null:Number(e.target.value)})}/><small>{field.hint}</small></label>)}</div></section>
    <section className="settings-form-section"><h3>费用单价 <span className="field-optional">人民币元 / 百万 Token</span></h3><div className="edit-form-grid">{prices.map(field=><label className="edit-field" key={field.key}><span>{field.label}</span><input type="number" min={0} max={1000000} step="0.000001" value={value[field.key]??""} onChange={e=>setValue({...value,[field.key]:e.target.value===""?null:Number(e.target.value)})}/><small>{field.hint}</small></label>)}</div><p className="admin-help">按模型服务商的实际账户单价填写；费用统计为估算值。</p></section>
    {error&&<p role="alert" className="admin-alert">{error}</p>}
    <div className="settings-form-actions"><button className="admin-button admin-primary" disabled={busy}>{busy?"保存中…":"保存 AI 设置"}</button></div>
  </fieldset></form>;
}
export default function AiSettingsPanel(){
  const [status,setStatus]=useState<AiStatus|null>(null),[error,setError]=useState(""),[notice,setNotice]=useState("");
  useEffect(()=>{let active=true;aiRequest<AiStatus>(undefined,"settings").then(value=>{if(active)setStatus(value);}).catch(err=>{if(active)setError(err.message);});return()=>{active=false;};},[]);
  return <section className="panel admin-center-panel"><SettingsPanelHeader title="AI 设置" description="配置模型服务、访问密钥和团队使用限额。" actions={status&&<SettingsStatus tone={status.enabled?"success":"neutral"}>{status.enabled?"已开启":"未开启"}</SettingsStatus>}/>
    {error&&<p className="admin-alert" role="alert">{error}</p>}{notice&&<p className="admin-notice" role="status">{notice}</p>}
    {!status&&!error&&<p className="settings-empty" role="status">正在读取 AI 设置…</p>}
    {status?.canManage&&status.settings&&<Settings key={status.settings.revision} settings={status.settings} onSaved={value=>{setStatus(value);setNotice("AI 设置已保存。");}}/>}
  </section>;
}
