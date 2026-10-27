"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import AccountBar from "./AccountBar";
import { BrandIdentity } from "./Branding";
import {SettingsIcon,SettingsPanelHeader,SettingsStatus} from "./SettingsUI";
import { teamRequest, type TeamUser } from "./lib/team-client";
import { usernameHelp, usernamePattern } from "./lib/username-policy";

export default function AccountSettings({ user }: { user: TeamUser }) {
  const router = useRouter();
  const [username, setUsername] = useState(user.username || "");
  const [saved, setSaved] = useState(!!user.username);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saved || busy) return;
    setBusy(true); setError("");
    try {
      const result = await teamRequest<{ username: string }>("auth_username", { username }, user.csrf);
      setUsername(result.username); setSaved(true); router.refresh();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  return <><AccountBar user={user} management /><main className="page-shell account-settings">
    <header className="settings-page-head"><div><BrandIdentity/><h1>我的账号</h1><p>查看账号资料和日常登录方式。</p></div></header>
    <section className="panel"><SettingsPanelHeader title="账号资料" description="用户名和邮箱均可登录，姓名用于页面展示。"/>
      <dl className="account-profile"><div><dt>姓名</dt><dd>{user.name}</dd></div><div><dt>账号邮箱</dt><dd>{user.email}<SettingsStatus tone={user.email_verified?"success":"neutral"}>{user.email_verified?"已验证":"未验证"}</SettingsStatus></dd></div></dl>
      {error&&<p role="alert" className="admin-alert">{error}</p>}
      <form className="team-form account-username" onSubmit={save}><label><span>用户名 {saved&&<span className="field-optional">已锁定</span>}</span><span className="username-input"><input required autoComplete="username" autoCapitalize="none" spellCheck={false} pattern={usernamePattern} minLength={3} maxLength={30} readOnly={saved} aria-describedby="account-username-help" value={username} onChange={e=>setUsername(e.target.value)}/>{saved&&<SettingsIcon name="lock"/>}</span></label>
        <p id="account-username-help" className="admin-help" role={saved?"status":undefined}>{saved?"此用户名不能修改，可直接用于登录。":usernameHelp}</p>
        {!saved&&<button className="admin-button admin-primary" disabled={busy}>{busy?"正在保存…":"设置用户名"}</button>}
      </form>
      <div className="account-recovery-note"><h3>账号恢复</h3><p>忘记密码或无法取得动态验证码时，请联系管理员重新签发登录邀请。账号恢复保留原有事项权限和历史记录。</p></div>
    </section>
  </main></>;
}
