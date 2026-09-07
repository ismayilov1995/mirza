import { runSupervisorNow } from "@/app/agent/actions";
import { getSession } from "@/lib/access";
import { getRunState } from "@/lib/supervisor/feed";
import AutoRefresh from "./AutoRefresh";
import RunSupervisorButton from "./RunSupervisorButton";
import { Icon } from "@/components/ui";
import s from "@/components/ui/ui.module.css";

function bakuTime(iso: string): string {
  const d = new Date(iso);
  const fmt = (o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("az-AZ", { timeZone: "Asia/Baku", ...o }).format(d);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Baku" }).format(new Date());
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Baku" }).format(d);
  const time = fmt({ hour: "2-digit", minute: "2-digit" });
  return day === today ? time : `${fmt({ day: "numeric", month: "short" })} ${time}`;
}

/**
 * "Yoxlamanı indi işlət" — cron-un növbəti saatını gözləməmək üçün.
 *
 * Yalnız admin görür: hər klik Anthropic API-yə pul xərcləyir, ona görə
 * keçən gedişatın hesabı da düymənin yanında yazılır — kor-koranə basılan
 * düymə olmasın.
 */
export default async function SupervisorRunBar() {
  const me = await getSession();
  if (me?.role !== "admin") return null;

  const state = await getRunState();

  return (
    <div className={s.runBar}>
      {state.running ? (
        <>
          {/* Gedişat 1–2 dəqiqə çəkir və bazada bitir — səhifəni özü yeniləsin. */}
          <AutoRefresh intervalMs={6000} />
          <span className={s.runBusy}>
            <Icon name="loader-circle" size={13} className={s.spin} />
            Nəzarətçi işləyir
            {state.startedAt ? ` — ${bakuTime(state.startedAt)}-də başladı` : ""}
          </span>
          <span className={s.runMeta}>Bitəndə lent özü yenilənəcək.</span>
        </>
      ) : (
        <>
          <form action={runSupervisorNow}>
            {/* Emoji ikon deyil: dizayn dili SVG tələb edir və «🔄» ekran
                oxuyucusuna "arrows counterclockwise" kimi oxunur. */}
            <RunSupervisorButton />
          </form>
          <span className={s.runMeta}>
            {state.finishedAt
              ? `Son yoxlama ${bakuTime(state.finishedAt)} · ${state.findingCount} tapıntı` +
                (state.costUsd ? ` · ≈$${state.costUsd.toFixed(2)}` : "")
              : "Hələ yoxlama olmayıb."}
            {state.status === "error" ? " · sonuncu gedişat xəta ilə bitib" : ""}
          </span>
        </>
      )}
    </div>
  );
}
