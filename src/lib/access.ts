import { cookies } from "next/headers";
import { forbidden, redirect } from "next/navigation";
import { pool } from "./db";
import { SESSION_COOKIE, verifySessionToken } from "./auth";

/*
 * Giriş nəzarətinin yeganə qapısı.
 *
 * NİYƏ MARKALI TİP. Bu app-də 30-a yaxın sorğu funksiyası və 120-yə yaxın çağırış
 * yeri var. "Hər yerdə yoxlama yazmağı unutma" qaydası bir müddət işləyir, sonra
 * kimsə yeni səhifə əlavə edir və unudur — və sızma səssiz olur, çünki səhifə
 * mükəmməl işləyir, sadəcə başqasının məlumatını göstərir.
 *
 * Ona görə yoxlama TİP SİSTEMİNƏ bağlanıb. Sorğu funksiyaları `string` yox,
 * `ScopedInstanceId` qəbul edir; belə dəyəri yalnız aşağıdakı funksiyalar
 * istehsal edə bilir. `getOverview(params.instanceId)` yazan adam kompilyasiya
 * xətası alır. Unutmaq mümkün deyil, çünki unudulmuş yol tərtib olunmur.
 *
 * TƏHLÜKƏSİZLİK SƏRHƏDİ BURADADIR, proxy.ts-də YOX. Next-in öz sənədi də bunu
 * deyir (01-getting-started/16-proxy.md): proxy "optimistic check" üçündür,
 * "should not be used as a full session management or authorization solution".
 * proxy.ts yalnız istifadəçini /login-ə yönləndirir; icazəni hər səhifə, route
 * və server action özü burada yoxlayır.
 */

declare const scopedBrand: unique symbol;

/** İcazəsi yoxlanmış instans ID-si. Yalnız bu fayldakı funksiyalar yarada bilər. */
export type ScopedInstanceId = string & { readonly [scopedBrand]: "instance" };

/** İcazəsi yoxlanmış JID — çağıranın gördüyü instanslardan birində mövcuddur. */
export type ScopedJid = string & { readonly [scopedBrand]: "jid" };

/**
 * İcazəsi yoxlanmış mənbə ID-si — kanonik anbar (katibe.message) üçün.
 *
 * Anbar iki cür mənbə saxlayır: Evolution instansları və arxiv importları. Bu
 * marka instansdakı ilə eyni işi görür — sorğu funksiyaları `string` yox, bunu
 * qəbul edir, yəni yoxlamanı unutmaq kompilyasiya xətası verir.
 */
export type ScopedSourceId = string & { readonly [scopedBrand]: "source" };

export type Role = "admin" | "viewer" | "monitor";

export interface Session {
  userId: number;
  username: string;
  role: Role;
  mustChangePassword: boolean;
}

/**
 * Sessiyası olmayan proseslər — cron skriptləri və MCP serveri — üçün yeganə
 * qaçış yolu.
 *
 * Adı qəsdən uzun və axtarıla biləndir: CI onun yalnız scripts/, mcp/ və
 * src/lib/supervisor/ altında görünməsini yoxlayır. src/app/ altında bir dənə
 * görünsə, bu, icazə yoxlamasının atlandığı deməkdir və build dayanır.
 */
export function systemScope(instanceId: string): ScopedInstanceId {
  return instanceId as ScopedInstanceId;
}

/** systemScope-un JID qarşılığı, eyni qaydalarla. */
export function systemScopeJid(jid: string): ScopedJid {
  return jid as ScopedJid;
}

/**
 * İcazə rədd — render dayanır və 403 göstərilir (src/app/forbidden.tsx).
 *
 * next/navigation-dan gələn forbidden() ATIR, ona görə təhlükəsizlik həmin
 * atmadan gəlir: bayraq sönsə belə icra davam etmir. Bayraq (authInterrupts)
 * yalnız gözəl səhifənin render olunmasına cavabdehdir.
 */
function deny(): never {
  forbidden();
}

