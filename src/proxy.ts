import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

export const config = {
  // `api/webhooks` MÜTLƏQ kənarda qalmalıdır. Evolution API oraya sessiya
  // çərəzi olmadan POST edir; bu proxy onu tutsaydı, hər hadisə /login-ə 307
  // ilə yönləndirilib itərdi — özü də iki tərəfdə də heç bir xəta görünmədən.
  // O yol öz paylaşılan açarı ilə qorunur (src/lib/webhook-auth.ts).
  //
  // /api/live QƏSDƏN kənarda deyil: söhbət məlumatı daşıyır, sessiya tələb edir.
    // İstisnalar YOL SEQMENTİ ilə bitir. Əvvəl sadəcə prefiks idi, yəni
  // /loginfoo və ya /api/webhooksXYZ kimi hər hansı gələcək yol da səssizcə
  // sessiya yoxlamasından kənarda qalardı. Belə yol bu gün yoxdur — amma
  // olanda qüsur görünməz olardı.
  matcher: [
    "/((?!login(?:/|$)|api/login(?:/|$)|api/webhooks(?:/|$)|_next/static/|_next/image/|favicon\\.ico$).*)",
  ],
};

export async function proxy(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const secret = process.env.SESSION_SECRET!;
  const valid = await verifySessionToken(secret, token);
  if (!valid) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", req.nextUrl.pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}
