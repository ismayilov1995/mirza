import OpenAI from "openai";
import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import { pool } from "../db";
import { contactDisplaySql, groupSubjectJoin } from "../queries";
import { scoreIntent, type IntentKind } from "./severity";
import { searchSimilar } from "../embedding";
import type { ScopedInstanceId } from "../access";
import type { Detector, DetectorContext, Finding } from "./types";

/*
 * Tapıntılar ki, saat onları görmür.
 *
 * Mövcud üç detektor vaxt ölçür — kim gözləyir, kim susub. Onlar tez cavab
 * verilmiş, amma pis gedən bir söhbəti heç vaxt görmür: müştəri əsəbidir,
 * verilən söz pozulub, qiymətdən narazıdır, ya da açıq deyir ki başqa yerdən
 * alacaq. Bunların hamısı SÖZDƏDİR, saatda deyil.
 *
 * NİYƏ AXTARIŞ YOX, OXUMA. Əvvəlcə semantik axtarışla namizəd süzmək
 * planlaşdırılmışdı; ölçüldü və işləmədi — "başqa yerdən alacağam" sorğusuna
 * "evə gedib götürəcəm" qayıdır, çünki sıx vektor mövzunu tutur, hadisəni yox.
 * Gündəlik həcm isə ~1000 parçadır, yəni hamısını ucuz modelə oxutmaq ayda
 * bir-iki dollardır. Süzgəc həm işləmir, həm də lazım deyil.
 *
 * BAL YENƏ DÜSTURDAN GƏLİR (severity.ts, scoreIntent). Modelin işi yalnız
 * hadisəni tapmaqdır; rəqəmi obyektiv faktlar verir — müştəridirmi, hələ
 * gözləyirmi, təkrarlanırmı. Bu, agentin qurucu prinsipidir və pozulmur.
 */

/** Ucuz oxuma işidir, mühakimə deyil — model də ona uyğun seçilib. */
const MODEL = process.env.SUP_INTENT_MODEL ?? "gpt-5-mini";

/**
 * Düşünmə səyi. `low`, çünki ölçüldü (scripts/eval-intent.ts, 47 hal):
 *
 *   minimal   dəqiqlik  38% · yalan-müsbət 12%
 *   low       dəqiqlik 100% · yalan-müsbət  0%
 *   medium    dəqiqlik 100% · yalan-müsbət  0%
 *
 * `minimal` bura rerankerdən köçürülmüşdü, orada isə ölçülüb zərərsiz
 * çıxmışdı — amma o, mətni oxuyub sıralamaq idi; bu, "bu cümlə şikayətdirmi"
 * mühakiməsidir və fərq beş yalan bayraqdır. `medium` əlavə heç nə vermir.
 */
const EFFORT = (process.env.SUP_INTENT_EFFORT ?? "low") as
  "minimal" | "low" | "medium" | "high";

/** Bir çağırışda neçə söhbət pəncərəsi. */
const BATCH = 20;

const KINDS = ["leaving", "broken_promise", "anger", "price_dispute"] as const;

const Findings = z.object({
  findings: z.array(
    z.object({
      /** Girişdə verilən nömrə — modelin uydurduğu id yox. */
      index: z.number().int(),
      kind: z.enum(KINDS),
      /** Söhbətdən GÖTÜRÜLMÜŞ cümlə, yenidən yazılmamış. */
      quote: z.string(),
    }),
  ),
});

