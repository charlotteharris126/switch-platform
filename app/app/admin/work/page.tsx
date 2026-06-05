import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/auth/allowlist";
import { listWorkTasksAction } from "./actions";
import { listRoadmapAction } from "../roadmap/actions";
import { WorkHub } from "./work-hub";

export const dynamic = "force-dynamic";

export default async function WorkPage() {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user || !isAdmin(userData.user.email)) {
    redirect("/login?from=/admin/work");
  }

  const [workResult, roadmapResult] = await Promise.all([
    listWorkTasksAction(),
    listRoadmapAction(),
  ]);

  if (!workResult.ok) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="text-2xl font-bold mb-4">Work</h1>
        <p className="text-red-600">Failed to load: {workResult.error}</p>
      </main>
    );
  }

  return (
    <WorkHub
      workTasks={workResult.tasks}
      roadmapTasks={roadmapResult.ok ? roadmapResult.tasks : []}
    />
  );
}
