import { askWorker } from './outside-bridge';
import { askSemantic } from './semantic-bridge';
import { pathToFileURL } from 'node:url';
import { failureCategory } from '../../packages/agent-flow/failure';
import { roles, type Role, type Task } from '../../packages/agent-flow/contracts';
import { composeRoleSession, toolHandler } from './prompt';

// Structural boundary: CodeBuddy is installed only on the VPS and loaded there.
type Harness = {
  start(options:unknown):Promise<{stop():Promise<void>}>;
  tool(name:string,description:string,shape:Record<string,unknown>,handler:(args:any)=>Promise<unknown>):unknown;
  partitionToolsOption(tools:unknown[]):{whitelist:string[]};
  query(id:string,prompt:string,options:unknown):Promise<{stopReason:string;errorMessage?:string}>;
  interrupt(id:string):Promise<void>;close(id:string):Promise<void>;
  subscribe(id:string,listener:(event:any)=>void):()=>void;
};
// A submission the case tool accepted has already passed the full validator, so it stands whatever stopped the
// harness afterwards: a submit on the last allowed turn ends with a turn-limit stop, not 'completed'.
/** A harness query that throws after the submit tool accepted a submission still counts: the accepted artifact is delivered. With nothing accepted, the error stands. */
export async function queryOrAccepted<T extends {stopReason:string;errorMessage?:string}>(run:()=>Promise<T>,submitted:()=>unknown):Promise<T|{stopReason:string;errorMessage:string}> {
  try{return await run();}catch(error){if(!submitted())throw error;return {stopReason:'error_after_accepted_submission',errorMessage:error instanceof Error?error.message:String(error)};}
}
/**
 * A fixed label for the harness's error, for the event trail a reviewer sees: run f631ba3c lost seat B to "429 Credits
 * exhausted" and the trail showed nothing a person could act on. Never any of the error text itself, which can quote the
 * prompt, the case or a credential.
 */
