import type { FileVersion } from "./lib/file-library";

export default function AgreementDates({version}: {version: FileVersion}) {
  return <dl className="agreement-dates">
    <div><dt>协议载明日期</dt><dd>{version.agreement_date || "未记录"}</dd></div>
    <div><dt>实际签署完成日期</dt><dd>{version.signing_completed_date || "未记录"}</dd></div>
  </dl>;
}
