import { fileURLToPath } from "node:url";

export const EVAL_ROOT = fileURLToPath(new URL("../", import.meta.url));
export const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const EVAL_TMP_ROOT = fileURLToPath(new URL("../../_tmp_evals/", import.meta.url));
export const EVAL_METRICS_DIR = fileURLToPath(new URL("../../_tmp_evals/metrics/", import.meta.url));
export const EVAL_REPORT_PATH = fileURLToPath(
  new URL("../../_tmp_evals/reports/latest.json", import.meta.url),
);
