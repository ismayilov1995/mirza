import { pool } from "../db";
import { publish, hasSubscribers } from "../live-bus";

/*
 * Bayrağın DƏRHAL bağlanması — saatlıq gedişatı gözləmədən.
 *
 * PROBLEM, ölçülmüş halda. Bayraq açılır, satıcı iki dəqiqə sonra müştəriyə
 * yazır, məsələ bitir — amma lentdə bayraq qırmızı qalır, çünki onu bağlayan
 * yeganə şey saatda bir işləyən gedişatdır. Son 30 günün rəqəmi (368 öz-özünə
 * bağlanmış cavabsızlıq bayrağı): satıcının cavabı ilə bayrağın bağlanması
 * arasında MEDİAN 32 dəqiqə, 199-u (54%) yarım saatdan çox. Yəni menecerin
 * lentdə gördüyü hər ikinci qırmızı sətir artıq həll olunmuş problem idi.
 *
 * HƏLL: mesaj vebhuku onsuz da hər gedişən mesajda gəlir (route.ts). Açıq
 * bayrağı olan söhbətə cavab yazılan kimi HƏMİN söhbət — yalnız o — yenidən
 * yoxlanılır. Bütün sistemi hər mesajda yoxlamaq bahadır və lazım deyil:
 * cavab yalnız öz söhbətinin bayrağına təsir edir.
 *
 * QƏRAR QAYDASI DƏYİŞMİR. Burada bağlanma şərti autoCloseMissing-dəki ilə
 * eynidir (persist.ts): bayrağı doğuran son gələn mesajdan SONRA bizdən mesaj
 * getdiyi görünməlidir. Yəni bu, yeni bir siyasət deyil — eyni qərar, bir saat
 * tez. Bir yerdə daha ehtiyatlıdır: cavabımızdan sonra müştəri yenidən
 * yazıbsa, bayraq AÇIQ qalır (aşağıdakı qeydə bax).
 *
 * BAYRAQ AÇMIR, yalnız bağlayır. Açmaq üçün SLA təqvimi, nəzarət saatları,
 * müştəri dairəsi və doğrulama lazımdır — onlar gedişatın işidir. Vebhuk
 * yolunda model ÇAĞIRILMIR, deməli bu yol pul xərcləmir.
 */

/** Vebhuk Message sətrindən tez gələ bilər — sübutu axtarmazdan əvvəl bu qədər gözlə. */
const WRITE_GRACE_MS = 2000;

/** Sətir hələ görünməyibsə bir dəfə də bax (media/qeyri-adi gecikmə üçün). */
const RETRY_DELAY_MS = 8000;

export interface ReactiveResult {
  /** Söhbətdə açıq bayraq var idimi — yoxdursa heç nə edilmir. */
  hadOpenFlags: boolean;
  closed: number;
}

/**
 * Bir söhbətin açıq bayraqlarını cavabdan sonra bağlayır.
 *
 * Sorğu bir dənədir və indekslidir (2026-09-06_reactive_flag_index.sql):
 * açıq bayrağı olmayan söhbətdə — yəni mesajların böyük əksəriyyətində —
 * heç bir sətrə toxunmadan qayıdır.
 */
