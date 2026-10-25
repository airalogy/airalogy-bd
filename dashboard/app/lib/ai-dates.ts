export function initialDates(timezone: string) {
  const parts = new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const from = new Date(`${parts}T00:00:00Z`); from.setUTCDate(from.getUTCDate() - 6);
  return { from: from.toISOString().slice(0, 10), to: parts };
}