interface UserRow {
  id: number;
  username: string;
  role: Role;
  active: boolean;
  must_change_password: boolean;
  session_epoch: number;
}

/**
 * Cari sessiya, yoxsa null.
 *
 * İmza doğrulaması cookie-nin saxta olmadığını sübut edir, amma hesabın HƏLƏ DƏ
 * mövcud və aktiv olduğunu yox. Ona görə hər sorğuda bazadan yoxlanılır:
 * hesab söndürülübsə və ya session_epoch artırılıbsa (parol/rol dəyişikliyi),
 * açıq cookie dərhal qüvvədən düşür. Bu, bir indeksli sorğudur.
 */
export async function getSession(): Promise<Session | null> {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const payload = await verifySessionToken(secret, token);
  if (!payload) return null;

  const { rows } = await pool.query<UserRow>(
    `SELECT id, username, role, active, must_change_password, session_epoch
     FROM katibe.dashboard_users WHERE id = $1`,
    [payload.userId],
  );
  const user = rows[0];
  if (!user || !user.active) return null;
  if (user.session_epoch !== payload.epoch) return null;

  return {
    userId: user.id,
    username: user.username,
    role: user.role,
    mustChangePassword: user.must_change_password,
  };
}

/** Sessiya yoxdursa /login-ə yönləndirir. Səhifələr üçün. */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect("/login");
  /*
   * NƏZARƏTÇİNİN BU APP-DƏ İŞİ YOXDUR.
   *
   * Statistika, AI analizi, etiketləmə, admin paneli, kataloq — hamısı bu bir
   * sətirlə bağlanır, çünki hər səhifə və hər server action onsuz da buradan
   * keçir. Yeni səhifə yazan adam nəzarətçini ayrıca düşünmək məcburiyyətində
   * deyil: default bağlıdır, açıq olan yalnız /monitor altındakı yoldur.
   *
   * 403 yox, YÖNLƏNDİRMƏ: girişdən sonra brauzer "/"-a gedir və nəzarətçi üçün
   * doğru yer /monitor-dur. redirect() ATIR — bu, "davam etmə" deyil, icranın
   * tam dayanmasıdır, yəni məlumat sızmır.
   */
  if (session.role === "monitor") redirect("/monitor");
  return session;
}

/** Admin deyilsə 403. */
export async function requireAdmin(): Promise<Session> {
  const session = await requireSession();
  if (session.role !== "admin") deny();
  return session;
}

/**
 * Çağıranın görə bildiyi instansların TAM siyahısı — bir SQL, bir qayda.
 *
 * viewer : yalnız açıq icazə verilənlər
 * admin  : privat OLMAYAN hər şey + ona açıq icazə verilmiş privatlar
 *
 * Privat instans (katibe.instance_access.private) roldan asılı olmayaraq
 * gizlidir. Sahibin şəxsi nömrəsi belə qorunur: sabah yaradılan admin onu
 * görmür və bunun üçün heç kimin heç nə etməsi lazım deyil.
 */
export async function myInstances(): Promise<ScopedInstanceId[]> {
  const session = await requireSession();
  return instancesForUser(session.userId, session.role);
}

