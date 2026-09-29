// Exact decimal arithmetic for the few sums the bot shows members (points ×
// price). Prices are decimal strings ("0.1"); in binary floating point
// 3 × 0.1 is 0.30000000000000004, so values are held as a BigInt with a
// decimal scale instead: "0.1" is {digits: 1n, scale: 1}.

// {digits, scale} for a decimal string or finite number ("0.25", "3", 3,
// 1e-7), or null when it is not one.
function parseDecimal(value) {
  const text = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : String(value ?? "").trim();
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match || (match[2] + (match[3] || "")) === "") return null;
  const [, sign, whole, fraction = "", exponent = "0"] = match;
  let digits = BigInt(whole + fraction || "0");
  let scale = fraction.length - Number(exponent);
  if (scale < 0) {
    digits *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return {digits: sign === "-" ? -digits : digits, scale};
}

// The canonical string: no exponent, no trailing zeros, no "-0".
function formatDecimal({digits, scale}) {
  const negative = digits < 0n;
  let text = (negative ? -digits : digits).toString().padStart(scale + 1, "0");
  if (scale > 0) text = `${text.slice(0, -scale)}.${text.slice(-scale)}`.replace(/\.?0+$/, "");
  return (negative && text !== "0" ? "-" : "") + text;
}

function align(a, b) {
  const scale = Math.max(a.scale, b.scale);
  return [a.digits * 10n ** BigInt(scale - a.scale), b.digits * 10n ** BigInt(scale - b.scale), scale];
}

// decimalMul(3, "0.1") === "0.3"; null when either side is not a decimal.
export function decimalMul(a, b) {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  if (!x || !y) return null;
  return formatDecimal({digits: x.digits * y.digits, scale: x.scale + y.scale});
}

// decimalSub(10, 2.5) === "7.5"; null when either side is not a decimal.
export function decimalSub(a, b) {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  if (!x || !y) return null;
  const [dx, dy, scale] = align(x, y);
  return formatDecimal({digits: dx - dy, scale});
}

// True for a decimal strictly above zero.
export function isPositiveDecimal(value) {
  return (parseDecimal(value)?.digits ?? 0n) > 0n;
}
