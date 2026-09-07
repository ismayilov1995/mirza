"use client";

import { createContext, useContext } from "react";

/**
 * Zolaq (instans) seçimi — ChatScreen ilə sidebar arasında.
 *
 * Sidebar səhifədə SERVERDƏ qurulur və ChatScreen-ə prop kimi ötürülür, yəni
 * onun içindəki komponent ChatScreen-in state-ini birbaşa görə bilmir. React
 * konteksti isə elementin harada YARADILDIĞINA görə yox, ağacda harada
 * DURDUĞUNA görə axır: ChatScreen ötürülən sidebar-ı bu provider-lə bürüyür və
 * içindəki instans siyahısı seçimi oxuya bilir.
 *
 * Alternativ zolağı URL-ə çıxarmaq idi. Onda hər nömrə dəyişimi server
 * gedişi olurdu — dörd sətirlik siyahı üçün baha, və söhbət ekranı onsuz da
 * client-dədir.
 */
export interface LaneApi {
  lane: string | null;
  setLane: (id: string | null) => void;
  /** Həmin instansa keç və ən yeni oxunmamış söhbəti aç. */
  jumpToUnread: (id: string | null) => void;
}

export const LaneContext = createContext<LaneApi | null>(null);

export function useLane(): LaneApi | null {
  return useContext(LaneContext);
}
