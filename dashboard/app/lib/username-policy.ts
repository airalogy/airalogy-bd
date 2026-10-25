export const usernamePattern = "[a-zA-Z0-9][a-zA-Z0-9._]{2,29}";
export const usernameHelp = "3–30 位字母、数字、点或下划线，以字母或数字开头，不区分大小写。设置后保留不变。";
export function normalizeUsername(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
export function validUsername(value: string) {
  return /^[a-z0-9][a-z0-9._]{2,29}$/.test(value);
}
