import { timingSafeEqual } from "node:crypto";

export const WEBHOOK_SECRET_HEADER = "x-katibe-webhook-secret";

// Evolution vebhuk gövdəsini imzalamır — yalnız sərbəst başlıq göndərə bilir.
// Ona görə bu paylaşılan açar endpoint-in qarşısındakı yeganə tətbiq səviyyəli
// yoxlamadır. Açar yoxdursa HƏR sorğu rədd edilir (fail closed).
export function requireWebhookSecret(): string {
  const secret = process.env.KATIBE_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("KATIBE_WEBHOOK_SECRET environment variable is not set");
  }
  return secret;
}

export function verifyWebhookSecret(expected: string, provided: string | null | undefined): boolean {
  if (!provided) return false;

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");

  // timingSafeEqual uzunluqlar fərqli olanda XƏTA atır, false qaytarmır —
  // ona görə uzunluq yoxlaması əvvəl gəlir.
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}
