"use client";
import {useId,useState} from "react";
import {Field} from "./RecordForms";
import {changeAgreementDate,chooseSigningDate,signingDateMode,type SigningDateMode,type FileVersion} from "./lib/file-library";

export default function AgreementDateFields({value, onChange}: {
  value: Pick<FileVersion, "agreement_date" | "signing_completed_date">;
  onChange: (dates: Pick<FileVersion, "agreement_date" | "signing_completed_date">) => void;
}) {
  const name = useId();
  const [mode, setMode] = useState<SigningDateMode>(() => signingDateMode(value));
  const options = [
    {id: "unset", label: "暂不填写"},
    {id: "same", label: "与协议载明日期一致"},
    {id: "custom", label: "另填实际日期"},
  ] as const;
  return <div className="agreement-date-fields edit-field-wide">
    <Field label="协议载明日期（选填）" hint="协议文本中写明的日期；预先填写也可记录。"><input type="date" value={value.agreement_date || ""} onChange={event => {
      const dates = changeAgreementDate(value, event.target.value);
      if (mode === "same") setMode(signingDateMode(dates));
      onChange(dates);
    }} /></Field>
    <fieldset className="agreement-signing-date" aria-describedby={`${name}-help`}>
      <legend>实际签署完成日期（选填）</legend>
      <div className="agreement-date-options">{options.map(option => <label key={option.id} className={`agreement-date-option${mode === option.id ? " is-selected" : ""}`}>
        <input type="radio" name={name} value={option.id} checked={mode === option.id} disabled={option.id === "same" && !value.agreement_date}
          onChange={() => {setMode(option.id);onChange(chooseSigningDate(value, option.id));}} />
        <span>{option.label}</span>
      </label>)}</div>
      <p id={`${name}-help`} className="admin-help">{mode === "unset" ? "尚未完成签署或日期不确定时留空。" : "填写确认各方完成签字、盖章的实际日期。"}{!value.agreement_date && "填写协议载明日期后，可选择日期一致。"}</p>
      {mode === "same" && <p className="agreement-date-confirmation" role="status">实际签署完成日期：{value.signing_completed_date}</p>}
      {mode === "custom" && <Field label="实际日期"><input type="date" required value={value.signing_completed_date || ""} onChange={event => onChange({...value, signing_completed_date:event.target.value})} /></Field>}
    </fieldset>
    <p className="admin-help">两个日期分别记录。更改协议载明日期不会改动已填好的实际日期；填写日期不自动改变文件状态或事项阶段。</p>
  </div>;
}
