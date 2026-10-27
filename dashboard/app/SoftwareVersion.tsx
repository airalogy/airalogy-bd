"use client";
import { useEffect, useRef } from "react";
import buildInfo from "./lib/software-build";
import { productInfo } from "./lib/product-info";

export default function SoftwareVersion({ locale, timezone }: { locale: string; timezone: string }) {
  const disclosure = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = () => { if (disclosure.current) disclosure.current.open = false; };
    const dismissOutside = (event: Event) => {
      if (event.target instanceof Node && !disclosure.current?.contains(event.target)) close();
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || !disclosure.current?.open) return;
      event.preventDefault();
      close();
      disclosure.current.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("focusin", dismissOutside);
    document.addEventListener("keydown", dismissOnEscape);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("focusin", dismissOutside);
      document.removeEventListener("keydown", dismissOnEscape);
      window.removeEventListener("blur", close);
    };
  }, []);
  const local = buildInfo.channel === "local";
  return <details className="software-version" ref={disclosure}>
    <summary aria-label="关于 Airalogy BD 和软件版本"><span className="software-product-name">{productInfo.name}</span><span className="software-release">{buildInfo.version ? `v${buildInfo.version}` : "版本信息不可用"}</span></summary>
    <div className="software-version-card">
      <strong>关于 {productInfo.name}</strong>
      <p>团队商务拓展与进展管理工作台。</p>
      <dl>
        <div><dt>开发公司</dt><dd>{productInfo.developer}</dd></div>
        <div><dt>软件版权</dt><dd>© {productInfo.copyrightHolder}</dd></div>
        <div><dt>当前版本</dt><dd>{buildInfo.version ? `v${buildInfo.version}` : "未记录"}</dd></div>
        {local && <div><dt>构建来源</dt><dd>本地源码</dd></div>}
        <div><dt>构建标识</dt><dd>{buildInfo.build_id || "未记录"}</dd></div>
        <div><dt>构建时间</dt><dd>{buildInfo.built_at ? <time dateTime={buildInfo.built_at}>{new Intl.DateTimeFormat(locale, { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(buildInfo.built_at))}</time> : "未记录"}</dd></div>
        {local && <div><dt>代码版本</dt><dd>{buildInfo.revision || "尚未提交"}</dd></div>}
      </dl>
      {local && <p>本地修改以构建标识区分；更新后可在这里核对。</p>}
    </div>
  </details>;
}
