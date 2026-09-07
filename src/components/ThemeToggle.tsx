"use client";

import { useEffect, useSyncExternalStore } from "react";
import { Icon } from "@/components/ui";
import { THEME_COOKIE, type ThemePref } from "@/lib/theme";
import s from "@/components/ui/ui.module.css";

const OPTIONS: { key: ThemePref; icon: string; label: string }[] = [
  { key: "system", icon: "monitor", label: "Sistem" },
  { key: "light", icon: "sun", label: "İşıqlı" },
  { key: "dark", icon: "moon", label: "Tünd" },
];

/*
 * Seçim brauzerin cookie-sindədir, React state-ində yox.
 *
 * useSyncExternalStore məhz bunun üçündür: dəyər komponentin xaricində yaşayır
 * və serverdə oxunmur. Sadə useState + useEffect burada iki problem yaradardı
 * — hidrasiya uyğunsuzluğu (server "tünd" yazır, brauzer cookie-dən "işıqlı"
 * oxuyur) və effekt içində dərhal setState (kaskad render).
 */
let listeners: (() => void)[] = [];

function subscribe(fn: () => void): () => void {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((l) => l !== fn);
  };
}

function readPref(): ThemePref {
  const m = document.cookie.match(new RegExp(`(?:^|; )${THEME_COOKIE}=([^;]*)`));
  const v = m ? decodeURIComponent(m[1]) : "dark";
  return v === "light" || v === "system" ? v : "dark";
}

/** Serverdə cookie yoxdur; layout da eyni default ilə render edir. */
function serverPref(): ThemePref {
  return "dark";
}

function resolve(pref: ThemePref): "light" | "dark" {
  if (pref !== "system") return pref;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function store(pref: ThemePref): void {
  // Bir il, Lax: yalnız bu adamın brauzerinə aid görünüş tənzimidir.
  document.cookie =
    `${THEME_COOKIE}=${pref}; path=/; max-age=${365 * 24 * 3600}; samesite=lax`;
  document.documentElement.dataset.theme = resolve(pref);
  for (const l of [...listeners]) l();
}

/**
 * Tema seçici — sistem / işıqlı / tünd.
 *
 * Seçim dərhal tətbiq olunur və səhifə yenilənmir: tema bir atributdur, onu
 * dəyişmək üçün serveri bir daha soruşmağa ehtiyac yoxdur. Cookie yalnız
 * NÖVBƏTİ səhifənin serverdə düzgün temada render olunması üçün yazılır.
 *
 * "Sistem" seçiləndə əməliyyat sisteminin gün ərzində dəyişməsi də izlənilir —
 * noutbuk axşam öz-özünə tündləşəndə panel də tündləşməlidir.
 */
export default function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const pref = useSyncExternalStore(subscribe, readPref, serverPref);

  /* Sistem rejimində əməliyyat sistemi gün ərzində dəyişə bilər. Yalnız
     atribut yenilənir — burada setState yoxdur, çünki seçim dəyişmir,
     yalnız onun həlli dəyişir. */
  useEffect(() => {
    if (pref !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => {
      document.documentElement.dataset.theme = mq.matches ? "light" : "dark";
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);

  return (
    <div className={s.themeGroup} role="group" aria-label="Tema">
      {OPTIONS.map((o) => (
        <button
          key={o.key}
          type="button"
          className={s.themeBtn}
          data-active={pref === o.key ? "true" : undefined}
          aria-pressed={pref === o.key}
          title={o.label}
          onClick={() => store(o.key)}
        >
          <Icon name={o.icon} size={13} />
          {!compact && <span>{o.label}</span>}
        </button>
      ))}
    </div>
  );
}
