import { filesForEvent, fileUrl, type LibraryFile } from "./lib/file-library";
export default function EventAttachments({files,matter,event,snapshot}: {files:LibraryFile[];matter:string;event:string;snapshot?:string}) {
  const linked=filesForEvent(files,matter,event).flatMap(file=>file.versions.filter(version=>file.records.some(r=>r.project_id===matter&&r.event_id===event&&r.version_id===version.id)).map(version=>({file,version})));
  if(!linked.length)return null;
  return <ul className="event-file-links" aria-label="进展关联文件">{linked.map(({file,version})=><li key={`${file.id}:${version.id}`}><a href={fileUrl(file,version)+(snapshot?`&snapshot=${encodeURIComponent(snapshot)}`:"")} download title={`下载 ${version.filename}`}><span>{version.filename}</span><small>v{file.versions.indexOf(version)+1} · 下载</small></a></li>)}</ul>;
}
