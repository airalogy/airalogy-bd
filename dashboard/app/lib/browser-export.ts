export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text: string): Promise<void> {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("aria-hidden", "true");
  area.style.cssText = "position:fixed;left:-9999px;top:0";
  const active = document.activeElement;
  try {
    (active?.closest('[role="dialog"]') ?? document.body).append(area);
    area.select();
    if (document.execCommand("copy")) return;
  } catch { /* Some browsers only support the asynchronous clipboard API. */ }
  finally {
    area.remove();
    if (active instanceof HTMLElement) active.focus({preventScroll:true});
  }
  let timeout: number | undefined;
  try {
    await Promise.race([
      navigator.clipboard.writeText(text),
      new Promise<never>((_, reject) => { timeout = window.setTimeout(() => reject(new Error("复制超时")), 3000); }),
    ]);
  } finally { window.clearTimeout(timeout); }
}
