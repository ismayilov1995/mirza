import { redirect } from "next/navigation";

/**
 * Köhnə daimi keçid: /arxiv/<id> → /arxiv?chat=<id>.
 *
 * Söhbət artıq ayrıca səhifə deyil, arxiv ekranının içindədir. Bu marşrut
 * saxlanılır, çünki ona verilən linklər var — MCP cavablarında, köhnə
 * yazışmalarda, kiminsə əlfəcinində. Sınmış link ilə əvəzlənmiş link
 * arasındakı fərq ucuzdur.
 */
export default async function ArchiveChatRedirect({
  params,
}: {
  params: Promise<{ chatId: string }>;
}) {
  const { chatId } = await params;
  redirect(/^\d+$/.test(chatId) ? `/arxiv?chat=${chatId}` : "/arxiv");
}
