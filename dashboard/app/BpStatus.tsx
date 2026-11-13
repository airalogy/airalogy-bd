"use client";

import type { LibraryFile } from "./lib/file-library";
import { bpSendings } from "./lib/investments";

export default function BpStatus({ projectId, files, people, onOpen }: {
  projectId: string; files: LibraryFile[]; people: {id:string;name:string}[]; onOpen: (fileId?: string) => void;
}) {
  const records = bpSendings(projectId, files);
  const latest = records[0];
  if (!latest) return <span className="bp-unrecorded" aria-label="暂无 BP 发送记录">—</span>;
  return <div className="bp-status">
    <strong className="bp-sent">已发送</strong>
    <p>{latest.title} · {latest.versionLabel}</p><small>{latest.filename}</small><time>{latest.date}</time>
      <details><summary>{records.length > 1 ? `全部 ${records.length} 次发送` : "发送详情"}</summary>
        <ol>{records.map(record => <li key={`${record.fileId}:${record.id}`}>
          <time>{record.date}</time><p>{record.title} · {record.versionLabel}</p><small>{record.filename}</small>
          <p>{record.people.map(id => people.find(person => person.id === id)?.name || id).join("、")} · {record.channel}</p>{record.note && <p>{record.note}</p>}
          {record.archived && <small>资料已移入回收站，发送记录保留</small>}
          <button type="button" className="investment-expand" onClick={() => onOpen(record.fileId)}>查看这份 BP</button>
        </li>)}</ol>
      </details>
    <button type="button" className="investment-expand" onClick={() => onOpen()}>BP 资料与发送记录</button>
  </div>;
}
