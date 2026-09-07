"use server";

import { revalidatePath } from "next/cache";
import { pool } from "@/lib/db";
import {
  requireAdmin,
  requireFlagReviewer,
  requireInstance,
  requireMonitorScope,
  requireSession,
  requireVisibleChat,
} from "@/lib/access";
import { insertPostComment } from "@/lib/supervisor/comments";
import { decodeChatId } from "@/lib/monitor-token";
import {
  SNOOZE_DAY_OPTIONS,
  mutePostForever,
  ratePost,
  revokeSuppression,
  snoozePost,
  type SnoozeDays,
} from "@/lib/supervisor/ratings";
import { getChatDetail, getRecentMessages, type ChatMessage } from "@/lib/queries";

export interface ChatPreview {
  contactName: string;
  phoneNumber: string | null;
  identityHint: string | null;
  messages: ChatMessage[];
  hasMore: boolean;
}

/** Sürətli baxış pəncərəsinin son N mesajı. Yalnız oxu, heç nəyi dəyişmir. */
const QUICK_VIEW_MESSAGES = 20;

/**
 * Lentdən sol-klik atmadan söhbətə baxmaq üçün: "Söhbətə bax" tam səhifəyə
 * aparırdı, indi ChatQuickView bunu modal içində açır. Serializasiya oluna
 * bilən adi data qaytarır — client komponent onu state-ə qoyub göstərir.
 */
export async function getChatPreview(instanceId: string, jid: string): Promise<ChatPreview | null> {
  const scoped = await requireInstance(instanceId);
  const [detail, transcript] = await Promise.all([
    getChatDetail(scoped, jid),
    getRecentMessages(scoped, jid, QUICK_VIEW_MESSAGES),
  ]);
  if (!detail) return null;
  return {
    contactName: detail.displayName ?? detail.contactName,
    phoneNumber: detail.phoneNumber,
    identityHint: detail.identityHint,
    messages: transcript.messages,
    hasMore: transcript.hasMore,
  };
}

/**
 * "Həll edildi" — bayraq bağlanır, SƏBƏBİ İLƏ.
 *
 * Post silinmir: acknowledged_at dolur, lentdə adi sıraya keçir. Eyni problem
 * davam edərsə detektor onu təzə post kimi yenidən açır, yəni "bağladım"
 * susdurmaq deyil — "gördüm, məşğulam" deməkdir.
 *
 * QEYD MƏCBURİDİR. Bağlamaq bayrağı menecerin diqqətindən çıxaran yeganə
 * hərəkətdir; səbəbsiz bağlama səhvdən, fikir ayrılığından və sadəcə ekranı
 * təmizləməkdən fərqlənmir. Qeyd sonradan bu üçünü ayırd etməyə imkan verir —
 * və detektoru yaxşılaşdırmaq üçün yeganə xammaldır: "bu şikayət deyildi,
 * çatdırılma haqqında soruşurdu" etiketlənmiş mənfi nümunədir.
 *
 * KİM. Admin və nəzarətçi. Nəzarətçi rolu hər yerdə bağlıdır (access.ts), bura
 * isə requireFlagReviewer() ilə bir qapı açılıb — çünki bayraqları gün boyu
 * oxuyan odur və hansının lazımsız olduğunu ondan yaxşı bilən yoxdur.
 *
 * Nəzarətçi instans icazəsi ilə yoxlanmır: onun görə bildiyi söhbətlər
 * monitor_profile ilə müəyyən olunur və lentə də yalnız o dairə düşür.
 */
export async function acknowledgeAgentPost(formData: FormData) {
  const id = Number(formData.get("postId"));
  const note = String(formData.get("note") ?? "").trim();
  if (!Number.isInteger(id) || id <= 0) return;
  // Boş və ya bir sözlük qeyd qeyd deyil. Səssizcə buraxmaq əvəzinə heç nə
  // etmirik — forma qeydi məcburi sahə kimi göstərir, bu isə son sədd.
  if (note.length < 10) return;

  const session = await requireFlagReviewer();

  // Post ID-si ardıcıl tam ədəddir, yəni sadalana bilir. Ona görə əvvəlcə
  // postun HANSI nömrəyə aid olduğu tapılır, sonra icazə yoxlanılır — yoxsa
  // 1..N gəzməklə bütün nömrələrin bayraqları susdurulurdu.
  const { rows } = await pool.query<{
    instance_id: string; severity: number; detector: string; title: string;
  }>(
    `SELECT instance_id, severity, detector, title
       FROM katibe.agent_posts WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) return;
  const post = rows[0];
  if (session.role === "admin") await requireInstance(post.instance_id);

  const { rowCount } = await pool.query(
    `UPDATE katibe.agent_posts
        SET acknowledged_at = now(), acknowledged_by = $2,
            closed_reason = 'MANUAL', closed_note = $3
      WHERE id = $1 AND acknowledged_at IS NULL`,
    [id, session.username, note.slice(0, 2000)],
  );
  // Yalnız həqiqətən bağlanan post loga düşür: artıq bağlı olana ikinci dəfə
  // basmaq jurnalda ikinci sətir yaratmamalıdır.
  if (rowCount === 0) return;

  await pool.query(
    `INSERT INTO katibe.flag_close_log
       (post_id, closed_by, note, severity, detector, title)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, session.userId, note.slice(0, 2000), post.severity, post.detector, post.title],
  );
  revalidatePath("/");
  revalidatePath("/agent");
  revalidatePath("/monitor");
}

