import { LANGUAGES, LocalizedError, t } from "./i18n.js";

export const STATUSES = ["Pendientes", "Falladas", "Acertadas"];
export const TOPICS = { "Temas GCP": "gcp_topics", Productos: "gcp_products", "Machine learning": "ml_topics" };
const own = (value, key) => Object.hasOwn(value, key);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const positiveId = value => /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));

export function requireValid(condition, message, values) {
  if (!condition) throw new LocalizedError(message, values);
}

export function validateQuestion(value, legacy = false) {
  requireValid(object(value), "La pregunta no es un objeto válido.");
  const q = structuredClone(value);
  requireValid(Number.isSafeInteger(q.id) && q.id > 0, "Identificador de pregunta inválido.");
  requireValid(["single_choice", "multiple_choice"].includes(q.mode), "Modo inválido en la pregunta {id}.", { id: q.id });
  requireValid(typeof q.question === "string" && q.question.trim(), "Enunciado vacío en la pregunta {id}.", { id: q.id });
  for (const field of ["options", "gcp_topics", "gcp_products", "ml_topics"]) {
    if (field !== "options" && q[field] === undefined) q[field] = [];
    requireValid(Array.isArray(q[field]) && q[field].every(s => typeof s === "string" && s.trim()), "Lista {field} inválida en la pregunta {id}.", { field, id: q.id });
  }
  requireValid(q.options.length > 0, "La pregunta {id} no tiene opciones.", { id: q.id });
  requireValid(q.explanation == null || typeof q.explanation === "string", "Explicación inválida.");
  if (legacy && q.mode === "multiple_choice" && Number.isInteger(q.answer)) q.answer = [q.answer];
  requireValid(q.mode === "single_choice" ? Number.isInteger(q.answer) : Array.isArray(q.answer), "Formato de respuesta inválido.");
  const answers = correctAnswers(q);
  validateSelection(q, answers);
  requireValid(answers.length > 0, "Selecciona al menos una respuesta correcta.");
  return q;
}

function parseLines(text) {
  return text.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; }
    catch { throw new LocalizedError("JSON inválido en la línea {line}.", { line: index + 1 }); }
  });
}

export function parseQuestions(text) {
  const ids = new Set();
  const questions = parseLines(text).map(value => {
    if (value?.mode === "multiple_choice" && Number.isInteger(value.answer)) {
      console.warn(`Respuesta múltiple heredada normalizada en memoria: ${value.id}.`);
    }
    const q = validateQuestion(value, true);
    requireValid(!ids.has(q.id), "Identificador duplicado: {id}.", { id: q.id });
    ids.add(q.id);
    return q;
  });
  requireValid(questions.length > 0, "El banco de preguntas está vacío.");
  return questions;
}

export function parseProducts(text) {
  const names = new Set();
  return parseLines(text).map(row => {
    requireValid(object(row) && typeof row.product_name === "string" && row.product_name.trim(), "Nombre de producto inválido.");
    requireValid(!names.has(row.product_name), "Nombre de producto duplicado.");
    names.add(row.product_name);
    for (const field of ["ui", "connected_to", "use_cases", "not_used_when"]) {
      row[field] ??= [];
      requireValid(Array.isArray(row[field]) && row[field].every(s => typeof s === "string"), "Campo {field} inválido.", { field });
    }
    for (const field of ["entity_type", "short_description"]) {
      row[field] ??= "";
      requireValid(typeof row[field] === "string", "Campo {field} inválido.", { field });
    }
    return row;
  });
}

export const correctAnswers = q => Array.isArray(q.answer) ? q.answer : [q.answer];
export const questionStatus = (q, progress) => !own(progress, q.id) ? "Pendientes" : progress[q.id] ? "Acertadas" : "Falladas";
export const effectiveQuestions = (bank, edits) => bank.map(q => edits[q.id] ?? q);
export const eligibleQuestions = (bank, progress, statuses, topics = []) => bank.filter(q =>
  statuses.includes(questionStatus(q, progress)) && (!topics.length || q.gcp_topics.some(t => topics.includes(t))));

