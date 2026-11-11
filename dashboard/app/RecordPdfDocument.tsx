import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import type { ProjectEvent } from "./lib/types";

export type PdfSupplement = {
  id: string; title: string; date: string; body: string;
  author: {name: string}; updated_by: {name: string}; created_at: string; updated_at: string;
};
export type PdfRecord = {
  event: ProjectEvent; sourceLabel: string; workspaceName: string;
  participants: string[]; historical: boolean;
};
export function recordPdfFilename(event: ProjectEvent) {
  return `${event.date}-${event.title}`.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").slice(0, 140) || "交流记录";
}

// The same rules style the preview and the isolated print document.
export const recordPdfStyles = `
.record-pdf { box-sizing:border-box; color:#172536; background:white; font-family:"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif; font-size:11pt; line-height:1.7; overflow-wrap:anywhere; }
.record-pdf * { box-sizing:border-box; }
.record-pdf header { border-bottom:1px solid #cbd5df; padding-bottom:14px; margin-bottom:22px; }
.record-pdf .record-pdf-brand { color:#52687a; font-size:9pt; margin:0 0 10px; }
.record-pdf h1 { font-size:21pt; line-height:1.35; margin:0 0 12px; font-weight:700; }
.record-pdf .record-pdf-meta { margin:4px 0; color:#526071; font-size:9.5pt; }
.record-pdf .record-pdf-history { color:#8a5522; }
.record-pdf h2 { font-size:15pt; margin:22px 0 10px; line-height:1.45; }
.record-pdf h3 { font-size:12.5pt; margin:18px 0 8px; line-height:1.5; }
.record-pdf h4,.record-pdf h5,.record-pdf h6 { font-size:11pt; margin:14px 0 6px; }
.record-pdf h1,.record-pdf h2,.record-pdf h3,.record-pdf h4 { break-after:avoid; page-break-after:avoid; }
.record-pdf p { margin:9px 0; orphans:3; widows:3; }
.record-pdf ul,.record-pdf ol { margin:10px 0; padding-left:1.8em; list-style-position:outside; }
.record-pdf ul { list-style-type:disc; }.record-pdf ol { list-style-type:decimal; }
.record-pdf li { margin:5px 0; }.record-pdf li>p { margin:0; }
.record-pdf ul ul { list-style-type:circle; }.record-pdf ul ul ul { list-style-type:square; }
.record-pdf blockquote { margin:12px 0; padding:6px 14px; border-left:3px solid #b8c7d5; color:#465668; }
.record-pdf table { width:100%; border-collapse:collapse; table-layout:fixed; margin:14px 0; font-size:10pt; }
.record-pdf th,.record-pdf td { border:1px solid #cbd5df; padding:7px 9px; text-align:left; vertical-align:top; overflow-wrap:anywhere; }
.record-pdf th { background:#f1f5f8; font-weight:600; }.record-pdf thead { display:table-header-group; }
.record-pdf tr { break-inside:avoid; }.record-pdf img { max-width:100%; max-height:225mm; height:auto; object-fit:contain; }
.record-pdf pre { white-space:pre-wrap; overflow-wrap:anywhere; padding:12px; background:#f4f6f8; border:1px solid #dce3e9; font-size:9pt; }
.record-pdf code { font-family:ui-monospace,monospace; font-size:.9em; }
.record-pdf a { color:#215675; text-decoration:underline; }
.record-pdf hr { border:0; border-top:1px solid #dce3e9; margin:20px 0; }
.record-pdf details>summary { font-weight:600; }.record-pdf details { margin:12px 0; }
.record-pdf .record-pdf-supplements { border-top:1px solid #cbd5df; margin-top:28px; padding-top:6px; }
.record-pdf .record-pdf-supplement { margin-top:20px; }
`;

function Markdown({children}: {children: string}) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, rehypeSanitize]}
    components={{details: ({children}) => <details open>{children}</details>}}>{children}</ReactMarkdown>;
}

export default function RecordPdfDocument({record, supplements = []}: {record: PdfRecord; supplements?: PdfSupplement[]}) {
  const {event} = record;
  return <article className="record-pdf">
    <header>
      <p className="record-pdf-brand">{record.workspaceName}</p>
      <h1>{event.title}</h1>
      <p className="record-pdf-meta">{record.sourceLabel} · {event.date}</p>
      {record.participants.length > 0 && <p className="record-pdf-meta">参与人：{record.participants.join("、")}</p>}
      {record.historical && <p className="record-pdf-meta record-pdf-history">历史版本记录</p>}
    </header>
    {event.related_document?.markdown.trim() ? <Markdown>{event.related_document.markdown}</Markdown> : <p>{event.summary}</p>}
    {supplements.length > 0 && <section className="record-pdf-supplements">
      <h2>会后补充</h2>
      {supplements.map(item => <section key={item.id} className="record-pdf-supplement">
        {item.title && <h3>{item.title}</h3>}
        <p className="record-pdf-meta">补充日期：{item.date} · 作者：{item.author.name}
          {item.updated_at !== item.created_at && <> · 最近编辑：{item.updated_by.name}</>}
        </p>
        <Markdown>{item.body}</Markdown>
      </section>)}
    </section>}
  </article>;
}
