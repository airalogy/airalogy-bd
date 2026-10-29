import { workspaceRequest, WorkspaceError } from "./workspace-client";
import type { WorkspaceResponse } from "./workspace-types";

export const fileCategories = { agreement: "协议", presentation: "演示材料", bp: "商业计划书", introduction: "公司介绍", other: "其他资料" };
export const agreementTypes = { unspecified: "未标注", nda: "保密协议（NDA）", investment_cooperation: "投资合作协议" };
export type AgreementType = Exclude<keyof typeof agreementTypes, "unspecified">;
export type FileFilter = "all" | AgreementType | keyof typeof fileCategories;
export const fileStatuses = { unspecified: "未标注", draft: "草案", final: "定稿", signed: "签署件" };
export const fileUses = { reference: "进展附件", meeting: "会议使用", sent: "实际发送", received: "对方提供" };
export type FileVersion = { id: string; filename: string; sha256: string; size: number; status: keyof typeof fileStatuses; created_at: string; archive_path: string; note: string; agreement_date?: string; signing_completed_date?: string };
export type AgreementDateValues = Pick<FileVersion, "agreement_date" | "signing_completed_date">;
export type SigningDateMode = "unset" | "same" | "custom";
export function signingDateMode(value: AgreementDateValues): SigningDateMode {
  if (!value.signing_completed_date) return "unset";
  return value.agreement_date === value.signing_completed_date ? "same" : "custom";
}
export function chooseSigningDate(value: AgreementDateValues, mode: SigningDateMode): AgreementDateValues {
  if (mode === "same" && !value.agreement_date) throw new Error("请先填写协议载明日期。");
  return {...value, signing_completed_date: mode === "unset" ? "" : mode === "same" ? value.agreement_date : value.signing_completed_date};
}
// Copying a date is a shortcut, never a persistent link between two facts.
export function changeAgreementDate(value: AgreementDateValues, date: string): AgreementDateValues {
  return {...value, agreement_date: date};
}
export type FileUsage = { id: string; version_id: string; kind: keyof typeof fileUses; date: string; project_id: string; event_id: string; people: string[]; channel: string; note: string; archive_path?: string };
export type LibraryFile = { id: string; title: string; organization: string; category: keyof typeof fileCategories; agreement_type?: keyof typeof agreementTypes; project_ids: string[]; home_counterparty_id: string; notes: string; archived: boolean; current_version: string; versions: FileVersion[]; records: FileUsage[]; revision?: string };
export type FileListing = { files: LibraryFile[]; directory_pattern: string; workspace_directory: string; max_bytes: number };

export function filesForEvent(files: LibraryFile[], projectId: string, eventId: string) {
  return files.filter(file => !file.archived && file.project_ids.includes(projectId)
    && file.records.some(record => record.project_id === projectId && record.event_id === eventId));
}

// A progress entry refers to the version used then, not the file's current version.
export function fileVersionsForEvent(files: LibraryFile[], projectId: string, eventId: string) {
  return filesForEvent(files, projectId, eventId).flatMap(file => file.versions.flatMap((version, index) =>
    file.records.some(record => record.project_id === projectId && record.event_id === eventId && record.version_id === version.id)
      ? [{file, version, number: index + 1}] : []));
}

export function fileTypeLabel(file: LibraryFile) {
  const type = file.agreement_type;
  return file.category === "agreement" && type && type !== "unspecified" && agreementTypes[type]
    ? `协议 · ${agreementTypes[type]}` : fileCategories[file.category];
}

export function matchesFileFilter(file: LibraryFile, filter: FileFilter, query = "", organization = file.organization) {
  const typeMatches = filter === "all" || (filter in agreementTypes ? file.category === "agreement" && file.agreement_type === filter : file.category === filter);
  return typeMatches && `${file.title} ${organization} ${fileTypeLabel(file)} ${file.notes} ${file.versions.map(version => version.filename).join(" ")}`.toLowerCase().includes(query.trim().toLowerCase());
}

export function fileUrl(file: LibraryFile, version: FileVersion, preview = false) {
  return `/api/files?${new URLSearchParams({ action: "download", id: file.id, version_id: version.id, ...(preview ? { preview: "1" } : {}) })}`;
}
export async function fileRequest<T>(input?: Record<string, unknown>, file?: File): Promise<T> {
  let response: Response;
  if (!input) response = await fetch("/api/files?action=list", { cache: "no-store" });
  else {
    const { csrf } = await workspaceRequest<WorkspaceResponse>("workspace");
    const form = new FormData();
    if (file) { form.set("metadata", JSON.stringify(input)); form.set("file", file); }
    response = await fetch("/api/files", { method: "POST", headers: { "X-BD-CSRF": csrf, ...(!file ? { "Content-Type": "application/json" } : {}) }, body: file ? form : JSON.stringify(input) });
  }
  const result = await response.json();
  if (!response.ok || !result.ok) throw new WorkspaceError(result.error || "操作未完成。", result.code, result.details);
  return result.result as T;
}
