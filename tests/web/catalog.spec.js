import { test, expect } from "@playwright/test";
import { readFile, readdir } from "node:fs/promises";

test("production artifact contains no learner files or server sources", async () => {
  expect((await readdir("dist/data")).sort()).toEqual(["gcp_products.jsonl", "quizzes.jsonl"]);
  const root = await readdir("dist");
  for (const denied of ["cache", ".git", ".env", "tests", "node_modules", "utils", "README.md"]) expect(root).not.toContain(denied);
});

test("real catalog, subdirectory URLs, images and responsive study screens", async ({ page }, testInfo) => {
  const failures = [];
  page.on("pageerror", error => failures.push(error.message));
  await page.goto("./");
  await expect(page.getByRole("heading", { name: "Tu próxima sesión de estudio" })).toBeVisible();
  await expect(page.locator(".metric").first()).toContainText("841");
  await page.screenshot({ path: testInfo.outputPath("home-dark.png"), fullPage: true });
  await page.getByRole("link", { name: "Editar preguntas" }).click();
  const bank = (await readFile("data/quizzes.jsonl", "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const illustrated = bank.find(q => q.explanation?.includes("<img"));
  await page.getByRole("combobox", { name: "Pregunta por identificador" }).selectOption(String(illustrated.id));
  const image = page.locator("main img").first();
  await image.scrollIntoViewIfNeeded();
  await expect.poll(() => image.evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
  expect(await image.getAttribute("src")).toContain("/gcp-pmle-quiz-matt/static/images/");
  await page.setViewportSize({ width: 320, height: 740 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("link", { name: "Práctica", exact: true }).click();
  await page.getByRole("button", { name: "Empezar ronda", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Pregunta 1 de 20", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("question-mobile.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Cambiar tema" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({ path: testInfo.outputPath("question-light.png"), fullPage: true });
  expect(failures).toEqual([]);
});
