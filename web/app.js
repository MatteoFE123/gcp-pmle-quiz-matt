import DOMPurify from "dompurify";
import { marked } from "marked";
import {
  STATUSES, TOPICS, parseQuestions, parseProducts, correctAnswers, validateQuestion,
  validateState, eligibleQuestions, effectiveQuestions, catalogStats, topicStatistics,
  rankedTopics, startRound, selectAnswer, submitAnswer, finishRound, resetProgress,
  importData, applyImport, exportMarkdown, productConnections, requireValid, optionText,
} from "./core.js";
import { openStorage, readStorage, writeStorage, recoverStorage } from "./storage.js";
import { LANGUAGES, LocalizedError, setLanguage, t } from "./i18n.js";
import "./style.css";

const main = document.querySelector("#main");
const notice = document.querySelector("#notice");
const routes = ["Inicio", "Quiz_Mode", "Progress", "GCP_Products", "Export_for_LM", "Edit_Questions"];
let db, state, bank, products, queue = Promise.resolve();
let editing = null, pendingImport = null, activeRoute = "Inicio";
const settings = {
  statuses: ["Pendientes"], topics: [], length: 20,
  field: "gcp_topics", analysis: "repaso", sort: "gap", minimum: 1, maximum: 100, limit: 10,
  search: "", focused: [], product: "", productView: "Ficha", connections: 10,
  exportScope: "Falladas", explanations: true, editorId: null,
};
const h = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const selected = (a, b) => a === b ? " selected" : "";
const checked = value => value ? " checked" : "";
const disabled = value => value ? " disabled" : "";
const options = (values, value, label = v => v) => values.map(v => `<option value="${h(v)}"${selected(v, value)}>${h(label(v))}</option>`).join("");
const multiple = (values, chosen) => values.map(v => `<option${chosen.includes(v) ? " selected" : ""}>${h(v)}</option>`).join("");
const heading = (title, description) => `<h1 tabindex="-1">${h(title)}</h1><p class="lead">${h(description)}</p>`;
const message = text => `<p class="message">${h(text)}</p>`;
const button = (action, label, primary = false, off = false) => `<button type="button" data-action="${action}"${primary ? ' class="primary"' : ""}${disabled(off)}>${h(label)}</button>`;
const allQuestions = () => effectiveQuestions(bank, state.edits);
const topicNames = () => [...new Set(allQuestions().flatMap(q => q.gcp_topics))].sort();
const route = () => routes.includes(location.hash.slice(1)) ? location.hash.slice(1) : "Inicio";
const exportTitle = (scope = settings.exportScope) => t(`Preguntas ${scope.toLowerCase()}`);