/**
 * "Bu, əslində bayraq olmalıydı" — agentin buraxdığı hal.
 *
 * Əks istiqamət, və ölçmə üçün ondan az vacib deyil: detektorun nəyi
 * buraxdığını yalnız söhbətləri gün boyu oxuyan adam görür. Posta bağlı deyil,
 * çünki post yoxdur — bütün məsələ elə budur.
 */
/**
 * "This should have been flagged" — from the shared chat screen.
 *
 * Same record and the same checks as reportMissedFlag(); only the way the
 * conversation is named differs. The old form carries an opaque token because
 * it sits on a screen built around instance + JID; this one carries a
 * canonical chat id, which is a row number and reveals nothing — no phone
 * number reaches the browser either way.
 *
 * The id is still not permission. It is resolved to an instance and a JID
 * here, and requireVisibleChat() decides, exactly as before: a hand-typed id
 * for a conversation this reviewer may not see is refused rather than filed.
 */
export async function reportMissedFlagForChat(formData: FormData) {
  const chatId = Number(formData.get("chatId") ?? "");
  const note = String(formData.get("note") ?? "").trim();
  const kindRaw = String(formData.get("kind") ?? "other");
  const kind = ["leaving", "broken_promise", "anger", "price_dispute", "other"].includes(kindRaw)
    ? kindRaw
    : "other";
  if (!Number.isInteger(chatId) || note.length < 10) return;

  const session = await requireFlagReviewer();
  const scope = await requireMonitorScope();

  // The conversation's Evolution identity: a canonical chat can carry several
  // JIDs (a number that later became a LID), so this takes the one that
  // belongs to an instance in scope rather than whichever is first.
  const { rows } = await pool.query<{ instance_id: string; remote_jid: string }>(
    `SELECT ms.source_id AS instance_id, m.remote_jid
       FROM katibe.message m
       JOIN katibe.message_source ms ON ms.message_id = m.id
       JOIN katibe.source s ON s.id = ms.source_id AND s.kind = 'evolution'
      WHERE m.chat_id = $1 AND ms.source_id = ANY($2::text[])
      ORDER BY m.ts DESC
      LIMIT 1`,
    [chatId, scope.instances],
  );
  if (rows.length === 0) return;
  const { instance_id: instanceId, remote_jid: jid } = rows[0];
  await requireVisibleChat(scope, instanceId, jid);

  await pool.query(
    `INSERT INTO katibe.missed_flag (instance_id, remote_jid, reported_by, note, kind)
     VALUES ($1, $2, $3, $4, $5)`,
    [instanceId, jid, session.userId, note.slice(0, 2000), kind],
  );
  revalidatePath("/monitor");
}

export async function reportMissedFlag(formData: FormData) {
  const instanceId = String(formData.get("instanceId") ?? "");
  // Söhbətin açarı TOKENDİR, xam JID deyil. /monitor müştəriyə heç vaxt JID
  // göndərmir, çünki JID-in özü telefon nömrəsidir və maskalanmış ekranın
  // altında açıq nömrə qaytarmaq maskalamanı teatra çevirər
  // (src/lib/monitor-token.ts, və npm run verify:access məhz bunu tutmuşdu).
  const chatToken = String(formData.get("chatId") ?? "");
  const note = String(formData.get("note") ?? "").trim();
  const kindRaw = String(formData.get("kind") ?? "other");
  const kind = ["leaving", "broken_promise", "anger", "price_dispute", "other"].includes(kindRaw)
    ? kindRaw
    : "other";
  if (!instanceId || !chatToken || note.length < 10) return;

  const session = await requireFlagReviewer();
  // Token icazə DEYİL — yalnız "hansı söhbət" sualına cavabdır. İcazə həmişə
  // requireVisibleChat()-dən keçir, eynilə /monitor-un qalan hissəsindəki kimi.
  const scope = await requireMonitorScope();
  const jid = decodeChatId(instanceId, chatToken);
  if (!jid) return;
  await requireVisibleChat(scope, instanceId, jid);

  await pool.query(
    `INSERT INTO katibe.missed_flag (instance_id, remote_jid, reported_by, note, kind)
     VALUES ($1, $2, $3, $4, $5)`,
    [instanceId, jid, session.userId, note.slice(0, 2000), kind],
  );
  revalidatePath("/monitor");
}

