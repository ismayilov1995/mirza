import OpenAI from "openai";
import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import type { SimilarChunk } from "./embedding";

/*
 * Reordering vector hits by whether they actually answer the question.
 *
 * WHY THIS EXISTS. Measured on /var/lib/katibe/search-eval.json, the vector
 * index finds the right subject and the wrong conversation: ask "how much does
 * the courier cost" and it returns an exchange about a courier that never
 * mentions a price. That is not a weakness of one embedding model but of the
 * comparison itself — a single vector per passage is a summary of what the
 * passage is about, and "about couriers" is true of both the answer and the
 * hundred near misses around it.
 *
 * A reranker does the comparison the index cannot: it reads the question and
 * the passage together, so "costs 15 AZN, cash" can outrank a longer, more
 * on-topic passage that answers nothing. It runs over the shortlist the index
 * produced, which is what keeps it affordable — one call, not one per chunk.
 */

/** Cheap and sufficient: this is a reading task, not a reasoning one. */
export const RERANK_MODEL = process.env.RERANK_MODEL ?? "gpt-5-mini";

/** How many candidates to hand the model. Beyond this the prompt stops paying. */
export const RERANK_CANDIDATES = 50;

const Verdict = z.object({
  results: z.array(
    z.object({
      /** Index into the candidate list as it was presented, 1-based. */
      index: z.number().int(),
      /** 0 = unrelated, 1 = same subject only, 2 = relevant, 3 = answers it. */
      grade: z.number().int(),
    }),
  ),
});

const INSTRUCTIONS = `Sən WhatsApp söhbət arxivində axtarış nəticələrini sıralayırsan.

Mətnlər Azərbaycan, rus və ingilis dillərinin qarışığıdır və çox vaxt diakritikasız
latın transliterasiyasıdır ("Cox sagolun" = "Çox sağ olun", "Uje" = rusca "уже").
Bunu nəzərə al.

Hər namizədə 0-3 bal ver:
  3 — sualın cavabı burada var
  2 — birbaşa aidiyyəti var, cavabın bir hissəsidir
  1 — yalnız eyni mövzudadır, sualı cavablandırmır
  0 — aidiyyəti yoxdur

ƏSAS QAYDA: mövzu oxşarlığı bal qazandırmır. "Kuryer neçəyə başa gəlir?" sualına
kuryerdən danışan, amma qiymət deməyən mətn 1-dir, 3 deyil. Sualın predikatını
(gecikir? bahadır? hazırdır?) yoxla, təkcə mövzusunu yox.

Yalnız balı 1 və daha yuxarı olanları qaytar.`;

let client: OpenAI | null = null;
function openai(): OpenAI {
  client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

export interface RerankedChunk extends SimilarChunk {
  /** 0-3 as graded above; absent from the result when the model said 0. */
  grade: number;
}

/**
 * Reorders candidates by grade, keeping vector score as the tie-break.
 *
 * Returns the input order untouched if the call fails — a reranker that throws
 * would turn a degraded search into a broken one, and the caller has perfectly
 * usable results already.
 */
export async function rerank(
  query: string,
  candidates: SimilarChunk[],
  limit = 10,
): Promise<RerankedChunk[]> {
  if (candidates.length === 0) return [];
  const shortlist = candidates.slice(0, RERANK_CANDIDATES);
  // Newlines inside a chunk would blur the boundaries between candidates in
  // the prompt, so they are flattened; the text is otherwise sent verbatim.
  const listing = shortlist
    .map((c, i) => `[${i + 1}] ${c.text.replace(/\n/g, " / ").slice(0, 600)}`)
    .join("\n\n");

  try {
    const res = await openai().responses.parse({
      model: RERANK_MODEL,
      instructions: INSTRUCTIONS,
      input: `SUAL: ${query}\n\nNAMİZƏDLƏR:\n${listing}`,
      text: { format: zodTextFormat(Verdict, "results") },
      // Grading a passage against a question is reading, not deduction, and
      // the default effort spends half a minute on it — far too slow for a
      // search box. Measured: 29s at default, and the accuracy below is what
      // this setting was chosen against, not assumed.
      reasoning: { effort: "minimal" },
    });
    const parsed = res.output_parsed;
    if (!parsed) throw new Error("model returned no parsed output");

    const graded = new Map<number, number>();
    for (const r of parsed.results) {
      const c = shortlist[r.index - 1];
      if (c && r.grade > 0) graded.set(c.id, r.grade);
    }
    return shortlist
      .filter((c) => graded.has(c.id))
      .map((c) => ({ ...c, grade: graded.get(c.id) as number }))
      .sort((a, b) => b.grade - a.grade || b.score - a.score)
      .slice(0, limit);
  } catch (e) {
    console.error("[rerank] alınmadı, vektor sırası saxlanılır:", e);
    return shortlist.slice(0, limit).map((c) => ({ ...c, grade: 0 }));
  }
}
