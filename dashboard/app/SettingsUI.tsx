import type {ReactNode} from "react";

export type SettingsIconName = "members" | "ai" | "usage" | "remote" | "backup" | "plus" | "search" | "lock";
const paths:Record<SettingsIconName,ReactNode> = {
  members:<><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v2"/></>,
  ai:<><path d="m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7L12 3Z"/></>,
  usage:<><path d="M4 4v16h16M9 15v-4m5 4V7m5 8v-6"/></>,
  remote:<><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4M8 9l-2 2 2 2m8-4 2 2-2 2"/></>,
  backup:<><path d="M12 3v12m-4-4 4 4 4-4M4 15v5h16v-5"/></>,
  plus:<path d="M12 5v14M5 12h14"/>,
  search:<><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></>,
  lock:<><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v2"/></>,
};
export function SettingsIcon({name}:{name:SettingsIconName}) {
  return <svg className="settings-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
export function SettingsPanelHeader({title,description,actions}:{title:string;description?:string;actions?:ReactNode}) {
  return <header className="settings-panel-head"><div><h2>{title}</h2>{description&&<p>{description}</p>}</div>{actions}</header>;
}
export function SettingsStatus({children,tone="neutral"}:{children:ReactNode;tone?:"neutral"|"success"|"warning"}) {
  return <span className={`settings-status is-${tone}`}><span aria-hidden="true"/>{children}</span>;
}
