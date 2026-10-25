"use client";
import { createContext, useContext, useState } from "react";

type Branding = { name: string; logo: string };
const Context = createContext<Branding>({ name: "Airalogy BD", logo: "/airalogy-logo.svg" });
export function BrandingProvider({ value, children }: { value: Branding; children: React.ReactNode }) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function BrandLogo() {
  const brand = useContext(Context);
  const [failed, setFailed] = useState(false);
  // A small, same-origin logo; never request a third-party image from the login page.
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="site-brand-logo" src={failed ? "/airalogy-logo.svg" : brand.logo} alt="" aria-hidden="true" onError={() => setFailed(true)} />;
}
export function BrandIdentity() {
  const brand = useContext(Context);
  return <span className="site-brand-identity"><BrandLogo /><span>{brand.name}</span></span>;
}
