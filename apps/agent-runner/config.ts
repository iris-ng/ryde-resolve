import { isJudge, type Role } from '../../packages/agent-flow/contracts';
import { agentDefinitions, type AgentDefinition } from './agents/index';

// Each role maps to one CodeBuddy-format agent definition (apps/agent-runner/agents/*.md).
// The file pins the default model, turn budget and thinking budget; environment
// variables override per role for a launcher or deployment. Bounds are enforced.
// The photo role is a server-side call with no agent file (packages/evidence-collection/photo-examiner.ts).
export const agentNameFor = (role: Role) => ({ rider: 'rider-advocate', driver: 'driver-advocate', judge: 'judge', judge_b: 'judge-seat-b', judge_c: 'judge-seat-c', evidence: 'evidence-collector', policy: 'policy-analyst', photo: undefined } as const)[role];
export function agentFor(role: Role): AgentDefinition {
  const name = agentNameFor(role);
  const definition = name ? agentDefinitions[name] : undefined;
  if (!definition) throw new Error('Missing agent definition for ' + role);
  return definition;
}
export const sharedRules = agentDefinitions['_shared-rules']?.prompt ?? '';
export function runtimeConfig(role: Role, env: Record<string, string | undefined> = process.env) {
  const judge = isJudge(role), agent = agentFor(role);
  const modelVar = { rider: 'RYDE_ADVOCATE_MODEL', driver: 'RYDE_ADVOCATE_MODEL', judge: 'RYDE_JUDGE_MODEL', judge_b: 'RYDE_JUDGE_B_MODEL', judge_c: 'RYDE_JUDGE_C_MODEL', evidence: 'RYDE_EVIDENCE_MODEL', policy: 'RYDE_POLICY_MODEL', photo: 'RYDE_PHOTO_MODEL' }[role];
  const model = env[modelVar] ?? env.RYDE_CODEBUDDY_MODEL ?? agent.model;
  if (!model) throw new Error('No model: set it in the agent definition or the environment');
  const turns = Number(env[judge ? 'RYDE_JUDGE_MAX_TURNS' : 'RYDE_ADVOCATE_MAX_TURNS'] ?? agent.maxTurns ?? (judge ? 12 : 10));
  const thinkingTokens = Number(env[judge ? 'RYDE_JUDGE_THINKING_TOKENS' : 'RYDE_ADVOCATE_THINKING_TOKENS'] ?? agent.thinkingTokens ?? (judge ? 4096 : 2048));
  if (!Number.isInteger(turns) || turns < 2 || turns > 16 || !Number.isInteger(thinkingTokens) || thinkingTokens < 1024 || thinkingTokens > 8192) throw new Error('Runtime settings outside bounded limits');
  // Advocates get four turns past their stated budget (5 October 2026): 2 of about 29 live runs failed when an advocate
  // spent all 12 turns reading and never submitted. The prompt still states maxTurns, so a session that keeps to it sees
  // and does exactly what it did before; only one that overruns uses the grace. The harness stops at harnessMaxTurns.
  const graceTurns = role === 'rider' || role === 'driver' ? 4 : 0;
  const thinking = { type: 'enabled' as const, budget_tokens: thinkingTokens };
  return { model, maxTurns: turns, graceTurns, harnessMaxTurns: turns + graceTurns, thinking, maxThinkingTokens: thinkingTokens, effort: (agent.effort ?? 'medium') as 'low' | 'medium' | 'high', agentName: agent.name, agentFile: agent.file, agentSha256: agent.sha256, modelSource: env[modelVar] ?? env.RYDE_CODEBUDDY_MODEL ? 'environment' : 'agent definition' };
}