export function validateSelection(q, selected) {
  requireValid(Array.isArray(selected) && selected.every(i => Number.isInteger(i) && i >= 0 && i < q.options.length), "Selección de respuesta inválida.");
  requireValid(new Set(selected).size === selected.length, "Una opción no puede repetirse.");
  requireValid(q.mode !== "single_choice" || selected.length <= 1, "Selecciona una sola respuesta.");
}

export function isCorrect(q, selected) {
  const answer = correctAnswers(q);
  return answer.length === selected.length && answer.every(i => selected.includes(i));
}

export function validateProgress(progress) {
  requireValid(object(progress), "El progreso debe ser un objeto de identificadores y resultados.");
  requireValid(Object.entries(progress).every(([id, value]) => positiveId(id) && typeof value === "boolean"), "El progreso contiene identificadores o resultados inválidos.");
  return progress;
}

export function emptyState() {
  return { version: 1, revision: 0, progress: {}, round: null, edits: {}, theme: "dark", language: "es" };
}

export function validateState(value) {
  const s = structuredClone(value);
  requireValid(object(s) && s.version === 1, "Formato de copia no compatible. No se han sobrescrito tus datos.");
  requireValid(Number.isSafeInteger(s.revision) && s.revision >= 0, "Revisión de datos inválida.");
  requireValid(["dark", "light"].includes(s.theme), "Tema inválido.");
  if (!own(s, "language")) s.language = "es";
  requireValid(typeof s.language === "string" && own(LANGUAGES, s.language), "Idioma no compatible.");
  validateProgress(s.progress);
  requireValid(object(s.edits), "Ediciones inválidas.");
  for (const [id, q] of Object.entries(s.edits)) {
    requireValid(positiveId(id) && object(q) && Number(id) === q.id, "Identificador de edición inválido.");
    s.edits[id] = validateQuestion(q);
  }
  if (s.round !== null) {
    const r = s.round;
    requireValid(object(r) && typeof r.id === "string" && r.id.length > 0, "Ronda inválida.");
    requireValid(Array.isArray(r.questions) && r.questions.length > 0, "La ronda no tiene preguntas.");
    r.questions = r.questions.map(q => validateQuestion(q));
    requireValid(new Set(r.questions.map(q => q.id)).size === r.questions.length, "La ronda contiene preguntas repetidas.");
    requireValid(Number.isInteger(r.position) && r.position >= 0 && r.position <= r.questions.length, "Posición de ronda inválida.");
    requireValid(object(r.selections) && object(r.results), "Respuestas de ronda inválidas.");
    for (const [index, selection] of Object.entries(r.selections)) {
      requireValid(/^(0|[1-9]\d*)$/.test(index) && Number(index) < r.questions.length, "Posición de respuesta inválida.");
      validateSelection(r.questions[index], selection);
    }
    for (const [index, result] of Object.entries(r.results)) {
      requireValid(own(r.selections, index) && r.selections[index].length > 0 && typeof result === "boolean", "Resultado sin respuesta válida.");
      requireValid(result === isCorrect(r.questions[index], r.selections[index]), "La puntuación no coincide con la respuesta.");
    }
  }
  return s;
}

export function startRound(s, candidates, limit, rng = Math.random) {
  requireValid(s.round === null, "Termina o descarta la ronda pendiente primero.");
  requireValid(candidates.length > 0 && Number.isInteger(limit) && limit > 0, "No hay preguntas para esta ronda.");
  const pool = structuredClone(candidates);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  s.round = { id: crypto.randomUUID(), questions: pool.slice(0, limit), position: 0, selections: {}, results: {} };
}

export function selectAnswer(s, id, pos, selected) {
  requireValid(s.round?.id === id && s.round.position === pos, "La pregunta ha cambiado. Vuelve a abrir la ronda.");
  requireValid(!own(s.round.results, pos), "La respuesta enviada ya no se puede cambiar.");
  validateSelection(s.round.questions[pos], selected);
  s.round.selections[pos] = [...selected];
}

