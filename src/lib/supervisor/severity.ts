// Deterministik severity düsturu.
//
// Rəqəm buradan çıxır, modeldən yox: LLM sonradan ən çoxu ±2 düzəliş edə
// bilir və səbəbini yazmağa məcburdur (llm.ts). Ona görə "niyə 7?" sualının
// cavabı həmişə bu fayldakı hesabdır — bahalı bir modelin o günkü əhvalı yox.
//
// Zolaqlar: 1-3 məlumat, 4-5 diqqət, 6-8 ciddi, 9-10 kritik. 6-dan yuxarı
// lentdə qırmızı bayraqla sancaqlanır. 10-a deterministik yol yoxdur —
// o, yalnız modelin 8-9-u əsaslandırılmış şəkildə qaldırması ilə mümkündür
// ("müştəri açıq şəkildə getməklə hədələyir" səviyyəsi üçün saxlanılıb).

export interface UnansweredInputs {
  waitedSeconds: number;
  targetSeconds: number;
  /** Hədəf SLA qaydasından gəlmir, ehtiyat rəqəmdir — iddia yumşalır. */
  fallbackTarget: boolean;
  /** Qarşı tərəf Client kimi etiketlənib. */
  isClient: boolean;
  /** Cavabsız seriyada müştərinin mesaj sayı — 3+ dalbadal yazmaq səbirsizlikdir. */
  msgsWaiting: number;
  /** Eyni gedişatda hədəfi keçmiş söhbətlərin ümumi sayı — 3+ sistemli problemdir. */
  breachingChatsInRun: number;
}

export function scoreUnanswered(i: UnansweredInputs): number {
  const r = i.waitedSeconds / i.targetSeconds;
  if (r < 1) return 0; // pozuntu yoxdur — tapıntı yaranmır

  let score = r < 2 ? 4 : r < 4 ? 5 : r < 8 ? 6 : 7;
  if (i.isClient) score += 1;
  if (i.msgsWaiting >= 3) score += 1;
  if (i.breachingChatsInRun >= 3) score += 1;
  score = Math.min(score, 9);
  if (i.fallbackTarget) score = Math.max(4, score - 1);
  return score;
}

export interface SilenceInputs {
  /** Hazırda cavab gözləyən söhbətlərin sayı. */
  waitingChats: number;
  /** Əvvəlki 4 həftənin eyni pəncərəsində median giden mesaj sayı. */
  baselineMedian: number;
}

export function scoreSilence(i: SilenceInputs): number {
  let score = 4;
  if (i.waitingChats >= 2) score += 1;
  if (i.baselineMedian >= 10) score += 1;
  return Math.min(score, 7);
}

export interface CustomerDecidingInputs {
  isClient: boolean;
}

/**
 * "Müştəri qərar verir" follow-up xatırlatması qəsdən "diqqət" zolağında
 * (4-5) qalır: sallanan satış itki riskidir, amma SLA pozuntusu deyil —
 * sancaqlanıb qırmızı bayraq olması lentin ciddi bayraqlarını ucuzlaşdırardı.
 */
export function scoreCustomerDeciding(i: CustomerDecidingInputs): number {
  return i.isClient ? 5 : 4;
}

/**
 * Modelin düzəlişi: v1-də YALNIZ AŞAĞI, ən çoxu -2. Model SQL-in gördüyündən
 * azını görür — yüksəltmək ixtiyarı yoxdur. Üstəlik deterministik düstur 6+
 * deyibsə, model onu bayraq həddinin altına da sala bilmir: sancağı yalnız
 * insan ("Həll edildi") çıxarır.
 */
export function applyAdjustment(base: number, adjust: number): number {
  const clamped = Math.max(-2, Math.min(0, Math.round(adjust)));
  const adjusted = Math.max(1, Math.min(10, base + clamped));
  return base >= 6 ? Math.max(adjusted, 6) : adjusted;
}

export function verdictFor(severity: number): "INTERVENE" | "OK" {
  return severity >= 6 ? "INTERVENE" : "OK";
}

/**
 * Mətndən oxunan hadisələr — saatın görə bilmədikləri.
 *
 * Mövcud üç detektor vaxt ölçür: kim gözləyir, kim susub. Bu isə NƏ DEYİLDİYİNİ
 * oxuyur. Prinsip dəyişmir — modelin işi yalnız hadisəni TAPMAQdır, rəqəm yenə
 * buradan çıxır, ona görə "niyə 9?" sualının cavabı yenə bu fayldadır.
 *
 * Faylın başındakı qeyd 10 balı "müştəri açıq şəkildə getməklə hədələyir" üçün
 * saxlamışdı, amma ora deterministik yol yox idi və llm.ts modelə yalnız
 * AŞAĞI salmağa icazə verir — yəni 10 əlçatmaz qalırdı. `leaving` onu əlçatan
 * edir, çünki elə həmin hadisədir.
 */
export type IntentKind = "leaving" | "broken_promise" | "anger" | "price_dispute";

/** Hadisə növünün öz ağırlığı. Müştərini itirmək ən bahalısıdır. */
const INTENT_BASE: Record<IntentKind, number> = {
  leaving: 8,
  broken_promise: 6,
  anger: 6,
  price_dispute: 4,
};

/** `leaving` 10-a qalxa bilir; qalanları 8-də dayanır — bax zolaq qeydinə. */
const INTENT_CAP: Record<IntentKind, number> = {
  leaving: 10,
  broken_promise: 8,
  anger: 8,
  price_dispute: 6,
};

export interface IntentInputs {
  kind: IntentKind;
  /** Qarşı tərəf Client kimi etiketlənib. */
  isClient: boolean;
  /** Hadisədən sonra müştəri hələ də cavab gözləyir — yara açıq qalıb. */
  stillWaiting: boolean;
  /** Son 30 gündə eyni söhbətdə eyni növ tapıntı — təkrarlanan problem daha ağırdır. */
  repeatsIn30Days: number;
}

export function scoreIntent(i: IntentInputs): number {
  let score = INTENT_BASE[i.kind];
  if (i.isClient) score += 1;
  if (i.stillWaiting) score += 1;
  if (i.repeatsIn30Days >= 1) score += 1;
  return Math.min(score, INTENT_CAP[i.kind]);
}
