"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

type MenuKind = "create" | "export";
type MenuAction = { label: string; description: string; select: () => void };

export default function ToolbarActions({
  onNewProject,
  onNewProgress,
  onExportProjects,
  onExportWeekly,
}: {
  onNewProject?: () => void;
  onNewProgress?: () => void;
  onExportProjects?: () => void;
  onExportWeekly: () => void;
}) {
  const [activeMenu, setActiveMenu] = useState<MenuKind | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRefs = useRef<Partial<Record<MenuKind, HTMLButtonElement | null>>>({});
  const focusEdge = useRef<"first" | "last">("first");
  const id = useId();
  const actions: Record<MenuKind, MenuAction[]> = {
    create: [
      ...(onNewProject ? [{ label: "新增事项", description: "合作、投资与资源对接", select: onNewProject }] : []),
      ...(onNewProgress ? [{ label: "新增进展", description: "补充一次沟通或活动", select: onNewProgress }] : []),
    ],
    export: [
      ...(onExportProjects ? [{ label: "事项报告", description: "当前筛选结果或完整总览", select: onExportProjects }] : []),
      { label: "工作周报", description: "按周期汇总实际进展", select: onExportWeekly },
    ],
  };

  useEffect(() => {
    if (!activeMenu) return;
    const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    items?.[focusEdge.current === "last" ? items.length - 1 : 0]?.focus();
    const closeOutside = (event: Event) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setActiveMenu(null);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("focusin", closeOutside);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("focusin", closeOutside);
    };
  }, [activeMenu]);

  const close = (kind: MenuKind) => {
    setActiveMenu(null);
    triggerRefs.current[kind]?.focus();
  };
  const triggerKeys = (event: KeyboardEvent<HTMLButtonElement>, kind: MenuKind) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusEdge.current = event.key === "ArrowUp" ? "last" : "first";
      if (activeMenu === kind) {
        const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
        items?.[focusEdge.current === "last" ? items.length - 1 : 0]?.focus();
      } else setActiveMenu(kind);
    } else if (event.key === "Escape" && activeMenu) close(kind);
  };
  const menuKeys = (event: KeyboardEvent<HTMLDivElement>, kind: MenuKind) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(kind);
      return;
    }
    if (event.key === "Tab") {
      setActiveMenu(null);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    const current = items.findIndex((item) => item === document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  return <div className="toolbar-menus" ref={rootRef} role="group" aria-label="新增与导出">
    {(["create", "export"] as const).filter(kind => actions[kind].length > 0).map((kind) => {
      const open = activeMenu === kind;
      return <div className="toolbar-menu" key={kind}>
        <button type="button"
          className={`toolbar-menu-trigger ${kind === "export" ? "export-trigger" : "admin-button"}`}
          id={`${id}-${kind}-trigger`}
          ref={(element) => { triggerRefs.current[kind] = element; }}
          aria-haspopup="menu" aria-expanded={open} aria-controls={open ? `${id}-${kind}-menu` : undefined}
          onKeyDown={(event) => triggerKeys(event, kind)}
          onClick={() => { focusEdge.current = "first"; setActiveMenu(open ? null : kind); }}>
          <span className="toolbar-menu-icon" aria-hidden="true">{kind === "export" ? "⇩" : "+"}</span>
          {kind === "export" ? "导出" : "新增"}
          <svg className="toolbar-menu-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        {open && <div className="toolbar-menu-panel" role="menu" id={`${id}-${kind}-menu`}
          aria-labelledby={`${id}-${kind}-trigger`} ref={menuRef} onKeyDown={(event) => menuKeys(event, kind)}>
          {actions[kind].map((action, index) => <button type="button" role="menuitem" tabIndex={-1}
            key={action.label} aria-label={action.label} aria-describedby={`${id}-${kind}-note-${index}`}
            onClick={() => { close(kind); action.select(); }}>
            <strong>{action.label}</strong><small id={`${id}-${kind}-note-${index}`}>{action.description}</small>
          </button>)}
        </div>}
      </div>;
    })}
  </div>;
}
