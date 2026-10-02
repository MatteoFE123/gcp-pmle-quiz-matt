import DOMPurify from "dompurify";
import { marked } from "marked";
import {
  STATUSES, TOPICS, parseQuestions, parseProducts, correctAnswers, validateQuestion,
  validateState, eligibleQuestions, effectiveQuestions, catalogStats, topicStatistics,
  rankedTopics, startRound, selectAnswer, submitAnswer, finishRound, resetProgress,
  importData, applyImport, exportMarkdown, productConnections, requireValid, optionText,
} from "./core.js";
import { openStorage, readStorage, writeStorage, recoverStorage } from "./storage.js";
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
const options = (values, value) => values.map(v => `<option value="${h(v)}"${selected(v, value)}>${h(v)}</option>`).join("");
const multiple = (values, chosen) => values.map(v => `<option${chosen.includes(v) ? " selected" : ""}>${h(v)}</option>`).join("");
const heading = (title, description) => `<h1 tabindex="-1">${h(title)}</h1><p class="lead">${h(description)}</p>`;
const message = text => `<p class="message">${h(text)}</p>`;
const button = (action, label, primary = false, off = false) => `<button type="button" data-action="${action}"${primary ? ' class="primary"' : ""}${disabled(off)}>${h(label)}</button>`;
const allQuestions = () => effectiveQuestions(bank, state.edits);
const topicNames = () => [...new Set(allQuestions().flatMap(q => q.gcp_topics))].sort();
const route = () => routes.includes(location.hash.slice(1)) ? location.hash.slice(1) : "Inicio";

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
      image.replaceWith(document.createTextNode("[Dirección de imagen no válida]"));
      continue;
    }
    const localImages = new URL("static/images/", document.baseURI);
    if (url.origin !== localImages.origin || !url.pathname.startsWith(localImages.pathname)) {
      image.replaceWith(document.createTextNode("[Imagen externa no cargada]"));
      continue;
    }
    image.src = url.href;
    image.loading = "lazy";
    image.alt ||= "Ilustración de la pregunta";
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
  notice.innerHTML = text ? `<div class="message${error ? " error" : ""}"${error ? ' role="alert"' : ""}>${h(text)}${error && state ? ` <button type="button" data-action="reload">Recargar datos</button>` : ""}</div>` : "";
}

function report(error) {
  console.error(error);
  showNotice(error.message || "Ha ocurrido un error. Tus datos no se han borrado.", true);
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  document.querySelector("#theme").textContent = state.theme === "dark" ? "Tema claro" : "Tema oscuro";
}