/**
 * Şərh — "gördüm, səbəbi budur", BAĞLAMADAN. acknowledged_at/severity-yə
 * toxunmur, ona görə "Həll edildi"dən fərqli olaraq istənilən instans
 * icazəsi olan (o cümlədən viewer/Sales) yaza bilər — özününkü olmayan
 * nömrəyə yox, çünki requireInstance eynilə burada da yoxlanılır.
 */
export async function commentAgentPost(formData: FormData) {
  const id = Number(formData.get("postId"));
  const text = String(formData.get("comment") ?? "").trim();
  if (!Number.isInteger(id) || id <= 0 || text.length === 0) return;
  // Şablon xəbərdarlıqların altında itməsin deyə uzunluq kəsilir, silinmir.
  const comment = text.slice(0, 2000);

  const session = await requireSession();
  const { rows } = await pool.query<{ instance_id: string }>(
    `SELECT instance_id FROM katibe.agent_posts WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) return;
  await requireInstance(rows[0].instance_id);

  await insertPostComment(id, session.userId, comment);
  revalidatePath("/");
  revalidatePath("/agent");
}

/**
 * Bayrağa 1-5 qiymət. YALNIZ ADMIN.
 *
 * Nə edir və nə ETMİR:
 *   1 = "bu ümumiyyətlə bayraq olmamalıydı" → post bağlanır (closed_reason
 *       'RATED_NOISE') VƏ həmin söhbət+detektor üçün susdurma açılır. Növbəti
 *       gedişatlarda eyni vəziyyət lentə çıxmır, amma hər dəfə
 *       katibe.agent_suppression_log-a yazılır (/admin/suppressions).
 *   2-5 = yalnız qiymətdir. Bayrağa TOXUNMUR — bağlanmır, sancağı düşmür,
 *       problem davam edirsə növbəti gedişatda yenə görünür. "Həll edildi"
 *       ayrı düymədir və elə də qalır.
 *
 * Niyə admin: susdurma bayrağı gözdən gizlədə bilən yeganə mexanizmdir
 * (şərh və "Həll edildi"dən fərqli olaraq, susdurulmuş bayraq heç yerdə
 * görünmür). Ona görə acknowledgeAgentPost ilə eyni səviyyədə saxlanılır.
 */
export async function rateAgentPost(formData: FormData) {
  const id = Number(formData.get("postId"));
  const rating = Number(formData.get("rating"));
  const note = String(formData.get("note") ?? "").trim();
  if (!Number.isInteger(id) || id <= 0) return;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return;

  // acknowledgeAgentPost-dakı eyni sıra: əvvəl postun hansı nömrəyə aid
  // olduğu tapılır, sonra icazə yoxlanılır — post ID-si sadalana biləndir.
  const session = await requireAdmin();
  const { rows } = await pool.query<{ instance_id: string }>(
    `SELECT instance_id FROM katibe.agent_posts WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) return;
  await requireInstance(rows[0].instance_id);

  await ratePost(id, rating, note ? note.slice(0, 1000) : null, session.userId);
  revalidatePath("/");
  revalidatePath("/agent");
  revalidatePath("/admin/suppressions");
}

/**
 * «Bir daha göstərmə» — postu bağlayır və həmin söhbətdə həmin növ bayrağı
 * DAİMİ susdurur. YALNIZ ADMIN, "Həll edildi" və reytinq ilə eyni səviyyədə.
 *
 * Niyə ayrıca düymə lazım oldu: reytinq 1-in açdığı 30 günlük susdurmanın
 * üstündən model «vəziyyət dəyişib» deyib keçə bilir. Telefonda bağlanan
 * işlərdə bu, hər gedişatda baş verirdi — söhbətin özündə heç nə dəyişmir,
 * son mesaj həmişəlik «cavab bizdən gözlənilir» kimi oxunur. Menecer eyni
 * bayrağa üç dəfə 1 verdi, üç dəfə də geri qayıtdı (bax
 * sql/2026-08-27_permanent_suppression.sql).
 *
 * Təsdiq pəncərəsi UI tərəfdədir (MuteFlagButton) və qəsdən məcburidir: bu,
 * geri qaytarılması yalnız /admin/suppressions-dən mümkün olan yeganə
 * düymədir.
 */