export async function instancesForUser(userId: number, role: Role): Promise<ScopedInstanceId[]> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT i.id
     FROM evolution_api."Instance" i
     LEFT JOIN katibe.instance_access ia ON ia.instance_id = i.id
     WHERE
       EXISTS (SELECT 1 FROM katibe.dashboard_user_instances g
               WHERE g.user_id = $1 AND g.instance_id = i.id)
       OR ($2 = 'admin' AND COALESCE(ia.private, false) = false)
     ORDER BY i.name`,
    [userId, role],
  );
  return rows.map((r) => r.id as ScopedInstanceId);
}

/**
 * Bayraq lentini nəzərdən keçirə bilənlər: admin və nəzarətçi.
 *
 * NİYƏ AYRICA FUNKSİYA. `monitor` rolu qəsdən bağlıdır — requireSession() onu
 * /monitor-a yönləndirir və bu, rolun təhlükəsiz paylanmasının səbəbidir. Rolu
 * geniş açmaq əvəzinə burada BİR qapı açılır: nəzarətçi bayraqları görə və
 * (səbəb yazmaqla) bağlaya bilər, qalan hər şey bağlı qalır.
 *
 * Yönləndirmə deyil, icazə qaytarır: çağıran səhifə nə edəcəyini özü bilir.
 */
export async function requireFlagReviewer(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "admin" && session.role !== "monitor") deny();
  return session;
}

/**
 * Çağıranın kanonik anbarda görə bildiyi mənbələr.
 *
 * İki qayda, ikisi də mövcud modelin davamıdır:
 *
 * Evolution mənbəyi instansdır, ona görə instans icazəsini olduğu kimi izləyir
 * — burada yeni qayda yoxdur, myInstances() nə deyirsə odur.
 *
 * Arxiv bir ŞƏXSƏ aiddir, instansa yox: o, telefonun öz ehtiyat nüsxəsidir və
 * katibe.source.owner_user_id onun sahibini göstərir, eynilə
 * user_instances.user_id-nin instansın sahibini göstərdiyi kimi. Hesab həmin
 * şəxsə bağlıdırsa (dashboard_users.katibe_user_id) görür, deyilsə görmür.
 * "Arxiv yalnız sahibinə görünür" qaydası beləliklə ayrıca mexanizm deyil,
 * sütunun özündən çıxır.
 */
export async function mySources(): Promise<ScopedSourceId[]> {
  const session = await requireSession();
  const instances = await myInstances();
  const { rows } = await pool.query<{ id: string }>(
    `SELECT s.id FROM katibe.source s
      WHERE (s.kind = 'evolution' AND s.id = ANY($2::text[]))
         OR (s.kind = 'archive'
             AND s.owner_user_id IS NOT NULL
             AND s.owner_user_id = (SELECT du.katibe_user_id
                                      FROM katibe.dashboard_users du
                                     WHERE du.id = $1))
      ORDER BY s.id`,
    [session.userId, instances],
  );
  return rows.map((r) => r.id as ScopedSourceId);
}

/**
 * The sources a monitor may read in the canonical store.
 *
 * Evolution source ids ARE instance ids — that is how the merge was built —
 * so a monitor's instance scope converts directly. The conversion lives here
 * rather than at the call site because minting a ScopedSourceId is exactly the
 * kind of thing that should be hard to do by accident: this file is the only
 * one allowed to, and the input is already a checked ScopedInstanceId.
 *
 * The archive source is deliberately NOT included. A monitor watches live
 * conversations for the instances they were granted; nine years of somebody
 * else's history is a different question, with a different answer.
 *
 * Takes the whole MonitorScope rather than a list of ids, because the scope is
 * the proof that requireMonitorScope() ran. A bare string[] would let any
 * caller name any instance and get branded ids back.
 */
export async function monitorSources(scope: MonitorScope): Promise<ScopedSourceId[]> {
  const instances = scope.instances;
  if (instances.length === 0) return [];
  const { rows } = await pool.query<{ id: string }>(
    `SELECT s.id FROM katibe.source s
      WHERE s.kind = 'evolution' AND s.id = ANY($1::text[]) ORDER BY s.id`,
    [instances],
  );
  return rows.map((r) => r.id as ScopedSourceId);
}

/**
 * Bir instansa giriş icazəsini yoxlayır və markalı ID qaytarır.
 *
 * Səhifələr və route-lar üçün əsas qapı. İcazə yoxdursa 403 — "tapılmadı" YOX:
 * istifadəçi öz nömrəsinin ID-sini səhv yazanda "yoxdur" cavabı çaşdırıcıdır.
 * Mövcudluğun özü sirr deyil (instans ID-ləri təxmin edilə bilməyən UUID-dir),
 * sirr olan içindəki məlumatdır.
 */
export async function requireInstance(instanceId: string): Promise<ScopedInstanceId> {
  const allowed = await myInstances();
  if (!allowed.includes(instanceId as ScopedInstanceId)) deny();
  return instanceId as ScopedInstanceId;
}

/**
 * Bir JID-ə toxunma icazəsi: həmin söhbət çağıranın gördüyü instanslardan
 * birində mövcud olmalıdır.
 *
 * Bu, qlobal (JID-ə bağlı, instans sütunu olmayan) cədvəllərə yazmaq üçün
 * lazımdır — katibe.contact_labels və qonşuları. Onlar qəsdən paylaşılandır:
 * bir kontaktın adı hər yerdə eynidir. Amma yazmaq başqa məsələdir — heç vaxt
 * görmədiyi bir söhbətin adını dəyişmək icazəsi heç kimə lazım deyil.
 */
export async function requireJid(jid: string): Promise<ScopedJid> {
  const allowed = await myInstances();
  if (allowed.length === 0) deny();

  const { rows } = await pool.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM evolution_api."Message" m
       WHERE m."instanceId" = ANY($1::text[]) AND m.key->>'remoteJid' = $2
       LIMIT 1
     ) AS ok`,
    [allowed, jid],
  );
  if (!rows[0].ok) deny();
  return jid as ScopedJid;
}

