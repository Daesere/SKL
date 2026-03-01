import { z } from "zod";

export const TaskAssignmentSchema = z.object({
  agent_id: z.string(),
  semantic_scope: z.string(),
  file_scope: z.string().optional(),
  task_description: z.string(),
  assignment_rationale: z.string(),
});
export type TaskAssignment = z.infer<typeof TaskAssignmentSchema>;
