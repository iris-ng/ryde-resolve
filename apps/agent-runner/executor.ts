import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import type { Executor, Role } from "../../packages/agent-flow/contracts";
import { routeFor, type Route } from "./role";
import { answerOutsideRequest } from "./outside-bridge";
import { answerSemanticRequest } from "./semantic-bridge";

const credentials:Record<Route,Set<string>>={
  codebuddy:new Set(['RYDE_CODEBUDDY_RUNTIME_TOKEN','RYDE_CODEBUDDY_AUTH_METHOD','RYDE_CODEBUDDY_ACCOUNT_UID','RYDE_CODEBUDDY_ID_SOURCE']),
  gateway:new Set(['RYDE_MODEL_GATEWAY_URL','RYDE_MODEL_GATEWAY_SECRET','RYDE_GATEWAY_ROLES']),
};
// A role child gets only its own route's credentials: a gateway role never sees the CodeBuddy token (so it
// cannot fall back to hosted CodeBuddy) and a CodeBuddy role never sees the gateway secret.
export function roleEnv(role:Role,home:string,source:Record<string,string|undefined>=process.env):NodeJS.ProcessEnv{
  const route=routeFor(role,source),other=credentials[route==='gateway'?'codebuddy':'gateway'];
  const env:NodeJS.ProcessEnv={PATH:'/usr/local/bin:/usr/bin:/bin',HOME:home,TMPDIR:home,XDG_CONFIG_HOME:home,XDG_CACHE_HOME:home,NODE_ENV:'production'};
  for(const name of ['RYDE_CODEBUDDY_ENTRY','RYDE_CODEBUDDY_RUNTIME_TOKEN','RYDE_MODEL_GATEWAY_URL','RYDE_MODEL_GATEWAY_SECRET','RYDE_GATEWAY_ROLES','RYDE_CODEBUDDY_MODEL','RYDE_CODEBUDDY_AUTH_METHOD','RYDE_CODEBUDDY_ACCOUNT_UID','RYDE_CODEBUDDY_ID_SOURCE','RYDE_ADVOCATE_MODEL','RYDE_JUDGE_MODEL','RYDE_JUDGE_B_MODEL','RYDE_JUDGE_C_MODEL','RYDE_EVIDENCE_MODEL','RYDE_POLICY_MODEL','RYDE_PRE_AGENTS','RYDE_USE_AGENT_DEFINITIONS','RYDE_SAFETY_CLEARED','RYDE_EXTERNAL_LIVE','RYDE_POSTURE','RYDE_ADVOCATE_MAX_TURNS','RYDE_JUDGE_MAX_TURNS','RYDE_ADVOCATE_THINKING_TOKENS','RYDE_JUDGE_THINKING_TOKENS'])if(source[name]&&!other.has(name))env[name]=source[name];
  return env;
}
/** How long a role child may take to close its harness and exit by itself after it has delivered its result, before its process group is killed. */
export const childCleanupMs=15000;
const delay=(ms:number)=>new Promise<void>(done=>setTimeout(done,ms));
const cleanups=new Set<Promise<void>>();
/** Resolves when every role child started so far has been reaped and its home removed. For tests and an orderly shutdown. */
export const roleCleanups=()=>Promise.all([...cleanups]).then(()=>{});
// The result message is the success boundary. The child validates its
// artifact, sends it, then closes the harness and its tool server; those closes have no deadline of their own. Waiting for
// the child to exit let a task deadline discard an artifact the parent already held. So: the returned promise settles the
// moment a result (or a failure) is known; cleanup runs separately, is idempotent and never rejects; the child is its own
// process group, and what is still alive after the cleanup bound is killed as a group, so no descendant of the harness
// outlives its task; activity forwarding stops at delivery, so cleanup cannot add task events. The worker revalidates the artifact.
export const createRoleExecutor=(self:string,cleanupMs=childCleanupMs):Executor=>async(task,emit,signal)=>{
  const home=await mkdtemp('/tmp/ryde-role-');
  // Cancelled while the home was being created: never start a child that no drain would wait for.
  if(signal.aborted){await Promise.race([rm(home,{recursive:true,force:true}).catch(()=>{}),delay(5000)]);emit({kind:'role_failed',message:'Agent cancelled'});throw new Error('Agent cancelled');}
  const env=roleEnv(task.role,home);
  let child:ChildProcess|undefined,exited=false,delivered=false,cleaning:Promise<void>|undefined,markExit=()=>{};
  const exit=new Promise<void>(done=>{markExit=done;});
  // The child leads its own process group (detached), so a group signal reaches every descendant. `sweep` signals the group even after the leader has exited.
  const killTree=(sig:NodeJS.Signals,sweep=false)=>{const pid=child?.pid;if(!pid||(exited&&!sweep))return;try{process.kill(-pid,sig);}catch{if(!exited)try{child!.kill(sig);}catch{/* already gone */}}};
  const cleanup=()=>cleaning??=(async()=>{
    try{
      if(child?.pid&&!exited){await Promise.race([exit,delay(cleanupMs)]);if(!exited){killTree('SIGKILL');await Promise.race([exit,delay(2000)]);}}
      if(child?.pid)killTree('SIGKILL',true); // the leader is gone (or just killed): sweep any descendant left in its group
    }catch{/* cleanup never fails a task */}
    // The removal is bounded too: a stuck filesystem must not hold up the phase drain.
    await Promise.race([rm(home,{recursive:true,force:true}).catch(()=>{}),delay(5000)]);
  })();
  return new Promise((resolve,reject)=>{
    let result:unknown;let failure:string|undefined;let kill:NodeJS.Timeout|undefined;let settled=false;let outsideAsked=0,semanticAsked=0;const outsideStop=new AbortController();
    // Settling also stops any outside lookup still running for this task, so no request or paid picture reading outlives it.
    const settle=(finish:()=>void)=>{if(settled)return;settled=true;outsideStop.abort();signal.removeEventListener('abort',abort);finish();const c=cleanup();cleanups.add(c);void c.finally(()=>cleanups.delete(c));};
    // A cancellation settles at once and registers the bounded cleanup, so a cancelled child is always tracked by roleCleanups()
    // and the worker never moves on to another run while it is still alive. A delivered result is not affected.
    const abort=()=>{if(delivered||settled)return;if(!exited){killTree('SIGTERM');kill??=setTimeout(()=>killTree('SIGKILL'),1500);}emit({kind:'role_failed',message:'Agent cancelled'});settle(()=>reject(new Error('Agent cancelled')));};
    try{child=fork(self,['--role-child'],{cwd:home,env,execArgv:[],stdio:['ignore','ignore','ignore','ipc'],detached:true});}
    catch{emit({kind:'role_failed',message:'Runner child could not start'});settle(()=>reject(new Error('Runner child could not start')));return;}
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    child.on('message',(message:any)=>{
      if(delivered||settled)return; // frozen once the task is settled: nothing the child says during cleanup is task activity
      if(message?.type==='activity')emit(message.event);
      if(message?.type==='result'){result=message.artifact;if(result&&!failure&&!signal.aborted){delivered=true;settle(()=>resolve(result as any));}}
      // A failure the child reports is known now: settle here rather than waiting for a child whose cleanup may hang.
      if(message?.type==='error'){failure=String(message.message??'Role child failed');emit({kind:'role_failed',message:failure});settle(()=>reject(new Error(failure)));}
      // Outside lookups (owner, 11 October 2026): the worker makes the call with its own keys (outside-bridge.ts); no child ever holds one.
      if(message?.type==='outside_lookup'){outsideAsked++;void answerOutsideRequest(task,message,outsideAsked,{fetch,env:process.env,signal:outsideStop.signal}).then(reply=>{if(reply&&!settled&&child?.connected)child.send(reply);});}
      // Semantic search (11 October 2026): the worker embeds and reranks with its own Voyage key (semantic-bridge.ts); the same stop signal ends it with the task.
      if(message?.type==='semantic_search'){semanticAsked++;void answerSemanticRequest(task,message,semanticAsked,{fetch,env:process.env,signal:outsideStop.signal}).then(reply=>{if(reply&&!settled&&child?.connected)child.send(reply);});}
    });
    // A spawn failure can raise `error` with no `exit`: fail the task here instead of leaving it pending.
    child.on('error',()=>{failure??='Runner child could not start';if(!child?.pid){exited=true;markExit();}if(!delivered&&!settled){emit({kind:'role_failed',message:failure});settle(()=>reject(new Error(failure)));}});
    child.on('exit',(code,sig)=>{exited=true;markExit();if(kill)clearTimeout(kill);if(delivered||settled)return;
      if(code!==0||failure||!result||signal.aborted){const why=failure??(signal.aborted?'Agent cancelled':!result?`Agent exited (code ${code}, signal ${sig}) without a result message`:`Agent exited with code ${code}`);emit({kind:'role_failed',message:why});settle(()=>reject(new Error(why)));}
      else settle(()=>resolve(result as any));});
    child.send(task);
  });
};
