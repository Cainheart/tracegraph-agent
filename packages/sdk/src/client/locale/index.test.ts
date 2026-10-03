import { describe, expect, it } from "vitest";
import { createTranslator, localeCatalogs, localeKeys, resolveLocale, terminalLocale, translate } from "./index.js";

describe("shared client locale contract", () => {
  it("uses identical complete keys for Web, Desktop and terminal clients", () => {
    expect(localeKeys.length).toBeGreaterThan(300);
    expect(Object.keys(localeCatalogs.en)).toEqual(Object.keys(localeCatalogs["zh-CN"]));
    for (const locale of ["en", "zh-CN"] as const) {
      const web = createTranslator(locale);
      const desktop = createTranslator(locale);
      const terminal = createTranslator(terminalLocale({ TRACEGRAPH_LOCALE: locale }));
      for (const key of localeKeys) {
        expect(web(key)).toBe(desktop(key));
        expect(web(key)).toBe(terminal(key));
        expect(web(key).trim().length).toBeGreaterThan(0);
      }
    }
  });
  it("falls back without changing wire values, model text or prototype keys", () => {
    expect(translate("fr-FR", "Settings")).toBe("Settings");
    expect(translate("zh_CN.UTF-8", "Settings")).toBe("设置");
    for (const value of ["run.completed", "user supplied text", "constructor", "__proto__"]) {
      expect(translate("zh-CN", value)).toBe(value);
    }
    expect(resolveLocale(undefined)).toBe("en");
    expect(resolveLocale("C.UTF-8")).toBe("en");
  });
  it("honors explicit locale before POSIX environment and preserves missing placeholders", () => {
    expect(terminalLocale({ TRACEGRAPH_LOCALE: "en", LC_ALL: "zh_CN.UTF-8" })).toBe("en");
    expect(terminalLocale({ LC_MESSAGES: "zh_CN.UTF-8", LANG: "en_US" })).toBe("zh-CN");
    expect(translate("en", "{count} items for {name}", { count: 3 })).toBe("3 items for {name}");
    expect(translate("en", "{value}", { value: "$& <unsafe>" })).toBe("$& <unsafe>");
  });
});
