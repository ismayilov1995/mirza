"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui";

/**
 * «Yoxlamanı indi işlət» düyməsi.
 *
 * Ayrıca client komponentdir, çünki `useFormStatus()` yalnız formanın İÇİNDƏ
 * işləyir, SupervisorRunBar isə server komponentidir.
 *
 * Ortaq SubmitButton işlədilmədi: o, köhnə dashboard.module.css siniflərinə
 * bağlıdır və onu dizayn sisteminə keçirmək bütün admin səhifələrinin
 * görünüşünü dəyişərdi — istənilməyən yerdə istənilməyən risk.
 */
export default function RunSupervisorButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" icon="refresh-cw" loading={pending}>
      {pending ? "Başladılır…" : "Yoxlamanı indi işlət"}
    </Button>
  );
}
