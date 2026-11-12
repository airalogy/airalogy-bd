"use client";
import * as Dialog from "@radix-ui/react-dialog";
import {useEffect, useRef, useState} from "react";
import {useReactToPrint} from "react-to-print";
import RecordPdfDocument, {recordPdfFilename, recordPdfStyles, type PdfRecord, type PdfSupplement} from "./RecordPdfDocument";
import {workspaceRequest} from "./lib/workspace-client";
import type {WorkspaceResponse} from "./lib/workspace-types";

type ExportSelection = PdfRecord & {projectId?: string; snapshot?: string};
function PdfPreview({selection, onClose}: {selection: ExportSelection; onClose: () => void}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const [includeSupplements, setIncludeSupplements] = useState(false);
  const [supplements, setSupplements] = useState<PdfSupplement[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [printError, setPrintError] = useState("");
  useEffect(() => () => requestRef.current?.abort(), []);
  const print = useReactToPrint({
    contentRef,
    documentTitle: recordPdfFilename(selection.event),
    ignoreGlobalStyles: true,
    pageStyle: `@page {size:A4 portrait;margin:16mm;} html,body {margin:0;padding:0;background:white;} ${recordPdfStyles}`,
    onPrintError: () => setPrintError("无法打开打印窗口，请重试或使用桌面浏览器。"),
  });
  const chooseSupplements = async (include: boolean) => {
    requestRef.current?.abort();
    setIncludeSupplements(include); setError(""); setSupplements([]); setLoading(include);
    if (!include) return;
    const controller = new AbortController(); requestRef.current = controller;
    try {
      const result = await workspaceRequest<{items: PdfSupplement[]}>("supplements", {
        operation: "list", project_id: selection.projectId, event_id: selection.event.id, snapshot: selection.snapshot,
      }, false, controller.signal);
      if (!controller.signal.aborted) setSupplements(result.items);
    } catch (caught) {
      if (!controller.signal.aborted) setError((caught as Error).message);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };
  return <Dialog.Root open onOpenChange={open => {if (!open) onClose();}}>
    <Dialog.Portal>
      <Dialog.Overlay className="record-dialog-overlay"/>
      <Dialog.Content className="record-dialog record-pdf-dialog">
        <header className="record-dialog-head">
          <div><Dialog.Title>导出 PDF</Dialog.Title><Dialog.Description>预览本条记录，在打印窗口中选择“另存为 PDF”。</Dialog.Description></div>
          <Dialog.Close asChild><button type="button" className="close-button" aria-label="关闭 PDF 预览">×</button></Dialog.Close>
        </header>
        <div className="record-pdf-toolbar">
          {selection.projectId && <label>
            <input type="checkbox" checked={includeSupplements} disabled={loading} onChange={event => void chooseSupplements(event.target.checked)}/>
            附上补充记录
          </label>}
          <button type="button" className="admin-button admin-primary" disabled={loading || !!error} onClick={() => {setPrintError(""); print();}}>打印 / 存为 PDF</button>
        </div>
        {printError && <p className="record-pdf-status admin-alert" role="alert">{printError}</p>}
        {loading && <p className="record-pdf-status" role="status">正在读取补充记录…</p>}
        {includeSupplements && !loading && !error && supplements.length === 0 && <p className="record-pdf-status" role="status">这条进展暂无补充记录。</p>}
        {error && <div className="record-pdf-status admin-alert" role="alert">{error}{includeSupplements && <button type="button" className="supplement-text-action" onClick={() => void chooseSupplements(true)}>重新读取</button>}</div>}
        <div className="record-dialog-scroll record-pdf-preview">
          <style>{recordPdfStyles}</style>
          <div ref={contentRef}><RecordPdfDocument record={selection} supplements={includeSupplements ? supplements : []}/></div>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

export default function RecordPdfExport(props: PdfRecord & {projectId?: string; snapshot?: string; viewVersion?: string}) {
  const [selection, setSelection] = useState<ExportSelection | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState("");
  const prepare = async () => {
    setPreparing(true); setPrepareError("");
    try {
      if (props.snapshot) {
        setSelection({...props, event: structuredClone(props.event), participants: [...props.participants]});
        return;
      }
      // Read one authorized, current snapshot so a just-saved supplement cannot be
      // omitted while the surrounding dashboard is still refreshing.
      const latest = await workspaceRequest<WorkspaceResponse>("workspace");
      if (!latest.data || latest.status.errors.length) throw new Error("当前资料暂时无法导出，请刷新记录后重试。");
      const project = latest.data.projects.find(item => item.id === props.projectId);
      const event = (props.projectId ? project?.events : latest.data.company_events)?.find(item => item.id === props.event.id);
      if (!event) throw new Error("这条记录已不存在或不在当前访问范围内。");
      const names = new Map(latest.data.people.map(person => [person.id, person.name]));
      setSelection({...props, event, sourceLabel: project?.name || props.sourceLabel,
        workspaceName: latest.data.workspace.workspace_title,
        participants: event.participants.map(id => names.get(id) || id), snapshot: latest.status.version});
    } catch (caught) {
      setPrepareError((caught as Error).message);
    } finally { setPreparing(false); }
  };
  return <>
    <button type="button" className="admin-button record-pdf-trigger" disabled={preparing} onClick={() => void prepare()}>{preparing ? "正在准备…" : "导出 PDF"}</button>
    {prepareError && <span className="admin-help" role="alert">{prepareError}</span>}
    {selection && <PdfPreview selection={selection} onClose={() => setSelection(null)}/>}
  </>;
}
