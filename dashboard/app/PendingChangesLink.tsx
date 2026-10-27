"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SettingsIcon } from "./SettingsUI";
import { REMOTE_DRAFTS_CHANGED } from "./lib/remote-events";

export default function PendingChangesLink() {
  const pathname = usePathname();
  const [count, setCount] = useState<number | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let controller: AbortController | null = null;
    let disposed = false;
    async function refresh(force = false) {
      if (document.visibilityState === "hidden" || (controller && !force)) return;
      controller?.abort();
      const current = new AbortController();
      controller = current;
      try {
        const response = await fetch("/api/remote?action=pending", { cache: "no-store", signal: current.signal });
        if (!response.ok) throw new Error("unavailable");
        const body = await response.json();
        if (!body.ok || !Number.isSafeInteger(body.result?.count) || body.result.count < 0) throw new Error("invalid count");
        if (!disposed && !current.signal.aborted) { setCount(body.result.count); setUnavailable(false); }
      } catch {
        if (!disposed && !current.signal.aborted) { setCount(null); setUnavailable(true); }
      } finally {
        if (controller === current) controller = null;
      }
    }
    const onVisible = () => void refresh();
    const onChanged = () => void refresh(true);
    void refresh();
    const timer = window.setInterval(onVisible, 60_000);
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(REMOTE_DRAFTS_CHANGED, onChanged);
    return () => {
      disposed = true;
      controller?.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(REMOTE_DRAFTS_CHANGED, onChanged);
    };
  }, [pathname]);
  const hasPending = count !== null && count > 0;
  const label = hasPending ? `待确认修改，${count} 条草稿` : count === 0 ? "待确认修改，暂无草稿" : "待确认修改";
  return <Link href="/remote" className={`app-pending${hasPending ? " has-pending" : " is-muted"}`}
    aria-current={pathname === "/remote" ? "page" : undefined} aria-label={label}
    title={unavailable ? "数量暂时无法获取，点击查看待确认修改" : label}>
    <SettingsIcon name="review"/><span>待确认</span>
    {hasPending && <span className="app-pending-count" aria-hidden="true">{count > 99 ? "99+" : count}</span>}
  </Link>;
}