export function submitAnswer(s) {
  const r = s.round;
  requireValid(r && r.position < r.questions.length, "No hay una pregunta activa.");
  requireValid(!own(r.results, r.position), "Esta pregunta ya está corregida.");
  const selected = r.selections[r.position] ?? [];
  requireValid(selected.length > 0, "Selecciona al menos una respuesta antes de enviarla.");
  r.results[r.position] = isCorrect(r.questions[r.position], selected);
}

export function finishRound(s, save) {
  requireValid(s.round, "No hay una ronda pendiente.");
  if (save) {
    requireValid(Object.keys(s.round.results).length > 0, "No hay resultados para guardar.");
    for (const [pos, result] of Object.entries(s.round.results)) s.progress[s.round.questions[pos].id] = result;
  }
  s.round = null;
}

export function resetProgress(s) {
  requireValid(s.round === null, "Guarda o descarta la ronda pendiente antes de reiniciar el historial.");
  s.progress = {};
}

export function importData(text) {
  let data;
  try { data = JSON.parse(text); }
  catch { throw new LocalizedError("El archivo no contiene JSON válido."); }
  if (data?.app === "pmle-study") return { kind: "backup", state: validateState(data.state) };
  return { kind: "progress", progress: validateProgress(data) };
}

export function applyImport(s, data) {
  requireValid(s.round === null, "Guarda o descarta la ronda pendiente antes de importar.");
  if (data.kind === "backup") {
    const restored = structuredClone(validateState(data.state));
    s.progress = restored.progress;
    s.edits = restored.edits;
    s.round = restored.round;
    s.theme = restored.theme;
    s.language = restored.language;
  } else s.progress = structuredClone(validateProgress(data.progress));
}

export function catalogStats(bank, progress) {
  const answered = bank.filter(q => own(progress, q.id));
  const correct = answered.filter(q => progress[q.id]).length;
  return { total: bank.length, correct, wrong: answered.length - correct, unanswered: bank.length - answered.length };
}

export function topicStatistics(bank, progress, field) {
  const rows = new Map();
  for (const q of bank) {
    if (!own(progress, q.id)) continue;
    for (const topic of new Set(q[field])) {
      const row = rows.get(topic) ?? { topic, attempts: 0, correct: 0 };
      row.attempts++;
      row.correct += Number(progress[q.id]);
      rows.set(topic, row);
    }
  }
  return [...rows.values()].map(r => ({ ...r, accuracy: r.correct / r.attempts, gap: 1 - r.correct / r.attempts }));
}

export function rankedTopics(rows, sort = "gap", limit = 10) {
  return [...rows].sort((a, b) => (sort === "accuracy" ? a.accuracy - b.accuracy : b[sort] - a[sort]) || a.topic.localeCompare(b.topic)).slice(0, limit);
}

export function productConnections(rows) {
  const counts = new Map();
  for (const row of rows) {
    for (const value of new Set(row.connected_to.map(v => v.trim().replace(/\s+/g, " ")))) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export const optionText = (q, index) => q.options[index].replace(new RegExp(`^\\s*${String.fromCharCode(65 + index)}[.)]\\s+`), "");
export const answerLabel = (q, index) => `${String.fromCharCode(65 + index)}. ${optionText(q, index)}`;
export function exportMarkdown(questions, title, explanations = true) {
  const lines = [`# ${title}`, "", t("Material de repaso personal. El contenido conserva su idioma original."), ""];
  for (const q of questions) {
    lines.push(`## ${t("Pregunta #{id}", { id: q.id })}`, "", q.question, "", `### ${t("Opciones")}`, ...q.options.map((_, i) => answerLabel(q, i)), "", `### ${t("Respuesta correcta")}`, ...correctAnswers(q).map(i => answerLabel(q, i)));
    if (explanations && q.explanation) lines.push("", `### ${t("Explicación")}`, "", q.explanation);
    lines.push("", "---", "");
  }
  return lines.join("\n");
}
