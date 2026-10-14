import { z } from 'zod';
import { schemaFor, type Task } from '../../packages/agent-flow/contracts';

export function submissionTool(task:Task){
  const artifactSchema=schemaFor(task);
  const schema=z.object({caseId:z.string(),artifactJson:z.string().max(45000)}).strict();
  return {
    artifactSchema,shape:schema.shape,
    // The one form for this step: its exact top-level fields, so an agent cannot borrow another step's fields.
    // The citation sentence answers the most common rejection.
    description:`Submit the ${task.phase} artifact as a JSON string in artifactJson. Top-level fields: ${artifactSchema instanceof z.ZodObject?Object.keys(artifactSchema.shape).join(', '):'see the schema'}. No other fields. Each citation names a sourceId exactly as list_evidence gives it and lines inside that source that you read in this task; cite a policy as policy/public/<ruleId>.json by the card's own line numbers, never by the archived page lines in its sources. Submission is immutable.`,
    convert(input:unknown){
      const args=schema.parse(input);
      return {caseId:args.caseId,artifact:JSON.parse(args.artifactJson)};
    },
  };
}
