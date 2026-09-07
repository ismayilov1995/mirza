import { NextRequest, NextResponse } from "next/server";
import { getInstanceStatus } from "@/lib/evolution";
import { requireAdmin } from "@/lib/access";

export const runtime = "nodejs";

/**
 * Pairing status for the QR page to poll.
 *
 * ADMIN ONLY, qəsdən: qoşulmamış instans üçün bu cavab QR kodu daşıyır və onu
 * skan etmək telefonu həmin WhatsApp hesabına bağlayır. Əvvəl istənilən sessiya
 * istənilən instans adı üçün cavab alırdı — bu, status endpoint-i yox, hesab
 * ələ keçirmə vasitəsi idi.
 *
 * Evolution serverdən çağırılır ki, API açarı brauzerə düşməsin.
 */
export async function GET(req: NextRequest) {
  await requireAdmin();

  const name = req.nextUrl.searchParams.get("name");
  if (!name) return NextResponse.json({ error: "name tələb olunur" }, { status: 400 });
  try {
    return NextResponse.json(await getInstanceStatus(name));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Bilinməyən xəta";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