function mutate(change, success = "", repaint = true) {
  queue = queue.then(async () => {
    state = await writeStorage(db, state.revision, change);
    applyTheme();
    if (repaint) render();
    showNotice(success);
    return true;
  }).catch(error => {
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
  return `<div class="metrics">${[["Preguntas", stats.total], ["Pendientes", stats.unanswered], ["Aciertos", stats.correct], ["Fallos", stats.wrong]].map(([label, value]) => `<div class="metric"><strong>${value}</strong><span>${label}</span></div>`).join("")}</div>`;
}

function explanation(q) {
  return `<h3>Respuesta correcta</h3>${correctAnswers(q).map(i => optionContent(q, i)).join("")}
    <h3>Explicación</h3><div class="rich">${q.explanation ? rich(q.explanation) : "<p>No hay explicación registrada.</p>"}</div>`;
}

function optionContent(q, i) {
  return `<div class="answer-copy"><strong>${String.fromCharCode(65 + i)}.</strong><div class="rich">${rich(optionText(q, i))}</div></div>`;
}

function home() {
  const questions = allQuestions();
  const stats = catalogStats(questions, state.progress);
  const weak = rankedTopics(topicStatistics(questions, state.progress, "gcp_topics").filter(t => t.gap > 0), "gap", 1)[0];
  return heading("Tu próxima sesión de estudio", "Practica a tu ritmo para Google Cloud Professional Machine Learning Engineer.")
    + `<section class="panel"><h2>${state.round ? "Tienes una ronda pendiente" : "Un poco de práctica, cada día"}</h2>
      <p>${state.round ? `${Object.keys(state.round.results).length} de ${state.round.questions.length} preguntas respondidas. Continúa donde lo dejaste.` : "Elige una sesión corta, repasa tus fallos o céntrate en un tema."}</p>
      <a class="button primary" href="#Quiz_Mode">${state.round ? "Continuar ronda" : "Preparar práctica"}</a></section>
      <h2>Tu banco de preguntas</h2>${metrics(stats)}
      <p class="caption">Se muestra el último resultado guardado de cada pregunta. No es una predicción de la nota del examen.</p>
      ${weak ? `<h2>Un tema para tu próximo repaso</h2><p>${h(weak.topic)}</p><p class="caption">Con pocas preguntas, esta recomendación es orientativa.</p>${button("weak", "Practicar este tema")}` : message(stats.correct + stats.wrong ? "No hay temas con fallos registrados. Puedes practicar preguntas pendientes o reforzar tus aciertos." : "Guarda una ronda para descubrir qué temas necesitas repasar.")}
      <h2>Tus datos, en este navegador</h2>
      <p class="muted">No se sincronizan entre dispositivos. Si borras los datos del sitio, perderás el progreso y las ediciones locales. Descarga una copia para conservarlos.</p>
      <details><summary>Copias, importación y reinicio</summary>
        <div class="actions">${button("backup", "Descargar copia completa")}${button("progress-download", "Descargar progreso")}${button("previous-backup", "Descargar copia anterior")}</div>
        <p class="caption">La copia completa incluye progreso, ronda pendiente y ediciones. También puedes importar el archivo progress.json de Streamlit. Nunca se publica tu historial.</p>
        <label class="field">Importar una copia o progreso<input id="import-file" type="file" accept=".json,application/json" data-change="import"></label>
        ${pendingImport ? `<p>${pendingImport.kind === "backup" ? "Copia completa válida. Reemplazará el progreso, las ediciones y la ronda." : `${Object.keys(pendingImport.progress).length} resultados válidos. Reemplazarán el historial actual; las ediciones no cambian.`}</p><div class="actions">${button("import-confirm", "Confirmar importación", true, !!state.round)}${button("import-cancel", "Cancelar importación")}</div>` : ""}
        ${state.round ? message("Guarda o descarta la ronda pendiente antes de importar o reiniciar el historial.") : ""}
        <p class="caption">El reinicio borra solo el historial; conserva preguntas y ediciones. La copia anterior se sustituye en cada guardado.</p>
        <label class="check"><input id="reset-confirm" type="checkbox" data-change="reset-confirm"${disabled(!!state.round)}>Quiero borrar mi historial guardado</label>
        ${button("reset", "Reiniciar historial", false, true)}
      </details>`;
}

function setup() {
  const candidates = eligibleQuestions(allQuestions(), state.progress, settings.statuses, settings.topics);
  const count = Math.min(settings.length, candidates.length);
  return `<h2>Prepara una sesión</h2><p>Las preguntas se mezclan sin repetirse dentro de la ronda.</p>
    <form data-form="start" class="panel">
      <fieldset><legend>Estado de las preguntas</legend><div class="choices">${STATUSES.map(status => `<label class="check"><input type="checkbox" data-change="status" value="${status}"${checked(settings.statuses.includes(status))}>${status}</label>`).join("")}</div></fieldset>
      <div class="grid"><label class="field">Temas GCP (opcional)<select id="topics" multiple data-change="topics" aria-describedby="topics-help">${multiple(topicNames(), settings.topics)}</select><small id="topics-help">Sin selección: todos los temas. En escritorio, usa Ctrl o Cmd para combinar.</small></label>
      <label class="field">Preguntas por ronda<select id="length" data-change="length">${[10, 20, 40, Infinity].map(n => `<option value="${n}"${selected(settings.length, n)}>${n === Infinity ? "Todas" : n}</option>`).join("")}</select></label></div>
      <p>${candidates.length} preguntas disponibles. Esta ronda tendrá ${count}.</p>
      ${!count ? message("No hay preguntas con esta selección. Añade otro estado o elimina el filtro de temas.") : ""}
      <button class="primary"${disabled(!count)}>Empezar ronda</button>
    </form><p class="caption">Las selecciones se guardan automáticamente. El historial cambia solo al guardar los resultados.</p>`;
}

function answerInputs(q, selection, locked = false, editor = false) {
  return `<fieldset><legend>${editor ? "Respuesta correcta" : q.mode === "single_choice" ? "Selecciona una respuesta" : "Selecciona todas las respuestas que correspondan"}</legend>
    ${q.options.map((_, i) => `<label class="option"><input type="${q.mode === "single_choice" ? "radio" : "checkbox"}" name="${editor ? "editor-answer" : "answer"}" value="${i}" data-change="${editor ? "editor-answer" : "answer"}" data-round="${state.round?.id ?? ""}" data-position="${state.round?.position ?? 0}"${checked(selection.includes(i))}${disabled(locked)}>${optionContent(q, i)}</label>`).join("")}</fieldset>`;
}

function quiz() {
  const r = state.round, pos = r.position, q = r.questions[pos];
  const done = Object.keys(r.results).length;
  if (!q) return review();
  const answered = Object.hasOwn(r.results, pos);
  return `<label for="round-progress" class="caption">${done} de ${r.questions.length} preguntas respondidas</label><progress id="round-progress" value="${done}" max="${r.questions.length}"></progress>
    <h2>Pregunta ${pos + 1} de ${r.questions.length}</h2>
    <p class="caption">ID ${q.id} · ${q.mode === "single_choice" ? "Respuesta única" : "Selección múltiple"}</p>
    <div class="rich question">${rich(q.question)}</div>
    ${answerInputs(q, r.selections[pos] ?? [], answered)}
    <div class="actions">${button("submit", "Comprobar respuesta", true, answered)}${button("next", answered ? "Siguiente" : "Saltar por ahora")}</div>
    ${answered ? `<p class="message${r.results[pos] ? "" : " error"}" role="status">${r.results[pos] ? "Respuesta correcta." : "Respuesta incorrecta. Revisa la explicación antes de continuar."}</p><section class="panel">${explanation(q)}</section>` : ""}
    <div class="actions">${button("review", "Ver resumen")}<a href="#Inicio" class="button">Pausar ronda</a></div>
    <details><summary>Terminar o reiniciar la ronda</summary>
      <p>El historial solo cambia al guardar resultados. Al descartar o reiniciar, se pierden las respuestas de esta ronda.</p>
      <div class="actions">${button("finish", "Guardar y terminar", true, !done)}${button("discard", "Descartar ronda")}${button("restart", "Reiniciar ronda")}</div>
    </details>`;
}

function review() {
  const r = state.round;
  const values = Object.values(r.results);
  const pending = r.questions.length - values.length;
  return `<h2>Resumen de la ronda</h2>${metrics({ total: r.questions.length, correct: values.filter(Boolean).length, wrong: values.filter(v => !v).length, unanswered: pending })}
    <p class="caption">Los saltos no cuentan como fallos. El historial cambia solo al guardar los resultados.</p>
    <div class="actions">${button("finish", "Guardar resultados", true, !values.length)}${pending ? button("pending", "Volver a pendientes") : ""}${button("discard", "Descartar ronda")}</div>
    <h2>Revisar preguntas</h2>${r.questions.map((q, i) => {
      const done = Object.hasOwn(r.results, i);
      return `<details data-review="${i}"><summary>${i + 1}. ${done ? r.results[i] ? "Correcta" : "Incorrecta" : "Sin responder"} · Pregunta #${q.id}</summary></details>`;
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
  return heading("Progreso", "Detecta qué repasar. Los datos reflejan el último resultado guardado, no todos tus intentos.")
    + metrics(catalogStats(questions, state.progress))
    + `<p class="caption">Una pregunta con varias etiquetas participa en varios temas. Estos porcentajes no equivalen a preparación para el examen.</p>
    <div class="grid"><label class="field">Analizar por<select id="field" data-change="field">${Object.entries(TOPICS).map(([label, value]) => `<option value="${value}"${selected(settings.field, value)}>${label}</option>`).join("")}</select></label>
    <label class="field">Vista<select id="analysis" data-change="analysis"><option value="repaso"${selected(settings.analysis, "repaso")}>Qué repasar</option><option value="banco"${selected(settings.analysis, "banco")}>Contenido del banco</option></select></label></div>
    <details><summary>Ajustar el análisis</summary><div class="grid">
      <label class="field">Mínimo de preguntas por tema<input id="minimum" type="number" min="1" max="${questions.length}" value="${settings.minimum}" data-change="minimum"${disabled(distribution)}></label>
      <label class="field">Precisión máxima (%)<input id="maximum" type="number" min="0" max="100" value="${settings.maximum}" data-change="maximum"${disabled(distribution)}></label>
      <label class="field">Orden<select id="sort" data-change="sort"${disabled(distribution)}>${[["gap", "Más fallos primero"], ["accuracy", "Menor precisión primero"], ["attempts", "Más preguntas primero"]].map(([v, label]) => `<option value="${v}"${selected(settings.sort, v)}>${label}</option>`).join("")}</select></label>
      <label class="field">Límite de temas<select id="limit" data-change="limit">${options([5, 10, 20, 40], settings.limit)}</select></label>
    </div></details>
    <h2>${distribution ? "Contenido del banco" : "Qué repasar"}</h2>
    ${shown.length ? `<div class="table-wrap"><table><caption class="caption">Temas prioritarios según los filtros seleccionados</caption><thead><tr><th scope="col">Tema</th><th scope="col">Preguntas</th>${distribution ? "" : '<th scope="col">Aciertos</th><th scope="col">Precisión</th>'}</tr></thead><tbody>
      ${shown.map(row => `<tr><th scope="row">${h(row.topic)}${!distribution ? `<div class="bar" aria-hidden="true" style="width:${(row.gap * 100).toFixed(1)}%"></div>` : ""}</th><td class="number">${row.attempts}</td>${distribution ? "" : `<td class="number">${row.correct}</td><td class="number">${(row.accuracy * 100).toFixed(1)}%</td>`}</tr>`).join("")}
      </tbody></table></div>${distribution ? "" : '<p class="caption">La línea muestra la proporción de fallos. Sin línea significa que todos los resultados guardados son correctos.</p>'}`
      : message("No hay resultados con estos filtros. Guarda una ronda, reduce el mínimo de preguntas o cambia la categoría.")}`;
}

const list = values => values.length ? `<ul class="list">${values.map(v => `<li class="rich">${rich(v)}</li>`).join("")}</ul>` : '<p class="muted">No hay información registrada.</p>';
function productPage() {
  const filtered = products.filter(p => (!settings.focused.length || settings.focused.includes(p.product_name)) &&
    `${p.product_name} ${p.short_description}`.toLocaleLowerCase().includes(settings.search.toLocaleLowerCase()));
  if (!filtered.some(p => p.product_name === settings.product)) settings.product = filtered[0]?.product_name ?? "";
  const row = filtered.find(p => p.product_name === settings.product);
  const connections = productConnections(filtered).slice(0, settings.connections);
  return heading("Productos de Google Cloud", "Consulta cuándo usar cada servicio y compara sus conexiones.")
    + `<div class="grid"><label class="field">Buscar un producto<input id="search" type="search" placeholder="Nombre o descripción" value="${h(settings.search)}" data-input="search"></label>
      <label class="field">Productos a mostrar<select id="focused" multiple data-change="focused">${multiple(products.map(p => p.product_name).sort(), settings.focused)}</select><small>Sin selección: todos los productos.</small></label></div>
      <p class="caption">${filtered.length} de ${products.length} productos</p>
      <label class="field">Vista<select id="productView" data-change="productView">${options(["Ficha", "Conexiones"], settings.productView)}</select></label>
      ${!row ? message("No hay coincidencias. Borra la búsqueda o cambia los productos seleccionados.")
        : settings.productView === "Ficha" ? `<label class="field">Producto<select id="product" data-change="product">${options(filtered.map(p => p.product_name).sort(), settings.product)}</select></label>
          <section class="panel"><h2>${h(row.product_name)}</h2><div class="rich">${rich(row.short_description)}</div><p class="caption">${h(row.entity_type)}</p>
          <div class="grid"><div><h3>Cuándo usarlo</h3>${list(row.use_cases)}</div><div><h3>Cuándo no usarlo</h3>${list(row.not_used_when)}</div></div></section>
          <details><summary>Acceso y conexiones</summary><h3>Formas de acceso</h3>${list(row.ui)}<h3>Conectado con</h3>${list(row.connected_to)}</details>`
        : !connections.length ? message("Estos productos no tienen conexiones registradas.")
        : `<label class="field">Conexiones a mostrar<select id="connections" data-change="connections">${options([5, 10, 20, 50], settings.connections)}</select></label>
          <p class="caption">Una conexión registrada no obliga a utilizar ambos servicios. Desplaza la tabla horizontalmente para ver todas las columnas.</p>
          <div class="table-wrap"><table><thead><tr><th scope="col">Producto</th>${connections.map(([name]) => `<th scope="col">${h(name)}</th>`).join("")}</tr></thead><tbody>
          ${filtered.map(p => `<tr><th scope="row">${h(p.product_name)}</th>${connections.map(([name]) => `<td>${p.connected_to.some(v => v.trim().replace(/\s+/g, " ") === name) ? "Sí" : "No"}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
          <h2>Conexiones más compartidas</h2><div class="table-wrap"><table><thead><tr><th>Conexión</th><th>Productos conectados</th></tr></thead><tbody>${connections.map(([name, count]) => `<tr><th scope="row">${h(name)}</th><td>${count}</td></tr>`).join("")}</tbody></table></div>`}`;
}

function exportPage() {
  const questions = eligibleQuestions(allQuestions(), state.progress, [settings.exportScope]);
  return heading("Exportar para repasar", "Descarga solo las preguntas que necesitas. No se envía nada a un servicio externo.")
    + `<label class="field">Contenido<select id="exportScope" data-change="exportScope">${STATUSES.map(s => `<option value="${s}"${selected(settings.exportScope, s)}>Preguntas ${s.toLocaleLowerCase()}</option>`).join("")}</select></label>
      <label class="check"><input type="checkbox" data-change="explanations"${checked(settings.explanations)}>Incluir explicaciones</label>
      <h2>${questions.length} ${questions.length === 1 ? "pregunta" : "preguntas"} en el archivo</h2>
      ${questions.length ? `${message("Antes de subir el archivo a NotebookLM u otro servicio, comprueba los permisos del contenido y su política de privacidad.")}
        ${button("markdown", "Descargar Markdown", true)}<p class="caption">Incluye preguntas y respuestas, no tu historial. Las imágenes locales no se incluyen como archivos dentro del Markdown.</p>
        <details><summary>Vista previa de la primera pregunta</summary><pre>${h(exportMarkdown(questions.slice(0, 1), `Preguntas ${settings.exportScope.toLocaleLowerCase()}`, settings.explanations))}</pre></details>`
        : message("No hay preguntas en este grupo. Elige otro o guarda una ronda.")}`;
}

function editorPage() {
  const questions = allQuestions();
  settings.editorId ??= questions[0].id;
  const q = editing?.question ?? questions.find(q => q.id === settings.editorId);
  return heading("Editar preguntas", "Los cambios se guardan solo en este navegador y se aplican a futuras rondas.")
    + `<label class="field">Pregunta por identificador<select id="editorId" data-change="editorId"${disabled(!!editing)}>${questions.map(q => `<option value="${q.id}"${selected(settings.editorId, q.id)}>Pregunta #${q.id}</option>`).join("")}</select></label>
      <div class="rich question">${rich(q.question)}</div>
      ${editing ? `<p class="message">Guarda o cancela antes de cambiar de página. El banco de GitHub no se modifica.</p>
        <form data-form="edit">${answerInputs(q, editing.answer, false, true)}<label class="field">Explicación<textarea id="explanation" data-input="explanation">${h(editing.explanation)}</textarea></label>
        <div class="actions"><button class="primary">Guardar cambios</button>${button("edit-cancel", "Cancelar edición")}</div></form>`
        : `${q.options.map((_, i) => optionContent(q, i)).join("")}
        <details open><summary>Respuesta y explicación actuales</summary>${explanation(q)}</details><div class="actions">${button("edit", "Editar esta pregunta", true)}${button("bank-download", "Descargar banco editado")}${state.edits[q.id] ? button("edit-restore", "Restaurar pregunta original") : ""}</div>
        <p class="caption">La copia completa incluye tus ediciones. El banco descargado conserva los identificadores y metadatos.</p>`}`;
}

function render() {
  const focus = document.activeElement?.id;
  const cursor = document.activeElement?.selectionStart;
  const expanded = [...main.querySelectorAll("details")].map(d => d.open);
  const samePage = activeRoute === route();
  activeRoute = route();
  const pages = { Inicio: home, Quiz_Mode: () => heading("Práctica", "Una pregunta cada vez. Entiende la respuesta y decide qué repasar.") + (state.round ? quiz() : setup()), Progress: progress, GCP_Products: productPage, Export_for_LM: exportPage, Edit_Questions: editorPage };
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
      applyTheme(); render(); showNotice("Datos actualizados desde este navegador.");
      break;
    }
    case "submit": await mutate(submitAnswer); break;
    case "next": await mutate(s => { s.round.position++; }); break;
    case "review": await mutate(s => { s.round.position = s.round.questions.length; }); break;
    case "pending": await mutate(s => { s.round.position = s.round.questions.findIndex((_, i) => !Object.hasOwn(s.round.results, i)); }); break;
    case "revisit": await mutate(s => { s.round.position = Number(element.dataset.position); }); break;
    case "finish": await mutate(s => finishRound(s, true), "Resultados guardados en tu progreso."); break;
    case "discard":
      if (confirm("¿Descartar esta ronda sin guardar sus resultados?")) await mutate(s => finishRound(s, false), "Ronda descartada. El historial no ha cambiado.");
      break;
    case "restart":
      if (confirm("¿Reiniciar esta ronda y borrar sus respuestas?")) await mutate(s => {
        const questions = s.round.questions;
        s.round = null; startRound(s, questions, questions.length);
      }, "Ronda reiniciada.");
      break;
    case "weak": {
      const weak = rankedTopics(topicStatistics(allQuestions(), state.progress, "gcp_topics").filter(t => t.gap > 0), "gap", 1)[0];
      settings.statuses = [...STATUSES]; settings.topics = [weak.topic];
      location.hash = "Quiz_Mode";
      if (state.round) showNotice("Termina o descarta la ronda pendiente para preparar este tema.");
      break;
    }
    case "reset":
      if (document.querySelector("#reset-confirm")?.checked && confirm("¿Borrar el historial guardado en este navegador?")) await mutate(resetProgress, "Historial reiniciado. Se conserva una copia anterior.");
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
      if (pendingImport && confirm("¿Reemplazar tus datos actuales por los de este archivo?")) {
        const data = pendingImport;
        if (await mutate(s => applyImport(s, data), "Importación guardada.")) {
          pendingImport = null; render();
        }
      }
      break;
    case "import-cancel": pendingImport = null; render(); break;
    case "markdown":
      download(`preguntas-${settings.exportScope.toLocaleLowerCase()}.md`,
        exportMarkdown(eligibleQuestions(allQuestions(), state.progress, [settings.exportScope]),
          `Preguntas ${settings.exportScope.toLocaleLowerCase()}`, settings.explanations), "text/markdown");
      break;
    case "edit": {
      const q = allQuestions().find(q => q.id === settings.editorId);
      editing = { question: structuredClone(q), answer: [...correctAnswers(q)], explanation: q.explanation ?? "" };
      render(); break;
    }
    case "edit-cancel": editing = null; render(); break;
    case "edit-restore":
      if (confirm("¿Eliminar la edición local y recuperar esta pregunta del banco original?")) await mutate(s => { delete s.edits[settings.editorId]; }, "Pregunta original restaurada.");
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
  if (state) mutate(s => { s.theme = s.theme === "dark" ? "light" : "dark"; }, "", false);
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
    ${done ? `<h3>Tu selección</h3>${r.selections[i].map(j => optionContent(q, j)).join("")}${explanation(q)}` : `<p class="muted">La explicación se mostrará después de responder.</p><button data-action="revisit" data-position="${i}">Responder esta pregunta</button>`}`);
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
    }, "Edición guardada en este navegador.", false).then(success => {
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
    if (!confirm("Hay una edición sin guardar. ¿Salir y descartar el borrador?")) {
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
  if (!response.ok) throw new Error(`No se pudo cargar ${path} (HTTP ${response.status}). Recarga la página cuando tengas conexión.`);
  return parser(await response.text());
}

async function boot() {
  let stored;
  try {
    [bank, products, db] = await Promise.all([
      loadCatalog("data/quizzes.jsonl", parseQuestions),
      loadCatalog("data/gcp_products.jsonl", parseProducts),
      openStorage(),
    ]);
    stored = await readStorage(db);
    state = validateState(stored.current);
    applyTheme(); render();
  } catch (error) {
    main.innerHTML = heading("No se pudo abrir la aplicación", "No se han borrado ni reemplazado tus datos.")
      + `<p class="message error" role="alert">${h(error.message)}</p><button type="button" id="retry">Volver a cargar</button>`;
    document.querySelector("#retry").onclick = () => location.reload();
    if (stored) {
      main.insertAdjacentHTML("beforeend", `<p class="caption">Descarga los datos antes de modificar el almacenamiento del sitio.</p><button id="damaged">Descargar datos originales</button>`);
      document.querySelector("#damaged").onclick = () => download("pmle-datos-originales.json", JSON.stringify(stored, null, 2));
      if (stored.backup) {
        try {
          validateState(stored.backup);
          main.insertAdjacentHTML("beforeend", '<button id="recover">Recuperar copia anterior</button>');
          document.querySelector("#recover").onclick = async () => {
            if (!confirm("¿Recuperar la copia anterior? Se conservarán también los datos dañados.")) return;
            try {
              state = await recoverStorage(db, stored.current, stored.backup);
              applyTheme(); render(); showNotice("Copia anterior recuperada.");
            } catch (failure) { report(failure); }
          };
        } catch (failure) {
          console.error("La copia anterior tampoco es válida.", failure);
          main.insertAdjacentHTML("beforeend", "<p>La copia anterior tampoco es válida. Conserva la descarga para recuperar los datos manualmente.</p>");
        }
      }
    }
    console.error(error);
  }
}
boot();
