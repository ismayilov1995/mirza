import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { pool } from "./db";

/*
 * Müştəri mesajlarının mövzu təsnifatı.
 *
 * NİYƏ YALNIZ GƏLƏN MESAJLAR. Bizim cavabımızın mövzusu müştərinin sualının
 * mövzusu ilə eynidir; ikisini də təsnif etmək qiyməti ikiqat edib heç nə
 * əlavə etmir.
 *
 * NİYƏ HAIKU. Bu, təhlil deyil, təsnifatdır — yeddi qapalı etiketdən birini
 * seçmək. identify-clients-də eyni qərar verilib və eyni səbəbdən.
 *
 * DİQQƏT: Haiku 4.5 `thinking: adaptive` və `effort` parametrlərini 400 ilə
 * rədd edir (identify-clients-də bu bir dəfə hər paketi səssizcə uçurmuşdu) —
 * ona görə burada onlar ümumiyyətlə göndərilmir.
 *
 * Dizayn: docs/satici-fakt-qati-dizayn.md §8
 */

export const TOPICS = [
  "GENERAL",
  "PRODUCT_INFO",
  "ORDER",
  "LOGISTICS",
  "PAYMENT",
  "PRICE_INQUIRY",
  "COMPLAINT",
] as const;
export type Topic = (typeof TOPICS)[number];

export const TOPIC_MODEL = "claude-haiku-4-5";
export const BATCH_SIZE = 40;

/** Bundan qısa mesaj modelə getmir — «ok», «👍», «salam» heç nə öyrətmir. */
const MIN_LENGTH = 12;

const BatchSchema = z.object({
  labels: z.array(
    z.object({
      i: z.number().describe("Mesajın nömrəsi, verildiyi kimi"),
      topic: z.enum(TOPICS),
    }),
  ),
});

const SYSTEM = `Sən müştəri yazışmalarını təsnif edirsən. Hər mesaja YALNIZ bir etiket ver:

PRICE_INQUIRY — qiymət soruşur («neçəyədir», «endirim varmı»)
PRODUCT_INFO — məhsulun özü haqqında sual (rəng, ölçü, material, mövcudluq)
ORDER — sifariş vermək, dəyişmək, təsdiqləmək
PAYMENT — ödəniş, köçürmə, hesab, borc
LOGISTICS — çatdırılma, göndərmə, ünvan, gömrük, yük
COMPLAINT — narazılıq, şikayət, qüsur, gecikmədən şikayət
GENERAL — salamlaşma, təşəkkür, boş söhbət, yuxarıdakıların heç biri

Mesajlar Azərbaycan, rus, ingilis və ərəb dillərində ola bilər.
Şübhə edirsənsə GENERAL yaz — səhv spesifik etiket boş etiketdən pisdir.
Hər mesaj üçün bir sətir qaytar, nömrəni dəyişmə.`;

export interface Candidate {
  id: number;
  body: string;
}

/**
 * Təsnif olunmamış gələn müştəri mesajları — ən yenidən köhnəyə.
 *
 * Dairə statistika ilə eynidir (Sales instansları, fərdi/lid söhbətlər,
 * Nəzarətçinin müştəri süzgəci), yoxsa mövzu qarışığı cədvəldəki rəqəmlərlə
 * başqa çoxluğu təsvir edərdi.
 */
export async function findCandidates(days: number, limit: number): Promise<Candidate[]> {
  const { rows } = await pool.query<{ id: string; body: string }>(
    `SELECT DISTINCT m.id, m.body
       FROM katibe.message m
       JOIN katibe.message_source ms ON ms.message_id = m.id AND ms.direction = 'in'
       JOIN katibe.user_instances ui ON ui.instance_id = ms.source_id AND ui.ended_at IS NULL
       JOIN katibe.users u ON u.id = ui.user_id
       JOIN katibe.categories c ON c.id = u.category_id AND c.name = 'Sales'
       JOIN katibe.chat ch ON ch.id = m.chat_id AND ch.kind IN ('individual','lid')
      WHERE m.ts > EXTRACT(epoch FROM now() - make_interval(days => $1::int))::int
        AND m.body IS NOT NULL AND length(m.body) >= $2
        AND NOT EXISTS (SELECT 1 FROM katibe.message_topic t WHERE t.message_id = m.id)
        AND NOT EXISTS (
          SELECT 1 FROM katibe.contact_labels cl
          JOIN katibe.categories cat ON cat.id = cl.category_id
          WHERE cl.remote_jid = m.remote_jid AND cat.name <> 'Client')
      ORDER BY m.id DESC
      LIMIT $3`,
    [days, MIN_LENGTH, limit],
  );
  return rows.map((r) => ({ id: Number(r.id), body: r.body }));
}