const INSTRUCTIONS = `Sən satış yazışmalarını oxuyub DÖRD hadisəni tapırsan.

leaving        — müştəri başqa yerdən alacağını, imtina etdiyini, sifarişi ləğv
                 etdiyini deyir
broken_promise — bizim verdiyimiz söz pozulub: "sabah hazır olacaq" deyilib,
                 olmayıb; təyin olunmuş tarix keçib
anger          — müştəri açıq narazılıq, əsəbilik, şikayət bildirir
price_dispute  — qiyməti baha sayır, endirim tələb edir, qiymətə etiraz edir

Mətnlər Azərbaycan, rus və ingilis dillərinin qarışığıdır, çox vaxt
diakritikasız latın transliterasiyasıdır ("Cox sagolun", "Uje" = rusca "уже").

QAYDALAR:
- Hadisə YOXDURSA heç nə qaytarma. Boş cavab NORMALDIR və gözlənilir.
  Söhbətlərin böyük əksəriyyətində bu dördündən heç biri olmur.
- quote sahəsinə söhbətdən EYNƏN götürülmüş cümləni yaz. Öz sözünlə yazma,
  ümumiləşdirmə. Sitat gətirə bilmirsənsə, deməli hadisə yoxdur.
- "leaving" yalnız müştəri BİZDƏN imtina edəndə. "Evə gedirəm", "bazara
  gedirəm" kimi cümlələr bura aid deyil.
- "broken_promise" yalnız BİZİM sözümüz pozulanda. Müştərinin gecikməsi yox.
- "anger" üçün narazılıq açıq olmalıdır. Adi sual, dəqiqləşdirmə, tələsmək
  narazılıq deyil.
- Bir söhbətdə birdən çox hadisə varsa, ən ağırını seç.
- Şübhə varsa QAYTARMA. Yalan bayraq lentin dəyərini sıfırlayır — buraxılmış
  hadisədən daha zərərlidir.
- Sitat MÜŞTƏRİNİN öz sözü olmalıdır ("Onlar:" ilə başlayan sətir). Bizim
  yazdığımız ("Biz:") sitat kimi işləmir.
- Müştərinin adi SUALI hadisə deyil: "nə vaxt göndərirsiniz?", "qiymət nədir?"
  — bunlar sorğudur, narazılıq və ya imtina deyil.
- Söhbətin qarşı tərəfi şirkət/təchizatçı/kargodursa (müştəri deyilsə), onların
  sözləri bu dörd hadisəyə aid edilmir.
- ŞİRKƏTİN BUTİKLƏRİ: Bakı, Dubay, Riyad. Müştəri bunlardan birinə getməkdən,
  orada ölçü verməkdən və ya oradakı işçi ilə davam etməkdən danışırsa, bu,
  "leaving" DEYİL — o, hələ də bizdən alır, sadəcə başqa filialdan. Ölçülüb:
  "I went to the Riyadh boutique... I decided to go with the gold one" yanlış
  olaraq imtina kimi oxunmuşdu.`;