export function errorDetail(message:unknown):string {
  const text=String(message instanceof Error?message.message:message??'');
  if(!text.trim()||text==='No valid completed submission')return '';
  const status=text.match(/\b([45]\d\d)\b/)?.[1];
  return failureCategory(text)+(status?`, status ${status}`:'');
}
export function roleOutcome(result:{stopReason:string;errorMessage?:string},submitted:unknown):{ok:true}|{ok:false;category:string} {
  if(submitted)return {ok:true};
  const message=result.errorMessage??'';
  return {ok:false,category:/auth|401|403|login|token/i.test(message)?'authentication':/model/i.test(message)?'model configuration':/turn/i.test(message)?'turn limit':/tool/i.test(message)?'tool compatibility':'incomplete submission'};
}
const builtinDeny=['Bash','Read','Write','Edit','Glob','Grep','WebFetch','WebSearch','Agent','Task','Workflow','AskUserQuestion'];
// Where each role's model calls go. CodeBuddy route: the dedicated CodeBuddy runtime token and CodeBuddy's
// hosted models. Gateway route (RYDE_MODEL_GATEWAY_URL): CodeBuddy stays the harness but its model calls go
// to our own gateway (apps/model-gateway), which holds the OpenAI key; the gateway secret takes the token's
// seat and no CodeBuddy login is used. RYDE_GATEWAY_ROLES picks the roles that take the gateway route
// (for example "judge" to split spend); unset or empty with a gateway URL means every role.
export type Route='gateway'|'codebuddy';
export function routeFor(role:Role,env:Record<string,string|undefined>=process.env):Route {
  if(!env.RYDE_MODEL_GATEWAY_URL)return 'codebuddy';
  const listed=(env.RYDE_GATEWAY_ROLES??'').split(',').map(name=>name.trim()).filter(Boolean);
  for(const name of listed)if(!(roles as readonly string[]).includes(name))throw new Error(`Unknown role in RYDE_GATEWAY_ROLES: ${name.slice(0,40)}`);
  return !listed.length||listed.includes(role)?'gateway':'codebuddy';
}
export function harnessIdentity(role:Role,env:Record<string,string|undefined>=process.env) {
  if(routeFor(role,env)==='gateway'){
    const gateway=env.RYDE_MODEL_GATEWAY_URL!,secret=env.RYDE_MODEL_GATEWAY_SECRET??'';
    if(!/^https?:\/\/[^\s]+$/.test(gateway)||secret.length<32)throw new Error('Gateway route needs RYDE_MODEL_GATEWAY_URL and a RYDE_MODEL_GATEWAY_SECRET of at least 32 characters');
    return {mode:'gateway' as const,gateway,auth:{accessToken:secret,method:'api_key'}};
  }
  const token=env.RYDE_CODEBUDDY_RUNTIME_TOKEN;
  if(!token)throw new Error(`Explicit runtime credential required for ${role}: RYDE_CODEBUDDY_RUNTIME_TOKEN, or route it through the model gateway`);
  return {mode:'codebuddy' as const,auth:{accessToken:token,method:env.RYDE_CODEBUDDY_AUTH_METHOD??'api_key'},
    ...(env.RYDE_CODEBUDDY_ACCOUNT_UID?{account:{uid:env.RYDE_CODEBUDDY_ACCOUNT_UID,idSource:env.RYDE_CODEBUDDY_ID_SOURCE}}:{})};
}
// Startup check for a worker or runner: every role has the credentials its route needs.
export function harnessRouting(env:Record<string,string|undefined>=process.env) {
  const routing:Record<Route,Role[]>={gateway:[],codebuddy:[]};
  // The photo examiner is a direct gateway call, not a CodeBuddy session.
  for(const role of roles.filter(r=>r!=='photo')){harnessIdentity(role,env);routing[routeFor(role,env)].push(role);}
  return routing;
}
export async function loadHarness(identity?:ReturnType<typeof harnessIdentity>):Promise<Harness> {
  const entry=process.env.RYDE_CODEBUDDY_ENTRY;
  if(!entry?.startsWith('/') || !entry.endsWith('/server.mjs'))throw new Error('Explicit VPS CodeBuddy server entry required');
  if(identity?.mode==='gateway'){
    // Read by the harness when it loads, so set before import (each role runs in its own process). Telemetry
    // and remote config off: a 2026-09-30 probe of 2.155.0 in this mode made no connection but the gateway.
    process.env.CODEBUDDY_BASE_URL=identity.gateway;process.env.DISABLE_TELEMETRY='1';process.env.CODEBUDDY_REMOTE_CONFIG_DISABLED='1';
  }
  return import(pathToFileURL(entry).href);
}
export async function roleChild(task:Task) {
  const send=(data:unknown)=>process.send?.(data);
  const emit=(event:{kind:string;message:string;data?:unknown})=>send({type:'activity',event});
  let harness:Harness|undefined; let server:Awaited<ReturnType<Harness['start']>>|undefined;
  // Outside lookups go to the worker, which holds the keys (outside-bridge.ts); this process never has one.
  const lookupOutside=askWorker(send,handler=>process.on('message',handler));
  // So does the semantic search: the worker embeds the case and ranks the rulings; this process never sees the Voyage key.
  const semanticSearch=askSemantic(send,handler=>process.on('message',handler));
  const session=composeRoleSession(task,emit,{lookupOutside,semanticSearch});
  const {tools,config,agent}=session;
  try {
    const identity=harnessIdentity(task.role);const {auth}=identity;
    harness=await loadHarness(identity);server=await harness.start({settingSources:[],projectKey:'ryde-isolated-runtime'});
    const definitions=session.toolSpecs.map(spec=>harness!.tool(spec.name,spec.description,spec.shape,toolHandler(tools,spec,emit)));
    const names=new Set(tools.names);
    emit(session.configured);
    // No model text or hidden reasoning is forwarded to the app. Custom tools emit bounded domain events.
    const reportedModels=new Set<string>();let settled=false;
    const unsubscribe=harness.subscribe(task.sessionId,event=>{
      const model=event?.model??event?.message?.model;
      if(typeof model==='string'&&!reportedModels.has(model)){reportedModels.add(model);emit({kind:'model_reported',message:'Harness reported model',data:{model,sessionId:task.sessionId}});}
      if(event?.type==='result')settled=true;
      if(event?.type==='result'&&event.usage){const usage=Object.fromEntries(Object.entries(event.usage).filter(([k,v])=>['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens'].includes(k)&&typeof v==='number'));if(Object.keys(usage).length)emit({kind:'usage_reported',message:'Harness usage report',data:usage});}
      if(event?.type==='system' && event?.subtype==='init')emit({kind:'session_started',message:'CodeBuddy session initialized'});
    });
    const abort=new AbortController();
    const stop=()=>{tools.close();abort.abort();void harness?.interrupt(task.sessionId).catch(()=>{});};
    process.on('SIGTERM',stop);
    const result=await queryOrAccepted(()=>harness!.query(task.sessionId,session.prompt,{
      cwd:process.cwd(),systemPrompt:session.system,tools:definitions,allowedTools:tools.names,disallowedTools:builtinDeny,
      ...(process.env.RYDE_USE_AGENT_DEFINITIONS==='1'?{agent:config.agentName,agents:{[config.agentName]:{description:agent.description,prompt:session.system,tools:tools.names,disallowedTools:builtinDeny,model:config.model}}}:{}),
      model:config.model,maxTurns:config.harnessMaxTurns,thinking:config.thinking,maxThinkingTokens:config.maxThinkingTokens,effort:config.effort,permissionMode:'default',abortController:abort,
      remoteAgentsUrl:'',auth,...('account' in identity?{account:identity.account}:{}),
      canUseTool:async(name:string,input:unknown)=>{
        const normalized=name.startsWith('mcp__custom_tools__')?name.slice('mcp__custom_tools__'.length):name;
        if(names.has(normalized))return {behavior:'allow',updatedInput:input};
        emit({kind:'tool_denied',message:'Harness rejected a non-case tool'});
        return {behavior:'deny',message:'Only case tools are available'};
      },
    }),()=>tools.result());
    // Through the model gateway the final result event (with usage) can land just after query settles.
    for(let waited=0;!settled&&waited<500;waited+=50)await new Promise(resolve=>setTimeout(resolve,50));
    unsubscribe();tools.close();
    const outcome=roleOutcome(result,tools.result());
    if(!outcome.ok){const detail=errorDetail(result.errorMessage);emit({kind:'role_failed',message:`Harness stopped: ${outcome.category}${detail?` (${detail})`:''}`});throw new Error('No valid completed submission');}
    await new Promise<void>(resolve=>{if(!process.send)return resolve();process.send({type:'result',artifact:tools.result()},undefined,undefined,()=>resolve());});
  } catch (error) { const detail=errorDetail(error); send({type:'error',message:'CodeBuddy role did not produce a valid submission; check dedicated runtime authentication, model and tool compatibility.'+(detail?` Cause: ${detail}.`:'')}); }
  finally {tools.close();if(harness)await harness.close(task.sessionId).catch(()=>{});if(server)await server.stop().catch(()=>{});await new Promise(resolve=>setTimeout(resolve,50));process.disconnect?.();}
}
