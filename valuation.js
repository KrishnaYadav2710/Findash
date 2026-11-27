function number(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number.`);
  return n;
}

export function runDCF(input = {}) {
  const cashFlow = number(input.cashFlow ?? input.fcf, "Cash flow");
  const growth = number(input.growth ?? 0.05, "Growth") / (Number(input.growth) > 1 ? 100 : 1);
  const discount = number(input.discountRate ?? 0.1, "Discount rate") / (Number(input.discountRate) > 1 ? 100 : 1);
  const terminalGrowth = number(input.terminalGrowth ?? 0.02, "Terminal growth") / (Number(input.terminalGrowth) > 1 ? 100 : 1);
  if (discount <= terminalGrowth) throw new Error("Discount rate must exceed terminal growth.");
  const years = Math.max(1, Math.floor(number(input.years ?? 5, "Years")));
  let value = 0;
  for (let year = 1; year <= years; year += 1) value += cashFlow * (1 + growth) ** year / (1 + discount) ** year;
  value += cashFlow * (1 + growth) ** years * (1 + terminalGrowth) / (discount - terminalGrowth) / (1 + discount) ** years;
  return { ok: true, enterpriseValue: value, assumptions: { cashFlow, growth, discount, terminalGrowth, years } };
}

export function reverseDCF(input = {}) {
  const target = number(input.targetValue ?? input.enterpriseValue, "Target value");
  const cashFlow = number(input.cashFlow ?? input.fcf, "Cash flow");
  return { ok: true, targetValue: target, cashFlow, note: "Reverse DCF requires explicit assumptions; use the forward DCF for valuation output." };
}
