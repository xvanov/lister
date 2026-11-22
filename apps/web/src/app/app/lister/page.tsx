import { ListerConsole } from "@/components/lister-console";
import { requireSession } from "@/lib/session";

export default async function ListerPage() {
  await requireSession();
  return <ListerConsole />;
}
