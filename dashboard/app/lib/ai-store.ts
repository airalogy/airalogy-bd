import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { estimateCost, type TokenUsage } from "./ai-meter";
import { aiDefaults, type AiSettings, type AiUsageReport, type AiUsageRow } from "./ai-types";

export class AiError extends Error {
  constructor(message: string, public code = "invalid") { super(message); }
}
export type StoredSettings = Omit<AiSettings, "keyConfigured"> & { apiKey: string };
// Separate from content/history/backups: provider credentials and short-lived dialogue are private runtime state.
export class AiStore {
  db: DatabaseSync;
  private key: Buffer;
  constructor() {
    const content = process.env.BD_CONTENT_DIR;
    if (!content) throw new AiError("资料服务尚未配置。", "unavailable");
    const directory = path.join(path.dirname(path.resolve(content)), ".bd-ai");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    writeFileSync(path.join(directory, ".gitignore"), "*\n", { mode: 0o600 });
    let secret = process.env.BETTER_AUTH_SECRET || "";
    if (process.env.BD_MODE === "server") {
      if (secret.length < 32) throw new AiError("服务器密钥尚未配置。", "unavailable");
    } else {
      const file = path.join(directory, "local.key");
      try { writeFileSync(file, randomBytes(32), { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      secret = readFileSync(file).toString("hex");
    }
    this.key = createHash("sha256").update(`bd-ai-v1:${secret}`).digest();
    const file = path.join(directory, "state.sqlite3");
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS transient (id TEXT PRIMARY KEY, owner TEXT NOT NULL, binding TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, requests INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS meter (
        id TEXT PRIMARY KEY, day TEXT NOT NULL, at INTEGER NOT NULL, owner TEXT NOT NULL, member TEXT NOT NULL,
        provider TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL,
        input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER, estimated_cny REAL,
        reserved_tokens INTEGER NOT NULL, reserved_cny REAL, input_price REAL, cached_price REAL, output_price REAL);
      CREATE INDEX IF NOT EXISTS meter_day ON meter(day);
      CREATE INDEX IF NOT EXISTS meter_active ON meter(status,owner);`);
    this.db.prepare("UPDATE meter SET status='unknown' WHERE status='running' AND at < ?").run(Date.now() - 120000);
    this.db.prepare("DELETE FROM transient WHERE expires < ?").run(Date.now());
    this.db.prepare("DELETE FROM attempts WHERE at < ?").run(Date.now() - 60000);
    this.db.prepare("DELETE FROM usage WHERE day < ?").run(new Date(Date.now() - 32 * 86400000).toISOString().slice(0, 10));
  }
  close() { this.db.close(); }
  private seal(value: unknown) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
  }
  private open<T>(value: string): T {
    try {
      const data = Buffer.from(value, "base64");
      const cipher = createDecipheriv("aes-256-gcm", this.key, data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(12, 28));
      return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString());
    } catch { throw new AiError("AI 配置无法解密，请检查服务器密钥。", "unavailable"); }
  }
  settings(): StoredSettings {
    const row = this.db.prepare("SELECT value FROM settings WHERE id=1").get() as { value: string } | undefined;
    return row ? { ...aiDefaults, ...this.open<StoredSettings>(row.value) } : { ...aiDefaults, apiKey: "", revision: "initial" };
  }
  configure(value: StoredSettings, expected: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.settings().revision !== expected) throw new AiError("配置已被其他管理员修改，请重新打开设置。", "conflict");
      this.db.prepare("INSERT OR REPLACE INTO settings VALUES(1, ?)").run(this.seal(value));
      this.db.exec("DELETE FROM transient; COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  reserve(owner: string, limit: number, day: string, request?: { settings: StoredSettings; member: string; inputBound: number }) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT requests FROM usage WHERE day=?").get(day) as { requests: number } | undefined;
      const rate = this.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE owner=? AND at>=?").get(owner, Date.now() - 60000) as { n: number };
      if ((row?.requests || 0) >= limit || rate.n >= 10) throw new AiError("AI 请求次数已达上限，请稍后再试或联系管理员。", "rate_limited");
      const id = randomUUID();
      if (request) {
        const { settings, inputBound, member } = request;
        const active = this.db.prepare("SELECT owner FROM meter WHERE status='running'").all() as { owner: string }[];
        if (active.length >= 4 || active.some(row => row.owner === owner)) throw new AiError("已有 AI 请求正在处理，请等待完成后再试。", "rate_limited");
        const outputBound = settings.provider === "openai" ? 8000 : 4000;
        const reservedTokens = inputBound + outputBound;
        const reservedCost = estimateCost({ inputTokens: inputBound, outputTokens: outputBound, cachedTokens: 0 }, { ...settings, inputPriceCny: settings.inputPriceCny === null ? null : Math.max(settings.inputPriceCny, settings.cachedInputPriceCny ?? 0) });
        const used = this.db.prepare(`SELECT COALESCE(SUM(COALESCE(input_tokens + output_tokens, reserved_tokens)),0) AS tokens,
          COALESCE(SUM(COALESCE(estimated_cny,reserved_cny)),0) AS cost,
          COUNT(CASE WHEN estimated_cny IS NULL AND reserved_cny IS NULL THEN 1 END) AS unpriced FROM meter WHERE day=?`).get(day) as { tokens: number; cost: number; unpriced: number };
        if (settings.dailyTokenLimit !== null && used.tokens + reservedTokens > settings.dailyTokenLimit) throw new AiError("今日 Token 额度不足以完成本次请求，请缩小范围或联系管理员。", "rate_limited");
        if (settings.dailyBudgetCny !== null && (reservedCost === null || used.unpriced)) throw new AiError("今日有无法估算费用的请求，暂不能按费用额度继续调用。请管理员核对单价和账单。", "rate_limited");
        if (settings.dailyBudgetCny !== null && used.cost + (reservedCost || 0) > settings.dailyBudgetCny) throw new AiError("今日费用额度不足以完成本次请求，请联系管理员。", "rate_limited");
        this.db.prepare(`INSERT INTO meter(id,day,at,owner,member,provider,model,status,reserved_tokens,reserved_cny,input_price,cached_price,output_price)
          VALUES(?,?,?,?,?,?,?,'running',?,?,?,?,?)`).run(id, day, Date.now(), owner, member, settings.provider, settings.model, reservedTokens, reservedCost, settings.inputPriceCny, settings.cachedInputPriceCny, settings.outputPriceCny);
      }
      this.db.prepare("INSERT INTO usage VALUES(?,1) ON CONFLICT(day) DO UPDATE SET requests=requests+1").run(day);
      this.db.prepare("INSERT INTO attempts(owner,at) VALUES(?,?)").run(owner, Date.now());
      this.db.exec("COMMIT");
      return id;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  reportUsage(id: string, usage: TokenUsage | null) {
    if (!usage) return;
    const row = this.db.prepare("SELECT input_price,cached_price,output_price FROM meter WHERE id=? AND status='running'").get(id) as { input_price: number | null; cached_price: number | null; output_price: number | null } | undefined;
    if (!row) return;
    const cost = estimateCost(usage, { inputPriceCny: row.input_price, cachedInputPriceCny: row.cached_price, outputPriceCny: row.output_price });
    this.db.prepare("UPDATE meter SET input_tokens=?,output_tokens=?,cached_tokens=?,estimated_cny=? WHERE id=?").run(usage.inputTokens, usage.outputTokens, usage.cachedTokens, cost, id);
  }
  finishRequest(id: string, status: "success" | "failed") {
    this.db.prepare("UPDATE meter SET status=? WHERE id=? AND status='running'").run(status, id);
  }
  usageReport(from: string, to: string): AiUsageReport {
    const rows = this.db.prepare(`SELECT day,owner,member,provider,model,COUNT(*) AS requests,
      SUM(CASE WHEN status IN ('failed','unknown') THEN 1 ELSE 0 END) AS failures,
      SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running,
      COALESCE(SUM(input_tokens),0) AS inputTokens,COALESCE(SUM(output_tokens),0) AS outputTokens,
      COALESCE(SUM(cached_tokens),0) AS cachedTokens,COALESCE(SUM(estimated_cny),0) AS estimatedCny,
      SUM(CASE WHEN input_tokens IS NULL THEN 1 ELSE 0 END) AS unknownUsage,
      SUM(CASE WHEN estimated_cny IS NULL THEN 1 ELSE 0 END) AS unpriced,
      COALESCE(SUM(CASE WHEN input_tokens IS NULL THEN reserved_tokens ELSE 0 END),0) AS heldTokens,
      COALESCE(SUM(CASE WHEN estimated_cny IS NULL THEN reserved_cny ELSE 0 END),0) AS heldCny
      FROM meter WHERE day>=? AND day<=? GROUP BY day,owner,member,provider,model ORDER BY day DESC,member,model`).all(from, to) as AiUsageRow[];
    return { from, to, rows };
  }
  put(kind: string, owner: string, binding: string, value: unknown) {
    const id = randomUUID(), expiresAt = Date.now() + 30 * 60000;
    this.db.prepare("INSERT INTO transient VALUES(?,?,?,?,?,?)").run(id, owner, binding, kind, this.seal(value), expiresAt);
    return { id, expiresAt };
  }
  get<T>(id: string, kind: string, owner: string, binding: string): T {
    const row = this.db.prepare("SELECT value FROM transient WHERE id=? AND kind=? AND owner=? AND binding=? AND expires>=?").get(id, kind, owner, binding, Date.now()) as { value: string } | undefined;
    if (!row) throw new AiError("草稿或对话已失效，请重新整理；当前资料尚未更改。", "conflict");
    return this.open(row.value);
  }
  consume(id: string) {
    if (this.db.prepare("DELETE FROM transient WHERE id=?").run(id).changes !== 1) throw new AiError("这份草稿已处理，请刷新查看最新进展。", "conflict");
  }
}
