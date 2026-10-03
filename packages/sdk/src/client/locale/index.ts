import { zhCN } from "./catalog.js";

export type ClientLocale = "en" | "zh-CN";
export type LocaleKey = keyof typeof zhCN;
export const supportedLocales: readonly ClientLocale[] = Object.freeze(["en", "zh-CN"]);
export const localeKeys: readonly LocaleKey[] = Object.freeze(Object.keys(zhCN) as LocaleKey[]);
export const localeCatalogs: Readonly<Record<ClientLocale, Readonly<Record<LocaleKey, string>>>> = Object.freeze({
  en: Object.freeze(Object.fromEntries(localeKeys.map((key) => [key, key])) as Record<LocaleKey, string>),
  "zh-CN": zhCN,
});

/** Explicit locale takes precedence over environment hints. POSIX locale suffixes are accepted. */
export function resolveLocale(value?: string | null): ClientLocale {
  const normalized = value?.trim().toLowerCase().replaceAll("_", "-").split(/[.@]/u)[0];
  return normalized === "zh" || normalized?.startsWith("zh-") ? "zh-CN" : "en";
}

/** Presentation-only translation. Unknown keys preserve the caller's exact fallback text. */
export function translate(locale: string | null | undefined, key: string, values: Readonly<Record<string, string | number>> = {}): string {
  const catalog = localeCatalogs[resolveLocale(locale)];
  const template = Object.hasOwn(catalog, key) ? catalog[key as LocaleKey] : key;
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu, (placeholder, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : placeholder);
}

/** Browser, Desktop and terminal adapters share one key set and fallback policy. */
export function createTranslator(locale?: string | null): (key: string, values?: Readonly<Record<string, string | number>>) => string {
  return (key, values) => translate(locale, key, values);
}

export function terminalLocale(environment: Readonly<Record<string, string | undefined>>): ClientLocale {
  return resolveLocale(environment.TRACEGRAPH_LOCALE || environment.LC_ALL || environment.LC_MESSAGES || environment.LANG);
}
