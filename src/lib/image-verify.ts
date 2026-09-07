import OpenAI from "openai";
import fs from "node:fs";
import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import { prepareImage, type CatalogHit } from "./image-match";

/*
 * Deciding what a photo actually shows.
 *
 * The vector index produces a shortlist and cannot do more: measured on this
 * archive, a correct match scored 0.92 and confident wrong ones scored 0.89
 * and 0.84, because two different ivory lace gowns are genuinely close in CLIP
 * space. A threshold over that score would label bespoke work with a
 * catalogue code — the one error worth avoiding, since a wrong code is
 * believed while a missing one is merely unhelpful.
 *
 * So this stage looks at the photo and the shortlist together and is allowed
 * to reject all of them. "Not ours" is the answer for a customer sending a
 * competitor's runway shot and asking whether it can be made, which is a real
 * and common message here.
 */

export const VERIFY_MODEL = process.env.IMAGE_VERIFY_MODEL ?? "gpt-5-mini";

/** How many candidates the model is shown. Beyond this the prompt stops paying. */
export const VERIFY_CANDIDATES = 5;

const Verdict = z.object({
  verdict: z.enum(["catalog", "customized", "not_dress", "unsure"]),
  /** The code, exactly as labelled in the input, when verdict is `catalog`. */
  code: z.string(),
  reason: z.string(),
});

export type ImageVerdict = z.infer<typeof Verdict>;

const INSTRUCTIONS = `Sən moda evinin arxivində şəkilləri tanıyırsan.

Sənə BİR sorğu şəkli, sonra kolleksiyadan bir neçə namizəd verilir. Namizədlərin
hər birinin kodu şəkildən əvvəl yazılır.

Qərar ver:
- "catalog"   — sorğudakı paltar namizədlərdən BİRİDİR. code sahəsinə həmin kodu yaz.
- "customized"— paltardır, amma namizədlərin heç biri deyil (sifariş işi və ya
                başqa markanın modeli). code boş string.
- "not_dress" — paltar yoxdur: sənəd, qaimə, parça detalı, barkod, kolaj,
                emalatxana şəkli. code boş string.
- "unsure"    — qərar verə bilmirsən. code boş string.

ƏSAS QAYDA: NAMİZƏDLƏR ADƏTƏN YANLIŞDIR. Onlar rəngə və ümumi görünüşə görə
seçilib, ona görə düzgün paltar siyahıda ÇOX VAXT YOXDUR. Sənin işin siyahıdan
ən yaxşısını seçmək DEYİL — düzgün olanın orada olub-olmadığını demək.

Əvvəlcə GEYİM TİPİNİ yoxla: don, pencək+ətək, kombinezon, ətək, üst? Tip
uyğun gəlmirsə dərhal "customized" — rəng oxşarlığının əhəmiyyəti yoxdur.

Sonra konkret detallara bax: yaxa forması, qol, bel xətti, yarıq yeri, naxışın
növü. Ən azı ÜÇÜ üst-üstə düşməlidir. Düşmürsə "customized".

Yanlış kod verməkdənsə "customized" demək HƏMİŞƏ daha yaxşıdır: koda inanırlar
və sifariş işini kataloq malı kimi qeyd etmək real ziyandır. "customized"
cavabı uğursuzluq deyil, normal və gözlənilən nəticədir.

SKRİNŞOTLAR. Gələnlərin çoxu sayt və ya Instagram skrinşotudur: şəklin böyük
hissəsi ağ interfeys, düymə və mətndir, paltar isə kiçik bir sahədədir. İki şey
et:
1. Şəkildə paltarın ADI yazılıbsa (məsələn "OMBRÉ CRYSTAL CORSET GOWN"), onu
   OXU və namizədlərlə TUTUŞDUR. DİQQƏT: ad namizədi TƏSDİQLƏMƏK üçün deyil,
   YOXLAMAQ üçündür. Ad "korset don" deyirsə, namizəd isə pencək-ətəkdirsə,
   bu, uyğunsuzluq SÜBUTUdur — "customized" ver. Adı oxuyub onu namizədin
   üstünə yazma.
2. Yalnız paltarın olduğu sahəyə diqqət et; interfeysi, mətn bloklarını,
   fonu və modelin üzünü nəzərə alma.

Sorğu şəkli bir neçə kiçik şəklin KOLAJIdırsa (qalereya, "51 of 132" kimi
göstərici), tək bir paltar seçmək mümkün deyil — "unsure" ver.

Kəsilmiş və yaxın çəkilmiş şəkillərdə paltarın formasına, tikişinə, naxışına
bax — fona və modelə yox.

reason sahəsini AZƏRBAYCAN DİLİNDƏ, bir qısa cümlə yaz.`;

let client: OpenAI | null = null;
function openai(): OpenAI {
  client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

function dataUrl(base64: string): string {
  return `data:image/jpeg;base64,${base64}`;
}

/**
 * Judges one photo against its shortlist.
 *
 * Returns `unsure` rather than throwing when the call fails: an image left
 * undecided can be retried or read by a person, whereas a thrown error in a
 * batch loop costs the whole run.
 */
export async function verifyImage(
  queryImage: Buffer,
  candidates: CatalogHit[],
): Promise<ImageVerdict & { model: string }> {
  const shortlist = candidates.slice(0, VERIFY_CANDIDATES);
  try {
    const content: OpenAI.Responses.ResponseInputContent[] = [
      { type: "input_text", text: "SORĞU ŞƏKLİ:" },
      { type: "input_image", image_url: dataUrl(await prepareImage(queryImage)), detail: "auto" },
      { type: "input_text", text: `NAMİZƏDLƏR (${shortlist.length}):` },
    ];
    for (const c of shortlist) {
      content.push({ type: "input_text", text: `kod: ${c.code}` });
      content.push({
        type: "input_image",
        image_url: dataUrl(await prepareImage(fs.readFileSync(c.filePath))),
        detail: "auto",
      });
    }

    const res = await openai().responses.parse({
      model: VERIFY_MODEL,
      instructions: INSTRUCTIONS,
      input: [{ role: "user", content }],
      text: { format: zodTextFormat(Verdict, "verdict") },
      // Same finding as the text reranker: this is looking, not deducing, and
      // the default effort spends far longer for no measured gain.
      reasoning: { effort: "minimal" },
    });
    const parsed = res.output_parsed;
    if (!parsed) throw new Error("model returned no parsed output");

    // A code the model invented is worse than no code, so it must be one we
    // actually showed it.
    const valid = new Set(shortlist.map((c) => c.code));
    if (parsed.verdict === "catalog" && !valid.has(parsed.code)) {
      return {
        verdict: "unsure",
        code: "",
        reason: `model siyahıda olmayan kod verdi: ${parsed.code.slice(0, 40)}`,
        model: VERIFY_MODEL,
      };
    }
    return { ...parsed, model: VERIFY_MODEL };
  } catch (e) {
    return {
      verdict: "unsure",
      code: "",
      reason: `çağırış alınmadı: ${(e as Error).message.slice(0, 120)}`,
      model: VERIFY_MODEL,
    };
  }
}
