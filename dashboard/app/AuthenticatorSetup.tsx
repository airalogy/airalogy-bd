export default function AuthenticatorSetup({ secret, otp_uri }: { secret: string; otp_uri: string }) {
  return <section className="auth-setup" aria-labelledby="auth-setup-title">
    <h2 id="auth-setup-title">绑定身份验证器</h2>
    <p>身份验证器是生成六位动态验证码的手机 App，登录时用它确认身份。</p>
    <ol className="auth-setup-steps">
      <li>安装 <a href="https://support.microsoft.com/en-us/authenticator/how-to-add-your-accounts-to-microsoft-authenticator" target="_blank" rel="noopener noreferrer">Microsoft Authenticator（微软）</a>或 <a href="https://support.google.com/accounts/answer/1066447?hl=zh-Hans" target="_blank" rel="noopener noreferrer">Google Authenticator（谷歌）</a>，任选一个。</li>
      <li>在 App 中手动添加账号。名称可填“Airalogy BD + 你的用户名”，密钥填写下方内容；类型选“基于时间”（如有）。</li>
      <li>输入 App 当前显示的六位验证码，点击“完成绑定”。以后登录也从这个 App 获取验证码。</li>
    </ol>
    <details className="auth-setup-guide">
      <summary>App 操作入口与常见问题</summary>
      <p><strong>微软：</strong>点击“+”添加账号 → “其他账户” → “手动输入代码”。</p>
      <p><strong>谷歌：</strong>点击“+”→“输入设置密钥”。不同版本的按钮名称可能略有差异。</p>
      <p>验证码不可用时，等下一组数字刷新后再试，并检查手机已开启自动设置时间。</p>
    </details>
    <h3>设置密钥</h3>
    <code aria-label="身份验证器设置密钥">{secret}</code>
    <p className="admin-help">此密钥仅用于你自己的身份验证器，请勿分享。</p>
    <p><a href={otp_uri}>在此设备的身份验证器中打开</a></p>
  </section>;
}
