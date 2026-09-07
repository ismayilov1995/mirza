import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, createSessionToken } from "@/lib/auth";
import { verifyPassword } from "@/lib/password";
import { pool } from "@/lib/db";

export const runtime = "nodejs";

const MAX_AGE = 60 * 60 * 24 * 7; // 7 days

// Paylaşılan DASHBOARD_PASSWORD bu fayldan silindi — indi hər girişin sahibi var.
// Köhnə yol qəsdən saxlanılmadı: iki paralel giriş yolu olsaydı, zəif olanı
// güclüsünü mənasız edərdi.

/**
 * Mövcud olmayan istifadəçi üçün də scrypt işlədilir.
 *
 * Əks halda "belə ad yoxdur" cavabı dərhal qayıdardı, parol yoxlanan hal isə
 * ~290 ms çəkərdi — bu fərq istifadəçi adlarını sadalamağa imkan verir.
 */
const DUMMY_HASH =
  "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const username = typeof body?.username === "string" ? body.username.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  const fail = () =>
    NextResponse.json({ ok: false, error: "İstifadəçi adı və ya parol yanlışdır" }, { status: 401 });

  if (!username || !password) return fail();

  const { rows } = await pool.query<{
    id: number;
    password_hash: string;
    active: boolean;
    session_epoch: number;
  }>(
    `SELECT id, password_hash, active, session_epoch
     FROM katibe.dashboard_users WHERE lower(username) = lower($1)`,
    [username],
  );
  const user = rows[0];

  const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  // Söndürülmüş hesab da eyni mesajı alır: "parol düzdür, amma hesabınız
  // bağlıdır" cavabı işləyən parolu təsdiqləyərdi.
  if (!user || !ok || !user.active) {
    console.warn(`[login] uğursuz cəhd: ${username.slice(0, 40)}`);
    return fail();
  }

  await pool.query(`UPDATE katibe.dashboard_users SET last_login_at = now() WHERE id = $1`, [user.id]);

  const token = await createSessionToken(
    process.env.SESSION_SECRET!,
    { userId: user.id, epoch: user.session_epoch },
    MAX_AGE,
  );
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: true, // katibe.online now has real TLS (nginx + certbot) — flipped 2026-08-24
    path: "/",
    maxAge: MAX_AGE,
  });
  return res;
}
