import type {LibraryFile} from './file-library';
export const referenceSources={roadshow:'路演',exchange:'交流',event:'活动听闻',article:'公开资料',other:'其他'};
export type ReferenceFields={title:string;organization:string;observed_on:string|null;source_type:keyof typeof referenceSources;source_name:string;source_url:string;tags:string[];summary:string;body:string;insights:string;attachment_ids:string[];archived:boolean};
export type ReferenceRecord=ReferenceFields&{id:string;author:{id:string;name:string};updated_by:{id:string;name:string};created_at:string;updated_at:string};
export type ReferenceRead={record:ReferenceRecord|null;fields:ReferenceFields;attachments:LibraryFile[];revision:string};
export type ReferenceVersion={version:string;at:string;label:string;actor:{id:string;name:string}|null};
export type ReferenceList={items:Omit<ReferenceRecord,'body'|'insights'>[];total:number;tags:string[];next_offset:number|null};
