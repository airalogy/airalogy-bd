import type { DashboardData } from "./types";

export type EditableCounterparty = {metadata: {id:string; name:string; short_name?:string | null; kind:"organization" | "person"}; body:string; people:string[]};
export type RecordKind = "counterparty" | "person" | "project" | "progress" | "company" | "file";
export type RecordTarget = { kind: RecordKind; id: string; project_id?: string; counterparty_id?: string };
export type Relation = { person_id: string; side: string; project_roles: string[]; notes: string | null };
export type EditablePerson = { id?: string; name: string; affiliation: string; phone?: string | null; wechat?: string | null; email?: string | null };
export type EditableEvent = { id?: string; date: string; type: string; title: string; summary: string; importance: string; participants: string[]; category?: string; organizers?: string[]; related_record?: string };
export type EditableProject = { metadata: Record<string, unknown>; body: string; contacts: Relation[]; events: EditableEvent[]; documents: Record<string, string> };
export type EditableProgress = { event: EditableEvent; document: { location?: string | null; participants?: Record<string, string[]> }; body: string };
export type EditableRecord = EditableCounterparty | EditablePerson | EditableProject | EditableProgress;
export type RecordResponse = { record: EditableRecord | null; revision: string };
export type WorkspaceStatus = { revision: string; version: string; errors: string[]; observed_at: string };
export type WorkspaceResponse = { status: WorkspaceStatus; data: DashboardData | null; csrf: string };
export type SavedResponse = { saved: boolean; message: string; id: string; status: WorkspaceStatus };
export type Version = { actor?: {id:string;name:string;email:string}|null; version: string; at: string; label: string; origin: string; valid: boolean };
export type HistoryResponse = { versions: Version[]; has_more: boolean; total: number };
export type Comparison = { changes: Array<{label: string; before: string; after: string}>; files: string[]; revision: string; errors: string[]; can_restore: boolean; historical_exists: boolean; current_exists: boolean };

export type HistoricalSnapshot = { data: DashboardData; version: Version; date?: string; timezone: string };
export type BackupCopy = {at:string;directory:string;path:string;size:number;sha256:string;version:string;oss?:{bucket:string;key:string}};
export type BackupStatus = { revision: string; config: {enabled: boolean; directory: string; interval_minutes: number;oss_enabled:boolean;retention_days:number}; server?:boolean;oss_configured?:boolean;in_progress?:boolean;cleanup_error?:string;error?: string; last_attempt?: string;last_local_success?:BackupCopy; last_success?: BackupCopy };