/**
 * Mesaj ID-sindən instansı tapıb icazəni yoxlayır.
 *
 * /api/media üçün: əvvəl instansId sorğu parametri idi, yəni çağıranın verdiyi
 * dəyər idi — icazə deyil, sadəcə axtarış açarı. İndi instans mesajın ÖZÜNDƏN
 * gəlir və yoxlanılır.
 */
export async function requireMessage(
  messageId: string,
): Promise<{ instanceId: ScopedInstanceId } | null> {
  const { rows } = await pool.query<{ instance_id: string }>(
    `SELECT "instanceId" AS instance_id FROM evolution_api."Message" WHERE id = $1`,
    [messageId],
  );
  if (rows.length === 0) return null;
  return { instanceId: await requireInstance(rows[0].instance_id) };
}

/* ────────────────────────────────────────────────────────────────────────────
 * NƏZARƏTÇİ (internal control) — yalnız-oxu görünüş və söhbət səviyyəsində süzgəc
 *
 * Yuxarıdakı `ScopedInstanceId` "bu nömrəyə baxa bilərsənmi" sualına cavab
 * verir. Nəzarətçi üçün bu KİFAYƏT DEYİL: o, nömrəni görür, amma həmin nömrənin
 * söhbətlərinin yalnız bir hissəsini görməlidir. İki fərqli sual, ona görə iki
 * fərqli marka.
 *
 * Markaların ayrı olması qəsdəndir: `MonitorScope`-dan `ScopedInstanceId`
 * çıxmır, yəni nəzarətçi kodu səhvən adi (süzgəcsiz) sorğu funksiyalarını
 * çağıra bilmir — `getRecentMessages(scope, jid)` kompilyasiya xətasıdır.
 * Süzgəci "unutmaq" mümkün deyil, çünki unudulmuş yol tərtib olunmur.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface MonitorProfile {
  /** Neçə günlük yazışma görünür. Bundan köhnəsi ümumiyyətlə qaytarılmır. */
  historyDays: number;
  /** Telefon nömrələri maskalansın (ad qalır, rəqəmlər gedir). */
  maskPhones: boolean;
  groupDefault: "hidden" | "visible";
  directDefault: "hidden" | "visible";
}

/**
 * Profil sətri olmayan nəzarətçi üçün qüvvədə olan dəyərlər.
 *
 * Hamısı ƏN DAR variantdır: hesab yaradıb qaydaları yazmağı unutmaq ən geniş
 * yox, ən məhdud görünüş verir.
 */
export const DEFAULT_MONITOR_PROFILE: MonitorProfile = {
  historyDays: 90,
  maskPhones: true,
  groupDefault: "hidden",
  directDefault: "visible",
};

declare const monitorBrand: unique symbol;

