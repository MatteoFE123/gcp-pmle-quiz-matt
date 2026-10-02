import { test, expect } from "@playwright/test";

const questions = [
  { id: 10001, mode: "single_choice", question: "<p>Pregunta única de prueba</p>", options: ["Uno", "Dos", "Tres"], answer: 1, explanation: "Explicación única", gcp_topics: ["Datos"], gcp_products: ["Storage"], ml_topics: [] },
  { id: 10002, mode: "multiple_choice", question: "Pregunta múltiple de prueba", options: ["Primera", "Segunda", "Tercera"], answer: [0, 2], explanation: "Explicación múltiple", gcp_topics: ["Modelos"], gcp_products: [], ml_topics: [] },
];
const products = [
  { product_name: "Servicio conectado", short_description: "Servicio de datos", ui: ["API"], connected_to: ["Cloud"], use_cases: ["Almacenar"], not_used_when: [] },
  { product_name: "Servicio aislado", short_description: "Sin conexiones", ui: [], connected_to: [], use_cases: [], not_used_when: [] },
];
const jsonl = rows => rows.map(row => JSON.stringify(row)).join("\n");
async function fixture(context) {
  await context.route("**/data/quizzes.jsonl", route => route.fulfill({ body: jsonl(questions) }));
  await context.route("**/data/gcp_products.jsonl", route => route.fulfill({ body: jsonl(products) }));
}
async function start(page, topic = "Datos") {
  await page.getByRole("link", { name: "Práctica", exact: true }).click();
  await page.getByLabel("Temas GCP (opcional)").selectOption(topic);
  await page.getByRole("button", { name: "Empezar ronda", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Pregunta 1 de 1", exact: true })).toBeVisible();
}
async function readState(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open(`pmle-study:${new URL(".", document.baseURI).pathname}`, 1);
    request.onsuccess = () => {
      const db = request.result;
      const get = db.transaction("state").objectStore("state").get("current");
      get.onsuccess = () => { resolve(get.result); db.close(); };
      get.onerror = () => reject(get.error);
    };
  }));
}
async function persisted(page, predicate) {
  await expect.poll(async () => predicate(await readState(page))).toBe(true);
}

test.beforeEach(async ({ context }) => fixture(context));

test("single answer, reload, answer lock, save and exact export", async ({ page }) => {
  await page.goto("./");
  await start(page);
  await page.getByRole("radio", { name: "B. Dos" }).check();
  await persisted(page, s => s?.round?.selections[0]?.[0] === 1);
  await page.reload();
  await expect(page.getByRole("radio", { name: "B. Dos" })).toBeChecked();
  await page.getByRole("button", { name: "Comprobar respuesta" }).click();
  await expect(page.getByText("Respuesta correcta.", { exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: "B. Dos" })).toBeDisabled();
  await page.getByRole("button", { name: "Ver resumen" }).click();
  await page.getByText("1. Correcta · Pregunta #10001", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Tu selección", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Guardar resultados" }).click();
  await expect(page.getByText("Resultados guardados en tu progreso.")).toBeVisible();
  await persisted(page, s => s?.progress[10001] === true && s.round === null);
  await page.getByRole("link", { name: "Exportar", exact: true }).click();
  await page.getByRole("combobox", { name: "Contenido", exact: true }).selectOption("Acertadas");
  await expect(page.getByRole("heading", { name: "1 pregunta en el archivo" })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Descargar Markdown" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("preguntas-acertadas.md");
  const stream = await file.createReadStream();
  let content = "";
  for await (const part of stream) content += part;
  expect(content).toContain("10001");
  expect(content).not.toContain("10002");
});

test("multiple choice and skipping back to pending", async ({ page }) => {
  await page.goto("./");
  await start(page, "Modelos");
  await page.getByRole("button", { name: "Saltar por ahora" }).click();
  await expect(page.getByRole("button", { name: "Guardar resultados" })).toBeDisabled();
  await page.getByRole("button", { name: "Volver a pendientes" }).click();
  await page.getByRole("checkbox", { name: "A. Primera" }).check();
  await page.getByRole("checkbox", { name: "C. Tercera" }).check();
  await page.getByRole("button", { name: "Comprobar respuesta" }).click();
  await expect(page.getByText("Respuesta correcta.", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "C. Tercera" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "C. Tercera" })).toBeDisabled();
});

