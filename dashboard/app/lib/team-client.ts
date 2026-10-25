import type { TeamUser } from "./server-auth";
export type { TeamUser };
export async function teamRequest<T>(action:string, input:Record<string,unknown>={}, csrf=""):Promise<T> {
  const response=await fetch("/api/auth",{method:"POST",cache:"no-store",headers:{"Content-Type":"application/json",...(csrf?{"X-BD-CSRF":csrf}:{})},body:JSON.stringify({...input,action})});
  const result=await response.json();
  if(!response.ok || !result.ok) throw new Error(result.error || "账号操作未完成。");
  return result.result;
}