/** Yoxlanmış nəzarətçi konteksti — yalnız `requireMonitorScope()` yaradır. */
export type MonitorScope = {
  readonly [monitorBrand]: "monitor-scope";
  /** Qaydaların sahibi olan nəzarətçi hesabı. */
  readonly monitorUserId: number;
  readonly monitorUsername: string;
  /**
   * Ekranın qarşısında ƏSLİNDƏ oturan adam. Adətən nəzarətçinin özüdür; admin
   * "nəzarətçi nə görür" önizləməsi açanda isə admin-dir. Jurnal bunu yazır ki,
   * önizləmə ilə real baxış qarışmasın.
   */
  readonly actorUserId: number;
  readonly preview: boolean;
  readonly profile: MonitorProfile;
  /** Görünən nömrələr (instans ID-ləri) — açıq təyinatlardan gəlir. */
  readonly instances: readonly string[];
  /** Tarixçə pəncərəsinin başlanğıcı, epoch saniyə. */
  readonly windowStart: number;
};

/** Görünməsi yoxlanmış söhbət — nəzarətçi sorğularının yeganə açarı. */
export type VisibleChat = {
  readonly [monitorBrand]: "visible-chat";
  readonly scope: MonitorScope;
  readonly instanceId: string;
  readonly jid: string;
};

interface MonitorProfileRow {
  history_days: number;
  mask_phones: boolean;
  group_default: "hidden" | "visible";
  direct_default: "hidden" | "visible";
}

async function loadMonitorProfile(userId: number): Promise<MonitorProfile> {
  const { rows } = await pool.query<MonitorProfileRow>(
    `SELECT history_days, mask_phones, group_default, direct_default
     FROM katibe.monitor_profile WHERE user_id = $1`,
    [userId],
  );
  const r = rows[0];
  if (!r) return DEFAULT_MONITOR_PROFILE;
  return {
    historyDays: Number(r.history_days),
    maskPhones: r.mask_phones,
    groupDefault: r.group_default,
    directDefault: r.direct_default,
  };
}

/**
 * Nəzarətçi konteksti — /monitor altındakı hər səhifənin və route-un ilk sətri.
 *
 * İki cür çağıran var:
 *   - nəzarətçinin özü: qaydalar öz hesabınındır;
 *   - admin `?as=<userId>` ilə: "bu adam nə görür" önizləməsi. Bu, qaydaları
 *     qurmağın yeganə dürüst yoxlanışıdır — admin gizlətdiyini gizlədə
 *     bildiyinə əmin olmalıdır. Önizləmə də eyni süzgəcdən keçir, yəni admin
 *     burada özünün geniş icazəsini yox, NƏZARƏTÇİNİN görünüşünü alır.
 *
 * viewer rolu bura düşə bilmir: onun /monitor-da işi yoxdur.
 */
export async function requireMonitorScope(previewUserId?: number): Promise<MonitorScope> {
  const session = await getSession();
  if (!session) redirect("/login");

  let monitorUserId: number;
  let monitorUsername: string;
  let preview = false;

  if (session.role === "monitor") {
    // Nəzarətçi başqasının adından baxa bilməz — parametr sadəcə nəzərə alınmır.
    monitorUserId = session.userId;
    monitorUsername = session.username;
  } else if (session.role === "admin" && previewUserId) {
    const { rows } = await pool.query<{ username: string }>(
      `SELECT username FROM katibe.dashboard_users
       WHERE id = $1 AND role = 'monitor' AND active`,
      [previewUserId],
    );
    if (rows.length === 0) deny();
    monitorUserId = previewUserId;
    monitorUsername = rows[0].username;
    preview = true;
  } else {
    deny();
  }

  const profile = await loadMonitorProfile(monitorUserId);
  const { rows: grants } = await pool.query<{ instance_id: string }>(
    `SELECT g.instance_id
     FROM katibe.dashboard_user_instances g
     JOIN evolution_api."Instance" i ON i.id = g.instance_id
     WHERE g.user_id = $1
     ORDER BY i.name`,
    [monitorUserId],
  );

  return {
    monitorUserId,
    monitorUsername,
    actorUserId: session.userId,
    preview,
    profile,
    instances: grants.map((g) => g.instance_id),
    windowStart: Math.floor(Date.now() / 1000) - profile.historyDays * 86_400,
    // Marka fantom sahədir — onu yalnız bu fayl "taxa" bilər, elə məqsəd də
    // budur. İkiqat çevirmə həmin taxmanın yeganə yeridir.
  } as unknown as MonitorScope;
}

