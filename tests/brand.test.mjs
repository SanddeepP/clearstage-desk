import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { tokensToCss } from "../scripts/tokens-to-css.mjs";

const read = p => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const tokens = JSON.parse(read("design/tokens.json"));

test("tokens.css is generated from design/tokens.json and up to date", () => {
  assert.equal(read("tokens.css"), tokensToCss(tokens), "run: node scripts/tokens-to-css.mjs");
});

test("brand book v4 values: pencil 3:1 border, pencil-label for draft text", () => {
  const c = Object.fromEntries(tokens.color.tokens.map(t => [t.name, t.value.light]));
  assert.equal(c.teal, "#2F6F6A"); assert.equal(c.pencil, "#8792A3"); assert.equal(c["pencil-label"], "#5B6573");
  assert.equal(c.late, "#B42318"); assert.equal(c.ontime, "#1E6B47"); assert.equal(c.clock, "#8A4F0F");
});

test("light mode only in v1, and no hand-typed hex colours outside the tokens", () => {
  const css = read("styles.css");
  assert.ok(!/prefers-color-scheme|data-theme/.test(css));
  const hex = (css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []);
  assert.deepEqual([...new Set(hex)].sort(), ["#D9F0DF", "#EEF2EF", "#FFFFFF"], "only the WhatsApp preview's own colours");
});

test("every font file the tokens name is self-hosted, each with a ₹ companion", () => {
  const css = read("tokens.css");
  for (const url of css.match(/fonts\/[\w-]+\.woff2/g)) assert.ok(existsSync(new URL("../" + url, import.meta.url)), url);
  assert.equal((css.match(/unicode-range: U\+20B9/g) ?? []).length, tokens.type.fonts.length);
  assert.ok(!read("index.html").includes("fonts.googleapis.com"), "no Google Fonts call");
});