function rich(text) {
  const fragment = DOMPurify.sanitize(marked.parse(text ?? "", { async: false }), {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ["p", "br", "ul", "ol", "li", "strong", "b", "em", "i", "a", "span", "code", "pre", "div", "img", "table", "thead", "tbody", "tr", "td", "th", "h2", "h3", "h4", "blockquote", "sup", "sub", "hr"],
    ALLOWED_ATTR: ["href", "src", "alt", "title", "colspan", "rowspan"],
  });
  for (const image of fragment.querySelectorAll("img")) {
    const raw = (image.getAttribute("src") ?? "").replace(/^app\/static\//, "static/");
    let url;
    try { url = new URL(raw, document.baseURI); }
    catch {
      image.replaceWith(document.createTextNode(t("[Dirección de imagen no válida]")));
      continue;
    }
    const localImages = new URL("static/images/", document.baseURI);
    if (url.origin !== localImages.origin || !url.pathname.startsWith(localImages.pathname)) {
      image.replaceWith(document.createTextNode(t("[Imagen externa no cargada]")));
      continue;
    }
    image.src = url.href;
    image.loading = "lazy";
    image.alt ||= t("Ilustración de la pregunta");
  }
  for (const link of fragment.querySelectorAll("a")) {
    let url;
    try { url = new URL(link.getAttribute("href") ?? "", document.baseURI); }
    catch {
      link.removeAttribute("href");
      continue;
    }
    if (!["https:", "http:"].includes(url.protocol)) link.removeAttribute("href");
    else {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
  }
  const wrapper = document.createElement("div");
  wrapper.append(fragment);
  return wrapper.innerHTML;
}

function showNotice(text, error = false) {
  notice.innerHTML = text ? `<div class="message${error ? " error" : ""}"${error ? ' role="alert"' : ""}>${h(text)}${error && state ? ` <button type="button" data-action="reload">${t("Recargar datos")}</button>` : ""}</div>` : "";
}

function report(error) {
  console.error(error);
  showNotice(error instanceof LocalizedError ? t(error.key, error.values) : error.message || t("Ha ocurrido un error. Tus datos no se han borrado."), true);
}

function applyTheme() {
  setLanguage(state.language ?? "es");
  document.documentElement.lang = state.language ?? "es";
  document.documentElement.dataset.theme = state.theme;
  document.querySelector("#theme").textContent = state.theme === "dark" ? t("Tema claro") : t("Tema oscuro");
  document.querySelector("#theme").setAttribute("aria-label", t("Cambiar tema"));
  document.querySelector("#language-label").textContent = t("Idioma");
  document.querySelector("#language").value = state.language ?? "es";
  document.querySelector("#language").disabled = false;
  document.querySelector("nav").setAttribute("aria-label", t("Navegación principal"));
  const labels = ["Inicio", "Práctica", "Progreso", "Productos", "Exportar", "Editar preguntas"];
  document.querySelectorAll("nav a").forEach((link, i) => { link.textContent = t(labels[i]); });
  document.querySelector(".skip-link").textContent = t("Saltar al contenido");
  document.querySelector("#footer-disclaimer").textContent = t("Preparación personal para Google Cloud PMLE. No es un producto oficial de Google.");
  document.querySelector("#footer-storage").textContent = t("Tu progreso se guarda en este navegador, no en GitHub.");
  document.querySelector("#language-help").textContent = t("El idioma cambia la interfaz. Las preguntas, explicaciones y fichas conservan su texto original.");
}

function mutate(change, success = "", repaint = true) {
  queue = queue.then(async () => {
    state = await writeStorage(db, state.revision, change);
    applyTheme();
    if (repaint) render();
    showNotice(typeof success === "function" ? success() : success);
    return true;
  }).catch(error => {
    applyTheme();
    render();
    report(error);
    return false;
  });
  return queue;
}

function download(name, content, type = "application/json") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function metrics(stats) {
  return `<div class="metrics">${[[t("Preguntas"), stats.total], [t("Pendientes"), stats.unanswered], [t("Aciertos"), stats.correct], [t("Fallos"), stats.wrong]].map(([label, value]) => `<div class="metric"><strong>${value}</strong><span>${label}</span></div>`).join("")}</div>`;
}

function explanation(q) {
  return `<h3>${t("Respuesta correcta")}</h3>${correctAnswers(q).map(i => optionContent(q, i)).join("")}
    <h3>${t("Explicación")}</h3><div class="rich">${q.explanation ? rich(q.explanation) : `<p>${t("No hay explicación registrada.")}</p>`}</div>`;
}

function optionContent(q, i) {
  return `<div class="answer-copy"><strong>${String.fromCharCode(65 + i)}.</strong><div class="rich">${rich(optionText(q, i))}</div></div>`;
}

function home() {
  const questions = allQuestions();
  const stats = catalogStats(questions, state.progress);
  const weak = rankedTopics(topicStatistics(questions, state.progress, "gcp_topics").filter(t => t.gap > 0), "gap", 1)[0];
  return heading(t("Tu próxima sesión de estudio"), t("Practica a tu ritmo para Google Cloud Professional Machine Learning Engineer."))
    + `<section class="panel"><h2>${state.round ? t("Tienes una ronda pendiente") : t("Un poco de práctica, cada día")}</h2>
      <p>${state.round ? t("{done} de {total} preguntas respondidas. Continúa donde lo dejaste.", { done: Object.keys(state.round.results).length, total: state.round.questions.length }) : t("Elige una sesión corta, repasa tus fallos o céntrate en un tema.")}</p>
      <a class="button primary" href="#Quiz_Mode">${state.round ? t("Continuar ronda") : t("Preparar práctica")}</a></section>
      <h2>${t("Tu banco de preguntas")}</h2>${metrics(stats)}
      <p class="caption">${t("Se muestra el último resultado guardado de cada pregunta. No es una predicción de la nota del examen.")}</p>
      ${weak ? `<h2>${t("Un tema para tu próximo repaso")}</h2><p>${h(weak.topic)}</p><p class="caption">${t("Con pocas preguntas, esta recomendación es orientativa.")}</p>${button("weak", t("Practicar este tema"))}` : message(stats.correct + stats.wrong ? t("No hay temas con fallos registrados. Puedes practicar preguntas pendientes o reforzar tus aciertos.") : t("Guarda una ronda para descubrir qué temas necesitas repasar."))}
      <h2>${t("Tus datos, en este navegador")}</h2>
      <p class="muted">${t("No se sincronizan entre dispositivos. Si borras los datos del sitio, perderás el progreso y las ediciones locales. Descarga una copia para conservarlos.")}</p>
      <details><summary>${t("Copias, importación y reinicio")}</summary>
        <div class="actions">${button("backup", t("Descargar copia completa"))}${button("progress-download", t("Descargar progreso"))}${button("previous-backup", t("Descargar copia anterior"))}</div>
        <p class="caption">${t("La copia completa incluye progreso, ronda pendiente y ediciones. También puedes importar el archivo progress.json de Streamlit. Nunca se publica tu historial.")}</p>
        <label class="field">${t("Importar una copia o progreso")}<input id="import-file" type="file" accept=".json,application/json" data-change="import"></label>
        ${pendingImport ? `<p>${pendingImport.kind === "backup" ? t("Copia completa válida. Reemplazará el progreso, las ediciones y la ronda.") : t("{count} resultados válidos. Reemplazarán el historial actual; las ediciones no cambian.", { count: Object.keys(pendingImport.progress).length })}</p><div class="actions">${button("import-confirm", t("Confirmar importación"), true, !!state.round)}${button("import-cancel", t("Cancelar importación"))}</div>` : ""}
        ${state.round ? message(t("Guarda o descarta la ronda pendiente antes de importar o reiniciar el historial.")) : ""}
        <p class="caption">${t("El reinicio borra solo el historial; conserva preguntas y ediciones. La copia anterior se sustituye en cada guardado.")}</p>
        <label class="check"><input id="reset-confirm" type="checkbox" data-change="reset-confirm"${disabled(!!state.round)}>${t("Quiero borrar mi historial guardado")}</label>
        ${button("reset", t("Reiniciar historial"), false, true)}
      </details>`;
}

function setup() {
  const candidates = eligibleQuestions(allQuestions(), state.progress, settings.statuses, settings.topics);
  const count = Math.min(settings.length, candidates.length);
  return `<h2>${t("Prepara una sesión")}</h2><p>${t("Las preguntas se mezclan sin repetirse dentro de la ronda.")}</p>
    <form data-form="start" class="panel">
      <fieldset><legend>${t("Estado de las preguntas")}</legend><div class="choices">${STATUSES.map(status => `<label class="check"><input type="checkbox" data-change="status" value="${status}"${checked(settings.statuses.includes(status))}>${t(status)}</label>`).join("")}</div></fieldset>
      <div class="grid"><label class="field">${t("Temas GCP (opcional)")}<select id="topics" multiple data-change="topics" aria-describedby="topics-help">${multiple(topicNames(), settings.topics)}</select><small id="topics-help">${t("Sin selección: todos los temas. En escritorio, usa Ctrl o Cmd para combinar.")}</small></label>
      <label class="field">${t("Preguntas por ronda")}<select id="length" data-change="length">${[10, 20, 40, Infinity].map(n => `<option value="${n}"${selected(settings.length, n)}>${n === Infinity ? t("Todas") : n}</option>`).join("")}</select></label></div>
      <p>${t(candidates.length === 1 ? "{available} pregunta disponible. Esta ronda tendrá {count}." : "{available} preguntas disponibles. Esta ronda tendrá {count}.", { available: candidates.length, count })}</p>
      ${!count ? message(t("No hay preguntas con esta selección. Añade otro estado o elimina el filtro de temas.")) : ""}
      <button class="primary"${disabled(!count)}>${t("Empezar ronda")}</button>
    </form><p class="caption">${t("Las selecciones se guardan automáticamente. El historial cambia solo al guardar los resultados.")}</p>`;
}

function answerInputs(q, selection, locked = false, editor = false) {
  return `<fieldset><legend>${editor ? t("Respuesta correcta") : q.mode === "single_choice" ? t("Selecciona una respuesta") : t("Selecciona todas las respuestas que correspondan")}</legend>
    ${q.options.map((_, i) => `<label class="option"><input type="${q.mode === "single_choice" ? "radio" : "checkbox"}" name="${editor ? "editor-answer" : "answer"}" value="${i}" data-change="${editor ? "editor-answer" : "answer"}" data-round="${state.round?.id ?? ""}" data-position="${state.round?.position ?? 0}"${checked(selection.includes(i))}${disabled(locked)}>${optionContent(q, i)}</label>`).join("")}</fieldset>`;
}

function quiz() {
  const r = state.round, pos = r.position, q = r.questions[pos];
  const done = Object.keys(r.results).length;
  if (!q) return review();
  const answered = Object.hasOwn(r.results, pos);
  return `<label for="round-progress" class="caption">${t("{done} de {total} preguntas respondidas", { done, total: r.questions.length })}</label><progress id="round-progress" value="${done}" max="${r.questions.length}"></progress>
    <h2>${t("Pregunta {position} de {total}", { position: pos + 1, total: r.questions.length })}</h2>
    <p class="caption">ID ${q.id} · ${q.mode === "single_choice" ? t("Respuesta única") : t("Selección múltiple")}</p>
    <div class="rich question">${rich(q.question)}</div>
    ${answerInputs(q, r.selections[pos] ?? [], answered)}
    <div class="actions">${button("submit", t("Comprobar respuesta"), true, answered)}${button("next", answered ? t("Siguiente") : t("Saltar por ahora"))}</div>
    ${answered ? `<p class="message${r.results[pos] ? "" : " error"}" role="status">${r.results[pos] ? t("Respuesta correcta.") : t("Respuesta incorrecta. Revisa la explicación antes de continuar.")}</p><section class="panel">${explanation(q)}</section>` : ""}
    <div class="actions">${button("review", t("Ver resumen"))}<a href="#Inicio" class="button">${t("Pausar ronda")}</a></div>
    <details><summary>${t("Terminar o reiniciar la ronda")}</summary>
      <p>${t("El historial solo cambia al guardar resultados. Al descartar o reiniciar, se pierden las respuestas de esta ronda.")}</p>
      <div class="actions">${button("finish", t("Guardar y terminar"), true, !done)}${button("discard", t("Descartar ronda"))}${button("restart", t("Reiniciar ronda"))}</div>
    </details>`;
}

function review() {
  const r = state.round;
  const values = Object.values(r.results);
  const pending = r.questions.length - values.length;
  return `<h2>${t("Resumen de la ronda")}</h2>${metrics({ total: r.questions.length, correct: values.filter(Boolean).length, wrong: values.filter(v => !v).length, unanswered: pending })}
    <p class="caption">${t("Los saltos no cuentan como fallos. El historial cambia solo al guardar los resultados.")}</p>
    <div class="actions">${button("finish", t("Guardar resultados"), true, !values.length)}${pending ? button("pending", t("Volver a pendientes")) : ""}${button("discard", t("Descartar ronda"))}</div>
    <h2>${t("Revisar preguntas")}</h2>${r.questions.map((q, i) => {
      const done = Object.hasOwn(r.results, i);
      return `<details data-review="${i}"><summary>${i + 1}. ${done ? r.results[i] ? t("Correcta") : t("Incorrecta") : t("Sin responder")} · ${t("Pregunta #{id}", { id: q.id })}</summary></details>`;
    }).join("")}`;
}

function progress() {
  const questions = allQuestions();
  let rows = topicStatistics(questions, state.progress, settings.field);
  const distribution = settings.analysis === "banco";
  if (distribution) {
    const counts = new Map();
    for (const q of questions) for (const topic of new Set(q[settings.field])) counts.set(topic, (counts.get(topic) ?? 0) + 1);
    rows = [...counts].map(([topic, attempts]) => ({ topic, attempts }));
  } else rows = rows.filter(r => r.attempts >= settings.minimum && r.accuracy <= settings.maximum / 100);
  const shown = rankedTopics(rows, distribution ? "attempts" : settings.sort, settings.limit);
  return heading(t("Progreso"), t("Detecta qué repasar. Los datos reflejan el último resultado guardado, no todos tus intentos."))
    + metrics(catalogStats(questions, state.progress))
    + `<p class="caption">${t("Una pregunta con varias etiquetas participa en varios temas. Estos porcentajes no equivalen a preparación para el examen.")}</p>
    <div class="grid"><label class="field">${t("Analizar por")}<select id="field" data-change="field">${Object.entries(TOPICS).map(([label, value]) => `<option value="${value}"${selected(settings.field, value)}>${t(label)}</option>`).join("")}</select></label>
    <label class="field">${t("Vista")}<select id="analysis" data-change="analysis"><option value="repaso"${selected(settings.analysis, "repaso")}>${t("Qué repasar")}</option><option value="banco"${selected(settings.analysis, "banco")}>${t("Contenido del banco")}</option></select></label></div>
    <details><summary>${t("Ajustar el análisis")}</summary><div class="grid">
      <label class="field">${t("Mínimo de preguntas por tema")}<input id="minimum" type="number" min="1" max="${questions.length}" value="${settings.minimum}" data-change="minimum"${disabled(distribution)}></label>
      <label class="field">${t("Precisión máxima (%)")}<input id="maximum" type="number" min="0" max="100" value="${settings.maximum}" data-change="maximum"${disabled(distribution)}></label>
      <label class="field">${t("Orden")}<select id="sort" data-change="sort"${disabled(distribution)}>${[["gap", t("Más fallos primero")], ["accuracy", t("Menor precisión primero")], ["attempts", t("Más preguntas primero")]].map(([v, label]) => `<option value="${v}"${selected(settings.sort, v)}>${label}</option>`).join("")}</select></label>
      <label class="field">${t("Límite de temas")}<select id="limit" data-change="limit">${options([5, 10, 20, 40], settings.limit)}</select></label>
    </div></details>
    <h2>${distribution ? t("Contenido del banco") : t("Qué repasar")}</h2>
    ${shown.length ? `<div class="table-wrap"><table><caption class="caption">${t("Temas prioritarios según los filtros seleccionados")}</caption><thead><tr><th scope="col">${t("Tema")}</th><th scope="col">${t("Preguntas")}</th>${distribution ? "" : `<th scope="col">${t("Aciertos")}</th><th scope="col">${t("Precisión")}</th>`}</tr></thead><tbody>
      ${shown.map(row => `<tr><th scope="row">${h(row.topic)}${!distribution ? `<div class="bar" aria-hidden="true" style="width:${(row.gap * 100).toFixed(1)}%"></div>` : ""}</th><td class="number">${row.attempts}</td>${distribution ? "" : `<td class="number">${row.correct}</td><td class="number">${(row.accuracy * 100).toFixed(1)}%</td>`}</tr>`).join("")}
      </tbody></table></div>${distribution ? "" : `<p class="caption">${t("La línea muestra la proporción de fallos. Sin línea significa que todos los resultados guardados son correctos.")}</p>`}`
      : message(t("No hay resultados con estos filtros. Guarda una ronda, reduce el mínimo de preguntas o cambia la categoría."))}`;
}

const list = values => values.length ? `<ul class="list">${values.map(v => `<li class="rich">${rich(v)}</li>`).join("")}</ul>` : `<p class="muted">${t("No hay información registrada.")}</p>`;
function productPage() {
  const filtered = products.filter(p => (!settings.focused.length || settings.focused.includes(p.product_name)) &&
    `${p.product_name} ${p.short_description}`.toLocaleLowerCase().includes(settings.search.toLocaleLowerCase()));
  if (!filtered.some(p => p.product_name === settings.product)) settings.product = filtered[0]?.product_name ?? "";
  const row = filtered.find(p => p.product_name === settings.product);
  const connections = productConnections(filtered).slice(0, settings.connections);
  return heading(t("Productos de Google Cloud"), t("Consulta cuándo usar cada servicio y compara sus conexiones."))
    + `<div class="grid"><label class="field">${t("Buscar un producto")}<input id="search" type="search" placeholder="${h(t("Nombre o descripción"))}" value="${h(settings.search)}" data-input="search"></label>
      <label class="field">${t("Productos a mostrar")}<select id="focused" multiple data-change="focused">${multiple(products.map(p => p.product_name).sort(), settings.focused)}</select><small>${t("Sin selección: todos los productos.")}</small></label></div>
      <p class="caption">${t("{count} de {total} productos", { count: filtered.length, total: products.length })}</p>
      <label class="field">${t("Vista")}<select id="productView" data-change="productView">${options(["Ficha", "Conexiones"], settings.productView, t)}</select></label>
      ${!row ? message(t("No hay coincidencias. Borra la búsqueda o cambia los productos seleccionados."))
        : settings.productView === "Ficha" ? `<label class="field">${t("Producto")}<select id="product" data-change="product">${options(filtered.map(p => p.product_name).sort(), settings.product)}</select></label>
          <section class="panel"><h2>${h(row.product_name)}</h2><div class="rich">${rich(row.short_description)}</div><p class="caption">${h(row.entity_type)}</p>
          <div class="grid"><div><h3>${t("Cuándo usarlo")}</h3>${list(row.use_cases)}</div><div><h3>${t("Cuándo no usarlo")}</h3>${list(row.not_used_when)}</div></div></section>
          <details><summary>${t("Acceso y conexiones")}</summary><h3>${t("Formas de acceso")}</h3>${list(row.ui)}<h3>${t("Conectado con")}</h3>${list(row.connected_to)}</details>`
        : !connections.length ? message(t("Estos productos no tienen conexiones registradas."))
        : `<label class="field">${t("Conexiones a mostrar")}<select id="connections" data-change="connections">${options([5, 10, 20, 50], settings.connections)}</select></label>
          <p class="caption">${t("Una conexión registrada no obliga a utilizar ambos servicios. Desplaza la tabla horizontalmente para ver todas las columnas.")}</p>
          <div class="table-wrap"><table><thead><tr><th scope="col">${t("Producto")}</th>${connections.map(([name]) => `<th scope="col">${h(name)}</th>`).join("")}</tr></thead><tbody>
          ${filtered.map(p => `<tr><th scope="row">${h(p.product_name)}</th>${connections.map(([name]) => `<td>${p.connected_to.some(v => v.trim().replace(/\s+/g, " ") === name) ? t("Sí") : t("No")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
          <h2>${t("Conexiones más compartidas")}</h2><div class="table-wrap"><table><thead><tr><th>${t("Conexión")}</th><th>${t("Productos conectados")}</th></tr></thead><tbody>${connections.map(([name, count]) => `<tr><th scope="row">${h(name)}</th><td>${count}</td></tr>`).join("")}</tbody></table></div>`}`;
}

function exportPage() {
  const questions = eligibleQuestions(allQuestions(), state.progress, [settings.exportScope]);
  return heading(t("Exportar para repasar"), t("Descarga solo las preguntas que necesitas. No se envía nada a un servicio externo."))
    + `<label class="field">${t("Contenido")}<select id="exportScope" data-change="exportScope">${STATUSES.map(s => `<option value="${s}"${selected(settings.exportScope, s)}>${exportTitle(s)}</option>`).join("")}</select></label>
      <label class="check"><input type="checkbox" data-change="explanations"${checked(settings.explanations)}>${t("Incluir explicaciones")}</label>
      <h2>${t(questions.length === 1 ? "{count} pregunta en el archivo" : "{count} preguntas en el archivo", { count: questions.length })}</h2>
      ${questions.length ? `${message(t("Antes de subir el archivo a NotebookLM u otro servicio, comprueba los permisos del contenido y su política de privacidad."))}
        ${button("markdown", t("Descargar Markdown"), true)}<p class="caption">${t("Incluye preguntas y respuestas, no tu historial. Las imágenes locales no se incluyen como archivos dentro del Markdown.")}</p>
        <details><summary>${t("Vista previa de la primera pregunta")}</summary><pre>${h(exportMarkdown(questions.slice(0, 1), exportTitle(), settings.explanations))}</pre></details>`
        : message(t("No hay preguntas en este grupo. Elige otro o guarda una ronda."))}`;
}

function editorPage() {
  const questions = allQuestions();
  settings.editorId ??= questions[0].id;
  const q = editing?.question ?? questions.find(q => q.id === settings.editorId);
  return heading(t("Editar preguntas"), t("Los cambios se guardan solo en este navegador y se aplican a futuras rondas."))
    + `<label class="field">${t("Pregunta por identificador")}<select id="editorId" data-change="editorId"${disabled(!!editing)}>${questions.map(q => `<option value="${q.id}"${selected(settings.editorId, q.id)}>${t("Pregunta #{id}", { id: q.id })}</option>`).join("")}</select></label>
      <div class="rich question">${rich(q.question)}</div>
      ${editing ? `<p class="message">${t("Guarda o cancela antes de cambiar de página. El banco de GitHub no se modifica.")}</p>
        <form data-form="edit">${answerInputs(q, editing.answer, false, true)}<label class="field">${t("Explicación")}<textarea id="explanation" data-input="explanation">${h(editing.explanation)}</textarea></label>
        <div class="actions"><button class="primary">${t("Guardar cambios")}</button>${button("edit-cancel", t("Cancelar edición"))}</div></form>`
        : `${q.options.map((_, i) => optionContent(q, i)).join("")}
        <details open><summary>${t("Respuesta y explicación actuales")}</summary>${explanation(q)}</details><div class="actions">${button("edit", t("Editar esta pregunta"), true)}${button("bank-download", t("Descargar banco editado"))}${state.edits[q.id] ? button("edit-restore", t("Restaurar pregunta original")) : ""}</div>
        <p class="caption">${t("La copia completa incluye tus ediciones. El banco descargado conserva los identificadores y metadatos.")}</p>`}`;
}

function render() {
  const focus = document.activeElement?.id;
  const cursor = document.activeElement?.selectionStart;
  const expanded = [...main.querySelectorAll("details")].map(d => d.open);
  const samePage = activeRoute === route();
  activeRoute = route();
  const pages = { Inicio: home, Quiz_Mode: () => heading(t("Práctica"), t("Una pregunta cada vez. Entiende la respuesta y decide qué repasar.")) + (state.round ? quiz() : setup()), Progress: progress, GCP_Products: productPage, Export_for_LM: exportPage, Edit_Questions: editorPage };
  main.innerHTML = pages[activeRoute]();
  document.querySelectorAll("nav a").forEach(link => {
    if (link.hash === `#${activeRoute}`) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  document.title = `${main.querySelector("h1").textContent} | PMLE Study`;
  if (samePage) {
    main.querySelectorAll("details").forEach((d, i) => { if (expanded[i] !== undefined) d.open = expanded[i]; });
    const input = focus && document.getElementById(focus);
    if (input) {
      input.focus({ preventScroll: true });
      if (typeof cursor === "number" && ["text", "search"].includes(input.type)) input.setSelectionRange(cursor, cursor);
    }
  } else main.querySelector("h1").focus({ preventScroll: true });
}

async function action(name, element) {
  await queue;
  switch (name) {
    case "reload": {
      const stored = await readStorage(db);
      state = validateState(stored.current);
      editing = null;
      applyTheme(); render(); showNotice(t("Datos actualizados desde este navegador."));
      break;
    }
    case "submit": await mutate(submitAnswer); break;
    case "next": await mutate(s => { s.round.position++; }); break;
    case "review": await mutate(s => { s.round.position = s.round.questions.length; }); break;
    case "pending": await mutate(s => { s.round.position = s.round.questions.findIndex((_, i) => !Object.hasOwn(s.round.results, i)); }); break;
    case "revisit": await mutate(s => { s.round.position = Number(element.dataset.position); }); break;
    case "finish": await mutate(s => finishRound(s, true), t("Resultados guardados en tu progreso.")); break;
    case "discard":
      if (confirm(t("¿Descartar esta ronda sin guardar sus resultados?"))) await mutate(s => finishRound(s, false), t("Ronda descartada. El historial no ha cambiado."));
      break;
    case "restart":
      if (confirm(t("¿Reiniciar esta ronda y borrar sus respuestas?"))) await mutate(s => {
        const questions = s.round.questions;
        s.round = null; startRound(s, questions, questions.length);
      }, t("Ronda reiniciada."));
      break;
    case "weak": {
      const weak = rankedTopics(topicStatistics(allQuestions(), state.progress, "gcp_topics").filter(t => t.gap > 0), "gap", 1)[0];
      settings.statuses = [...STATUSES]; settings.topics = [weak.topic];
      location.hash = "Quiz_Mode";
      if (state.round) showNotice(t("Termina o descarta la ronda pendiente para preparar este tema."));
      break;
    }
    case "reset":
      if (document.querySelector("#reset-confirm")?.checked && confirm(t("¿Borrar el historial guardado en este navegador?"))) await mutate(resetProgress, t("Historial reiniciado. Se conserva una copia anterior."));
      break;
    case "backup": download("pmle-copia-completa.json", JSON.stringify({ app: "pmle-study", state }, null, 2)); break;
    case "progress-download": download("progress.json", JSON.stringify(state.progress, null, 2)); break;
    case "previous-backup": {
      const stored = await readStorage(db);
      requireValid(stored.backup, "Todavía no existe una copia anterior.");
      download("pmle-copia-anterior.json", JSON.stringify({ app: "pmle-study", state: stored.backup }, null, 2));
      break;
    }
    case "import-confirm":
      if (pendingImport && confirm(t("¿Reemplazar tus datos actuales por los de este archivo?"))) {
        const data = pendingImport;
        if (await mutate(s => applyImport(s, data), () => t("Importación guardada."))) {
          pendingImport = null; render();
        }
      }
      break;
    case "import-cancel": pendingImport = null; render(); break;
    case "markdown":
      download(`preguntas-${settings.exportScope.toLocaleLowerCase()}.md`,
        exportMarkdown(eligibleQuestions(allQuestions(), state.progress, [settings.exportScope]),
          exportTitle(), settings.explanations), "text/markdown");
      break;
    case "edit": {
      const q = allQuestions().find(q => q.id === settings.editorId);
      editing = { question: structuredClone(q), answer: [...correctAnswers(q)], explanation: q.explanation ?? "" };
      render(); break;
    }
    case "edit-cancel": editing = null; render(); break;
    case "edit-restore":
      if (confirm(t("¿Eliminar la edición local y recuperar esta pregunta del banco original?"))) await mutate(s => { delete s.edits[settings.editorId]; }, t("Pregunta original restaurada."));
      break;
    case "bank-download":
      download("quizzes.jsonl", allQuestions().map(q => JSON.stringify(q)).join("\n") + "\n", "application/x-ndjson");
      break;
  }
}

document.addEventListener("click", event => {
  const element = event.target.closest("button[data-action]");
  if (element) action(element.dataset.action, element).catch(report);
});
document.querySelector("#theme").addEventListener("click", () => {
  if (state && bank && products) mutate(s => { s.theme = s.theme === "dark" ? "light" : "dark"; }, "", false);
});
document.querySelector("#language").addEventListener("change", event => {
  const language = event.target.value;
  if (state) mutate(s => {
    requireValid(Object.hasOwn(LANGUAGES, language), "Idioma no compatible.");
    s.language = language;
  }, () => t("Idioma actualizado."));
});
document.querySelector(".skip-link").addEventListener("click", event => {
  event.preventDefault();
  main.focus();
});
main.addEventListener("toggle", event => {
  const details = event.target;
  if (!details.open || details.dataset.review === undefined || details.dataset.loaded) return;
  const i = Number(details.dataset.review), r = state.round, q = r.questions[i];
  const done = Object.hasOwn(r.results, i);
  details.insertAdjacentHTML("beforeend", `<div class="rich">${rich(q.question)}</div>
    ${done ? `<h3>${t("Tu selección")}</h3>${r.selections[i].map(j => optionContent(q, j)).join("")}${explanation(q)}` : `<p class="muted">${t("La explicación se mostrará después de responder.")}</p><button data-action="revisit" data-position="${i}">${t("Responder esta pregunta")}</button>`}`);
  details.dataset.loaded = "true";
}, true);
main.addEventListener("submit", event => {
  event.preventDefault();
  if (event.target.dataset.form === "start") {
    mutate(s => startRound(s, eligibleQuestions(effectiveQuestions(bank, s.edits), s.progress, settings.statuses, settings.topics), Math.min(settings.length, bank.length)));
  } else if (event.target.dataset.form === "edit") {
    const draft = structuredClone(editing);
    mutate(s => {
      const current = effectiveQuestions(bank, s.edits).find(q => q.id === draft.question.id);
      requireValid(JSON.stringify(current) === JSON.stringify(draft.question), "Esta pregunta ha cambiado. Recarga los datos antes de editar.");
      const q = validateQuestion({ ...draft.question, answer: draft.question.mode === "single_choice" ? draft.answer[0] : draft.answer, explanation: draft.explanation });
      s.edits[q.id] = q;
    }, t("Edición guardada en este navegador."), false).then(success => {
      // Keep a failed draft visible so the learner can correct it or copy it.
      if (!success) return;
      editing = null; render();
    });
  }
});

main.addEventListener("change", async event => {
  const element = event.target, key = element.dataset.change;
  if (!key) return;
  try {
    if (key === "answer") {
      const index = Number(element.value), on = element.checked, pos = Number(element.dataset.position), id = element.dataset.round;
      await mutate(s => {
        const previous = s.round?.selections[pos] ?? [];
        selectAnswer(s, id, pos, element.type === "radio" ? [index] : on ? [...new Set([...previous, index])] : previous.filter(i => i !== index));
      }, "", false);
    } else if (key === "editor-answer") {
      editing.answer = [...main.querySelectorAll('input[name="editor-answer"]:checked')].map(input => Number(input.value));
    } else if (key === "reset-confirm") {
      main.querySelector('[data-action="reset"]').disabled = !element.checked || !!state.round || !Object.keys(state.progress).length;
    } else if (key === "import") {
      pendingImport = null;
      if (!element.files.length) return;
      requireValid(element.files[0].size < 30 * 1024 * 1024, "La copia supera el límite de 30 MB.");
      pendingImport = importData(await element.files[0].text());
      render();
    } else {
      if (key === "status") settings.statuses = [...main.querySelectorAll('[data-change="status"]:checked')].map(input => input.value);
      else if (["topics", "focused"].includes(key)) settings[key] = [...element.selectedOptions].map(o => o.value);
      else if (["length", "minimum", "maximum", "limit", "connections", "editorId"].includes(key)) {
        requireValid(element.validity.valid, "El valor está fuera del rango permitido.");
        settings[key] = Number(element.value);
      } else if (key === "explanations") settings.explanations = element.checked;
      else settings[key] = element.value;
      render();
    }
  } catch (error) { report(error); }
});
main.addEventListener("input", event => {
  if (event.target.dataset.input === "search") { settings.search = event.target.value; render(); }
  if (event.target.dataset.input === "explanation" && editing) editing.explanation = event.target.value;
});
window.addEventListener("hashchange", () => {
  if (!state) return;
  if (editing && route() !== activeRoute) {
    if (!confirm(t("Hay una edición sin guardar. ¿Salir y descartar el borrador?"))) {
      history.replaceState(null, "", `#${activeRoute}`);
      return;
    }
    editing = null;
  }
  render();
});
window.addEventListener("beforeunload", event => { if (editing) event.preventDefault(); });

async function loadCatalog(path, parser) {
  const response = await fetch(new URL(path, document.baseURI));
  if (!response.ok) throw new LocalizedError("No se pudo cargar {path} (HTTP {status}). Recarga la página cuando tengas conexión.", { path, status: response.status });
  return parser(await response.text());
}

async function boot() {
  let stored;
  try {
    db = await openStorage();
    stored = await readStorage(db);
    state = validateState(stored.current);
    applyTheme();
    document.querySelector("#language").disabled = true;
    main.querySelector("h1").textContent = t("Tu próxima sesión de estudio");
    main.querySelector('[role="status"]').textContent = t("Cargando preguntas y progreso del navegador…");
    [bank, products] = await Promise.all([
      loadCatalog("data/quizzes.jsonl", parseQuestions),
      loadCatalog("data/gcp_products.jsonl", parseProducts),
    ]);
    applyTheme(); render();
  } catch (error) {
    document.querySelector("#language").disabled = true;
    main.innerHTML = heading(t("No se pudo abrir la aplicación"), t("No se han borrado ni reemplazado tus datos."))
      + `<p class="message error" role="alert">${h(error.message)}</p><button type="button" id="retry">${t("Volver a cargar")}</button>`;
    document.querySelector("#retry").onclick = () => location.reload();
    if (stored && !state) {
      main.insertAdjacentHTML("beforeend", `<p class="caption">${t("Descarga los datos antes de modificar el almacenamiento del sitio.")}</p><button id="damaged">${t("Descargar datos originales")}</button>`);
      document.querySelector("#damaged").onclick = () => download("pmle-datos-originales.json", JSON.stringify(stored, null, 2));
      if (stored.backup) {
        try {
          validateState(stored.backup);
          main.insertAdjacentHTML("beforeend", `<button id="recover">${t("Recuperar copia anterior")}</button>`);
          document.querySelector("#recover").onclick = async () => {
            if (!confirm(t("¿Recuperar la copia anterior? Se conservarán también los datos dañados."))) return;
            try {
              state = await recoverStorage(db, stored.current, stored.backup);
              applyTheme(); render(); showNotice(t("Copia anterior recuperada."));
            } catch (failure) { report(failure); }
          };
        } catch (failure) {
          console.error("La copia anterior tampoco es válida.", failure);
          main.insertAdjacentHTML("beforeend", `<p>${t("La copia anterior tampoco es válida. Conserva la descarga para recuperar los datos manualmente.")}</p>`);
        }
      }
    }
    console.error(error);
  }
}
boot();