/**
 * Görünmə şərti, bir SQL ifadəsi — nəzarətçiyə məlumat qaytaran HƏR sorğu
 * bunu işlətməlidir.
 *
 * Sıra: söhbətin öz qaydası → kateqoriya qaydası → tipə görə default. İlk
 * uyğun gələn qalib gəlir, yəni "Supplier hamısı bağlı, amma bu bir qrup
 * açıq" ifadə oluna bilir.
 *
 * Profil dəyərləri sətir kimi YAPIŞDIRILMIR: onlar TS tərəfində boolean-a
 * çevrilir, ona görə bu ifadəyə istifadəçi mətni düşmür.
 *
 * `monitorVisibilityJoins()` ilə birlikdə işlənir — join-lər olmadan bu ifadə
 * kompilyasiya olunmaz (mcr/mkr aliasları tapılmaz), yəni yarımçıq işlətmək
 * səssiz sızma yox, açıq SQL xətası verir.
 */
export function monitorVisibleSql(jidExpr: string, profile: MonitorProfile): string {
  const groupDefault = profile.groupDefault === "visible" ? "true" : "false";
  const directDefault = profile.directDefault === "visible" ? "true" : "false";
  return `CASE
    WHEN ${jidExpr} LIKE '%@broadcast' THEN false
    WHEN mcr.visibility IS NOT NULL THEN mcr.visibility = 'allow'
    WHEN mkr.visibility IS NOT NULL THEN mkr.visibility = 'allow'
    WHEN ${jidExpr} LIKE '%@g.us' THEN ${groupDefault}
    ELSE ${directDefault}
  END`;
}

/**
 * `monitorVisibleSql()`-in tələb etdiyi join-lər.
 *
 * `cl` (katibe.contact_labels) çağıran sorğuda ONSUZ DA olmalıdır — kateqoriya
 * oradan gəlir və adı da eyni cədvəl verir.
 */
export function monitorVisibilityJoins(jidExpr: string, userParam: string): string {
  return `LEFT JOIN katibe.monitor_chat_rule mcr
            ON mcr.user_id = ${userParam} AND mcr.remote_jid = ${jidExpr}
          LEFT JOIN katibe.monitor_category_rule mkr
            ON mkr.user_id = ${userParam} AND mkr.category_id = cl.category_id`;
}

/**
 * Bir söhbətə baxmaq icazəsi: nömrə təyin olunubmu, qaydalar açırmı, və
 * pəncərədə heç olmasa bir mesaj varmı.
 *
 * Sonuncu şərt görünür ki, artıqdır — deyil: 90 gündən köhnə söhbət siyahıda
 * onsuz da yoxdur, ona görə URL-i əl ilə yazmaqla ona çatmaq da olmamalıdır.
 *
 * Rədd cavabı 403-dür, "tapılmadı" yox. Söhbətin mövcudluğu sirr deyil (JID
 * onsuz da nəzarətçinin gördüyü siyahıda ola bilər), sirr olan içindəkidir.
 */
