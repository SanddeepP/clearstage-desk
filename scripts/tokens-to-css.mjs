// Generates tokens.css from design/tokens.json (the brand book's tokens, copied verbatim).
// One source for the web app now and the phone app later. Light theme only in v1 (CTO, 12 Nov).
// Run: node scripts/tokens-to-css.mjs   (CI fails if tokens.css is out of date)
import { readFileSync, writeFileSync } from "node:fs";

export function tokensToCss(t, theme = "light") {
  const pick = v => (v && typeof v === "object") ? (v[theme] ?? Object.values(v)[0]) : v;
  const lines = [];
  for (const fam of ["color", "spacing", "radius", "shadow"]) for (const tok of t[fam]?.tokens ?? []) lines.push(`  --${tok.name}: ${pick(tok.value)};`);
  for (const [k, v] of Object.entries(t.type.families)) lines.push(`  --font-${k}: ${v};`);
  for (const g of t.type.groups) for (const s of g.styles) {
    lines.push(`  --type-${s.name}: ${s.fontWeight} ${s.fontSize}/${s.lineHeight} var(--font-${g.family});`);
    if (s.letterSpacing) lines.push(`  --type-${s.name}-tracking: ${s.letterSpacing};`);
  }
  // Brand-book font files are cut to Latin and have no ₹ (U+20B9). Each family gets a tiny ₹-only file
  // (from the same typeface, OFL) via unicode-range. JetBrains Mono has no ₹ in any release, so mono uses Inter's.
  const faces = t.type.fonts.map(f => {
    const base = f.file.replace(/^fonts\//, "fonts/");
    const rupee = f.family === "JetBrains Mono" ? `fonts/Inter-${f.weight === "500" ? "500" : "600"}-rupee.woff2` : base.replace(".woff2", "-rupee.woff2");
    return `@font-face { font-family: "${f.family}"; font-weight: ${f.weight}; font-style: normal; font-display: swap; src: url("${base}") format("woff2"); }\n` +
           `@font-face { font-family: "${f.family}"; font-weight: ${f.weight}; font-style: normal; font-display: swap; src: url("${rupee}") format("woff2"); unicode-range: U+20B9; }`;
  });
  return `/* ${t.name} — generated from design/tokens.json by scripts/tokens-to-css.mjs. Do not edit by hand. */\n${faces.join("\n")}\n:root {\n  color-scheme: light;\n${lines.join("\n")}\n}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const t = JSON.parse(readFileSync(new URL("../design/tokens.json", import.meta.url), "utf8"));
  writeFileSync(new URL("../tokens.css", import.meta.url), tokensToCss(t));
  console.log("tokens.css written");
}