export async function closeFlagsAfterReply(
  instanceId: string,
  remoteJid: string,
): Promise<ReactiveResult> {
  const { rows } = await pool.query<{ id: string; detector: string }>(
    `UPDATE katibe.agent_posts p
        SET acknowledged_at = now(), closed_reason = 'AUTO'
      WHERE p.instance_id = $1
        AND p.remote_jid = $2
        AND p.acknowledged_at IS NULL
        AND p.kind = 'finding'
        -- Sağlamlıq postları söhbətə bağlı deyil; şərt onsuz da tutmur, amma
        -- niyyət açıq yazılsın (persist.ts-dəki eyni istisna).
        AND p.detector <> 'instance_health'
        AND (p.evidence->>'lastInboundTs') IS NOT NULL
        -- SÜBUT: bayrağı doğuran mesajdan sonra BİZDƏN mesaj gedib.
        --
        -- Reaksiya və protokol mesajları sayılmır: 👍 basmaq cavab deyil,
        -- amma Message cədvəlində adi sətir kimi durur və onsuz bayrağı
        -- bağlayardı. Detektorların hamısı bu iki tipi onsuz da kənarda
        -- saxlayır (detectors.ts) — sübut da eyni dairədən olmalıdır.
        AND EXISTS (
          SELECT 1 FROM evolution_api."Message" m
           WHERE m."instanceId" = p.instance_id
             AND m.key->>'remoteJid' = p.remote_jid
             AND (m.key->>'fromMe')::boolean
             AND m."messageType" NOT IN ('protocolMessage', 'reactionMessage')
             AND m."messageTimestamp" > (p.evidence->>'lastInboundTs')::bigint
        )
        -- SON SÖZ BİZDƏ OLMALIDIR. Cavabımızdan sonra müştəri yenidən
        -- yazıbsa, o, artıq TƏZƏDƏN gözləyir — bağlamaq həmin anda açılmalı
        -- bayrağı silmək olardı. Bu şərt saatlıq bağlamada yoxdur (orada
        -- bayraq bağlanır və növbəti gedişat yenisini açır); burada var,
        -- çünki reaktiv yol məhz həmin mesajın gəldiyi anda işləyir və
        -- «bağla, sonra yenidən aç» səyriməsini menecer gözü ilə görərdi.
        AND NOT EXISTS (
          SELECT 1 FROM evolution_api."Message" m2
           WHERE m2."instanceId" = p.instance_id
             AND m2.key->>'remoteJid' = p.remote_jid
             AND NOT (m2.key->>'fromMe')::boolean
             AND m2."messageType" NOT IN ('protocolMessage', 'reactionMessage')
             AND m2."messageTimestamp" > (
                   SELECT MAX(m3."messageTimestamp") FROM evolution_api."Message" m3
                    WHERE m3."instanceId" = p.instance_id
                      AND m3.key->>'remoteJid' = p.remote_jid
                      AND (m3.key->>'fromMe')::boolean
                      AND m3."messageType" NOT IN ('protocolMessage', 'reactionMessage')
                 )
        )
      RETURNING p.id, p.detector`,
    [instanceId, remoteJid],
  );

  if (rows.length === 0) {
    const { rowCount } = await pool.query(
      `SELECT 1 FROM katibe.agent_posts
        WHERE instance_id = $1 AND remote_jid = $2
          AND acknowledged_at IS NULL AND kind = 'finding' LIMIT 1`,
      [instanceId, remoteJid],
    );
    return { hadOpenFlags: (rowCount ?? 0) > 0, closed: 0 };
  }

  if (hasSubscribers()) {
    publish({
      type: "flag_closed",
      instanceId,
      count: rows.length,
      at: new Date().toISOString(),
    });
  }
  return { hadOpenFlags: true, closed: rows.length };
}

/**
 * Vebhukun çağırdığı forma: gözlənilmir və heç vaxt atmır.
 *
 * Evolution vebhuku «göndər və unut»dur — yavaş cavab onun hadisə növbəsini
 * yığır (route.ts-dəki səs transkripti ilə eyni qayda). İş yenə də tamamlanır,
 * çünki `next start` uzunömürlü prosesdir; alınmasa saatlıq gedişat onsuz da
 * eyni bayrağı bağlayacaq — yəni ən pis hal köhnə davranışdır.
 */
export function scheduleReactiveClose(instanceId: string, remoteJid: string): void {
  void (async () => {
    try {
      // Evolution sətri yazıb vebhuku dərhal atır; sübutu bir neçə
      // millisaniyə tez axtarsaq, öz cavabımızı görməyə bilərik.
      await new Promise((r) => setTimeout(r, WRITE_GRACE_MS));
      let result = await closeFlagsAfterReply(instanceId, remoteJid);
      if (result.hadOpenFlags && result.closed === 0) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        result = await closeFlagsAfterReply(instanceId, remoteJid);
      }
      if (result.closed > 0) {
        console.log(
          `[reactive] ${instanceId} ${remoteJid}: cavab yazıldı — ${result.closed} bayraq dərhal bağlandı.`,
        );
      }
    } catch (err) {
      console.error("[reactive] bayraq bağlanması alınmadı:", err instanceof Error ? err.message : err);
    }
  })();
}
