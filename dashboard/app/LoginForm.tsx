"use client";
import {useEffect,useRef,useState} from "react";
import {teamRequest} from "./lib/team-client";
import {useRouter} from "next/navigation";
import {BrandIdentity} from "./Branding";
import AuthenticatorSetup from "./AuthenticatorSetup";
import {usernamePattern,usernameHelp} from "./lib/username-policy";

type Setup={secret:string;otp_uri:string};
type LoginStep={step:"email"|"setup"|"verify";email_sent?:boolean};
export default function LoginForm({join=false}:{join?:boolean}) {
  const router=useRouter();
  const token=useRef("");
  const [email,setEmail]=useState("");
  const [username,setUsername]=useState("");
  const [password,setPassword]=useState("");
  const [code,setCode]=useState("");
  const [emailCode,setEmailCode]=useState("");
  const [accepted,setAccepted]=useState(false);
  const [emailSent,setEmailSent]=useState(false);
  const [invitation,setInvitation]=useState<{email:string|null;name:string;username?:string|null}|null>(null);
  const [setup,setSetup]=useState<Setup|null>(null);
  const [step,setStep]=useState<"password"|"email"|"setup"|"verify">("password");
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  useEffect(()=>{
    if(!join)return;
    if(!token.current)token.current=window.location.hash.slice(1);
    // Keep invitations out of URLs, access logs and referrers after opening the page.
    window.history.replaceState(null,"",window.location.pathname);
    let active=true;
    teamRequest<{email:string|null;name:string;username?:string|null}>("auth_invite_info",{token:token.current}).then(data=>{if(active){setInvitation(data);setEmail(data.email||"");setUsername(data.username||"");}}).catch(err=>{if(active)setError(err.message);});
    return()=>{active=false;};
  },[join]);
  async function passwordLogin() {
    const response=await teamRequest<LoginStep>(join&&!accepted?"auth_accept":"auth_login",{identifier:email,email,username,password,token:token.current});
    if(join)setAccepted(true);
    setStep(response.step);setEmailSent(response.email_sent===true);
    if(response.step==="email")return;
    if(response.step==="verify"){setPassword("");return;}
    const enrollment=await teamRequest<Setup>("auth_setup",{password});
    setSetup(enrollment);setPassword("");setStep("verify");
  }
  async function resendEmail() {
    setBusy(true);setError("");
    try {await passwordLogin();setEmailCode("");}
    catch(err){setError((err as Error).message);}
    finally{setBusy(false);}
  }
  async function submit(event:React.FormEvent) {
    event.preventDefault();setBusy(true);setError("");
    try {
      if(step==="verify") {await teamRequest("auth_verify",{code});router.replace("/");router.refresh();return;}
      if(step==="email") {
        await teamRequest("auth_email_verify",{identifier:email,code:emailCode});
        setEmailCode("");await passwordLogin();return;
      }
      if(step==="password") {
        await passwordLogin();return;
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
      {step==="password"&&<>{join&&<p>受邀成员：{invitation?.name}</p>}<label>{join?"账号邮箱":"用户名或邮箱"}<input required type={join?"email":"text"} autoComplete={join?"email":"username"} autoCapitalize="none" spellCheck={false} value={email} onChange={e=>setEmail(e.target.value)} readOnly={join&&!!invitation?.email}/>{join&&<span className="admin-help">{invitation?.email?"邀请指定的账号邮箱。":"请填写你自己的邮箱，用于账号资料，也可以用于登录。"}</span>}</label>
        {join&&<label>用户名<input required autoComplete="username" autoCapitalize="none" spellCheck={false} pattern={usernamePattern} minLength={3} maxLength={30} value={username} onChange={e=>setUsername(e.target.value)} readOnly={!!invitation?.username}/><span className="admin-help">{invitation?.username?"账号恢复保留原用户名、事项权限和历史记录。":usernameHelp}</span></label>}</>}
      {(step==="password"||step==="setup")&&<label>{join&&!accepted?"设置密码（至少 12 个字符）":"密码"}<input required type="password" minLength={12} maxLength={256} autoComplete={join&&!accepted?"new-password":"current-password"} value={password} onChange={e=>setPassword(e.target.value)}/></label>}
      {step==="email"&&<><h2>验证账号邮箱</h2><p role="status">{emailSent?"验证码已发送至账号邮箱，10 分钟内有效。这是邮箱收到的验证码，身份验证器的动态验证码将在下一步输入。":"账号已保留，但验证邮件暂未发送成功。请稍后重新发送，或联系管理员检查发信配置。"}</p><label>邮箱验证码<input required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" value={emailCode} onChange={e=>setEmailCode(e.target.value)}/></label><button className="admin-button" type="button" onClick={resendEmail} disabled={busy}>重新发送验证码</button><p className="admin-help">每分钟最多发送一次；重新发送后请使用最新验证码。也可以返回登录页稍后继续。</p><a href="/login">返回登录</a></>}
      {setup && <AuthenticatorSetup {...setup} />}
      {step==="verify"&&<label>六位动态验证码<input required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" value={code} onChange={e=>setCode(e.target.value)}/>{!setup&&<span className="admin-help">打开你绑定的身份验证器 App，输入本账号当前显示的验证码。</span>}</label>}
      <button className="admin-button admin-primary" type="submit" disabled={busy}>{busy?"正在验证…":step==="email"?"验证邮箱并继续":step==="verify"?(setup?"完成绑定":"登录"):step==="setup"?"继续绑定":join&&!accepted?"设置密码并继续":"下一步"}</button>
    </form>}
    <p className="admin-help">仅限受邀成员。忘记密码或无法取得验证码时，请联系管理员重新签发邀请。设置中断后，可从登录页面继续绑定。</p>
    {join&&<p><a href="/login">返回登录</a></p>}
  </section></main>;
}
