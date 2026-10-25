"use client";
import {useEffect,useRef,useState} from "react";
import {teamRequest} from "./lib/team-client";
import {useRouter} from "next/navigation";
import {BrandIdentity} from "./Branding";
import {usernamePattern,usernameHelp} from "./lib/username-policy";

type Setup={secret:string;otp_uri:string};
export default function LoginForm({join=false}:{join?:boolean}) {
  const router=useRouter();
  const token=useRef("");
  const [email,setEmail]=useState("");
  const [username,setUsername]=useState("");
  const [password,setPassword]=useState("");
  const [code,setCode]=useState("");
  const [invitation,setInvitation]=useState<{email:string;name:string;username?:string|null}|null>(null);
  const [setup,setSetup]=useState<Setup|null>(null);
  const [step,setStep]=useState<"password"|"setup"|"verify">("password");
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  useEffect(()=>{
    if(!join)return;
    if(!token.current)token.current=window.location.hash.slice(1);
    // Keep invitations out of URLs, access logs and referrers after opening the page.
    window.history.replaceState(null,"",window.location.pathname);
    let active=true;
    teamRequest<{email:string;name:string;username?:string|null}>("auth_invite_info",{token:token.current}).then(data=>{if(active){setInvitation(data);setEmail(data.email);setUsername(data.username||"");}}).catch(err=>{if(active)setError(err.message);});
    return()=>{active=false;};
  },[join]);
  async function submit(event:React.FormEvent) {
    event.preventDefault();setBusy(true);setError("");
    try {
      if(step==="verify") {await teamRequest("auth_verify",{code});router.replace("/");router.refresh();return;}
      if(step==="password") {
        const response=await teamRequest<{step:"setup"|"verify"}>(join?"auth_accept":"auth_login",{identifier:email,username,password,token:token.current});
        setStep(response.step);
        if(response.step==="verify"){setPassword("");return;}
      }
      const enrollment=await teamRequest<Setup>("auth_setup",{password});
      setSetup(enrollment);setPassword("");setStep("verify");
    } catch(err){setError((err as Error).message);}
    finally{setBusy(false);}
  }
  return <main className="auth-page"><section className="auth-card"><h1><BrandIdentity /></h1><p>{join?"设置你的团队账号":"登录商务拓展工作台"}</p>
    {join && !invitation && !error && <p role="status">正在检查邀请…</p>}
    {error && <p className="admin-alert" role="alert">{error}</p>}
    {(!join || invitation) && <form onSubmit={submit}>
      {step==="password"&&<>{join&&<p>受邀成员：{invitation?.name}</p>}<label>{join?"绑定邮箱":"用户名或邮箱"}<input required type={join?"email":"text"} autoComplete={join?"email":"username"} autoCapitalize="none" spellCheck={false} value={email} onChange={e=>setEmail(e.target.value)} readOnly={join}/></label>
        {join&&<label>用户名<input required autoComplete="username" autoCapitalize="none" spellCheck={false} pattern={usernamePattern} minLength={3} maxLength={30} value={username} onChange={e=>setUsername(e.target.value)} readOnly={!!invitation?.username}/><span className="admin-help">{invitation?.username?"账号恢复保留原用户名、事项权限和历史记录。":usernameHelp}</span></label>}</>}
      {step!=="verify"&&<label>{join?"设置密码（至少 12 个字符）":"密码"}<input required type="password" minLength={12} maxLength={256} autoComplete={join?"new-password":"current-password"} value={password} onChange={e=>setPassword(e.target.value)}/></label>}
      {setup && <div className="auth-setup"><h2>绑定身份验证器</h2><p>在你的身份验证器中添加账号，选择“输入设置密钥”，填入以下密钥。请勿分享此密钥。</p><code>{setup.secret}</code><p><a href={setup.otp_uri}>在支持的身份验证器中打开</a></p></div>}
      {step==="verify"&&<label>六位动态验证码<input required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" value={code} onChange={e=>setCode(e.target.value)}/></label>}
      <button className="admin-button admin-primary" type="submit" disabled={busy}>{busy?"正在验证…":step==="verify"?(setup?"完成绑定":"登录"):step==="setup"?"继续绑定":join?"设置密码并继续":"下一步"}</button>
    </form>}
    <p className="admin-help">仅限受邀成员。忘记密码或无法取得验证码时，请联系管理员重新签发邀请。设置中断后，可从登录页面继续绑定。</p>
    {join&&<p><a href="/login">返回登录</a></p>}
  </section></main>;
}
