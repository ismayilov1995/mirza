"use client";

import { useLane } from "./lane-context";
import s from "@/components/ui/ui.module.css";

export interface NavInstance {
  id: string;
  name: string;
  /** Neçə söhbət — mənbənin "böyüklüyü". */
  chats: number;
  /** Cavab bizdə olan söhbətlərin sayı. 0 olanda qırmızı sayğac çıxmır. */
  awaiting: number;
  /** WhatsApp sessiyası diridirmi — yaşıl nöqtə buna baxır. */
  live: boolean;
  /**
   * Sayın yanındakı izah. Verilmirsə qoşulma vəziyyəti yazılır.
   *
   * Arxiv üçün lazımdır: köçürülmüş fayla "qoşulu deyil" yazmaq onu sınıq
   * nömrə kimi göstərir, halbuki o, sadəcə donmuş tarixdir.
   */
  meta?: string;
}

/**
 * Sidebar-dakı nömrə siyahısı.
 *
 * Nəzarətçinin ilk sualı "hansı nömrədə iş var?" olur, ona görə seçici
 * naviqasiyanın içindədir, siyahının başında yox: nömrələr ekranlar arasında
 * dəyişmir, süzgəclər isə dəyişir.
 *
 * Qırmızı sayğac ayrıca düymədir və yalnız cavabsız varsa görünür — «ən yeni
 * cavabsıza keç» əmri. Nömrəni seçmək və ora tullanmaq eyni şey deyil:
 * birincisi siyahını daraldır, ikincisi konkret söhbəti açır.
 */
export default function InstanceNav({
  instances, label = "İnstans",
}: {
  instances: NavInstance[];
  /** Bölmənin başlığı: nəzarətdə "İnstans", arxivdə "Mənbə". */
  label?: string;
}) {
  const api = useLane();
  if (instances.length === 0) return null;

  const total = instances.reduce((n, i) => n + i.awaiting, 0);
  const allChats = instances.reduce((n, i) => n + i.chats, 0);

  const rows: (NavInstance & { all?: boolean })[] = [
    { id: "", name: "Hamısı", chats: allChats, awaiting: total, live: instances.some((i) => i.live), all: true },
    ...instances,
  ];

  return (
    <div className={s.instNav}>
      <div className={s.instHead}>
        <span className={s.navLabel} style={{ padding: 0 }}>{label}</span>
        {/* Cavabsız sayı yoxdursa başlıqda yalan rəqəm göstərmirik. */}
        <span className={s.instTotal}>
          {total > 0 ? `${total} cavabsız` : `${allChats} yazışma`}
        </span>
      </div>
      {rows.map((i) => {
        const id = i.all ? null : i.id;
        const on = (api?.lane ?? null) === id;
        return (
          <div key={i.id || "all"} className={s.instRow}
            data-on={on ? "true" : undefined} data-live={i.live ? "true" : undefined}>
            <button type="button" className={s.instPick}
              aria-current={on ? "true" : undefined}
              onClick={() => api?.setLane(id)}>
              <span className={s.instDot} />
              <span className={s.instText}>
                <span className={s.instName}>{i.name}</span>
                <span className={s.instCount}>
                  {i.chats} yazışma
                  {i.all ? "" : i.meta ? ` · ${i.meta}` : i.live ? " · qoşulu" : " · qoşulu deyil"}
                </span>
              </span>
            </button>
            {i.awaiting > 0 && (
              <button type="button" className={s.instJump}
                title="Ən yeni cavabsız yazışmaya keç"
                aria-label={`${i.name}: ${i.awaiting} cavabsız, ən yenisinə keç`}
                onClick={() => api?.jumpToUnread(id)}>
                {i.awaiting}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
