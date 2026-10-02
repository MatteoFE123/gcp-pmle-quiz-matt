import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  parseQuestions, parseProducts, validateQuestion, validateState, emptyState, eligibleQuestions,
  startRound, selectAnswer, submitAnswer, finishRound, resetProgress, importData, applyImport,
  catalogStats, topicStatistics, rankedTopics, exportMarkdown, productConnections, effectiveQuestions,
} from "../../web/core.js";

const single = { id: 10001, mode: "single_choice", question: "Ejemplo único", options: ["A", "B", "C"], answer: 1, explanation: "Explicación", gcp_topics: ["Datos", "Datos"], gcp_products: [], ml_topics: [], source_note: "conservar" };
const multi = { ...single, id: 10002, mode: "multiple_choice", question: "Ejemplo múltiple", answer: [0, 2], gcp_topics: ["Modelos"] };
const bank = [single, multi];
const lines = rows => rows.map(q => JSON.stringify(q)).join("\n");

test("strict schema, duplicate IDs and legacy normalization without source mutation", () => {
  const original = { ...multi, answer: 1 };
  assert.deepEqual(parseQuestions(lines([original]))[0].answer, [1]);
  assert.equal(original.answer, 1);
  assert.throws(() => parseQuestions(lines([single, single])));
  assert.throws(() => parseQuestions("{bad}"), /línea 1/);
  assert.throws(() => parseQuestions("null"));
  for (const answer of [-1, 4, true, "1", [1]]) assert.throws(() => validateQuestion({ ...single, answer }));
  for (const answer of [[], [0, 0], [3], [false]]) assert.throws(() => validateQuestion({ ...multi, answer }));
  assert.equal(validateQuestion(single).source_note, "conservar");
});

test("real banks validate without changing their content", async () => {
  const questions = parseQuestions(await readFile("data/quizzes.jsonl", "utf8"));
  assert.equal(questions.length, 841);
  assert.equal(parseProducts(await readFile("data/gcp_products.jsonl", "utf8")).length, 104);
});

test("status and topic filters are independent", () => {
  const progress = { 10001: false, 10002: true };
  assert.deepEqual(eligibleQuestions(bank, progress, ["Falladas"]), [single]);
  assert.deepEqual(eligibleQuestions(bank, progress, ["Acertadas"], ["Modelos"]), [multi]);
  assert.equal(eligibleQuestions(bank, progress, ["Pendientes"]).length, 0);
  assert.equal(eligibleQuestions(bank, {}, []).length, 0);
  assert.equal(eligibleQuestions(bank, {}, ["Pendientes"]).length, 2);
});

test("round sampling preserves bank, bounds and snapshots", () => {
  const s = emptyState(), original = structuredClone(bank);
  startRound(s, bank, 20, () => 0.2);
  assert.equal(s.round.questions.length, 2);
  assert.equal(new Set(s.round.questions.map(q => q.id)).size, 2);
  assert.deepEqual(bank, original);
  s.round.questions[0].explanation = "snapshot";
  assert.deepEqual(bank, original);
  assert.throws(() => startRound(s, bank, 1));
});

test("answers cannot change after submission, and skips do not become failures", () => {
  const s = emptyState();
  startRound(s, bank, 2, () => .99);
  assert.throws(() => submitAnswer(s), /Selecciona/);
  selectAnswer(s, s.round.id, 0, [1]);
  submitAnswer(s);
  assert.throws(() => selectAnswer(s, s.round.id, 0, [0]));
  assert.throws(() => submitAnswer(s));
  assert.deepEqual(s.progress, {});
  finishRound(s, true);
  assert.deepEqual(s.progress, { 10001: true });
  assert.equal(s.round, null);
});

