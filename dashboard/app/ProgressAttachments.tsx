"use client";
import { useEffect, useState } from "react";
import { Field } from "./RecordForms";
import AgreementDateFields from "./AgreementDateFields";
import AgreementDates from "./AgreementDates";
import { agreementTypes, fileCategories, fileRequest, fileStatuses, fileUrl, type FileListing, type LibraryFile } from "./lib/file-library";
import { discardUpload, type ProgressFile } from "./lib/progress-files";
const accept = ".pdf,.ppt,.pptx,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.txt,.md,.csv,.zip";
export default function ProgressAttachments({matter,eventId,items,onChange}: {matter:string;eventId:string;items:ProgressFile[];onChange:(items:ProgressFile[])=>void}) {
  const [files,setFiles] = useState<LibraryFile[]>([]), [error,setError] = useState(""), [loading,setLoading] = useState(true);
  useEffect(()=>{
    let active=true;
    fileRequest<FileListing>().then(data=>{if(active)setFiles(data.files.filter(f=>!f.archived&&f.project_ids.includes(matter)));}).catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[matter]);
  const update = (key:string, patch:Partial<ProgressFile>)=>onChange(items.map(item=>item.key===key?{...item,...patch}:item));
  const remove = (item:ProgressFile)=>{if(item.uploaded)void discardUpload(item.uploaded.upload_id).catch(()=>{});onChange(items.filter(v=>v.key!==item.key));};
  const add = (mode:ProgressFile["mode"])=>onChange([...items,{key:crypto.randomUUID(),mode,file_id:"",revision:"",version_id:"",title:"",category:"other",agreement_type:"unspecified",status:"unspecified",note:""}]);
  const refresh = async()=>{
    setLoading(true);setError("");
    try {
      const listing=await fileRequest<FileListing>();const available=listing.files.filter(f=>!f.archived&&f.project_ids.includes(matter));setFiles(available);
      if(items.length)onChange(items.map(item=>{const file=available.find(f=>f.id===item.file_id);return file?{...item,revision:file.revision || "",category:file.category,agreement_type:file.agreement_type || "unspecified"}:item;}));
    }catch(e){setError((e as Error).message);}finally{setLoading(false);}
  };
  const linked=files.flatMap(file=>file.versions.filter(version=>file.records.some(r=>r.project_id===matter&&r.event_id===eventId&&r.version_id===version.id)).map(version=>({file,version})));
  return <section className="progress-attachments" aria-label="相关文件">
    <div className="progress-attachments-heading"><div><h3>相关文件 <span>选填</span></h3><p className="admin-help">与进展一起保存，自动归入本事项资料库。关联文件不会自动标记为已发送或已签署。</p></div><button type="button" className="event-secondary-trigger" disabled={loading} onClick={()=>void refresh()}>刷新附件列表</button></div>
    {error&&<p role="alert" className="admin-alert">{error}</p>}
    {linked.length>0&&<ul className="progress-linked-files">{linked.map(({file,version})=><li key={`${file.id}:${version.id}`}><div><strong>{file.title}</strong><span>v{file.versions.indexOf(version)+1} · {version.filename}</span></div><a className="event-secondary-trigger" href={fileUrl(file,version)} download>下载</a></li>)}</ul>}
    <div className="progress-attachment-actions"><button type="button" className="admin-button" disabled={items.length>=10} onClick={()=>add("upload")}>上传新文件</button><button type="button" className="admin-button" disabled={loading||items.length>=10||!files.length} onClick={()=>add("existing")}>关联已有文件</button><button type="button" className="admin-button" disabled={loading||items.length>=10||!files.length} onClick={()=>add("version")}>添加文件新版本</button></div>
    {items.map((item,index)=>{
      const selected=files.find(f=>f.id===item.file_id), version=selected?.versions.find(v=>v.id===item.version_id);
      return <section className="progress-file-card" key={item.key} aria-label={`待添加附件 ${index+1}`}>
        <div className="progress-file-card-heading"><strong>{index+1}. {item.mode==="upload"?"上传新文件":item.mode==="version"?"添加文件新版本":"关联已有文件"}</strong><button className="event-secondary-trigger" type="button" onClick={()=>remove(item)}>移除</button></div>
        <div className="edit-form-grid">
          {item.mode!=="upload"&&<Field label="选择已有资料" wide><select required value={item.file_id} onChange={e=>{const file=files.find(f=>f.id===e.target.value);update(item.key,{file_id:file?.id||"",revision:file?.revision||"",version_id:file?.current_version||"",category:file?.category||"other",agreement_type:file?.agreement_type||"unspecified",agreement_date:"",signing_completed_date:""});}}><option value="">请选择本事项资料</option>{files.map(file=><option key={file.id} value={file.id}>{file.title} · {file.versions.length} 个版本</option>)}</select></Field>}
          {item.mode==="existing"?<>
            <Field label="具体版本" wide><select required value={item.version_id} disabled={!selected} onChange={e=>update(item.key,{version_id:e.target.value})}><option value="">请选择版本</option>{[...selected?.versions||[]].reverse().map(v=><option key={v.id} value={v.id}>v{selected!.versions.indexOf(v)+1} · {v.filename} · {fileStatuses[v.status]}</option>)}</select></Field>
            {version&&selected?.category==="agreement"&&<AgreementDates version={version}/>}
          </>:<>
            <Field label="选择文件" wide hint="支持 PDF、Office 文档、图片、文本、ZIP；单个不超过 50 MB。"><input required={!item.localFile} type="file" accept={accept} onChange={e=>{const file=e.target.files?.[0];if(item.uploaded)void discardUpload(item.uploaded.upload_id).catch(()=>{});update(item.key,{localFile:file,uploaded:undefined,...(!item.title&&file?{title:file.name.replace(/\.[^.]+$/,"")}:{} )});}}/></Field>
            {item.mode==="upload"&&<><Field label="资料名称"><input required maxLength={100} value={item.title} onChange={e=>update(item.key,{title:e.target.value})}/></Field><Field label="资料分类"><select value={item.category} onChange={e=>update(item.key,{category:e.target.value as LibraryFile["category"],agreement_type:"unspecified",agreement_date:"",signing_completed_date:""})}>{Object.entries(fileCategories).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></Field>{item.category==="agreement"&&<Field label="协议类型"><select value={item.agreement_type} onChange={e=>update(item.key,{agreement_type:e.target.value as ProgressFile["agreement_type"]})}>{Object.entries(agreementTypes).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></Field>}</>}
            <Field label="文件状态"><select value={item.status} onChange={e=>update(item.key,{status:e.target.value as ProgressFile["status"]})}>{Object.entries(fileStatuses).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></Field>
            {item.category==="agreement"&&<AgreementDateFields key={`${item.key}:${item.file_id}`} value={item} onChange={dates=>update(item.key,dates)}/>}
            <Field label="版本说明（选填）" wide><input maxLength={500} value={item.note} onChange={e=>update(item.key,{note:e.target.value})}/></Field>
            {item.uploaded&&<p className="admin-help">文件已暂存，将随本次进展正式保存。</p>}
          </>}
        </div>
      </section>;
    })}
  </section>;
}