let client: OpenAI | null = null;
function openai(): OpenAI {
  client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

interface Window {
  jid: string;
  contact: string;
  text: string;
  isClient: boolean;
  stillWaiting: boolean;
  /** Son gələn mesajın vaxtı — bayrağın bağlanma sübutu. */
  lastInboundTs: number | null;
}

/**
 * Pəncərədəki müştəri söhbətləri, hazır mətn halında.
 *
 * katibe.message_chunk təkrar işlədilir: parçalar onsuz da qurulub, saatlıq
 * cron onları güncəl saxlayır, və sərhədləri (30 dəq fasilə) elə "bir söhbət"
 * anlayışına uyğundur. Yenidən yığmaq eyni işi ikinci dəfə görmək olardı.
 */
async function windowsFor(ctx: DetectorContext): Promise<Window[]> {
  const { rows } = await pool.query(
    `SELECT mc.remote_jid AS jid,
            ${contactDisplaySql("mc.remote_jid", `ct."pushName"`)} AS contact,
            string_agg(mc.text, E'\\n' ORDER BY mc.start_ts) AS text,
            -- Dairə "başqa kateqoriyada deyil" kimi qurulub (scope.ts), amma
            -- bal üçün AÇIQ Client etiketi lazımdır — ikisi eyni şey deyil.
            bool_or(scat.name = 'Client') AS is_client,
            -- Sonuncu mesaj onlardandırsa, top hələ bizdədir.
            (SELECT NOT (m.key->>'fromMe')::boolean
               FROM evolution_api."Message" m
              WHERE m."instanceId" = mc.instance_id
                AND m.key->>'remoteJid' = mc.remote_jid
              ORDER BY m."messageTimestamp" DESC LIMIT 1) AS still_waiting,
            -- Avtomatik bağlanmanın SÜBUTU (persist.ts autoCloseMissing).
            --
            -- Bu sahə olmadan intent bayraqları HEÇ VAXT öz-özünə bağlana
            -- bilmirdi: autoCloseMissing bağlamaq üçün evidence-dəki
            -- lastInboundTs-dən sonra bizdən mesaj getdiyini görməlidir,
            -- burada isə o sahə ümumiyyətlə yazılmırdı. Ölçüldü (30 gün):
            -- 24 intent postundan yalnız 5-i bağlanıb, 19-u lentdə əbədi
            -- qalmışdı — «menecer baxmır» kimi görünən şey əslində bu idi.
            (SELECT MAX(m."messageTimestamp")
               FROM evolution_api."Message" m
              WHERE m."instanceId" = mc.instance_id
                AND m.key->>'remoteJid' = mc.remote_jid
                AND NOT (m.key->>'fromMe')::boolean
                AND m."messageType" NOT IN ('protocolMessage', 'reactionMessage')) AS last_in_ts
       FROM katibe.message_chunk mc
       LEFT JOIN evolution_api."Chat" ch
              ON ch."instanceId" = mc.instance_id AND ch."remoteJid" = mc.remote_jid
       LEFT JOIN evolution_api."Contact" ct
              ON ct."instanceId" = mc.instance_id AND ct."remoteJid" = mc.remote_jid
       LEFT JOIN katibe.contact_labels cl ON cl.remote_jid = mc.remote_jid
       LEFT JOIN katibe.categories scat ON scat.id = cl.category_id
       LEFT JOIN katibe.lid_number ln ON ln.lid_jid = mc.remote_jid
       LEFT JOIN katibe.chat_identity ci ON ci.remote_jid = mc.remote_jid
       -- contactDisplaySql qrup adına (gs.subject) istinad edir; bu sorğu qrup
       -- görmür, amma alias mövcud olmalıdır, yoxsa planlayıcı sorğunu rədd edir.
       ${groupSubjectJoin("mc.remote_jid")}
      WHERE mc.instance_id = $1
        AND mc.end_ts >= $2 AND mc.start_ts <= $3
        -- Qrup deyil: "kim kimə cavab verdi" anlayışı orada yoxdur.
        AND (mc.remote_jid LIKE '%@s.whatsapp.net' OR mc.remote_jid LIKE '%@lid')
        -- DAIRE: yalniz ACIQ Client etiketi olan sohbetler.
        --
        -- Digər detektorlar clientScopeSql işlədir ("başqa kateqoriyada
        -- deyil"), çünki onlar vaxt ölçür və etiketsiz yeni müştərini
        -- buraxmamaq vacibdir. Burada isə əksi doğrudur: ölçüldü ki, o dairə
        -- təchizatçı və kargo yazışmalarını içəri buraxır, model onları
        -- müştəri şikayəti kimi oxuyur — "Pls send some new orders" (təchizatçı
        -- bizdən sifariş istəyir) 9 balla "müştəri gedir" oldu. Mətndən oxunan
        -- hadisə üçün kimin danışdığını bilmək şərtdir.
        AND EXISTS (
          SELECT 1 FROM katibe.contact_labels icl
          JOIN katibe.categories icat ON icat.id = icl.category_id
          WHERE icl.remote_jid = mc.remote_jid AND icat.name = 'Client'
        )
      -- contactDisplaySql-in toxunduğu hər sütun burada olmalıdır: ad zənciri
      -- beş mənbədən yığılır (queries.ts) və hamısı aqreqatdan kənardadır.
      GROUP BY mc.remote_jid, mc.instance_id, ch."name", ct."pushName",
               cl.display_name, ln.phone_number, gs.subject,
               ci.stated_name, ci.city, ci.order_code, ci.note
      HAVING length(string_agg(mc.text, ' ')) >= 60`,
    [ctx.instanceId, Math.floor(ctx.windowStart.getTime() / 1000),
     Math.floor(ctx.windowEnd.getTime() / 1000)],
  );
  return rows.map((r) => ({
    jid: r.jid as string,
    contact: (r.contact as string) ?? (r.jid as string),
    text: r.text as string,
    isClient: Boolean(r.is_client),
    stillWaiting: Boolean(r.still_waiting),
    lastInboundTs: r.last_in_ts === null ? null : Number(r.last_in_ts),
  }));
}

/** Tarixçədən gətirilən oxşar hadisə. */
export interface PastEcho {
  /** ISO tarixi — şərhdə "iyunda" demək üçün. */
  at: string;
  text: string;
}

/**
 * Bu müştərinin keçmişində indiki hadisəyə oxşayan anlar.
 *
 * Bura vektor axtarışı HƏQİQƏTƏN uyğun gəlir, halbuki hadisəni TAPMAQ üçün
 * uyğun gəlmirdi (bax faylın başındakı qeyd). Fərq sualdadır: "arxivdə
 * narazılıq varmı?" sualına sıx vektor pis cavab verir, çünki mövzunu tutur,
 * hadisəni yox. "Bu konkret cümləyə oxşayan nə olub?" sualına isə yaxşı cavab
 * verir — çünki sorğu artıq hadisənin özüdür, mücərrəd təsvir deyil.
 *
 * beforeTs olmasa ən yaxın nəticə həmişə hadisənin öz parçası olardı.
 */
async function pastEchoes(
  instanceId: ScopedInstanceId,
  jid: string,
  quote: string,
  beforeTs: number,
): Promise<PastEcho[]> {
  try {
    const hits = await searchSimilar(instanceId, {
      query: quote,
      jid,
      beforeTs,
      limit: 2,
      // Adi söhbətin təsadüfən oxşamasının qarşısını almaq üçün adi
      // axtarışdan yuxarı hədd: burada səhv "əvvəl də olub" iddiası
      // menecerə yanlış tarixçə göstərmək deməkdir.
      minScore: 0.55,
    });
    return hits.map((h) => ({
      at: new Date(h.startTs * 1000).toISOString().slice(0, 10),
      text: h.text.replace(/\n/g, " / ").slice(0, 220),
    }));
  } catch (e) {
    // Tarixçə bəzəkdir, tapıntının şərti deyil — axtarış uğursuz olsa
    // bayraq yenə qalxmalıdır.
    console.error("[intent] tarixçə alınmadı:", (e as Error).message.slice(0, 100));
    return [];
  }
}

/** Son 30 gündə eyni söhbətdə eyni növ tapıntı sayı — düsturun girişi. */
async function repeatsFor(jid: string, kind: IntentKind): Promise<number> {
  const { rows } = await pool.query(
    // evidence->>'kind', başlığa görə yox: başlıqlar azərbaycancadır
    // ("başqa yerə getməkdən danışır"), kind isə slug ('leaving'), ona görə
    // başlıq üzrə LIKE heç vaxt uyğun gəlməzdi və təkrar sayı həmişə 0 qalardı.
    `SELECT count(*)::int AS n FROM katibe.agent_posts
      WHERE remote_jid = $1 AND detector = 'intent'
        AND created_at > now() - interval '30 days'
        AND evidence->>'kind' = $2`,
    [jid, kind],
  );
  return (rows[0]?.n as number) ?? 0;
}

const TITLES: Record<IntentKind, string> = {
  leaving: "başqa yerə getməkdən danışır",
  broken_promise: "verdiyimiz söz pozulub",
  anger: "açıq narazılıq bildirir",
  price_dispute: "qiymətə etiraz edir",
};

export interface Classified {
  index: number;
  kind: IntentKind;
  quote: string;
}

/**
 * Runs the model over a batch of conversation texts.
 *
 * Split out from runIntent so scripts/eval-intent.ts scores THIS function
 * rather than a copy of it — a harness that tests its own reimplementation
 * measures nothing. Callers get raw classifications; the quote check and the
 * scoring stay with the detector, which is where the conversation context is.
 */
export async function classifyWindows(texts: string[]): Promise<Classified[]> {
  if (texts.length === 0) return [];
  const out: Classified[] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const input = batch.map((t, n) => `[${n}] ${t.slice(0, 1800)}`).join("\n\n---\n\n");
    try {
      const res = await openai().responses.parse({
        model: MODEL,
        instructions: INSTRUCTIONS,
        input,
        text: { format: zodTextFormat(Findings, "findings") },
        // Səviyyə ölçülür, seçilmir: rerankerdə "minimal" dəqiqliyə toxunmadan
        // 29 saniyəni 4.6-ya endirmişdi, amma o, OXUMA işi idi. Bu, MÜHAKİMƏ
        // işidir və fərqi scripts/eval-intent.ts göstərir.
        reasoning: { effort: EFFORT },
      });
      for (const f of res.output_parsed?.findings ?? []) {
        if (batch[f.index] !== undefined) {
          out.push({ index: i + f.index, kind: f.kind, quote: f.quote });
        }
      }
    } catch (e) {
      // Bir batch uğursuz olsa qalanı davam etsin: detektorun susması
      // gedişatın uğursuzluğundan yaxşıdır.
      console.error("[intent] batch alınmadı:", (e as Error).message.slice(0, 120));
    }
  }
  return out;
}

