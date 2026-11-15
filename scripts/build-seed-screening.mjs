// Builds seed/screening/seed-screening.json (shipped to the browser demo) from the generated CV files.
// For every CV it runs the real pipeline: extract text (unpdf / mammoth), mask, then checks the prepared
// evidence the same way model output is checked (verifyEvidence). Fails loudly if any prepared quote
// wouldn't survive verification, so the demo can't show evidence the live pipeline would throw away.
// The evidence is the seed cache: keyed by file hash + requirements version, exactly like a cached AI result.
import * as unpdf from "unpdf";
import mammoth from "mammoth";
import { readFileSync, writeFileSync } from "node:fs";
import { cvText } from "../lib/cvtext.js";
import { maskCv } from "../lib/mask.js";
import { verifyEvidence, sha256Hex, cacheKey, PROMPT_VERSION } from "../lib/evidence.js";
import { REQUIREMENTS } from "../seed/screening/requirements.js";

const dir = new URL("../seed/screening/", import.meta.url);
const profiles = JSON.parse(readFileSync(new URL("profiles.json", dir)));
const out = { prompt_version: PROMPT_VERSION, note: "Fictional people. Evidence prepared with the seed data and checked by the same code that checks AI output.", cvs: [] };
let problems = 0;
for (const p of profiles) {
  const bytes = new Uint8Array(readFileSync(new URL("files/" + p.file, dir)));
  const sha = await sha256Hex(bytes);
  const req = REQUIREMENTS[p.role];
  const t = await cvText(bytes, p.file, { unpdf, mammoth, node: true });
  const entry = { id: p.id, file: p.file, sha256: sha, role: p.role, name: p.name, source: p.source, referred: p.referred || null,
    applied_order: p.applied_order, readable: t.readable, reason: t.reason || null, band: p.band, injected: p.injected };
  if (t.readable) {
    const masked = maskCv(t.text, [p.name]).text;
    const v = verifyEvidence({ evidence: p.honest_evidence }, masked, req);
    const lost = v.dropped.filter(d => d.item);
    if (lost.length) { problems++; console.error(p.file, "prepared quotes that fail verification:", lost); }
    entry.cache_key = cacheKey(sha, req);
    entry.evidence = v.evidence; entry.roles = v.roles;
  } else if (p.format !== "scan") { problems++; console.error(p.file, "should be readable:", t.reason); }
  out.cvs.push(entry);
}
writeFileSync(new URL("seed-screening.json", dir), JSON.stringify(out, null, 1));
console.log(`${out.cvs.length} CVs, ${out.cvs.filter(c => !c.readable).length} unreadable, problems: ${problems}`);
if (problems) process.exit(1);
