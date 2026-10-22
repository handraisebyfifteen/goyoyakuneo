import { Link } from "wouter";
import type { ReactNode } from "react";
import { useI18n } from "@/lib/i18n";
import { Button } from "@/components/ui/button";

export function Layout({ children, title, right }: { children: ReactNode; title?: string; right?: ReactNode }) {
  const { t, lang, setLang } = useI18n();
  return (
    <div className="min-h-screen flex flex-col">
      <a href="#main" className="sr-only sr-only-focusable absolute left-2 top-2 z-50 bg-card px-3 py-2 rounded">{lang === "ja" ? "本文へ移動" : "Skip to content"}</a>
      <header className="border-b-2 bg-card">
        <div className="mx-auto max-w-3xl px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
          <Link href="/" className="text-lg font-bold" data-testid="link-home">{t("appName")}</Link>
          <div className="flex items-center gap-2">
            {right}
            <div role="group" aria-label="Language" className="flex rounded-md border-2 overflow-hidden">
              <button type="button" aria-pressed={lang === "ja"} onClick={() => setLang("ja")} className={`px-3 py-2 text-sm font-semibold ${lang === "ja" ? "bg-primary text-primary-foreground" : "bg-card"}`} data-testid="button-lang-ja">日本語</button>
              <button type="button" aria-pressed={lang === "en"} onClick={() => setLang("en")} className={`px-3 py-2 text-sm font-semibold ${lang === "en" ? "bg-primary text-primary-foreground" : "bg-card"}`} data-testid="button-lang-en">English</button>
            </div>
          </div>
        </div>
      </header>
      <main id="main" className="flex-1 mx-auto w-full max-w-3xl px-4 py-6">
        {title && <h1 className="text-2xl font-bold mb-5">{title}</h1>}
        {children}
      </main>
      <footer className="border-t-2 py-4 text-center text-sm text-muted-foreground">
        <Button variant="link" asChild size="sm"><Link href="/lookup">{t("customerLookup")}</Link></Button>
      </footer>
    </div>
  );
}