test("stale tab cannot replace another tab's round or saved selections", async ({ page, context }) => {
  await page.goto("./");
  const second = await context.newPage();
  await second.goto("./");
  await expect(second.getByRole("heading", { name: "Tu próxima sesión de estudio" })).toBeVisible();
  await start(page);
  await second.getByRole("link", { name: "Práctica", exact: true }).click();
  await second.getByRole("button", { name: "Empezar ronda" }).click();
  await expect(second.getByRole("alert")).toContainText("Otra pestaña");
  await second.getByRole("button", { name: "Recargar datos" }).click();
  await expect(second.getByRole("heading", { name: "Pregunta 1 de 1", exact: true })).toBeVisible();
  await page.getByRole("radio", { name: "B. Dos" }).check();
  await persisted(page, s => s?.round?.selections[0]?.[0] === 1);
  await second.getByRole("button", { name: "Ver resumen" }).click();
  await expect(second.getByRole("alert")).toContainText("Otra pestaña");
  expect((await readState(page)).round.selections[0]).toEqual([1]);
});

test("stale Home tab cannot reset history after a round starts elsewhere", async ({ page, context }) => {
  page.on("dialog", dialog => dialog.accept());
  await page.goto("./");
  await page.getByText("Copias, importación y reinicio", { exact: true }).click();
  await page.getByLabel("Importar una copia o progreso").setInputFiles({
    name: "progress.json", mimeType: "application/json", buffer: Buffer.from('{"10001":true}'),
  });
  await page.getByRole("button", { name: "Confirmar importación" }).click();
  await expect(page.getByText("Importación guardada.")).toBeVisible();
  const other = await context.newPage();
  await other.goto("./");
  await start(other, "Modelos");
  await page.getByLabel("Quiero borrar mi historial guardado").check();
  await page.getByRole("button", { name: "Reiniciar historial" }).click();
  await expect(page.getByRole("alert")).toContainText("Otra pestaña");
  expect((await readState(page)).progress).toEqual({ 10001: true });
  expect((await readState(page)).round).not.toBeNull();
});

test("failed writes roll back both storage and visible selections", async ({ page }) => {
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (window.failWrites && key === "current") throw new DOMException("Storage full", "QuotaExceededError");
      return original.call(this, value, key);
    };
  });
  await page.goto("./");
  await start(page);
  await page.evaluate(() => { window.failWrites = true; });
  await page.getByRole("radio", { name: "B. Dos" }).check();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("radio", { name: "B. Dos" })).not.toBeChecked();
  expect((await readState(page)).round.selections).toEqual({});
  await page.evaluate(() => { window.failWrites = false; });
  await page.getByRole("radio", { name: "B. Dos" }).check();
  await page.getByRole("button", { name: "Comprobar respuesta" }).click();
  await expect(page.getByText("Respuesta correcta.", { exact: true })).toBeVisible();
});

test("corrupt current state is not silently reset and can recover its backup", async ({ page }) => {
  page.on("dialog", dialog => dialog.accept());
  await page.goto("./");
  await start(page);
  await page.getByRole("radio", { name: "B. Dos" }).check();
  await persisted(page, s => s?.round?.selections[0]?.[0] === 1);
  await page.getByRole("button", { name: "Comprobar respuesta" }).click();
  await expect(page.getByText("Respuesta correcta.", { exact: true })).toBeVisible();
  await page.evaluate(() => new Promise(resolve => {
    const request = indexedDB.open(`pmle-study:${new URL(".", document.baseURI).pathname}`, 1);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction("state", "readwrite");
      tx.objectStore("state").put(null, "current");
      tx.oncomplete = () => { db.close(); resolve(); };
    };
  }));
  await page.reload();
  await expect(page.getByRole("heading", { name: "No se pudo abrir la aplicación" })).toBeVisible();
  expect(await readState(page)).toBeNull();
  await page.getByRole("button", { name: "Recuperar copia anterior" }).click();
  await expect(page.getByText("Copia anterior recuperada.")).toBeVisible();
  await expect(page.getByRole("radio", { name: "B. Dos" })).toBeChecked();
  expect((await readState(page)).round.results).toEqual({});
});

