import SoftwareVersion from "./SoftwareVersion";
import { productInfo } from "./lib/product-info";

export default function SoftwareFooter({ locale, timezone }: { locale: string; timezone: string }) {
  return <footer className="software-footer" aria-label="软件来源与版权">
    <SoftwareVersion locale={locale} timezone={timezone} />
    <span>© {productInfo.copyrightHolder}</span>
  </footer>;
}
