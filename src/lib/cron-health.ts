import { readFile } from "node:fs/promises";
import path from "node:path";

/*
 * Cron gözətçisinin son nəticəsi — /admin ekranındakı nişan üçün.
 *
 * Mənbə scripts/cron-watchdog.sh-in yazdığı JSON-dur. Bazadan gəlmir və
 * qəsdən: gözətçi Postgres susanda da işləməlidir, ona görə nəticəsini
 * bazaya yazmır. Fayl saatda bir dəfə tam üzərinə yazılır.
 *
 * GÖZƏTÇİNİN ÖZÜ SUSA BİLƏR — və bu hal xüsusi işlənir. Bütün bu iş ona görə
 * görüldü ki, sakit dayanan cron gözdən qaçmasın; gözətçinin özü dayansa və
 * ekran sadəcə köhnə "hər şey qaydasındadır" nəticəsini göstərsə, eyni tələyə
 * bir qat yuxarıda düşərdik. Ona görə faylın yaşı da nəticənin bir hissəsidir:
 * saatlıq iş üçün iki saatdan köhnə cavab cavab deyil.
 */

/** Gözətçi saatda bir işləyir; iki saatdan köhnə nəticə etibarsızdır. */
const STALE_AFTER_MS = 2 * 3600_000;

const STATE_PATH = path.join(process.cwd(), "logs", "watchdog-state.json");

export interface CronProblem {
  /** İLİŞİB | İŞLƏMİR | İŞLƏMƏYİB | KİLİDSİZ */
  kind: string;
  job: string;
  detail: string;
}

export interface CronHealth {
  checkedAt: Date | null;
  okCount: number;
  problems: CronProblem[];
  /** Nəticə var, amma köhnədir — gözətçi özü işləmir. */
  stale: boolean;
  /** Fayl yoxdur və ya oxunmur — gözətçi heç vaxt işləməyib. */
  missing: boolean;
}

/**
 * Heç vaxt atmır.
 *
 * Bu, /admin səhifəsinin ƏLAVƏ məlumatıdır. Fayl yoxdursa, yarımçıq
 * yazılıbsa və ya JSON pozulubsa, admin ekranı bütünlüklə çökməməlidir —
 * nişan "gözətçi susur" deyir və qalan hər şey öz işini görür.
 */
export async function getCronHealth(): Promise<CronHealth> {
  const empty: CronHealth = {
    checkedAt: null,
    okCount: 0,
    problems: [],
    stale: false,
    missing: true,
  };

  let raw: string;
  try {
    raw = await readFile(STATE_PATH, "utf8");
  } catch {
    return empty;
  }

  let parsed: {
    checked_at?: unknown;
    ok_count?: unknown;
    problems?: unknown;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }

  const checkedAt =
    typeof parsed.checked_at === "string" && !Number.isNaN(Date.parse(parsed.checked_at))
      ? new Date(parsed.checked_at)
      : null;

  const problems: CronProblem[] = Array.isArray(parsed.problems)
    ? parsed.problems.flatMap((p) => {
        if (typeof p !== "object" || p === null) return [];
        const o = p as Record<string, unknown>;
        return typeof o.job === "string"
          ? [
              {
                kind: typeof o.kind === "string" ? o.kind : "?",
                job: o.job,
                detail: typeof o.detail === "string" ? o.detail : "",
              },
            ]
          : [];
      })
    : [];

  return {
    checkedAt,
    okCount: typeof parsed.ok_count === "number" ? parsed.ok_count : 0,
    problems,
    stale: checkedAt !== null && Date.now() - checkedAt.getTime() > STALE_AFTER_MS,
    missing: checkedAt === null,
  };
}
