import { Button } from "@/components/ui";
import { refreshInsightsAction } from "./actions";

/**
 * Faktları indi yenilə.
 *
 * Server action-dur, client komponent deyil: bir düymə üçün brauzerə JS
 * göndərmək lazım deyil və bu ekranın qalanı da server komponentdir.
 */
export default function RefreshInsights({ label }: { label: string }) {
  return (
    <form action={refreshInsightsAction}>
      <Button size="sm" icon="refresh-cw" type="submit">
        {label}
      </Button>
    </form>
  );
}
