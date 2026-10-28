import { workspaceRequest, WorkspaceError } from "./workspace-client";
import type { WorkspaceResponse } from "./workspace-types";
import type { AgreementDateValues, LibraryFile, FileVersion } from "./file-library";
export type StagedFile = {upload_id:string;filename:string;size:number;sha256:string;expires:number;ready:boolean};
export type ProgressFile = AgreementDateValues & {
  key:string; mode:"upload"|"version"|"existing"; file_id:string; revision:string; version_id:string;
  title:string; category:LibraryFile["category"]; agreement_type:NonNullable<LibraryFile["agreement_type"]>;
  status:FileVersion["status"]; note:string; localFile?:File; uploaded?:StagedFile;
};
async function uploadRequest(input:FormData|Record<string,unknown>) {
  const {csrf} = await workspaceRequest<WorkspaceResponse>("workspace");
  const form = input instanceof FormData;
  const response = await fetch("/api/uploads", {method:"POST",headers:{"X-BD-CSRF":csrf,...(!form?{"Content-Type":"application/json"}:{})},body:form?input:JSON.stringify(input)});
  const result = await response.json();
  if(!response.ok || !result.ok) throw new WorkspaceError(result.error || "文件上传未完成。", result.code, result.details);
  return result.result;
}
export const discardUpload = (id:string) => uploadRequest({action:"upload_discard",upload_id:id});
export async function prepareProgressFiles(items:ProgressFile[], matter:string, onUploaded:(key:string,upload:StagedFile)=>void) {
  const attachments:Record<string,unknown>[] = [];
  for (const item of items) {
    if (item.mode === "existing") {
      attachments.push({mode:item.mode,file_id:item.file_id,version_id:item.version_id,revision:item.revision});
      continue;
    }
    if (!item.localFile?.size || item.localFile.size > 50*1024*1024) throw new Error("请选择非空文件，单个文件不超过 50 MB。");
    let uploaded = item.uploaded;
    if (!uploaded || uploaded.expires <= Date.now()/1000) {
      const form = new FormData();form.set("project_id",matter);form.set("file",item.localFile);
      uploaded = await uploadRequest(form) as StagedFile;
      onUploaded(item.key,uploaded);
    }
    attachments.push({mode:item.mode,upload_id:uploaded.upload_id,status:item.status,note:item.note,
      ...(item.mode==="upload"?{title:item.title,category:item.category,agreement_type:item.agreement_type}:{file_id:item.file_id,revision:item.revision}),
      ...(item.category==="agreement"?{agreement_date:item.agreement_date || "",signing_completed_date:item.signing_completed_date || ""}:{})});
  }
  return attachments;
}
