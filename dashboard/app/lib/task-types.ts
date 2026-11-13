export const taskStates = {pending:"待处理",in_progress:"进行中",waiting:"等待对方",completed:"已完成",cancelled:"已取消"} as const;
export type TaskState=keyof typeof taskStates;
export type TaskActor={id:string;name:string};
export type TaskFields={title:string;body:string;state:TaskState;assignee_id:string|null;due_date:string|null;source_progress_id:string|null;completion_note:string};
export type TaskRecord=Omit<TaskFields,"assignee_id"> & {id:string;project_id:string;assignee:TaskActor|null;author:TaskActor;updated_by:TaskActor;created_at:string;updated_at:string;completed_by:TaskActor|null;completed_at:string|null;completion_progress_id:string|null;matter_name?:string;source_title?:string;source_archived?:boolean;revision?:string};
export type TaskRead={record:TaskRecord|null;fields:TaskFields;revision:string;progress_revision:string};
export type TaskListing={assignees:TaskActor[];items:TaskRecord[];total:number;next_offset:number|null;counts:{active:number;completed:number;cancelled:number;overdue:number};today:string;current_user_id:string};
export type TaskVersion={version:string;at:string;label:string;actor:TaskActor|null};
export function taskDate(timezone:string,now=new Date()) {const parts=new Intl.DateTimeFormat("en-CA",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(now);return ["year","month","day"].map(t=>parts.find(p=>p.type===t)?.value).join("-");}
export function taskWhen(value:string,timezone:string) {return new Intl.DateTimeFormat("zh-CN",{timeZone:timezone,dateStyle:"short",timeStyle:"short"}).format(new Date(value));}
