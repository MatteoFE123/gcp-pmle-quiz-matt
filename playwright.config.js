import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/web",
  testMatch: "*.spec.js",
  fullyParallel: true,
  use: { baseURL: "http://127.0.0.1:4173/gcp-pmle-quiz-matt/", trace: "retain-on-failure" },
  webServer: {
    command: "npm run preview -- --port 4173 --strictPort --base /gcp-pmle-quiz-matt/",
    url: "http://127.0.0.1:4173/gcp-pmle-quiz-matt/",
    reuseExistingServer: false,
  },
});