test("local editor preserves modes and metadata without changing active snapshot", async ({ page }) => {
  await page.goto("./");
  await start(page);
  await page.getByRole("link", { name: "Editar preguntas" }).click();
  await page.getByRole("button", { name: "Editar esta pregunta" }).click();
  await page.getByRole("radio", { name: "A. Uno" }).check();
  await page.getByRole("textbox", { name: "Explicación", exact: true }).fill("Edición local");
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(page.getByText("Edición guardada en este navegador.")).toBeVisible();
  const state = await readState(page);
  expect(state.edits[10001].answer).toBe(0);
  expect(state.edits[10001].gcp_topics).toEqual(["Datos"]);
  expect(state.round.questions[0].answer).toBe(1);
  await page.reload();
  await expect(page.getByText("Edición local", { exact: true })).toBeVisible();
});

test("legacy progress import, backup, reset confirmation and empty product connections", async ({ page }) => {
  page.on("dialog", dialog => dialog.accept());
  await page.goto("./");
  await page.getByText("Copias, importación y reinicio", { exact: true }).click();
  await page.getByLabel("Importar una copia o progreso").setInputFiles({
    name: "progress.json", mimeType: "application/json", buffer: Buffer.from('{"10001":false}'),
  });
  await page.getByRole("button", { name: "Confirmar importación" }).click();
  await expect(page.getByText("Importación guardada.")).toBeVisible();
  const backup = page.waitForEvent("download");
  await page.getByRole("button", { name: "Descargar copia completa" }).click();
  expect((await backup).suggestedFilename()).toBe("pmle-copia-completa.json");
  await expect(page.getByRole("button", { name: "Reiniciar historial" })).toBeDisabled();
  await page.getByLabel("Quiero borrar mi historial guardado").check();
  await page.getByRole("button", { name: "Reiniciar historial" }).click();
  await expect(page.getByText("Historial reiniciado. Se conserva una copia anterior.")).toBeVisible();
  expect((await readState(page)).progress).toEqual({});
  await page.getByRole("link", { name: "Productos", exact: true }).click();
  await page.getByLabel("Buscar un producto").fill("aislado");
  await page.getByRole("combobox", { name: "Vista", exact: true }).selectOption("Conexiones");
  await expect(page.getByText("Estos productos no tienen conexiones registradas.")).toBeVisible();
});

test("malformed import does not overwrite data and HTML content is sanitized", async ({ page, context }) => {
  await context.route("**/data/quizzes.jsonl", route => route.fulfill({ body: jsonl([{ ...questions[0], question: '<img src="x" onerror="window.injected=true"><script>window.injected=true</script><p>Seguro</p>' }]) }));
  await page.goto("./");
  await page.getByText("Copias, importación y reinicio", { exact: true }).click();
  await page.getByLabel("Importar una copia o progreso").setInputFiles({ name: "bad.json", mimeType: "application/json", buffer: Buffer.from('{"10001":"true"}') });
  await expect(page.getByRole("alert")).toContainText("inválidos");
  await start(page);
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
  await expect(page.locator("main script")).toHaveCount(0);
  expect((await readState(page)).progress).toEqual({});
});

test("storage failure is explicit and does not present a working ephemeral app", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "indexedDB", { value: { open() { throw new DOMException("Storage blocked", "SecurityError"); } } });
  });
  await page.goto("./");
  await expect(page.getByRole("heading", { name: "No se pudo abrir la aplicación" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Volver a cargar" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Preparar práctica" })).toHaveCount(0);
});

test("dark/light themes, all destinations and 320px layout", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("heading", { name: "Tu próxima sesión de estudio" })).toBeVisible();
  await page.getByRole("button", { name: "Cambiar tema" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.setViewportSize({ width: 320, height: 740 });
  for (const name of ["Inicio", "Práctica", "Progreso", "Productos", "Exportar", "Editar preguntas"]) {
    await page.getByRole("link", { name, exact: true }).click();
    await expect(page.locator("main h1")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
