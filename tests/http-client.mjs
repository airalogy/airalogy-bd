import http from "node:http";

// Simulate an HTTPS reverse proxy: node's fetch discards an explicit Host header.
// Use the HTTP transport so tests exercise the same Host/Origin seen behind nginx.
export async function httpFetch(url, init = {}, redirects = 0) {
  const request = new Request(url, init);
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : null;
  const response = await new Promise((resolve, reject) => {
    const outgoing = http.request(url, {method:request.method, headers:Object.fromEntries(request.headers)}, incoming => {
      const headers = new Headers();
      for (let i=0;i<incoming.rawHeaders.length;i+=2) headers.append(incoming.rawHeaders[i],incoming.rawHeaders[i+1]);
      const chunks=[];
      incoming.on("data",chunk=>chunks.push(chunk));incoming.on("error",reject);
      incoming.on("end",()=>resolve(new Response(Buffer.concat(chunks),{status:incoming.statusCode,headers})));
    });
    outgoing.on("error",reject);outgoing.setTimeout(30000,()=>{
      let operation="";
      try {const input=JSON.parse(body?.toString()||"{}");operation=input.params?.name||input.operation||input.action||"";} catch {}
      outgoing.destroy(new Error(`Test HTTP request timed out: ${request.method} ${new URL(url).pathname} ${operation}`));
    });
    outgoing.end(body);
  });
  if ([301,302,303,307,308].includes(response.status) && response.headers.get("location") && redirects<5) return httpFetch(new URL(response.headers.get("location"),url),init,redirects+1);
  Object.defineProperty(response,"url",{value:String(url)});
  return response;
}
