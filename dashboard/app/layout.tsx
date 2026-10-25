import type { Metadata } from "next";
import "./globals.css";
import { loadDashboardData } from "./lib/server-data";
import {serverMode} from "./lib/server-auth";
import SoftwareFooter from "./SoftwareFooter";
import { BrandingProvider } from "./Branding";
import { siteBranding } from "./lib/branding";

async function readWorkspace() {
  if(serverMode()) return {short_name:siteBranding().name,workspace_title:"商务拓展工作台",privacy_notice:"仅限获授权成员",description:"团队合作与业务进展管理",locale:"zh-CN"};
  try {return (await loadDashboardData()).workspace;} catch {return {short_name:"本地工作台",workspace_title:"资料恢复",privacy_notice:"本机资料",description:"可从修改历史恢复资料",locale:"zh-CN"};}
}

export async function generateMetadata(): Promise<Metadata> {
  const workspace = await readWorkspace();
  return {
    title: `${workspace.short_name} · ${workspace.workspace_title}`,
    description: `${workspace.privacy_notice}。${workspace.description}。`,
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const workspace = await readWorkspace();
  return (
    <html lang={workspace.locale}>
      {/* Browser extensions can inject body attributes before React hydrates. */}
      <body className="site-frame" suppressHydrationWarning>
        <BrandingProvider value={siteBranding()}><div className="site-content">{children}</div></BrandingProvider>
        <SoftwareFooter locale={workspace.locale} timezone={"timezone" in workspace ? workspace.timezone : "Asia/Shanghai"} />
      </body>
    </html>
  );
}
