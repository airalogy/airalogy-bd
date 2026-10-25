import "server-only";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, lstatSync } from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import { admin, twoFactor } from "better-auth/plugins";
import { APIError } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";

type Member = {id:string;email:string;name:string;active:number;revision:string;credential_revision:string};
type Invitation = Member & {digest:string;expires:number};
const rejected = () => new APIError("UNAUTHORIZED", {message:"账号信息已失效，请重新登录或联系管理员。"});
const digest = (token:string) => createHash("sha256").update(token).digest("hex");

async function initialize() {
  if(process.env.BD_MODE !== "server") throw new Error("认证组件仅用于服务器模式。");
  const secret=process.env.BETTER_AUTH_SECRET;
  if(!secret || secret.length<32) throw new Error("请配置至少 32 字符的 BETTER_AUTH_SECRET。");
  const origin=new URL(process.env.BD_PUBLIC_URL || "").origin;
  const directory=path.join(path.dirname(process.env.BD_CONTENT_DIR || ""),".bd-auth");
  const file=path.join(directory,"accounts.sqlite3");
  if(lstatSync(directory).isSymbolicLink() || lstatSync(file).isSymbolicLink()) throw new Error("账号目录不能使用符号链接。");
  const db=new DatabaseSync(file);
  chmodSync(directory,0o700);chmodSync(file,0o600);
  db.exec("PRAGMA busy_timeout=30000; PRAGMA foreign_keys=ON;");
  const member=(id:string) => db.prepare("SELECT * FROM users WHERE id=?").get(id) as Member|undefined;
  const auth=betterAuth({
    appName:"Airalogy BD", baseURL:origin, basePath:"/api/identity", secret, telemetry:{enabled:false},
    database:db, trustedOrigins:[origin],
    emailAndPassword:{enabled:true,disableSignUp:true,minPasswordLength:12,maxPasswordLength:256},
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
      "/two-factor/*":{window:60,max:10},
    }},
    plugins:[admin(),twoFactor({issuer:"Airalogy BD",twoFactorTable:"ba_two_factor"})],
    databaseHooks:{session:{create:{before:async(session,ctx)=>{
      const identity=db.prepare("SELECT memberId,credentialRevision FROM ba_user WHERE id=?").get(session.userId) as {memberId:string;credentialRevision:string}|undefined;
      const current=identity && member(identity.memberId);
      if(!current?.active || current.credential_revision!==identity?.credentialRevision) throw rejected();
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
    if(!row) throw rejected();
    return row;
  }
  // Serialize activation, including retries, within the single application instance.
  // A consumed invite can never be used to replace a newly created identity.
  let activation:Promise<unknown>=Promise.resolve();
  function accept(token:unknown,password:unknown) {
    const next=activation.catch(()=>{}).then(async()=>{
      if(typeof password!=="string" || password.length<12 || password.length>256) throw new APIError("BAD_REQUEST",{message:"密码须为 12–256 个字符。"});
      const invited=invitation(token);
      const context=await auth.$context;
      const previous=await context.internalAdapter.findUserByEmail(invited.email);
      if(previous) await context.internalAdapter.deleteUser(previous.user.id);
      // This server-only call is never mounted as a public admin endpoint.
      const result=await auth.api.createUser({body:{email:invited.email,name:invited.name,password,
        data:{memberId:invited.id,credentialRevision:invited.credential_revision}}});
      db.exec("BEGIN IMMEDIATE");
      try {
        const fresh=invitation(token);
        if(fresh.credential_revision!==invited.credential_revision) throw rejected();
        db.prepare("DELETE FROM invitations WHERE digest=?").run(fresh.digest);
        db.prepare("UPDATE users SET active=1 WHERE id=?").run(invited.id);
        db.exec("COMMIT");
      } catch(error) {db.exec("ROLLBACK");await context.internalAdapter.deleteUser(result.user.id);throw error;}
      return {email:invited.email};
    });
    activation=next;
    return next;
  }
  async function providerSession(cookie:string) {
    return auth.api.getSession({headers:new Headers({cookie}),query:{disableCookieCache:true}});
  }
  async function handle(route:string,body:Record<string,unknown>,request:Request) {
    // Do not forward attacker-selected identity, permission or internal-invitation headers.
    const headers=new Headers({"Content-Type":"application/json",Origin:origin,Cookie:request.headers.get("cookie")||"",
      "x-real-ip":request.headers.get("x-real-ip")||"127.0.0.1","User-Agent":request.headers.get("user-agent")||""});
    return auth.handler(new Request(origin+"/api/identity"+route,{method:"POST",headers,body:JSON.stringify(body)}));
  }
  function audit(id:string,action:string) {
    const current=member(id);
    if(current) db.prepare("INSERT INTO audit(at,actor_id,actor_name,action,target,outcome) VALUES(?,?,?,?,?,?)").run(Math.floor(Date.now()/1000),id,current.name,action,id,"success");
  }
  return {auth,db,member,accept,providerSession,handle,audit};
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
  return session?.user.twoFactorEnabled && session.session.mfaVerified ? session.session.token : "";
}