export async function requireVisibleChat(
  scope: MonitorScope,
  instanceId: string,
  jid: string,
): Promise<VisibleChat> {
  if (!scope.instances.includes(instanceId)) deny();

  const { rows } = await pool.query<{ visible: boolean; in_window: boolean }>(
    `SELECT
       ${monitorVisibleSql("j.jid", scope.profile)} AS visible,
       EXISTS (
         SELECT 1 FROM evolution_api."Message" m
         WHERE m."instanceId" = $2 AND m.key->>'remoteJid' = $3
           AND m."messageTimestamp" >= $4
       ) AS in_window
     FROM (SELECT $3::text AS jid) j
     LEFT JOIN katibe.contact_labels cl ON cl.remote_jid = j.jid
     ${monitorVisibilityJoins("j.jid", "$1")}`,
    [scope.monitorUserId, instanceId, jid, scope.windowStart],
  );

  const row = rows[0];
  if (!row || !row.visible || !row.in_window) deny();
  return { scope, instanceId, jid } as unknown as VisibleChat;
}

/**
 * Media faylı üçün icazə: mesaj hansı söhbətə aiddirsə, o söhbət görünməlidir.
 *
 * `requireMessage()`-in nəzarətçi qarşılığı. Ayrıdır, çünki o, instans
 * icazəsini yoxlayır — nəzarətçi üçün instans icazəsi kifayət deyil: gizli
 * qrupun şəkli də həmin instansdadır.
 */
export async function requireMonitorMessage(
  scope: MonitorScope,
  messageId: string,
): Promise<VisibleChat | null> {
  const { rows } = await pool.query<{ instance_id: string; jid: string }>(
    `SELECT "instanceId" AS instance_id, key->>'remoteJid' AS jid
     FROM evolution_api."Message" WHERE id = $1`,
    [messageId],
  );
  if (rows.length === 0) return null;
  return requireVisibleChat(scope, rows[0].instance_id, rows[0].jid);
}

/**
 * "Kim, nəyə, nə vaxt baxdı" — nəzarətçini nəzarətdə saxlayan sətir.
 *
 * Söhbət başına 5 dəqiqədə bir yazılır: açıq qalan səhifə hər canlı yeniləmədə
 * jurnalı şişirtməməlidir, amma "bu söhbətə heç vaxt baxmayıb" iddiası da
 * yalan olmamalıdır.
 *
 * Yazma uğursuz olsa baxış DAYANMIR — audit oxumağın şərti deyil, izidir.
 */
export async function logMonitorView(
  scope: MonitorScope,
  instanceId: string,
  jid: string | null,
  action: "chat" | "list" | "media",
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO katibe.monitor_view_log (user_id, instance_id, remote_jid, action)
       SELECT $1, $2, $3, $4
       WHERE NOT EXISTS (
         SELECT 1 FROM katibe.monitor_view_log
         WHERE user_id = $1 AND instance_id = $2 AND remote_jid IS NOT DISTINCT FROM $3
           AND action = $4 AND at > now() - interval '5 minutes'
       )`,
      [scope.actorUserId, instanceId, jid, scope.preview ? `${action}:preview` : action],
    );
  } catch (err) {
    console.error("[monitor] audit yazıla bilmədi:", err);
  }
}

/**
 * Verilən JID-lərdən nəzarətçiyə görünənlər.
 *
 * Canlı axın üçün: hadisə saniyədə bir neçə dəfə gələ bilər, hər biri üçün
 * ayrıca sorğu atmaq mənasızdır. `requireVisibleChat()`-dən fərqi budur ki,
 * bu funksiya RƏDD ETMİR — sadəcə süzür; axın bir söhbəti "görmədi" deyə
 * bağlanmamalıdır.
 */
export async function visibleJids(scope: MonitorScope, jids: string[]): Promise<Set<string>> {
  if (jids.length === 0) return new Set();
  const { rows } = await pool.query<{ jid: string; visible: boolean }>(
    `SELECT j.jid, ${monitorVisibleSql("j.jid", scope.profile)} AS visible
     FROM unnest($2::text[]) AS j(jid)
     LEFT JOIN katibe.contact_labels cl ON cl.remote_jid = j.jid
     ${monitorVisibilityJoins("j.jid", "$1")}`,
    [scope.monitorUserId, jids],
  );
  return new Set(rows.filter((r) => r.visible).map((r) => r.jid));
}
