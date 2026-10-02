import { cp, mkdir, writeFile } from "node:fs/promises";

// Publish only the catalog and its images, never learner files or Python caches.
await mkdir("dist/data", { recursive: true });
for (const name of ["quizzes.jsonl", "gcp_products.jsonl"]) {
  await cp(`data/${name}`, `dist/data/${name}`);
}
await cp("static/images", "dist/static/images", { recursive: true });
await writeFile("dist/.nojekyll", "");
