import type { LibraryFile } from "./file-library";
export type Workspace = {
  id: string;
  name: string;
  short_name: string;
  workspace_title: string;
  description: string;
  locale: string;
  timezone: string;
  brand_mark: string;
  privacy_notice: string;
};

export type ContactChannels = {
  phone?: string | null;
  wechat?: string | null;
  email?: string | null;
};

export type Contact = ContactChannels & {
  id: string;
  person_id: string;
  name: string;
  affiliation: string;
  side: "counterparty" | "internal" | "advisor";
  project_roles: string[];
  last_activity: string;
  notes: string;
};

export type PersonProject = {
  project_id: string;
  project_name: string;
  side: Contact["side"];
  project_roles: string[];
  last_activity: string;
  notes: string;
};

export type Person = ContactChannels & {
  id: string;
  name: string;
  affiliation: string;
  last_activity: string | null;
  projects: PersonProject[];
};

export type ProjectEvent = {
  id: string;
  date: string;
  type: string;
  title: string;
  summary: string;
  importance: "key" | "normal";
  participants: string[];
  related_record?: string;
  related_document?: {
    path: string;
    title: string;
    markdown: string;
  };
};

export type CompanyEvent = ProjectEvent & {
  category: string;
  participants: string[];
  organizers?: string[];
};

export type Counterparty = {
  id: string; name: string; short_name?: string | null; kind: "organization" | "person";
  directory: string; body: string; people: string[]; related_people: string[]; matter_ids: string[];
};

export type Project = {
  id: string;
  name: string;
  directory: string;
  counterparties: string[];
  primary_counterparty_id: string;
  counterparty_ids: string[];
  record_type: "cooperation" | "investment" | "resource";
  target_investment_amount_cny?: number;
  category: string[];
  stage: string;
  relationship: string;
  priority: "high" | "medium" | "low";
  owner: string;
  first_contact: string | null;
  first_contact_certainty: string;
  sourced_by: string[];
  source_people: Array<Pick<Person, "id" | "name" | "affiliation">>;
  source_certainty: "confirmed" | "provisional" | "unknown";
  source_note: string;
  last_activity: string;
  follow_up_status:
    | "active_progress"
    | "proactive_contact"
    | "awaiting_response"
    | "on_hold"
    | "closed";
  next_action: string;
  next_action_due: string | null;
  summary: string;
  management_decisions: string[];
  contacts: Contact[];
  events: ProjectEvent[];
};

export type DashboardData = {
  access?: {qa_allowed?:boolean;server:boolean;role:"admin"|"editor"|"viewer";name:string;all_projects:boolean};
  counterparties: Counterparty[];
  files?: LibraryFile[];
  workspace: Workspace;
  updated_at: string | null;
  people: Person[];
  projects: Project[];
  company_events: CompanyEvent[];
};
