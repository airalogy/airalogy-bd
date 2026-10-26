import "server-only";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, lstatSync } from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { betterAuth } from "better-auth";
import { admin, twoFactor, username, emailOTP } from "better-auth/plugins";
import { APIError } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { normalizeUsername, validUsername, usernameHelp } from "./username-policy";
import { requireEmailVerification, verificationMailer } from "./email-delivery";

type Member = {id:string;email:string|null;name:string;username:string|null;active:number;revision:string;credential_revision:string};
type Invitation = Member & {digest:string;expires:number};
const rejected = () => new APIError("UNAUTHORIZED", {message:"账号信息已失效，请重新登录或联系管理员。"});
const digest = (token:string) => createHash("sha256").update(token).digest("hex");

async function initialize() {
  if(process.env.BD_MODE !== "server") throw new Error("认证组件仅用于服务器模式。");
  const secret=process.env.BETTER_AUTH_SECRET;
  if(!secret || secret.length<32) throw new Error("请配置至少 32 字符的 BETTER_AUTH_SECRET。");
  const emailRequired=requireEmailVerification();
  // Validate SMTP configuration before opening the account database.
  const sendMail=emailRequired?verificationMailer():null;
  const origin=new URL(process.env.BD_PUBLIC_URL || "").origin;
  const directory=path.join(path.dirname(process.env.BD_CONTENT_DIR || ""),".bd-auth");
  const file=path.join(directory,"accounts.sqlite3");
  if(lstatSync(directory).isSymbolicLink() || lstatSync(file).isSymbolicLink()) throw new Error("账号目录不能使用符号链接。");
  const db=new DatabaseSync(file);
  chmodSync(directory,0o700);chmodSync(file,0o600);
  db.exec("PRAGMA busy_timeout=30000; PRAGMA foreign_keys=ON;");
  const member=(id:string) => db.prepare("SELECT * FROM users WHERE id=?").get(id) as Member|undefined;
  const mailAttempt=new AsyncLocalStorage<{failed:boolean}>();
  const emailMember=(email:string) => db.prepare("SELECT u.* FROM users u JOIN ba_user b ON b.memberId=u.id WHERE b.email=? AND u.email=b.email AND u.active=1 AND b.credentialRevision=u.credential_revision").get(email) as Member|undefined;
  const auth=betterAuth({
    appName:"Airalogy BD", baseURL:origin, basePath:"/api/identity", secret, telemetry:{enabled:false},
    database:db, trustedOrigins:[origin],
    emailAndPassword:{enabled:true,disableSignUp:true,minPasswordLength:12,maxPasswordLength:256,requireEmailVerification:emailRequired},
    emailVerification:{sendOnSignUp:false,sendOnSignIn:false,autoSignInAfterVerification:false,
      beforeEmailVerification:async(user)=>{if(!emailRequired || !emailMember(user.email))throw rejected();},
      afterEmailVerification:async(user)=>{const current=emailMember(user.email);if(current)audit(current.id,"account.email_verified");}},
    user:{modelName:"ba_user",additionalFields:{
      memberId:{type:"string",required:true,input:false},
      credentialRevision:{type:"string",required:true,input:false},
    }},
    account:{modelName:"ba_account"}, verification:{modelName:"ba_verification"},
    session:{modelName:"ba_session",expiresIn:43200,disableSessionRefresh:true,cookieCache:{enabled:false},additionalFields:{
      permissionRevision:{type:"string",required:true,input:false},
      csrf:{type:"string",required:true,input:false},
      mfaVerified:{type:"boolean",defaultValue:false,input:false},
    }},
    advanced:{useSecureCookies:origin.startsWith("https:"),cookiePrefix:"bd",defaultCookieAttributes:{httpOnly:true,sameSite:"lax",path:"/"},
      // The reverse proxy overwrites this header. Missing IP falls back to one shared bucket.
      ipAddress:{ipAddressHeaders:["x-real-ip"]}},
    rateLimit:{enabled:true,storage:"database",modelName:"ba_rate_limit",window:60,max:100,customRules:{
      "/sign-in/email":{window:900,max:20},
      "/sign-in/username":{window:900,max:20},
      "/two-factor/*":{window:60,max:10},
    }},
    plugins:[admin(),twoFactor({issuer:"Airalogy BD",twoFactorTable:"ba_two_factor"}),username({displayUsername:false,immutableUsername:true,usernameValidator:validUsername}),
      emailOTP({disableSignUp:true,storeOTP:"hashed",expiresIn:600,allowedAttempts:5,
        generateOTP:({email,type})=>{
          if(!emailRequired || type!=="email-verification" || !emailMember(email))throw rejected();
          // Per-account cooldown also covers username/email aliases and different IP addresses.
          const identifier=`bd-email-send-${email}`;
          db.exec("BEGIN IMMEDIATE");
          try {
            const last=db.prepare("SELECT 1 FROM ba_verification WHERE identifier=? AND expiresAt>?").get(identifier,new Date().toISOString());
            if(last)throw new APIError("TOO_MANY_REQUESTS",{message:"请稍后再发送验证码。"});
            db.prepare("DELETE FROM ba_verification WHERE identifier=?").run(identifier);
            const now=new Date().toISOString();
            db.prepare("INSERT INTO ba_verification(id,identifier,value,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)").run(randomBytes(16).toString("hex"),identifier,"cooldown",new Date(Date.now()+60000).toISOString(),now,now);
            db.exec("COMMIT");
          } catch(error){db.exec("ROLLBACK");throw error;}
          // Better Auth generates, hashes, expires and atomically consumes the code.
          return undefined;
        },
        sendVerificationOTP:async({email,otp,type})=>{
          if(!sendMail || type!=="email-verification")throw rejected();
          try {await sendMail(email,otp);}
          catch {
            // Better Auth intentionally absorbs background mail errors. Track the outcome
            // within this request so the UI never claims that a failed delivery succeeded.
            const attempt=mailAttempt.getStore();
            if(attempt)attempt.failed=true;
            else throw new Error("验证邮件发送失败。");
          }
        },
      })],
    databaseHooks:{session:{create:{before:async(session,ctx)=>{
      const identity=db.prepare("SELECT memberId,credentialRevision,emailVerified FROM ba_user WHERE id=?").get(session.userId) as {memberId:string;credentialRevision:string;emailVerified:number}|undefined;
      const current=identity && member(identity.memberId);
      if(!current?.active || current.credential_revision!==identity?.credentialRevision || (emailRequired && !identity.emailVerified)) throw rejected();
      return {data:{...session,permissionRevision:current.revision,csrf:randomBytes(32).toString("hex"),
        // Only Better Auth's successful TOTP endpoint may produce a business session.
        mfaVerified:ctx?.path==="/two-factor/verify-totp"}};
    }}}},
  });
  const migration=await getMigrations(auth.options);
  await migration.runMigrations();

  function invitation(token:unknown) {
    if(typeof token!=="string" || !/^[A-Za-z0-9_-]{40,100}$/.test(token)) throw rejected();
    const row=db.prepare("SELECT u.*,i.digest,i.expires FROM invitations i JOIN users u ON u.id=i.user_id WHERE digest=? AND expires>?").get(digest(token),Math.floor(Date.now()/1000)) as Invitation|undefined;
    if(!row || row.active) throw rejected();
    return row;
  }
  // Serialize activation, including retries, within the single application instance.
  // A consumed invite can never be used to replace a newly created identity.
  let activation:Promise<unknown>=Promise.resolve();
  function chosenUsername(value:unknown,current:Member) {
    const name=normalizeUsername(value);
    if(!validUsername(name)) throw new APIError("BAD_REQUEST",{message:usernameHelp});
    if(current.username && name!==current.username) throw new APIError("BAD_REQUEST",{message:"用户名已设置，请继续使用原用户名。"});
    if(db.prepare("SELECT 1 FROM users WHERE username=? COLLATE NOCASE AND id!=?").get(name,current.id)) throw new APIError("CONFLICT",{message:"该用户名已被使用，请换一个。"});
    return name;
  }
  function chosenEmail(value:unknown,current:Member) {
    const email=typeof value==="string"?value.trim().toLowerCase():current.email;
    if(!email || email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new APIError("BAD_REQUEST",{message:"请填写有效的账号邮箱。"});
    if(current.email && current.email!==email)throw new APIError("BAD_REQUEST",{message:"请使用邀请指定的账号邮箱。"});
    if(db.prepare("SELECT 1 FROM users WHERE email=? COLLATE NOCASE AND id!=?").get(email,current.id))throw new APIError("CONFLICT",{message:"该邮箱不能用于此邀请，请使用自己的其他邮箱或联系管理员。"});
    const identity=db.prepare("SELECT memberId FROM ba_user WHERE email=? COLLATE NOCASE").get(email) as {memberId:string}|undefined;
    if(identity && identity.memberId!==current.id)throw new APIError("CONFLICT",{message:"该邮箱不能用于此邀请，请使用自己的其他邮箱或联系管理员。"});
    return email;
  }
  function accept(token:unknown,password:unknown,value:unknown,emailInput?:unknown) {
    const next=activation.catch(()=>{}).then(async()=>{
      if(typeof password!=="string" || password.length<12 || password.length>256) throw new APIError("BAD_REQUEST",{message:"密码须为 12–256 个字符。"});
      const invited=invitation(token);
      const chosen=chosenUsername(value ?? invited.username,invited);
      const email=chosenEmail(emailInput,invited);
      const context=await auth.$context;
      db.prepare("DELETE FROM ba_verification WHERE identifier IN (?,?)").run(`email-verification-otp-${email}`,`bd-email-send-${email}`);
      // Recovery and interrupted activation may replace only this invited member's
      // identity. A user-supplied email must never select another member for deletion.
      const previous=db.prepare("SELECT id FROM ba_user WHERE memberId=?").all(invited.id) as {id:string}[];
      for(const identity of previous)await context.internalAdapter.deleteUser(identity.id);
      // This server-only call is never mounted as a public admin endpoint.
      const result=await auth.api.createUser({body:{email,name:invited.name,password,
        data:{memberId:invited.id,credentialRevision:invited.credential_revision,username:chosen}}});
      db.exec("BEGIN IMMEDIATE");
      try {
        const fresh=invitation(token);
        if(fresh.credential_revision!==invited.credential_revision) throw rejected();
        chosenEmail(email,fresh);
        db.prepare("DELETE FROM invitations WHERE digest=?").run(fresh.digest);
        db.prepare("UPDATE users SET active=1,username=?,email=? WHERE id=?").run(chosen,email,invited.id);
        db.exec("COMMIT");
      } catch(error) {db.exec("ROLLBACK");await context.internalAdapter.deleteUser(result.user.id);throw error;}
      return {email};
    });
    activation=next;
    return next;
  }
  async function providerSession(cookie:string) {
    return auth.api.getSession({headers:new Headers({cookie}),query:{disableCookieCache:true}});
  }
  function setUsername(request:Request,value:unknown) {
    const next=activation.catch(()=>{}).then(async()=>{
      const session=await providerSession(request.headers.get("cookie")||"");
      const current=session && member(session.user.memberId);
      if(!session?.user.twoFactorEnabled || !session.session.mfaVerified || !current?.active || current.revision!==session.session.permissionRevision || current.credential_revision!==session.user.credentialRevision) throw rejected();
      const chosen=chosenUsername(value,current);
      if(current.username===chosen) return {username:chosen};
      const response=await handle("/update-user",{username:chosen},request);
      if(!response.ok) throw new APIError("CONFLICT",{message:"用户名未能设置，请检查格式或换一个后重试。"});
      db.prepare("UPDATE users SET username=? WHERE id=?").run(chosen,current.id);
      audit(current.id,"account.username");
      return {username:chosen};
    });
    activation=next;
    return next;
  }
  async function handle(route:string,body:Record<string,unknown>,request:Request) {
    // Do not forward attacker-selected identity, permission or internal-invitation headers.
    const headers=new Headers({"Content-Type":"application/json",Origin:origin,Cookie:request.headers.get("cookie")||"",
      "x-real-ip":request.headers.get("x-real-ip")||"127.0.0.1","User-Agent":request.headers.get("user-agent")||""});
    return mailAttempt.run({failed:false},async()=>{
      const response=await auth.handler(new Request(origin+"/api/identity"+route,{method:"POST",headers,body:JSON.stringify(body)}));
      if(mailAttempt.getStore()?.failed)return Response.json({code:"BD_EMAIL_SEND_FAILED"},{status:503});
      return response;
    });
  }
  function audit(id:string,action:string) {
    const current=member(id);
    if(current) db.prepare("INSERT INTO audit(at,actor_id,actor_name,action,target,outcome) VALUES(?,?,?,?,?,?)").run(Math.floor(Date.now()/1000),id,current.name,action,id,"success");
  }
  return {auth,db,member,accept,setUsername,providerSession,handle,audit,emailRequired};
}
// Next may bundle SSR and route handlers separately; share the connection/migration promise.
const state=globalThis as typeof globalThis & {bdAuthProvider?:ReturnType<typeof initialize>};
export function getAuthProvider() {
  if(!state.bdAuthProvider) state.bdAuthProvider=initialize().catch(error=>{state.bdAuthProvider=undefined;throw error;});
  return state.bdAuthProvider;
}
export async function verifiedSessionToken(cookie:string) {
  if(!cookie) return "";
  const session=await (await getAuthProvider()).providerSession(cookie);
  return session?.user.twoFactorEnabled && session.session.mfaVerified && (!requireEmailVerification() || session.user.emailVerified) ? session.session.token : "";
}
