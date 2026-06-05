import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/auth/allowlist";
import { listWorkTasksAction } from "./actions";
import { WorkBoard } from "./work-board";

export const dynamic = "force-dynamic";

export default async function WorkPage() {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user || !isAdmin(userData.user.email)) {
    redirect("/login?from=/admin/work");
  }

  const result = await listWorkTasksAction();
  if (!result.ok) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="text-2xl font-bold mb-4">Work</h1>
        <p className="text-red-600">Failed to load: {result.error}</p>
      </main>
    );
  }

  return <WorkBoard initialTasks={result.tasks} />;
}
