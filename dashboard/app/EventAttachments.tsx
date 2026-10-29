"use client";
import { useId, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { fileTypeLabel, fileUrl, fileVersionsForEvent, type LibraryFile } from "./lib/file-library";

function sizeLabel(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function PreviewImage({src, alt}: {src: string; alt: string}) {
  const [failed, setFailed] = useState(false);
  return failed ? <span className="attachment-image-error">图片暂时无法预览，可下载原文件查看。</span> :
    // Authenticated file URLs use the current session, without an image proxy or public cache.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} loading="lazy" decoding="async" onError={() => setFailed(true)} />;
}

function AttachmentCard({item, snapshot}: {item: ReturnType<typeof fileVersionsForEvent>[number]; snapshot?: string}) {
  const {file, version, number} = item;
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const extension = version.filename.split(".").pop()?.toLowerCase() || "";
  const image = ["png", "jpg", "jpeg"].includes(extension);
  const suffix = snapshot ? `&snapshot=${encodeURIComponent(snapshot)}` : "";
  const download = fileUrl(file, version) + suffix;
  const preview = fileUrl(file, version, true) + suffix;
  const meta = `${extension.toUpperCase() || "文件"} · ${sizeLabel(version.size)} · v${number}`;
  return <li className={`attachment-card${image ? " attachment-card-image" : ""}`}>
    {image ? <Dialog.Root open={open} onOpenChange={value => {setOpen(value);setExpanded(false);}}>
      <Dialog.Trigger asChild><button type="button" className="attachment-thumbnail" aria-label={`放大查看 ${version.filename}`}>
        <PreviewImage key={preview} src={preview} alt="" /><span className="attachment-thumbnail-hint">点击放大</span>
      </button></Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="attachment-preview-overlay" />
        <Dialog.Content className="attachment-preview-dialog">
          <header className="attachment-preview-heading"><div><Dialog.Title>{file.title}</Dialog.Title><Dialog.Description>{version.filename} · {meta}</Dialog.Description></div><Dialog.Close asChild><button type="button" className="close-button" aria-label="关闭图片预览">×</button></Dialog.Close></header>
          <div className="attachment-preview-toolbar"><button type="button" className="admin-button" aria-pressed={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? "适应窗口" : "放大阅读"}</button><a className="admin-button" href={download} download>下载原图</a></div>
          <div className={`attachment-preview-body${expanded ? " is-expanded" : ""}`} tabIndex={0} role="region" aria-label="图片内容，可滚动查看"><PreviewImage key={`${preview}:${open}`} src={preview} alt={file.title} /></div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root> : <span className="attachment-document-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5M8 12h8M8 16h6" /></svg></span>}
    <div className="attachment-card-content"><strong>{file.title}</strong><span className="attachment-filename">{version.filename}</span><span className="attachment-meta">{fileTypeLabel(file)} · {meta}</span>
      <div className="attachment-card-actions">{extension === "pdf" && <a href={preview} target="_blank" rel="noreferrer" aria-label={`预览 ${version.filename}（新标签页）`}>预览 PDF ↗</a>}<a href={download} download aria-label={`下载 ${version.filename}`}>下载</a></div>
    </div>
  </li>;
}

export default function EventAttachments({files,matter,event,snapshot,onDetails,compact=false}: {files: LibraryFile[]; matter: string; event: string; snapshot?: string; onDetails?: () => void; compact?: boolean}) {
  const headingId = useId();
  const linked = fileVersionsForEvent(files, matter, event);
  if (!linked.length) return null;
  return <section className={`event-attachments${compact ? " is-compact" : ""}`} aria-labelledby={headingId}>
    <div className="event-attachments-heading"><h3 id={headingId}>相关附件 <span>{linked.length}</span></h3>{onDetails && <button type="button" className="event-secondary-trigger" onClick={onDetails}>版本与使用记录</button>}</div>
    <ul className="event-attachment-grid">{linked.map(item => <AttachmentCard key={`${item.file.id}:${item.version.id}:${snapshot || "current"}`} item={item} snapshot={snapshot} />)}</ul>
  </section>;
}
