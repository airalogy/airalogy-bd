"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import AccountBar from "./AccountBar";
import { BrandIdentity } from "./Branding";
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
    <BrandIdentity /><h1>我的账号</h1>
    <section className="panel"><p>姓名：{user.name}</p><p>账号邮箱：{user.email}（{user.email_verified?"已验证":"未验证"}）</p>
      <p>用户名和邮箱均可登录，姓名用于展示。设置用户名不会改变你的事项权限或历史记录。</p>
      {error && <p role="alert" className="admin-alert">{error}</p>}
      <form className="team-form" onSubmit={save}><label>用户名<input required autoComplete="username" autoCapitalize="none" spellCheck={false} pattern={usernamePattern} minLength={3} maxLength={30} readOnly={saved} aria-describedby="account-username-help" value={username} onChange={e => setUsername(e.target.value)} /></label>
        <p id="account-username-help" className={saved ? "admin-notice" : "admin-help"} role={saved ? "status" : undefined}>{saved ? "已锁定，不能修改。可使用此用户名登录。" : usernameHelp}</p>
        {!saved && <button className="admin-button admin-primary" disabled={busy}>{busy ? "正在保存…" : "设置用户名"}</button>}
      </form><p className="admin-help">忘记密码或无法取得动态验证码时，请联系管理员重新签发登录邀请。</p>
    </section>
  </main></>;
}
