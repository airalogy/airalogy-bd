"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useRef, useState } from "react";
import { copyText, downloadBlob } from "./lib/browser-export";
import { matterBriefFilename, matterBriefMarkdown } from "./lib/matter-brief";
import type { Project } from "./lib/types";

export default function MatterBriefActions({ project, historical }: { project: Project; historical: boolean }) {
  const [open, setOpen] = useState(false);
  const [includeRecords, setIncludeRecords] = useState(false);
  const [status, setStatus] = useState<"idle" | "copying" | "copied" | "manual">("idle");
  const preview = useRef<HTMLTextAreaElement>(null);
  const recordCount = project.events.filter(event => event.related_document?.markdown.trim()).length;
  const markdown = open ? matterBriefMarkdown(project, includeRecords, historical) : "";

  function changeOpen(next: boolean) {
    setOpen(next);
    setIncludeRecords(false);
    setStatus("idle");
  }
  async function copy(text: string) {
    setStatus("copying");
    try {
      await copyText(text);
      setStatus("copied");
    } catch {
      setOpen(true);
      setStatus("manual");
      requestAnimationFrame(() => { preview.current?.focus(); preview.current?.select(); });
    }
  }

  return <Dialog.Root open={open} onOpenChange={changeOpen}>
    <div className="matter-brief-split" role="group" aria-label="事项背景">
      <button type="button" className="admin-button" disabled={status === "copying"} onClick={() => void copy(matterBriefMarkdown(project, false, historical))}>
        {status === "copied" && !open ? "已复制事项背景" : "复制事项背景"}
      </button>
      <Dialog.Trigger asChild><button type="button" className="admin-button matter-brief-options" title="预览与导出" aria-label="预览与导出事项背景">▾</button></Dialog.Trigger>
      <span className="sr-only" role="status">{status === "copied" && !open ? "事项背景已复制" : ""}</span>
    </div>
    <Dialog.Portal>
      <Dialog.Overlay className="record-dialog-overlay" />
      <Dialog.Content className="record-dialog matter-brief-dialog">
        <header className="record-dialog-head"><div>
          <div className="eyebrow">事项背景 · 预览与导出</div>
          <Dialog.Title>{project.name}</Dialog.Title>
          <Dialog.Description>{project.events.length} 条进展，按发生日期排列。下方文字可直接粘贴到外部 AI。</Dialog.Description>
        </div><Dialog.Close className="close-button" aria-label="关闭事项背景预览">×</Dialog.Close></header>
        <div className="matter-brief-body">
          <label className="matter-brief-option"><input type="checkbox" checked={includeRecords} disabled={!recordCount || status === "copying"} onChange={event => {setIncludeRecords(event.target.checked); setStatus("idle");}} />附上完整沟通记录（{recordCount} 份）</label>
          <textarea ref={preview} className="matter-brief-preview" aria-label="Markdown 内容预览" readOnly spellCheck={false} value={markdown} />
          <div className="admin-actions">
            <button type="button" className="admin-button admin-primary" disabled={status === "copying"} onClick={() => void copy(markdown)}>复制内容</button>
            <button type="button" className="admin-button" onClick={() => downloadBlob(new Blob([markdown], {type:"text/markdown;charset=utf-8"}), matterBriefFilename(project.name))}>下载 Markdown</button>
            <span className="admin-help" role="status">{status === "copied" ? "已复制" : status === "manual" ? "请选中预览文字手动复制，或下载 Markdown。" : ""}</span>
          </div>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
