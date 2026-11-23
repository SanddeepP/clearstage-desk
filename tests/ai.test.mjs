import test from "node:test";
import assert from "node:assert/strict";
import { pickKey, toGemini, fromGemini, classify, geminiLLM, AiError, toGeminiSchema, replayKey, DEFAULT_MODEL } from "../supabase/functions/_shared/ai.js";

const ENV = { GEMINI_API_KEY: "free", GEMINI_API_KEY_QA: "qa", GEMINI_API_KEY_PAID: "paid" };

test("pickKey: sample company uses the free key, QA accounts the QA key", () => {
  assert.deepEqual(pickKey({ isSample: true, env: ENV }), { key: "free", tier: "free" });
  assert.deepEqual(pickKey({ isSample: true, isQa: true, env: ENV }), { key: "qa", tier: "free_qa" });
});
test("pickKey: a real company uses the paid key and never falls back to a free key", () => {
  assert.deepEqual(pickKey({ isSample: false, env: ENV }), { key: "paid", tier: "paid" });
  assert.throws(() => pickKey({ isSample: false, isQa: true, env: { GEMINI_API_KEY: "free", GEMINI_API_KEY_QA: "qa" } }), e => e instanceof AiError && e.code === "off");
  assert.throws(() => pickKey({ isSample: true, env: {} }), e => e.code === "off");
  assert.deepEqual(pickKey({ isSample: false, env: k => ENV[k] }), { key: "paid", tier: "paid" });
});
test("default model is gemini-3.5-flash-lite", () => assert.equal(DEFAULT_MODEL, "gemini-3.5-flash-lite"));

test("toGeminiSchema keeps the OpenAPI subset", () => {
  const s = toGeminiSchema({ type: "object", additionalProperties: false, properties: { a: { type: ["string", "null"], format: "email" }, b: { type: "array", items: { type: "integer", minimum: 1 } } }, required: ["a"] });
  assert.deepEqual(s, { type: "OBJECT", properties: { a: { type: "STRING", nullable: true }, b: { type: "ARRAY", items: { type: "INTEGER", minimum: 1 } } }, required: ["a"] });
});

test("tool-call round trip keeps names, ids and thought signatures", () => {
  const r1 = fromGemini({ candidates: [{ content: { parts: [{ thought: true, text: "hidden" }, { functionCall: { name: "find_people", args: { q: "x" }, id: "g1" }, thoughtSignature: "SIG" }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, thoughtsTokenCount: 2 } });
  assert.equal(r1.stop_reason, "tool_use");
  assert.deepEqual(r1.usage, { input_tokens: 10, output_tokens: 5 });
  assert.equal(r1.content.length, 1);
  const call = r1.content[0];
  assert.equal(call.name, "find_people"); assert.equal(call._gsig, "SIG"); assert.equal(call._gid, "g1");
  const body = toGemini({ system: "sys", max_tokens: 99, tools: [{ name: "find_people", description: "d", input_schema: { type: "object", properties: {} } }],
    messages: [{ role: "user", content: "hi" }, { role: "assistant", content: r1.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: JSON.stringify({ people: [] }) }] }] });
  assert.equal(body.systemInstruction.parts[0].text, "sys");
  assert.equal(body.generationConfig.maxOutputTokens, 99);
  assert.deepEqual(body.contents.map(c => c.role), ["user", "model", "user"]);
  assert.deepEqual(body.contents[1].parts[0], { functionCall: { name: "find_people", args: { q: "x" }, id: "g1" }, thoughtSignature: "SIG" });
  assert.deepEqual(body.contents[2].parts[0], { functionResponse: { name: "find_people", response: { people: [] }, id: "g1" } });
  assert.equal(body.tools[0].functionDeclarations[0].parameters.type, "OBJECT");
});
test("plain text answer ends the turn", () => {
  const r = fromGemini({ candidates: [{ content: { parts: [{ text: "Hello" }] }, finishReason: "STOP" }] });
  assert.deepEqual(r.content, [{ type: "text", text: "Hello" }]); assert.equal(r.stop_reason, "end_turn");
});

test("classify: busy, credit, off", () => {
  assert.equal(classify(429, "Resource has been exhausted (e.g. check quota). per minute", "paid"), "busy");
  assert.equal(classify(429, "Your prepayment credits are depleted. billing", "paid"), "credit");
  assert.equal(classify(429, "quota exceeded", "free"), "busy");
  assert.equal(classify(503, "overloaded", "paid"), "busy");
  assert.equal(classify(403, "billing account disabled", "paid"), "credit");
  assert.equal(classify(403, "permission denied", "paid"), "off");
  assert.equal(classify(400, "API key not valid. Please pass a valid API key.", "paid"), "off");
  assert.equal(classify(400, "bad schema", "paid"), null);
});

const res = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
test("geminiLLM retries when busy, then answers; sends key in a header, never the URL", async () => {
  const calls = []; let n = 0;
  const llm = geminiLLM({ key: "K", tier: "free", sleep: async () => {}, fetchImpl: async (url, init) => { calls.push({ url, init }); return n++ === 0 ? res(503, { error: "busy" }) : res(200, { candidates: [{ content: { parts: [{ text: "ok" }] } }] }); } });
  const out = await llm(undefined, { messages: [{ role: "user", content: "hi" }] });
  assert.equal(out.content[0].text, "ok"); assert.equal(calls.length, 2);
  assert.match(calls[0].url, /models\/gemini-3\.5-flash-lite:generateContent$/);
  assert.equal(calls[0].init.headers["x-goog-api-key"], "K"); assert.doesNotMatch(calls[0].url, /key=/);
});
test("geminiLLM: busy three times → AiError busy; paid credit → AiError credit at once", async () => {
  let n = 0;
  await assert.rejects(geminiLLM({ key: "K", tier: "free", sleep: async () => {}, fetchImpl: async () => { n++; return res(429, "rate limit"); } })("m", { messages: [] }), e => e.code === "busy");
  assert.equal(n, 3); n = 0;
  await assert.rejects(geminiLLM({ key: "K", tier: "paid", sleep: async () => {}, fetchImpl: async () => { n++; return res(429, "prepayment credits depleted (billing)"); } })("m", { messages: [] }), e => e.code === "credit");
  assert.equal(n, 1);
});
test("replayKey normalises", () => assert.equal(replayKey("  Who's   SHORTLISTED?? "), "who s shortlisted"));
