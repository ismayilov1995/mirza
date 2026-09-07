import { redirect } from "next/navigation";
import AppHeader from "@/components/AppHeader";
import WorkSidebar from "@/components/WorkSidebar";
import MediaGrid from "@/components/media/MediaGrid";
import s from "@/components/media/media.module.css";
import { AppShell, Button, FilterChip, Input, Panel, StatCard, StatGrid, TopBar } from "@/components/ui";
import { getSession, mySources } from "@/lib/access";
import { humanSize } from "@/lib/format";
import {
  listMedia,
  mediaChatTitle,
  mediaFacets,
  MEDIA_TIPS,
  TIP_LABEL,
  type MediaTip,
} from "@/lib/media-library";

export const dynamic = "force-dynamic";

/**
 * Fayllar — arxivin qalereyası.
 *
 * Söhbət ekranı "bu yazışmada nə oldu" sualına cavab verir; burada sual
 * tərsinədir: "o şəkli haradasa görmüşdüm". Ona görə fayl əsas obyektdir,
 * söhbət isə süzgəc.
 *
 * SÜZGƏC URL-DƏDİR (docs/rules.md §8) və səhifə server komponentidir: `?tip=`,
 * `?chat=`, `?il=`, `?q=`. Bunun üç faydası var — süzülmüş görünüş linklə
 * göndərilir, geri düyməsi gözlənilən işi görür, və 291 min sətrin süzgəci
 * BAZADA qalır. Brauzerdə süzmək "altmış nəticədən dördü" göstərərdi,
 * halbuki növbəti səhifədə daha qırxı var.
 *
 * İcazə mənbələrdən gəlir (mySources) və hər fayl marşrutunda yenidən
 * yoxlanılır: səhifədən keçmək marşrutdan keçmək demək deyil.
 */
