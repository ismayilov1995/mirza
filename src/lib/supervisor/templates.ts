import { formatDuration } from "../format";
import type { Finding, WindowDigest } from "./types";

// Şablon mətnlər — modelin çağırılmadığı (sakit pəncərə) və ya alınmadığı
// (API xətası) hallar üçün. Tapıntı heç vaxt itmir: model olmasa da post
// sübut rəqəmləri ilə yazılır, sadəcə quru dillə.

export function renderFindingBody(f: Finding): string {
  if (f.detector === "unanswered") {
    const e = f.evidence as {
      waitedSeconds: number;
      targetSeconds: number;
      targetSource: string;
      msgsWaiting: number;
      isClient: boolean;
      chatSummary?: string | null;
    };
    const parts = [
      `${f.contact} ${formatDuration(e.waitedSeconds)} cavab gözləyir` +
        (e.targetSource === "rule"
          ? ` (hədəf: ${formatDuration(e.targetSeconds)})`
          : ` (SLA qaydası yoxdur, ehtiyat hədəf: ${formatDuration(e.targetSeconds)})`),
    ];
    if (e.msgsWaiting >= 2) parts.push(`${e.msgsWaiting} mesaj yazıb`);
    if (e.isClient) parts.push("etiketə görə müştəridir");
    // Mövzu şablonda da görünür. Bu cümlə modelin yazdığı deyil, hal
    // təsnifatının yazdığıdır (chat-state.ts) və artıq bazadadır — yəni
    // model çağırışı alınmayanda da menecer «nə barədə» sualına cavab alır.
    const summary = e.chatSummary?.trim();
    return parts.join(", ") + "." + (summary ? ` ${summary}` : "");
  }

  if (f.detector === "silence") {
    const e = f.evidence as { inbound: number; waitingChats: number; baselineMedian: number };
    return (
      `Bu pəncərədə bir dənə də cavab yazılmayıb — ${e.inbound} mesaj gəlib, ` +
      `${e.waitingChats} söhbət gözləyir. Adi belə vaxtlarda ~${Math.round(e.baselineMedian)} mesaj yazılır.`
    );
  }

  if (f.detector === "customer_deciding") {
    const e = f.evidence as {
      total: number;
      clients: number;
      oldestSeconds: number;
      top: { contact: string; waited: string; isClient: boolean; why?: string | null }[];
    };
    const list = e.top.map((t) => `${t.contact} (${t.waited})`).join(", ");
    return (
      `${e.total} söhbətdə təklif verilib, qərar gözlənilir` +
      (e.clients ? ` — ${e.clients}-i etiketli müştəridir` : "") +
      `. Ən köhnələri: ${list}. Follow-up vaxtıdır.`
    );
  }

  // Tanınmayan detektor (gələcək agentcik) — sübutu olduğu kimi göstər.
  return `${f.title}. ${JSON.stringify(f.evidence)}`;
}

export function renderAllClear(userName: string, digest: WindowDigest, windowHours: number): string {
  const bits = [
    `Son ${Math.round(windowHours)} saatda ${userName} üçün hər şey qaydasındadır — ` +
      `${digest.inbound} gələn, ${digest.outbound} gedən mesaj, ${digest.activeChats} aktiv söhbət.`,
  ];
  if (digest.topContacts.length > 0) {
    const top = digest.topContacts[0];
    bits.push(`Ən çox yazışdığı: ${top.contact} (${top.messages} mesaj).`);
  }
  if (digest.medianReplySeconds !== null) {
    bits.push(`Median cavab sürəti ${formatDuration(digest.medianReplySeconds)}.`);
  }
  return bits.join(" ");
}
