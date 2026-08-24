// Rupees and paise, in one place.
//
// Everything money-shaped on this platform is an INTEGER NUMBER OF PAISE, from
// the pack price to the collision offset to the amount parsed out of a bank
// SMS. Rupees exist only at the two edges where a person reads them: the QR's
// `am=` parameter and the screen. Both live here so neither can drift.
export function rupees(paise: number): string {
  const n = Math.trunc(paise);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** With the grouping a person expects: 123456789 → "12,34,567.89". Indian
 *  digit grouping, because this is priced in rupees and shown to players in
 *  India — 1,234,567 is the wrong shape here. */
export function rupeesPretty(paise: number): string {
  const [whole, fraction] = rupees(paise).split(".");
  const neg = whole.startsWith("-");
  const digits = neg ? whole.slice(1) : whole;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3;
  return `${neg ? "-" : ""}${grouped}.${fraction}`;
}
