"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Səhifəni verilən aralıqla yeniləyir — yalnız gözlənilən bir iş gedəndə.
 *
 * LiveUpdates yalnız WhatsApp hadisəsi gələndə oyanır; nəzarətçi gedişatı isə
 * bazada bitir, heç bir mesaj gəlmədən. Bu olmasa adam 1-2 dəqiqə boyu özü
 * F5 basmalı olur — düymənin bütün mənası da elə o gözləməni görünən etmək
 * idi.
 */
export default function AutoRefresh({ intervalMs }: { intervalMs: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs]);
  return null;
}
