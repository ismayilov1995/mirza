"use server";

import { revalidatePath } from "next/cache";
import { DEFAULT_SUMMARY_MODEL, generateSummary, isSummaryModel } from "@/lib/summary";
import { askAboutChat, DEFAULT_LANG, isLang } from "@/lib/chat-ai";
import { requireInstance } from "@/lib/access";

/**
 * The only path that spends API credit on a summary — analysis never runs
 * from a page view, so opening a chat is always free.
 */
export async function runAnalysis(formData: FormData) {
  const rawInstanceId = String(formData.get("instanceId") ?? "").trim();
  const jid = String(formData.get("jid") ?? "").trim();
  if (!rawInstanceId || !jid) return;
  // Server action HƏR sessiya sahibinin çağıra bildiyi HTTP endpoint-dir və bu
  // action pul xərcləyir — icazə burada, işdən əvvəl yoxlanılır.
  const instanceId = await requireInstance(rawInstanceId);

  const raw = formData.get("model");
  const model = isSummaryModel(raw) ? raw : DEFAULT_SUMMARY_MODEL;

  // Scoped to the caller's own account: the JID of a direct chat belongs to
  // the other party and is shared by everyone who talks to them.
  await generateSummary(instanceId, jid, model);
  revalidatePath(`/i/${instanceId}/chat/${encodeURIComponent(jid)}`);
}

/**
 * One admin question about one conversation. Also the only other path here
 * that spends credit, and likewise never triggered by a page view.
 */
export async function askQuestion(formData: FormData) {
  const rawInstanceId = String(formData.get("instanceId") ?? "").trim();
  const jid = String(formData.get("jid") ?? "").trim();
  const question = String(formData.get("question") ?? "").trim().slice(0, 500);
  if (!rawInstanceId || !jid || !question) return;
  const instanceId = await requireInstance(rawInstanceId);

  const rawLang = formData.get("lang");
  const lang = isLang(rawLang) ? rawLang : DEFAULT_LANG;

  await askAboutChat(instanceId, jid, question, lang);
  revalidatePath(`/i/${instanceId}/chat/${encodeURIComponent(jid)}`);
}
