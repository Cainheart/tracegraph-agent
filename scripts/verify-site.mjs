import { loadSiteProjection } from "./site-projection.mjs";
try {
  if (process.argv.length !== 2) throw new Error("Usage: node scripts/verify-site.mjs");
  const projection = await loadSiteProjection();
  console.log(JSON.stringify({ version: projection.version, ...projection.checks, excludedPages: projection.excludedPages.length, publication: "local canonical preview only; no translations or deployment" }, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
