import type { ContactChannels as Channels } from "./lib/types";

export default function ContactChannels({ person }: { person: Channels }) {
  if (![person.phone, person.wechat, person.email].some((value) => value?.trim())) return null;
  return (
    <dl className="contact-channels">
      {person.phone?.trim() && <div><dt>电话</dt><dd>{person.phone}</dd></div>}
      {person.wechat?.trim() && <div><dt>微信</dt><dd>{person.wechat}</dd></div>}
      {person.email?.trim() && <div><dt>邮箱</dt><dd>{person.email}</dd></div>}
    </dl>
  );
}
