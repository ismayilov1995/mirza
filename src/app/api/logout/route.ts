import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";

/*
 * Çıxış — iki metodla, çünki iki cür çağırılır.
 *
 * GET naviqasiyadır: sidebar-dakı «Çıxış» sətri və başlıqdakı hesab nişanı adi
 * linkdir. Bu marşrut yalnız POST idi və həmin link səssizcə 405 qaytarırdı —
 * basılırdı, heç nə olmurdu. Çıxışın JavaScript-siz işləyən yolu olmalıdır,
 * ona görə düzəliş linki dəyişmək yox, metodu əlavə etməkdir.
 *
 * POST fetch ilə çağıranlar üçün qalır: cavab JSON-dur, yönləndirmə çağıranın
 * öz işidir.
 *
 * İkisi də eyni şeyi edir — sessiya cookie-si silinir. Cookie gedəndən sonra
 * proxy onsuz da hər səhifəni /login-ə yönləndirir.
 */

function clear(res: NextResponse): NextResponse {
  res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}

export async function GET(request: Request) {
  // 303: brauzer növbəti sorğunu GET ilə göndərsin və «çıxış» tarixçədə
  // yenidən oynadıla bilən bir addım kimi qalmasın.
  return clear(NextResponse.redirect(new URL("/login", request.url), { status: 303 }));
}

export async function POST() {
  return clear(NextResponse.json({ ok: true }));
}