export default async function FilesPage({
  searchParams,
}: {
  searchParams: Promise<{ tip?: string; chat?: string; il?: string; q?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  // Nəzarətçinin öz ekranı var və rol oradan kənara çıxmır.
  if (session.role === "monitor") redirect("/monitor");

  const sp = await searchParams;
  const tip: MediaTip = MEDIA_TIPS.includes(sp.tip as MediaTip) ? (sp.tip as MediaTip) : "hamisi";
  const chatId = intParam(sp.chat);
  const year = intParam(sp.il);
  const q = (sp.q ?? "").slice(0, 120);
  const filtered = tip !== "hamisi" || chatId !== null || year !== null || q.trim() !== "";

  const sources = await mySources();
  const [facets, page, chatName] = await Promise.all([
    mediaFacets(sources),
    listMedia(sources, { tip, chatId, year, q }),
    chatId === null ? Promise.resolve(null) : mediaChatTitle(sources, chatId),
  ]);

  /* Süzgəc dəyişəndə DİGƏRLƏRİ İTMİR (§8): hər link mövcud parametrləri
     götürür və yalnız birini əvəz edir. */
  const hrefWith = (patch: Record<string, string | null>) => {
    const params = new URLSearchParams();
    const base: Record<string, string | null> = {
      tip: tip === "hamisi" ? null : tip,
      chat: chatId === null ? null : String(chatId),
      il: year === null ? null : String(year),
      q: q.trim() === "" ? null : q,
      ...patch,
    };
    for (const [k, v] of Object.entries(base)) if (v !== null && v !== "") params.set(k, v);
    const qs = params.toString();
    return qs ? `/fayllar?${qs}` : "/fayllar";
  };

  const query = new URLSearchParams({
    ...(tip !== "hamisi" ? { tip } : {}),
    ...(chatId !== null ? { chat: String(chatId) } : {}),
    ...(year !== null ? { il: String(year) } : {}),
    ...(q.trim() !== "" ? { q } : {}),
  }).toString();

  const gone = facets.total.gone;
  const have = facets.total.n - gone;

  return (
    <AppShell
      top={<AppHeader section="İş" />}
      sidebar={<WorkSidebar activeHref="/fayllar" />}
      header={
        <TopBar
          title="Fayllar"
          subtitle={`${facets.total.n.toLocaleString("az-AZ")} fayl · ${facets.chatCount.toLocaleString("az-AZ")} söhbət · şəkil, səs, video və sənəd bir yerdə`}
        />
      }
    >
      {/*
        Üç rəqəm, üç izah (§4). "Əlçatmaz" ayrıca kartdır, çünki bu ekranın ən
        çox soruşulan sualı odur: hər fayl açılırmı? Cavab "yox, 47 mini yox" —
        və bunu ekranda demək, boş qutu göstərməkdən yaxşıdır.
      */}
      <StatGrid>
        <StatCard
          label="Açıla bilən fayl"
          value={have.toLocaleString("az-AZ")}
          hint={`${humanSize(facets.total.bytes)} · Spaces-də saxlanılır`}
        />
        <StatCard
          label="Əlçatmaz"
          value={gone.toLocaleString("az-AZ")}
          tone={gone > 0 ? "serious" : "neutral"}
          hint="mesaj var, faylı yoxdur — köçürmə vaxtı WhatsApp onu silmişdi"
        />
        <StatCard
          label="Ən son fayl"
          value={page.items.length > 0 ? new Date(page.items[0].ts * 1000).toLocaleDateString("az-AZ") : "—"}
          hint={facets.years.length > 0 ? `${facets.years[facets.years.length - 1].year}-dən bəri` : "arxiv boşdur"}
        />
      </StatGrid>

      <Panel
        title={chatId !== null && chatName ? `Fayllar — ${chatName}` : "Fayllar"}
        hint={filtered ? "süzgəc qoyulub" : "hamısı, yenidən köhnəyə"}
        pad={false}
        actions={filtered ? <Button size="sm" variant="quiet" href="/fayllar">Süzgəci sıfırla</Button> : undefined}
      >
        <div className={s.filters}>
          <div className={s.chips}>
            <FilterChip href={hrefWith({ tip: null })} active={tip === "hamisi"}>
              Hamısı · {facets.total.n.toLocaleString("az-AZ")}
            </FilterChip>
            {facets.tips
              .filter((f) => f.tip !== "diger")
              .map((f) => (
                <FilterChip
                  key={f.tip}
                  href={hrefWith({ tip: f.tip as string })}
                  active={tip === f.tip}
                  title={`${humanSize(f.bytes)}${f.gone > 0 ? ` · ${f.gone.toLocaleString("az-AZ")} əlçatmaz` : ""}`}
                >
                  {TIP_LABEL[f.tip as MediaTip]} · {f.n.toLocaleString("az-AZ")}
                </FilterChip>
              ))}
          </div>

          {/*
            Söhbət və il seçicisi adi GET formasıdır: client JS olmadan işləyir
            və nəticə yenə URL-də qalır. Seçicidə ən çox fayl daşıyan 300
            söhbət var; qalanına kartın altındakı söhbət adına klikləməklə
            keçilir — 3,977 söhbətin hamısını bir siyahıya yığmaq seçici deyil,
            uzun mətn olardı.
          */}
          <form className={s.form} method="get" action="/fayllar">
            {tip !== "hamisi" && <input type="hidden" name="tip" value={tip} />}
            <Input
              size="sm"
              name="q"
              defaultValue={q}
              placeholder="Başlıqda və ya göndərəndə axtar"
              icon="search"
              aria-label="Fayllarda axtar"
            />
            <select className={s.select} name="chat" defaultValue={chatId === null ? "" : String(chatId)} aria-label="Söhbət">
              <option value="">Bütün söhbətlər</option>
              {chatId !== null && chatName && !facets.chats.some((c) => c.id === chatId) && (
                <option value={String(chatId)}>{chatName}</option>
              )}
              {facets.chats.map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {c.title} · {c.n}
                </option>
              ))}
            </select>
            <select className={s.select} name="il" defaultValue={year === null ? "" : String(year)} aria-label="İl">
              <option value="">Bütün illər</option>
              {facets.years.map((y) => (
                <option key={y.year} value={String(y.year)}>
                  {y.year} · {y.n}
                </option>
              ))}
            </select>
            <Button size="sm" type="submit" icon="funnel">Süz</Button>
          </form>
        </div>

        <MediaGrid
          /* Süzgəc dəyişəndə şəbəkə sıfırdan qurulur — köhnə səhifələr
             yenisinin altında qalmasın. */
          key={query}
          initial={page.items}
          initialNext={page.next}
          query={query}
          filtered={filtered}
        />
      </Panel>
    </AppShell>
  );
}

function intParam(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}
