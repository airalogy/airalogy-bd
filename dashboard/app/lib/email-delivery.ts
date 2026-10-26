import nodemailer from "nodemailer";

export function requireEmailVerification(env: NodeJS.ProcessEnv = process.env) {
  const value = env.BD_REQUIRE_EMAIL_VERIFICATION || "0";
  if (!["0", "1"].includes(value)) throw new Error("BD_REQUIRE_EMAIL_VERIFICATION 只支持 0 或 1。");
  return env.BD_MODE === "server" && value === "1";
}

export function smtpConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const host = (env.BD_SMTP_HOST || "").trim();
  const port = Number(env.BD_SMTP_PORT || "465");
  const user = env.BD_SMTP_USER || "";
  const pass = env.BD_SMTP_PASSWORD || "";
  const from = (env.BD_MAIL_FROM || "").trim();
  if (!/^[a-z0-9.-]+$/i.test(host) || !Number.isInteger(port) || port < 1 || port > 65535 || !user || !pass ||
      from.length > 254 || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(from)) {
    throw new Error("开启邮箱验证前，请配置 BD_SMTP_HOST、BD_SMTP_PORT、BD_SMTP_USER、BD_SMTP_PASSWORD 和 BD_MAIL_FROM。");
  }
  return {from, options: {
    host, port, secure: port === 465, requireTLS: port !== 465,
    auth: {user, pass}, tls: {minVersion: "TLSv1.2" as const, rejectUnauthorized: true},
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
  }};
}

export function verificationMailer(env: NodeJS.ProcessEnv = process.env) {
  const {from, options} = smtpConfiguration(env);
  const transport = nodemailer.createTransport(options);
  return async (email: string, code: string) => {
    try {
      const sent = await transport.sendMail({from, to: email, subject: "验证你的 BD 工作台邮箱",
        text: `你的邮箱验证码是：${code}\n\n验证码 10 分钟内有效，仅用于验证邮箱归属。请在发起验证的 BD 工作台页面输入，不要转发或分享。\n如果不是你本人操作，请忽略此邮件。`,
      });
      if (!sent.accepted?.length) throw new Error("not accepted");
    } catch {
      // Never propagate SMTP credentials, addresses, server responses or OTPs to logs/browser.
      throw new Error("验证邮件发送失败，请稍后重试或联系管理员检查发信配置。");
    }
  };
}
