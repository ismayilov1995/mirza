"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LiveDot } from "@/components/ui";

type Status = "connecting" | "live" | "offline";

/**
 * Yeni mesaj gələndə səhifəni yeniləyir.
 *
 * `router.refresh()` server komponentin ÖZ sorğularını yenidən işlədir və
 * React nəticəni yerində dəyişir. Bu qəsdəndir: canlı rəqəmlərlə bazadakı
 * rəqəmlər eyni sorğudan gəlir, ona görə bir-birindən ayrıla bilmir.
 * Alternativ — hadisənin içindəki rəqəmləri müştəridə yamamaq — statistikanın
 * ikinci bir hesablaması olardı və birinci uyğunsuzluqda yanlış göstərərdi.
 */
export default function LiveUpdates({ instanceId }: { instanceId?: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("connecting");
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);

  useEffect(() => {
    const url = instanceId ? `/api/live?instanceId=${encodeURIComponent(instanceId)}` : "/api/live";
    const source = new EventSource(url);

    const onReady = () => setStatus("live");
    const onMessage = () => {
      setStatus("live");
      setLastUpdate(new Date().toLocaleTimeString());
      router.refresh();
    };
    // EventSource özü yenidən qoşulur; vəziyyəti göstərmək lazımdır, çünki
    // ölü axınla sakit gün eyni görünür.
    const onError = () => setStatus("offline");

    source.addEventListener("ready", onReady);
    source.addEventListener("open", onReady);
    source.addEventListener("message", onMessage);
    source.addEventListener("error", onError);

    return () => {
      source.removeEventListener("ready", onReady);
      source.removeEventListener("open", onReady);
      source.removeEventListener("message", onMessage);
      source.removeEventListener("error", onError);
      source.close();
    };
  }, [router, instanceId]);

  const label =
    status === "offline"
      ? "Canlı yeniləmə kəsilib"
      : status === "connecting"
        ? "Qoşulur…"
        : lastUpdate
          ? `Canlı · ${lastUpdate}`
          : "Canlı · mesaj gözlənilir";

  /* Nişan dizayn sistemindən gəlir (LiveDot): əvvəl burada öz inline stili
     vardı və nəbzi yox idi, yəni "canlı" sözü yazılırdı, amma göstərilmirdi.
     Nəbz yalnız bağlantı diri olanda vurur — dayanmış nöqtə elə "yenilənmə
     dayanıb" deməkdir. */
  return (
    <span title="Mesaj gələn kimi yenilənir — səhifəni yeniləmək lazım deyil.">
      <LiveDot live={status === "live"} label={label} />
    </span>
  );
}
