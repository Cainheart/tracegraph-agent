import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LanguageProvider, useI18n } from "./i18n.js";

function Probe() {
  const { language, t } = useI18n();
  return <span lang={language}>{t("Settings")}|{t("run.completed")}</span>;
}

function renderPreference(saved: string | null, browserLanguage: string) {
  vi.stubGlobal("window", { localStorage: { getItem: () => saved }, navigator: { language: browserLanguage } });
  return renderToStaticMarkup(<LanguageProvider><Probe /></LanguageProvider>);
}

afterEach(() => vi.unstubAllGlobals());

describe("shared Web/Desktop language provider", () => {
  it("uses the shared Chinese catalog from saved preferences", () => {
    expect(renderPreference("zh-CN", "en-US")).toContain('lang="zh-CN">设置|run.completed');
  });
  it("uses browser hints when the persisted preference is unsupported", () => {
    expect(renderPreference("invalid", "zh-TW")).toContain('lang="zh-CN">设置|run.completed');
    expect(renderPreference(null, "fr-FR")).toContain('lang="en">Settings|run.completed');
  });
  it("keeps explicit English preference and renders safely without browser globals", () => {
    expect(renderPreference("en", "zh-CN")).toContain('lang="en">Settings|run.completed');
    vi.stubGlobal("window", undefined);
    expect(renderToStaticMarkup(<LanguageProvider><Probe /></LanguageProvider>)).toContain('lang="en">Settings|run.completed');
  });
});