test("multiple choice requires exact set, and backwards review preserves later answers", () => {
  const s = emptyState();
  startRound(s, bank, 2, () => .99);
  s.round.position = 1;
  selectAnswer(s, s.round.id, 1, [2]);
  submitAnswer(s);
  assert.equal(s.round.results[1], false);
  s.round.position = 0;
  validateState(s);
  selectAnswer(s, s.round.id, 0, [1]);
  submitAnswer(s);
  finishRound(s, true);
  assert.deepEqual(s.progress, { 10001: true, 10002: false });
});

test("discard/reset preserve intended scopes", () => {
  const s = emptyState();
  s.progress[10001] = true;
  s.edits[10001] = structuredClone(single);
  startRound(s, bank, 1);
  assert.throws(() => resetProgress(s), /ronda/);
  finishRound(s, false);
  assert.equal(s.progress[10001], true);
  resetProgress(s);
  assert.deepEqual(s.progress, {});
  assert.equal(s.edits[10001].source_note, "conservar");
});

test("state rejects corrupt versions, indices, fabricated scores and null", () => {
  assert.throws(() => validateState(null));
  assert.throws(() => validateState({ ...emptyState(), version: 2 }));
  assert.throws(() => validateState({ ...emptyState(), progress: { 1: "true" } }));
  assert.throws(() => validateState({ ...emptyState(), edits: { 1: null } }));
  const s = emptyState();
  startRound(s, [multi], 1);
  selectAnswer(s, s.round.id, 0, [2, 0]);
  submitAnswer(s);
  assert.equal(s.round.results[0], true);
  validateState(s);
  s.round.results[0] = false;
  assert.throws(() => validateState(s), /puntuación/);
});

test("validation normalizes optional fields without mutating the source", () => {
  const value = { ...emptyState(), edits: { 10001: { ...single } } };
  delete value.edits[10001].gcp_topics;
  const normalized = validateState(value);
  assert.deepEqual(normalized.edits[10001].gcp_topics, []);
  assert.equal(Object.hasOwn(value.edits[10001], "gcp_topics"), false);
});

test("imports legacy progress and full backups with strict validation", () => {
  for (const value of ["null", "[]", '{"1":0}', '{"01":true}', '{"1":"false"}', '{"__proto__":true}']) assert.throws(() => importData(value));
  const s = emptyState();
  applyImport(s, importData('{"10001":false,"10002":true}'));
  assert.equal(s.progress[10001], false);
  startRound(s, bank, 1);
  const data = importData(JSON.stringify({ app: "pmle-study", state: s }));
  assert.throws(() => applyImport(s, data));
  const target = emptyState();
  applyImport(target, data);
  assert.deepEqual(target.round, s.round);
  assert.equal(target.revision, 0);
});

test("statistics count unique tags and rank before limiting", () => {
  const questions = [single, multi, { ...multi, id: 10003 }];
  const p = { 10001: true, 10002: false, 10003: false, 99: true };
  assert.deepEqual(catalogStats(questions, p), { total: 3, correct: 1, wrong: 2, unanswered: 0 });
  const stats = topicStatistics(questions, p, "gcp_topics");
  assert.equal(stats.find(t => t.topic === "Datos").attempts, 1);
  assert.equal(rankedTopics(stats, "gap", 1)[0].topic, "Modelos");
});

test("edits preserve metadata and exports match selected scope", () => {
  const edited = { ...single, explanation: "Nueva" };
  const questions = effectiveQuestions(bank, { 10001: edited });
  const wrong = eligibleQuestions(questions, { 10001: false }, ["Falladas"]);
  const output = exportMarkdown(wrong, "Falladas");
  assert.match(output, /10001/);
  assert.doesNotMatch(output, /10002/);
  assert.match(output, /Nueva/);
  assert.doesNotMatch(exportMarkdown(wrong, "Falladas", false), /Nueva/);
  assert.equal(questions[0].source_note, "conservar");
});

test("product connection counts deduplicate and handle empty catalogs", () => {
  assert.deepEqual(productConnections([]), []);
  assert.deepEqual(productConnections([{ connected_to: [" GCP  API ", "GCP API"] }, { connected_to: [] }]), [["GCP API", 1]]);
});
