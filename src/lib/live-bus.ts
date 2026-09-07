// Vebhukdan gələn siqnalı açıq dashboard səhifələrinə ötürən sadə kanal.
//
// Katibe mesajları öz bazasına köçürmür — birbaşa evolution_api-dən oxuyur.
// Ona görə burada "ingest" yoxdur: vebhukun bütün işi "yeni mesaj gəldi"
// deməkdir, səhifə isə özü yenidən sorğu atır. Bu, rəqəmlərin iki yerdə
// hesablanıb bir-birindən ayrılmasının qarşısını alır.
//
// YALNIZ BİR PROSES ÜÇÜN. Abunəçilər siyahısı yaddaşdadır, yəni bu app tək
// `next start` prosesi kimi işlədiyi müddətdə doğrudur (indi elədir: systemd,
// 127.0.0.1:3000). Cluster rejimində Redis pub/sub-a keçmək lazım olacaq —
// `redis` paketi onsuz da asılılıqlarda var.

export type LiveEvent =
  | {
      type: "message";
      instanceId: string;
      instanceName: string;
      /** Qrup söhbətidirmi — səhifə buna görə süzgəcdən keçirə bilsin. */
      isGroup: boolean;
      /**
       * Hansı söhbətə gəldi.
       *
       * Statistika səhifələri buna baxmır (onlar sadəcə yenilənir), amma
       * nəzarətçi görünüşü açıq söhbətə mesaj ƏLAVƏ edir — yəni "hansı" sualı
       * olmadan ya hər hadisədə bütün yazışma yenidən çəkilməli, ya da gizli
       * söhbətin hərəkəti də ekrana düşməli olardı. İkisi də pisdir.
       *
       * DİQQƏT: bu sahə abunəçiyə OLDUĞU KİMİ verilmir — /api/monitor/live onu
       * görünmə qaydalarından keçirir (bax src/lib/access.ts).
       */
      remoteJid: string;
      at: string;
    }
  | {
      // Nəzarətçi agent yeni post yazdı (scripts/supervisor-run.ts →
      // /api/webhooks/agent). Müştəri tərəfi üçün fərq yoxdur — LiveUpdates
      // hər kadrda router.refresh() edir; tip yalnız aydınlıq üçündür.
      type: "agent_post";
      instanceId: string;
      count: number;
      maxSeverity: number;
      at: string;
    }
  | {
      /*
       * Açıq bayraq satıcının cavabı ilə dərhal bağlandı
       * (supervisor/reactive.ts). Ayrıca tip, çünki hadisə tərsinədir: lentə
       * sətir ƏLAVƏ olunmur, çıxır.
       *
       * SÖHBƏTİN JID-i QƏSDƏN YOXDUR. /api/live hadisəni olduğu kimi ötürür,
       * yəni instansı görən hər sessiya bu sahəni oxuya bilərdi; «hansı
       * söhbətdə bayraq bağlandı» isə görünmə qaydalarından keçməli məlumatdır
       * (bax /api/monitor/live). Səhifə onsuz da bütöv yenilənir — say kifayət
       * edir.
       */
      type: "flag_closed";
      instanceId: string;
      count: number;
      at: string;
    };

type Subscriber = (event: LiveEvent) => void;

const subscribers = new Set<Subscriber>();

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

export function hasSubscribers(): boolean {
  return subscribers.size > 0;
}

export function publish(event: LiveEvent): void {
  for (const fn of subscribers) {
    try {
      fn(event);
    } catch (err) {
      // Bir ölü axın qalan açıq səhifələrə çatdırmanı dayandırmamalıdır və
      // heç vaxt vebhuk cavabına qayıtmamalıdır.
      console.error("live bus subscriber threw:", err);
    }
  }
}
