"use client";

import { useState } from "react";
import { WorkBoard } from "./work-board";
import { RoadmapClient } from "../roadmap/roadmap-client";
import type { WorkTask } from "./actions";
import type { RoadmapTask } from "../roadmap/actions";

// The Work Hub: two altitudes in one page. "Run" = the operational kanban
// (strategy.tasks). "Build" = the roadmap rocks (strategy.roadmap_tasks),
// folded in here so there's one task surface, not two.
export function WorkHub({ workTasks, roadmapTasks, initialView }: {
  workTasks: WorkTask[]; roadmapTasks: RoadmapTask[]; initialView?: string;
}) {
  const [tab, setTab] = useState<"run" | "build">("run");
  return (
    <div>
      <div className="mx-auto max-w-[1400px] px-4 pt-6">
        <div className="inline-flex rounded-lg border border-[#dad4cb] bg-white p-0.5 text-sm">
          <button
            onClick={() => setTab("run")}
            className={`px-4 h-8 rounded-md font-semibold transition-colors ${
              tab === "run" ? "bg-[#11242e] text-white" : "text-[#5a6a72] hover:text-[#11242e]"}`}>
            Run
          </button>
          <button
            onClick={() => setTab("build")}
            className={`px-4 h-8 rounded-md font-semibold transition-colors ${
              tab === "build" ? "bg-[#11242e] text-white" : "text-[#5a6a72] hover:text-[#11242e]"}`}>
            Build (roadmap)
          </button>
        </div>
      </div>
      {tab === "run" ? <WorkBoard initialTasks={workTasks} initialView={initialView} /> : <RoadmapClient initialTasks={roadmapTasks} />}
    </div>
  );
}