export async function muteAgentPostForever(formData: FormData) {
  const id = Number(formData.get("postId"));
  const note = String(formData.get("note") ?? "").trim();
  if (!Number.isInteger(id) || id <= 0) return;

  // acknowledgeAgentPost-dakı eyni sıra: post ID-si sadalana biləndir, ona görə
  // əvvəl postun hansı nömrəyə aid olduğu tapılır, sonra icazə yoxlanılır.
  const session = await requireAdmin();
  const { rows } = await pool.query<{ instance_id: string }>(
    `SELECT instance_id FROM katibe.agent_posts WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) return;
  await requireInstance(rows[0].instance_id);

  await mutePostForever(id, note ? note.slice(0, 1000) : null, session.userId);
  revalidatePath("/");
  revalidatePath("/agent");
  revalidatePath("/admin/suppressions");
}

/**
 * MÖHLƏT — «bu bayrağı N gün göstərmə, sonra nəticəni de».
 *
 * Bağlamaq (acknowledgeAgentPost) və susdurmaq (muteAgentPostForever)
 * arasındakı boşluq: birincisi bir saatdan sonra bayrağı geri gətirir,
 * ikincisi isə heç vaxt gətirmir. Menecerin real cavabı çox vaxt üçüncüdür —
 * «çatdırılmanı gözləyirik, cümə axşamı yenidən bax».
 *
 * QEYD MƏCBURİ DEYİL. acknowledgeAgentPost-dan fərqli olaraq burada bayraq
 * itmir: müddət bitəndə problem qalıbsa özü qayıdır və nə vaxt, kim tərəfindən
 * möhlət verildiyi susdurma sətrində qalır. Ona görə qeyd faydalıdır, sədd yox.
 *
 * YALNIZ ADMİN — ekrandan bayraq gizlədən hər düymə kimi (mute ilə eyni qapı).
 * Nəzarətçi bayrağı bağlaya bilir, çünki bağlanan bayraq geri qayıdır; möhlət
 * isə ekranı günlərlə boş saxlayır və o qərar menecerindir.
 */
export async function snoozeAgentPost(formData: FormData) {
  const id = Number(formData.get("postId"));
  const days = Number(formData.get("days"));
  const note = String(formData.get("note") ?? "").trim();
  if (!Number.isInteger(id) || id <= 0) return;
  // Müddət seçimdir, sərbəst rəqəm deyil. Formada da belədir, amma hazırlanmış
  // sorğu düymələrdən keçmir — «300 gün möhlət» əslində gizli daimi susdurma
  // olardı və audit səhifəsində elə də görünməzdi.
  if (!SNOOZE_DAY_OPTIONS.includes(days as SnoozeDays)) return;

  // muteAgentPostForever-dəki eyni sıra: post ID-si sadalana biləndir, ona görə
  // əvvəl postun hansı nömrəyə aid olduğu tapılır, sonra icazə yoxlanılır.
  const session = await requireAdmin();
  const { rows } = await pool.query<{ instance_id: string }>(
    `SELECT instance_id FROM katibe.agent_posts WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) return;
  await requireInstance(rows[0].instance_id);

  await snoozePost(id, days, note ? note.slice(0, 1000) : null, session.userId);
  revalidatePath("/");
  revalidatePath("/agent");
  revalidatePath("/monitor");
  revalidatePath("/admin/suppressions");
}

/** Susdurmanı ləğv edir — "bu söhbəti yenidən izlə". Admin. */
export async function revokeAgentSuppression(formData: FormData) {
  const id = Number(formData.get("suppressionId"));
  if (!Number.isInteger(id) || id <= 0) return;

  const session = await requireAdmin();
  const { rows } = await pool.query<{ instance_id: string }>(
    `SELECT instance_id FROM katibe.agent_suppressions WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) return;
  await requireInstance(rows[0].instance_id);

  await revokeSuppression(id, session.userId);
  revalidatePath("/agent");
  revalidatePath("/admin/suppressions");
}
