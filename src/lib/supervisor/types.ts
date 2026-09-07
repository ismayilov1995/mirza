// Nəzarətçi agentin daxili tipləri.
//
// Detektor = ad + run(ctx). Gələcək "agentciklər" bu registrə yeni detektor
// əlavə etməkdən ibarətdir — axının qalan hissəsi (severity, LLM şərhi,
// yazılma, lent) onların hamısına eyni cür xidmət edir.
import type { ScopedInstanceId } from "../access";

export interface SalesInstance {
  instanceId: ScopedInstanceId;
  instanceName: string;
  userId: number;
  userName: string;
}

export interface DetectorContext {
  instanceId: ScopedInstanceId;
  instanceName: string;
  userId: number;
  userName: string;
  windowStart: Date;
  windowEnd: Date;
  /**
   * Pəncərənin bu user-in iş saatları ilə kəsişməsi, dəqiqə ilə. 0 olanda
   * gedişat yalnız açıq tapıntıları təzələyir — gecə saat 3-də cavab
   * vermədiyinə görə heç kim bayraqlanmır.
   */
  businessOverlapMinutes: number;
}

export interface Finding {
  detector: string;
  /** NULL = instans səviyyəli tapıntı (məs. ümumi susqunluq). */
  jid: string | null;
  /** Ad artıq həll olunmuş halda — @lid JID-lər lentdə oxunmur. */
  contact: string | null;
  /** Deterministik düsturdan gələn bal, 1-10. Model buna toxunmur. */
  baseSeverity: number;
  /** Qısa azərbaycanca başlıq, şablondan. */
  title: string;
  /** Düsturun istifadə etdiyi rəqəmlər — post "niyə" sualına cavab verə bilsin. */
  evidence: Record<string, unknown>;
}

export interface Detector {
  name: string;
  run(ctx: DetectorContext): Promise<Finding[]>;
}

/** Pəncərənin ümumi mənzərəsi — all-clear şablonu və LLM prompt-u üçün. */
export interface WindowDigest {
  inbound: number;
  outbound: number;
  activeChats: number;
  topContacts: { contact: string; jid: string; messages: number }[];
  /** Hazırda ən uzun gözləyən söhbət, saniyə — heç kim gözləmirsə null. */
  longestWaitSeconds: number | null;
  longestWaitContact: string | null;
  /** Pəncərə daxilindəki cavabların median sürəti, saniyə. */
  medianReplySeconds: number | null;
}

export const SEVERITY_BANDS = [
  { min: 9, key: "kritik", label: "Kritik" },
  { min: 6, key: "ciddi", label: "Ciddi" },
  { min: 4, key: "diqqet", label: "Diqqət" },
  { min: 1, key: "info", label: "Məlumat" },
] as const;

export type SeverityBand = (typeof SEVERITY_BANDS)[number]["key"];

export function severityBand(severity: number): SeverityBand {
  for (const b of SEVERITY_BANDS) if (severity >= b.min) return b.key;
  return "info";
}
