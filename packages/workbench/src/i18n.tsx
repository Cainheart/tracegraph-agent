import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { resolveLocale, translate, type ClientLocale } from "@tracegraph/sdk/client";

export type Language = ClientLocale;

const STORAGE_KEY = "tracegraph.language";



interface I18nValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (text: string) => string;
}

const I18nContext = createContext<I18nValue>({
  language: "en",
  setLanguage: () => undefined,
  t: (text) => text,
});

function initialLanguage(): Language {
  if (typeof window === "undefined") return "en";
  const saved = window.localStorage.getItem(STORAGE_KEY);
  if (saved === "zh-CN" || saved === "en") return saved;
  return resolveLocale(window.navigator.language);
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(initialLanguage);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, language);
    document.documentElement.lang = language;
  }, [language]);

  const value = useMemo<I18nValue>(() => ({
    language,
    setLanguage,
    t: (text) => translate(language, text),
  }), [language]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
