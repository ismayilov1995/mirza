import { requireMonitorScope, type MonitorScope } from "./access";

/*
 * /api/monitor/* route-larının ortaq girişi.
 *
 * `?as=<userId>` yalnız ADMİN üçün işləyir və "bu nəzarətçi nə görür"
 * önizləməsidir — yoxlama requireMonitorScope()-dadır, burada yalnız parametr
 * oxunur. Nəzarətçi özü bu parametri yazsa, nəzərə alınmır.
 */
export async function scopeFromRequest(request: Request): Promise<MonitorScope> {
  const raw = new URL(request.url).searchParams.get("as");
  const as = raw ? Number(raw) : NaN;
  return requireMonitorScope(Number.isInteger(as) && as > 0 ? as : undefined);
}

/** Nəzarətçi cavabları heç vaxt keşlənmir — canlı görünüşdür. */
export const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * URL-dən müsbət tam ədəd — yoxdursa null.
 *
 * `Number(searchParams.get(x))` İŞLƏMİR: parametr yoxdursa `Number(null)` sıfır
 * qaytarır və sıfır "sonludur", yəni verilməmiş limit səssizcə ən kiçik dəyərə
 * sıxılır. (Elə oldu da: limit verilməyəndə siyahı 40 yerinə 10 sətir qaytardı.)
 */
export function intParam(url: URL, name: string): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}