/** Qısa mesajlar modelə getmir, birbaşa GENERAL yazılır. */
export async function labelShortMessages(days: number): Promise<number> {
  const { rowCount } = await pool.query(
    `INSERT INTO katibe.message_topic (message_id, topic, model)
     SELECT DISTINCT m.id, 'GENERAL', 'qayda:qısa'
       FROM katibe.message m
       JOIN katibe.message_source ms ON ms.message_id = m.id AND ms.direction = 'in'
       JOIN katibe.user_instances ui ON ui.instance_id = ms.source_id AND ui.ended_at IS NULL
       JOIN katibe.users u ON u.id = ui.user_id
       JOIN katibe.categories c ON c.id = u.category_id AND c.name = 'Sales'
       JOIN katibe.chat ch ON ch.id = m.chat_id AND ch.kind IN ('individual','lid')
      WHERE m.ts > EXTRACT(epoch FROM now() - make_interval(days => $1::int))::int
        AND (m.body IS NULL OR length(m.body) < $2)
        AND NOT EXISTS (SELECT 1 FROM katibe.message_topic t WHERE t.message_id = m.id)
     ON CONFLICT (message_id) DO NOTHING`,
    [days, MIN_LENGTH],
  );
  return rowCount ?? 0;
}

export interface BatchResult {
  labelled: number;
  inputTokens: number;
  outputTokens: number;
}

export async function classifyBatch(batch: Candidate[]): Promise<BatchResult> {
  const client = new Anthropic();
  const numbered = batch
    .map((c, i) => `${i}. ${c.body.replace(/\s+/g, " ").slice(0, 400)}`)
    .join("\n");

  const res = await client.messages.parse({
    model: TOPIC_MODEL,
    max_tokens: 2000,
    output_config: { format: zodOutputFormat(BatchSchema) },
    system: SYSTEM,
    messages: [{ role: "user", content: numbered }],
  });

  const parsed = res.parsed_output;
  if (!parsed) return { labelled: 0, inputTokens: 0, outputTokens: 0 };

  let labelled = 0;
  for (const label of parsed.labels) {
    const candidate = batch[label.i];
    if (!candidate) continue; // model uydurma nömrə qaytarsa, sətir yazılmır
    await pool.query(
      `INSERT INTO katibe.message_topic (message_id, topic, model)
       VALUES ($1,$2,$3) ON CONFLICT (message_id) DO NOTHING`,
      [candidate.id, label.topic, TOPIC_MODEL],
    );
    labelled++;
  }
  return {
    labelled,
    inputTokens: res.usage?.input_tokens ?? 0,
    outputTokens: res.usage?.output_tokens ?? 0,
  };
}

/** Haiku 4.5 qiyməti, $/milyon token. Quru işləmənin hesabı bundan çıxır. */
export const PRICE = { input: 1.0, output: 5.0 };

export function estimateCost(candidates: Candidate[]): {
  batches: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
} {
  const batches = Math.ceil(candidates.length / BATCH_SIZE);
  // ~4 simvol bir token; sistem promptu hər paketdə təkrarlanır.
  const bodyTokens = candidates.reduce((a, c) => a + Math.ceil(Math.min(c.body.length, 400) / 4), 0);
  const inputTokens = bodyTokens + batches * 400;
  const outputTokens = candidates.length * 12;
  return {
    batches,
    inputTokens,
    outputTokens,
    usd: (inputTokens / 1e6) * PRICE.input + (outputTokens / 1e6) * PRICE.output,
  };
}
