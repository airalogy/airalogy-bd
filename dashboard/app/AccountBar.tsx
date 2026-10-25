"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { teamRequest, type TeamUser } from "./lib/team-client";

export default function AccountBar({ user, management = false }: { user: TeamUser; management?: boolean }) {
  const router = useRouter();
  const [error, setError] = useState("");
  async function logout() {
    try { await teamRequest("auth_logout", {}, user.csrf); router.replace("/login"); router.refresh(); }
    catch (err) { setError((err as Error).message); }
  }
  return <><div className="team-bar"><span>{user.name} · {{ admin: "管理员", editor: "编辑成员", viewer: "只读成员" }[user.role]}</span><div>
    {management ? <Link className="admin-button" href="/">返回工作台</Link> : user.role === "admin" && <Link className="admin-button" href="/admin">管理中心</Link>}
    <Link className="admin-button" href="/account">我的账号</Link>
    <Link className="admin-button" href="/remote">远程接入与草稿</Link>
    <button className="admin-button" onClick={() => void logout()}>退出登录</button>
  </div></div>{error && <p className="admin-alert" role="alert">{error}</p>}</>;
}