export async function runIntent(ctx: DetectorContext): Promise<Finding[]> {
  if (!process.env.OPENAI_API_KEY) return [];
  const windows = await windowsFor(ctx);
  if (windows.length === 0) return [];

  const classified = await classifyWindows(windows.map((w) => `${w.contact}\n${w.text}`));
  const out: Finding[] = [];
  for (const f of classified) {
    const w = windows[f.index];
    if (!w) continue;
    const quote = f.quote.trim();
    if (quote.length < 8) continue;
    // Sitat söhbətdə HƏQİQƏTƏN olmalıdır və MÜŞTƏRİNİN sətrindən gəlməlidir.
    //
    // İkinci şərt kodda yoxlanılır, promptda xahiş kimi yox: ilk sınaqda
    // model "When you will send to Baku?" cümləsini (kargo şirkətinin öz
    // sualı) "müştəri başqa yerə gedir" kimi oxumuşdu və 9 bal vermişdi.
    // Chunk formatı "Biz:" / "Onlar:" ilə başlayır, ona görə bu, təxmin
    // deyil, mexaniki yoxlamadır — və modelin razılığından asılı deyil.
    const needle = quote.toLowerCase().slice(0, 24);
    const theirLine = w.text
      .split("\n")
      .some((line) => !line.startsWith("Biz:") && line.toLowerCase().includes(needle));
    if (!theirLine) continue;
    const repeats = await repeatsFor(w.jid, f.kind);
    const history = await pastEchoes(
      ctx.instanceId, w.jid, quote, Math.floor(ctx.windowStart.getTime() / 1000),
    );
    out.push({
      detector: "intent",
      jid: w.jid,
      contact: w.contact,
      baseSeverity: scoreIntent({
        kind: f.kind,
        isClient: w.isClient,
        stillWaiting: w.stillWaiting,
        repeatsIn30Days: repeats,
      }),
      title: `${w.contact} — ${TITLES[f.kind]}`,
      evidence: {
        kind: f.kind, quote, stillWaiting: w.stillWaiting, repeatsIn30Days: repeats,
        contact: w.contact,
        // Bağlanma sübutu — bu hadisədən SONRA bizdən mesaj getsə, bayraq
        // digərləri kimi öz-özünə bağlanır (və satıcı cavab yazan kimi
        // reactive.ts onu dərhal bağlayır). Problem qayıdarsa dedupe açarı
        // azad olduğu üçün TƏZƏ bayraq açılır — köhnənin altında gizlənmir.
        ...(w.lastInboundTs !== null ? { lastInboundTs: w.lastInboundTs } : {}),
        // Şərh modelinə olduğu kimi ötürülür (llm.ts); boşdursa sahə də yoxdur,
        // çünki boş massiv modelə "tarixçə axtarıldı və tapılmadı" deyil,
        // "tarixçə var" kimi görünə bilər.
        ...(history.length > 0 ? { history } : {}),
      },
    });
  }
  return out;
}

export const intentDetector: Detector = { name: "intent", run: runIntent };
