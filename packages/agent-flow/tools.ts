import { z } from 'zod';
import { evidenceTimeline } from '../live-fishbowl/evidence';
import { deriveFacts } from './facts';
import { artifactId, citationsFor, hasLookups, hasOutsideLookups, hasRecordRequests, isJudge, maxOutsideCalls, outsideSourceKinds, validateArtifact, type Activity, type Artifact, type OutsideCall, type Task } from './contracts';
import { placeNames, windowNames } from '../outside-data/places';
import { outsideLookup, type LookupOutside } from '../outside-data/lookup';
import { missingOutsideCalls, needText } from '../outside-data/records';
import { isDatasetPacket } from '../case-packet/dataset';
import { conflictsFor } from '../policy/ruleset';
import { bindingStatuses, precedentNotice, readPrecedent, runLibrary } from '../policy/precedents';
import { caseFeatures, retrievalLimits, searchPrecedents, searchRules, type PrecedentHit } from '../policy/retrieval';
import { defaultEmbeddingDimension, defaultEmbeddingModel, defaultRerankModel, factsOnly, noLiveRunReason, semanticNotice, similarOnlyWeight, type SemanticOutcome, type SemanticResult, type SemanticSearch } from '../policy/semantic';
import { precedentHidden } from '../policy/evaluation';
import { collectExternal } from '../live-fishbowl/external';
import { readCheckRejection, TrustedRejection } from './citations';
import { ClaimCheckError, claimRejection } from './claim-checks';
import { lookupTools, maxRecordRequests, recordAnswer, requestArgs, runLookup, sealedText, shownLookupArgs, type LookupTool } from './lookups';

const readSchema = z.object({ caseId:z.string(), sourceId:z.string(), startLine:z.number().int().positive().optional(), endLine:z.number().int().positive().optional() }).strict();
const searchArgs=z.object({caseId:z.string(),query:z.string().max(300).optional(),category:z.string().max(40).optional()}).strict();
const offSetting={model:defaultEmbeddingModel,dimension:defaultEmbeddingDimension,reranker:defaultRerankModel};
/**
 * The semantic block joins the fact-matched list (11 October 2026): every binding hit first, unchanged; then the rulings the embedding
 * search found, best rerank first, each with its similarity and the similar-only weight; then the rest of the fact-ranked list. A hit
 * found by meaning that also binds keeps its binding weight. Binding itself is never read from here.
 */
export function mergeSemantic(shown:PrecedentHit[],all:PrecedentHit[],semantic:SemanticResult):PrecedentHit[]{
  const sim=new Map(semantic.hits.map(h=>[h.precedentId,h]));
  const withSim=(h:PrecedentHit):PrecedentHit=>{const s=sim.get(h.precedentId);return s?{...h,similarity:{cosine:s.cosine,rerank:s.rerank,rank:s.rank},weight:h.binding?h.weight:similarOnlyWeight+(h.weight.includes('decided under different rules')?'; decided under different rules':'')}:h;};
  const binding=shown.filter(h=>h.binding).map(withSim);
  const found=semantic.hits.map(s=>all.find(h=>h.precedentId===s.precedentId)).filter((h):h is PrecedentHit=>!!h&&!h.binding).map(withSim);
  return [...binding,...found,...shown.filter(h=>!h.binding&&!sim.has(h.precedentId))];
}
export function createCaseTools(task: Task, emit: (event: Activity) => void, options: { lookupOutside?: LookupOutside; semanticSearch?: SemanticSearch } = {}) {
  // Outside lookups (AD-11): in a live run the worker passes the bridge (apps/agent-runner/outside-bridge.ts), so the keys stay in the
  // worker; anywhere else (tests, local runs) the default looks up with no keys at all, so only keyless sources answer.
  // Closing the tools stops a default lookup still running (the worker stops bridged ones when the task settles).
  const stopOutside = new AbortController();
  const lookupOutside: LookupOutside = options.lookupOutside ?? ((args, n, requestId) => outsideLookup(task.packet, args, { fetch, env: {}, n, requestId, signal: stopOutside.signal }));
  let submitted: Artifact | undefined; let closed = false; let calls = 0;
  const dataset = isDatasetPacket(task.packet);
  // Evidence checks 2 (MVP fixes F2 and F3, second release): an advocate's record lookups and record requests (lookups.ts).
  const lookups=hasLookups(task), requests=hasRecordRequests(task);
  const names = ['list_evidence','read_evidence','read_policy','submit_artifact',...(task.protocolVersion===2?['read_calculations']:[]), ...(task.packet.policyReference ? ['read_timeline','read_policy_reference'] : []), ...(dataset ? ['read_timeline','list_conflicts'] : []), ...(dataset && task.phase==='collect' ? [hasOutsideLookups(task.packet) ? 'outside_lookup' : 'fetch_external'] : []), ...(dataset && task.phase!=='collect' ? ['search_rules'] : []), ...(dataset && (task.phase==='apply'||task.phase==='decide') ? ['search_precedents','read_precedent'] : []), ...(lookups ? lookupTools : []), ...(requests ? ['request_record'] : [])];
  const readLines=new Map<string,Set<number>>(), readPolicies=new Set<string>();let calculationsRead=false;
  // The lookup trail (tool, time, structured arguments, lines returned; a request's answer), attached to the submission as the server
  // field `lookups` and so disclosed with the argument, free text included. Until then the event trail shows that text sealed.
  const trail:NonNullable<Artifact['lookups']>=[];
  const markRead=(ranges:{sourceId:string;startLine:number;endLine:number}[])=>{for(const r of ranges){const coverage=readLines.get(r.sourceId)??new Set<number>();for(let i=r.startLine;i<=r.endLine;i++)coverage.add(i);readLines.set(r.sourceId,coverage);}};
  // Recomputed when an outside record joins the packet, so read_calculations matches what later roles get.
  let facts=deriveFacts(task.packet);
  let callNumber=0,currentCallId='';
  // Semantic search (11 October 2026): in a live run callAsync asks the worker before the fact search runs and leaves the answer here; the
  // sync path (tests, the local runner) is facts only and says so. The event records every live attempt, facts only included.
  let pendingSemantic:SemanticOutcome|undefined;
  const knownIds={sourceId:new Set(task.packet.sources.map(s=>s.id)),ruleId:new Set(task.packet.policies.map(p=>p.rule_id)),cardId:new Set((task.packet.policyReference?.cards??[]).map(c=>c.id)),precedentId:new Set(runLibrary(task.packet).map((p:{precedent_id?:string;id?:string})=>p.precedent_id??p.id??''))};
  // Before the paired disclosure a tool call's own events carry only trusted text,
  // for every tool (citations.ts, rule 1). The input is shown field by field: a pinned ID, a whole line number, a structured lookup
  // argument; free text sealed; any other field counted, never named. A non-object input is a fixed label and a locator keeps pinned IDs
  // and whole line numbers only. An error's message is logged only when it is a TrustedRejection (built never to repeat model text);
  // any other error, a schema issue or an older check that may quote a model value, is a fixed line. The model still reads it in full.
  const safe=(k:string,v:unknown)=>!Object.prototype.hasOwnProperty.call(knownIds,k)?v:typeof v==='string'&&knownIds[k as keyof typeof knownIds].has(v)?v:'(not a pinned ID)';
  const lineNumber=(v:unknown)=>Number.isInteger(v)&&(v as number)>0;
  const freeText=['query','category'],structured=['caseId','sourceId','ruleId','cardId','precedentId','startLine','endLine','offset',...freeText];
  const shownArgs=(name:string,args:Record<string,unknown>)=>{
    if((lookupTools as readonly string[]).includes(name)||name==='request_record')return shownLookupArgs(task.packet,args);
    const other=Object.keys(args).filter(k=>!structured.includes(k)).length;
    return {...Object.fromEntries(Object.entries(args).filter(([k])=>structured.includes(k)).map(([k,v])=>[k,k==='caseId'?(v===task.caseId?v:'(not this case)'):freeText.includes(k)?sealedText:k==='startLine'||k==='endLine'||k==='offset'?(Number.isInteger(v)&&(v as number)>=0?v:'(not a whole number)'):safe(k,v)])),...(other?{otherFields:other}:{})};
  };
  const loggedError=(error:unknown)=>error instanceof TrustedRejection?error.message:error instanceof z.ZodError?'Invalid tool arguments; the agent was told what to change.':'Rejected by the server\'s checks; the agent was told what to change.';
  function tracked(name:string,input:unknown):unknown {
    const callId=task.sessionId+':'+(++callNumber),label=names.includes(name)?name:'(not a tool)';currentCallId=callId;
    const object=!!input&&typeof input==='object'&&!Array.isArray(input),args=object?input as Record<string,unknown>:{};
    // Only trusted text reaches the event trail before disclosure (citations.ts, rule 1): an ID field keeps
    // only a string the packet holds, and a line field only a whole number.
    const locator=Object.fromEntries(['sourceId','startLine','endLine','ruleId'].filter(k=>k==='startLine'||k==='endLine'?lineNumber(args[k]):typeof args[k]==='string'||typeof args[k]==='number').map(k=>[k,String(safe(k,args[k])).slice(0,180)]));
    // Sealed advocacy is disclosed by the coordinator, never leaked in tool logs.
    emit({kind:'tool_call_started',message:label,data:{callId,...locator,input:name==='submit_artifact'?'Sealed submission; published at paired disclosure.':object?shownArgs(name,args):'(not an object)'}});
    try{const result=call(name,input);emit({kind:'tool_call_finished',message:label,data:{callId,result}});return result;}
    // A schema issue keeps its place and kind (schema keys and indexes), never its message, which can name a field the model made up.
    catch(error){emit({kind:'tool_error',message:label+': '+loggedError(error),data:{callId,...locator,...(error instanceof z.ZodError?{validationIssues:error.issues.map(i=>({path:i.path.filter(k=>typeof k==='number'||(typeof k==='string'&&/^[A-Za-z_][A-Za-z0-9_]{0,60}$/.test(k))),code:i.code}))}:{})}});throw error;}
  }
  const externalResults:unknown[]=[];
  const outsideTrail:OutsideCall[]=[];
  // Numbers and the one road-route slot are reserved before a lookup starts, so two lookups made at once never share a record.
  const outsideNumbers=new Map<string,number>();let outsideReserved=0,roadReserved=false;
  function call(name: string, input: unknown): unknown {
    if (closed) throw new TrustedRejection('Task is closed');
    if (++calls > 80) throw new TrustedRejection('Tool-call limit exceeded');
    if (!names.includes(name)) { emit({kind:'tool_denied',message:'Unknown tool rejected'}); throw new TrustedRejection('Tool is not permitted'); }
    const candidate = z.object({caseId:z.string()}).passthrough().parse(input);
    if (candidate.caseId !== task.caseId) { emit({kind:'tool_denied',message:'Cross-case request rejected'}); throw new TrustedRejection('Case scope mismatch'); }
    emit({kind:'tool_requested',message:name});
    let result: unknown;
    if (name === 'list_evidence') result = { caseId:task.caseId, evidenceVersion:task.packet.evidenceVersion, policyVersion:task.packet.policyVersion,
      evidence:task.packet.sources.map(s=>({sourceId:s.id,sha256:s.sha256,lines:s.lines.length})), policies:task.protocolVersion===2?facts.allowedPolicyIds:task.packet.policies.map(p=>p.rule_id), ...(task.packet.policyReference?{researchReference: {releaseId:task.packet.policyReference.releaseId,notice:task.packet.policyReference.notice,selection:task.packet.policyReference.selection,cards:task.packet.policyReference.cards.filter(c=>task.packet.policyReference!.selection.selectedIds.includes(c.id)).map(c=>({id:c.id,title:c.title}))}}:{}) };
    else if (name === 'read_evidence') {
      const args = readSchema.parse(input); const source = task.packet.sources.find(s=>s.id===args.sourceId);
      // A range past the end or over 100 lines returns what exists (at most 100 lines) and says where to continue; only a bad start is refused.
      const start=args.startLine??1,asked=args.endLine??start+99,length=source?.lines.length??0,end=Math.min(asked,length,start+99);
      if (!source || start > length || asked < start) throw new TrustedRejection('Invalid source range; source has '+length+' lines, maximum 100 lines per read');
      result = { sourceId:source.id, sha256:source.sha256, untrustedEvidence:true, lines:source.lines.slice(start-1,end).map((text,i)=>({line:start+i,text})), ...(end<Math.min(asked,length)?{nextStartLine:end+1}:{}) };
      const coverage=readLines.get(source.id)??new Set<number>();for(let i=start;i<=end;i++)coverage.add(i);readLines.set(source.id,coverage);
      emit({kind:'source_read',message:`${source.id}:${start}-${end}`,sources:[source.id],data:{sourceId:source.id,startLine:start,endLine:end,sha256:source.sha256}});
    } else if (name === 'read_policy') {
      const args = z.object({caseId:z.string(),ruleId:z.string()}).strict().parse(input);
      const rule = task.packet.policies.find(p=>p.rule_id===args.ruleId); if (!rule) throw new TrustedRejection('Unknown policy');
      if(task.protocolVersion===2&&!facts.allowedPolicyIds.includes(args.ruleId))throw new TrustedRejection('Policy is outside this case category');
      readPolicies.add(args.ruleId);
      // The same card is also pinned as a source (policy/public/<id>.json); reading the rule reads the card, so citing it by line is a personal read.
      const card=task.packet.sources.find(s=>s.id===`policy/public/${args.ruleId}.json`);
      if(card){const coverage=readLines.get(card.id)??new Set<number>();for(let i=1;i<=card.lines.length;i++)coverage.add(i);readLines.set(card.id,coverage);emit({kind:'source_read',message:`${card.id}:1-${card.lines.length}`,sources:[card.id],data:{sourceId:card.id,startLine:1,endLine:card.lines.length,sha256:card.sha256,via:'read_policy'}});}
      // rule.sources gives line numbers in the archived Ryde page; agents cited them against the card (3 October report).
      result = {policyVersion:task.packet.policyVersion,rule,...(card?{citeAs:{sourceId:card.id,lines:card.lines.length,note:`Cite this rule's text as ${card.id} with the card's own line numbers, 1 to ${card.lines.length}. line_start and line_end in rule.sources count lines of the archived page in archive_path, not this card; that page is not a source you can cite.`}}:{}),...(task.protocolVersion===2?{}:{profile:task.packet.policyProfile}),notice:task.packet.policyBasis==='reviewed-public'?task.packet.policyProfile:task.packet.datasetKind?'Policy supplied with this sample plus explicit limitations; not a verified Ryde service policy or an official adjudication service.':'Dated research reference plus explicit laboratory rules; not an official adjudication service.'};
    } else if(name==='read_timeline'){
      const args=z.object({caseId:z.string(),offset:z.number().int().min(0).default(0)}).strict().parse(input);
      const entries=evidenceTimeline(task.packet);result={notice:'Exact source-line index only; no interpretation. Read original sources before citing. Multiple timestamps in one line index the same original entry.',entries:entries.slice(args.offset,args.offset+40),total:entries.length,nextOffset:args.offset+40<entries.length?args.offset+40:null};
    } else if(name==='read_policy_reference'){
      const args=z.object({caseId:z.string(),cardId:z.string()}).strict().parse(input), release=task.packet.policyReference!;
      const card=release.cards.find(c=>c.id===args.cardId);if(!card||!release.selection.selectedIds.includes(card.id))throw new TrustedRejection('Reference card outside selected category/dependency set');
      result={releaseId:release.releaseId,sha256:release.sha256,notice:release.notice,applicability:release.selection.applicability,card};
      emit({kind:'policy_reference_read',message:card.id+' — '+card.title,data:result});
    } else if(name==='search_precedents'){
      const args=searchArgs.parse(input);
      const semantic=pendingSemantic??factsOnly(noLiveRunReason,offSetting);pendingSemantic=undefined;
      const shown=searchPrecedents(task.packet,{query:args.query}),all=semantic.result.hits.length?searchPrecedents(task.packet,{query:args.query,limit:10000}):shown;
      const merged=mergeSemantic(shown,all,semantic.result);
      // The record of the search (never the key, never model text: the agent's query is not in it; the case query is code-written and hashed).
      if(options.semanticSearch)emit({kind:'semantic_searched',message:semantic.result.mode==='on'?`semantic search: ${semantic.result.hits.length} similar by meaning`:`semantic search: facts only (${semantic.result.reason})`,
        data:{callId:currentCallId,mode:semantic.result.mode,model:semantic.result.model,dimension:semantic.result.dimension,reranker:semantic.result.reranker,...(semantic.result.reason?{reason:semantic.result.reason}:{}),queryTextSha256:semantic.trace.queryTextSha256,threshold:semantic.trace.threshold,notIndexed:semantic.trace.notIndexed,candidates:semantic.trace.candidates,embedding:semantic.trace.embedding,rerank:semantic.trace.rerank,
          hits:semantic.result.hits.map(h=>{const p=merged.find(x=>x.precedentId===h.precedentId);return {...h,binding:!!p?.binding,title:p?.title??null,differingFeatures:p?.differingFeatures??[],unknownFeatures:p?.unknownFeatures??[]};})}});
      result={notice:precedentNotice+' Ranking uses this case\'s deterministic facts (caseFeatures), the complaint wording and shared rules; it is not a finding. '+semanticNotice(semantic.result),caseFeatures:caseFeatures(task.packet).features,limits:retrievalLimits(task.packet),precedents:merged,semantic:semantic.result};
    } else if(name==='search_rules'){
      const args=z.object({caseId:z.string(),query:z.string().min(1).max(300)}).strict().parse(input);result={notice:'Keyword search over the rules pinned for this case only. A hit is a lead to read with read_policy, not a finding that the rule applies.',rules:searchRules(task.packet,args.query)};
    } else if(name==='read_precedent'){
      const args=z.object({caseId:z.string(),precedentId:z.string().max(80)}).strict().parse(input);const precedent=readPrecedent(args.precedentId,runLibrary(task.packet));if(!precedent||!(bindingStatuses as readonly string[]).includes(precedent.review_status)||precedentHidden(precedent,task.caseId))throw new TrustedRejection('Unknown precedent');result={notice:precedentNotice,precedent};emit({kind:'precedent_read',message:precedent.precedent_id,data:{precedentId:precedent.precedent_id}});
    } else if(name==='fetch_external'){
      throw new TrustedRejection('fetch_external is asynchronous; use callAsync');
    } else if(name==='list_conflicts'){
      const ids=task.packet.policySelection?.conflictIds??[];result={notice:'Recorded disagreements between archived Ryde pages that touch the pinned rules. Neither side is authoritative. Each conflict lists the decision criteria it can affect (affectsCriteria); a page_conflict blocker may sit only on those criteria and must name its conflictIds. A fee-amount or remedy conflict never blocks arrival, wait or trip criteria. A conflict with status explained carries the team reading that settles it (resolution); decide on that reading and do not cite it as a blocker. Page paths and line numbers here belong to archived Ryde pages, which are not sources you can cite; cite the policy card (policy/public/<ruleId>.json) by its own lines.',conflicts:conflictsFor(ids)};
    } else if(name==='read_calculations'){
      calculationsRead=true;result=facts;
    } else if((lookupTools as readonly string[]).includes(name)){
      const out=runLookup(task.packet,facts,name as LookupTool,input);markRead(out.returned);result=out.result;
      trail.push({tool:name,at:new Date().toISOString(),args:out.args,returned:out.returned});
      emit({kind:'lookup_read',message:`${name}: ${out.returned.reduce((n,r)=>n+r.endLine-r.startLine+1,0)} lines`,sources:[...new Set(out.returned.map(r=>r.sourceId))],data:{tool:name,returned:out.returned}});
    } else if(name==='request_record'){
      // Always answers (lookups.ts recordAnswer); past the limit with a note and no request ID, so no gap point can rest on it.
      const {caseId:_case,...args}=requestArgs.parse(input),made=trail.filter(l=>l.tool==='request_record'&&l.request?.requestId).length;
      const answer=made<maxRecordRequests?recordAnswer(task.packet,args.kind):null,requestId=answer?artifactId(task)+'#R'+(made+1):null;
      const note=!answer?`You have made ${maxRecordRequests} record requests in this task, the most allowed, so this one was not recorded and has no requestId. A gap point can rest only on a request with a requestId.`:answer.answer==='on_record'?answer.note:answer.note+(task.phase==='challenge'?` If this missing record weakens an opposing claim, you may file a gap point with requestId ${requestId}.`:' If it matters to your case, say so in your argument.');
      trail.push({tool:name,at:new Date().toISOString(),args,returned:[],request:{requestId,answer:answer?.answer??null,points:answer?.points??[]}});
      result={requestId,answer:answer?.answer??null,points:answer?.points??[],note};
    } else {
      const args = z.object({caseId:z.string(),artifact:z.unknown()}).strict().parse(input);
      // Evidence checks 1 (MVP fixes, 10 October 2026): claim problems and this task's read failures come back in one rejection.
      let validated:Artifact,claims:ClaimCheckError|undefined;
      // The trail is the server's: a model-written `lookups` is replaced, never kept.
      // Outside lookups (AD-13): the lookups this dispute needs come first; then the server's outside trail rides on the artifact.
      const outsideOn=task.phase==='collect'&&hasOutsideLookups(task.packet);
      // It joins the read checks' rejection below, so one resubmission can fix both.
      const missingOutside=outsideOn?missingOutsideCalls(task.packet,outsideTrail):[];
      const outsideProblem=missingOutside.length?`Before submitting, make these outside_lookup calls for this dispute: ${missingOutside.map(needText).join('; ')}. A lookup that comes back unavailable or finds nothing still counts; say so in evidenceRequests.`:null;
      const object=args.artifact&&typeof args.artifact==='object'&&!Array.isArray(args.artifact);
      const own=!object?args.artifact:{...args.artifact as Record<string,unknown>,...(lookups?{lookups:structuredClone(trail)}:{}),...(outsideOn?{outside:structuredClone(outsideTrail)}:{})};
      try{validated=validateArtifact(task,own);}catch(error){if(!(error instanceof ClaimCheckError))throw error;claims=error;validated=error.artifact;}
      if(task.protocolVersion===2){
        // The same four checks as before, reported together so one resubmission can fix them all (judge_c in run
        // bcf246ed was rejected for one unread required source, then for the next).
        const unread=new Map<string,Set<number>>();
        for(const c of citationsFor(validated))for(let line=c.startLine;line<=c.endLine;line++)if(!readLines.get(c.sourceId)?.has(line)){const s=unread.get(c.sourceId)??new Set<number>();s.add(line);unread.set(c.sourceId,s);}
        const unreadPolicies=[...new Set(validated.policyIds.filter(id=>!readPolicies.has(id)))];
        const missingJudgeSources=isJudge(task.role)?[...facts.requiredSourceIds,...(task.packet.sources.some(s=>s.id==='derived/photos.json')?['derived/photos.json']:[])].filter(id=>!readLines.has(id)):[];
        const rejection=readCheckRejection(task.packet,{unread,read:readLines,unreadPolicies,calculationsUnread:!calculationsRead,missingJudgeSources});
        if(claims)throw new TrustedRejection(claimRejection(claims.problems,rejection,claims.what));
        if(rejection||outsideProblem)throw new TrustedRejection([rejection,outsideProblem].filter(Boolean).join(' Also: '));
      }
      if(claims)throw claims;
      if(outsideProblem)throw new TrustedRejection(outsideProblem);
      // The same submission again, after more lookups, is the same submission: the trail is not part of what is compared.
      const sealed=(a:Artifact)=>JSON.stringify({...a,lookups:undefined,outside:undefined});
      if (submitted && sealed(submitted)!==sealed(validated)) throw new TrustedRejection('Submission is immutable');
      submitted = validated;
      result = {accepted:true,role:task.role,phase:task.phase};
      // Never leak sealed submissions through tool events.
    }
    emit({kind:'tool_completed',message:name}); return result;
  }
  async function callAsync(name:string,input:unknown):Promise<unknown>{
    if(name==='outside_lookup'){
      if(closed)throw new TrustedRejection('Task is closed');
      if(++calls>80)throw new TrustedRejection('Tool-call limit exceeded');
      if(!names.includes(name)){emit({kind:'tool_denied',message:'Unknown tool rejected'});throw new TrustedRejection('Tool is not permitted');}
      const args=z.object({caseId:z.string(),source:z.enum(outsideSourceKinds),place:z.enum(placeNames).optional(),window:z.enum(windowNames).optional()}).strict().parse(input);
      if(args.caseId!==task.caseId){emit({kind:'tool_denied',message:'Cross-case request rejected'});throw new TrustedRejection('Case scope mismatch');}
      if(outsideReserved>=maxOutsideCalls)throw new TrustedRejection(`At most ${maxOutsideCalls} outside lookups per task`);
      if(args.source==='road_route'&&roadReserved)throw new TrustedRejection('The road route is looked up once per run; read evidence/route_reference.json');
      const n=(outsideNumbers.get(args.source)??0)+1;outsideNumbers.set(args.source,n);outsideReserved++;if(args.source==='road_route')roadReserved=true;
      const callId=task.sessionId+':'+(++callNumber),shown={source:args.source,place:args.place??null,window:args.window??null};
      emit({kind:'tool_call_started',message:name,data:{callId,input:shown}});
      let call:OutsideCall,status:string;
      try{({call,status}=await lookupOutside({source:args.source,place:args.place,window:args.window},n,callId));}
      // A refused or unanswered lookup frees the road-route slot (its number stays used), so a required road route can still be made.
      catch(error){if(args.source==='road_route')roadReserved=false;emit({kind:'tool_error',message:name+': '+loggedError(error),data:{callId,input:shown}});throw error;}
      if(closed)throw new TrustedRejection('Task is closed');
      outsideTrail.push(call);
      // The record joins this task's sources at once, read in full, so the Collector can cite it in the same submission.
      const source={id:call.sourceId,text:call.text,lines:call.text.split('\n'),sha256:call.sha256};
      task.packet.sources=[...task.packet.sources.filter(s=>s.id!==source.id),source];knownIds.sourceId.add(source.id);
      markRead([{sourceId:source.id,startLine:1,endLine:source.lines.length}]);
      // The calculations a record changes (a road route's comparison) come back with it, so the Collector sees them without another read.
      const before=new Map(facts.facts.map(f=>[f.id,JSON.stringify(f.value)]));facts=deriveFacts(task.packet);
      const changed=facts.facts.filter(f=>before.get(f.id)!==JSON.stringify(f.value));
      // The whole record (provider data and the server's labels, never model text) is kept in the event log as it arrives, so a lookup
      // survives a Collector that fails before submitting.
      emit({kind:'outside_fetched',message:`${args.source}${args.place?' at '+args.place:''}: ${status}`,sources:[source.id],data:{callId,sourceId:source.id,sha256:source.sha256,kind:call.kind,place:call.place,window:call.window,status,text:call.text}});
      emit({kind:'tool_call_finished',message:name,data:{callId,sourceId:source.id,status}});
      return {sourceId:source.id,lines:source.lines.length,status,record:JSON.parse(call.text),...(changed.length?{changedCalculations:changed}:{}),note:'Saved as a record that you, both advocates and the Arbitrator can read and cite by its lines. Write an external_context observation citing it: what it shows and what it cannot show.'+(changed.length?' changedCalculations lists the calculations this record changed; read_calculations now shows them too.':'')};
    }
    // Semantic search: the worker is asked first (its answer never throws into the tool), then the fact search runs as before and merges it.
    if(name==='search_precedents'&&options.semanticSearch&&!closed){
      const parsed=searchArgs.safeParse(input);
      if(parsed.success&&parsed.data.caseId===task.caseId){
        try{pendingSemantic=await options.semanticSearch(task.packet,searchPrecedents(task.packet,{limit:10000}).map(h=>h.precedentId));}
        catch(error){pendingSemantic=factsOnly(error instanceof TrustedRejection?error.message:'the semantic search failed on the server',offSetting);}
      }
      // Consumed by this call alone: a call that fails before the search branch leaves nothing for a later one.
      try{return tracked(name,input);}finally{pendingSemantic=undefined;}
    }
    if(name!=='fetch_external')return tracked(name,input);
    if(closed)throw new TrustedRejection('Task is closed');
    if(++calls>80)throw new TrustedRejection('Tool-call limit exceeded');
    if(!names.includes(name))throw new TrustedRejection('Tool is not permitted');
    const args=z.object({caseId:z.string(),provider:z.enum(['rainfall','traffic']),date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),time:z.string().regex(/^\d{2}:\d{2}:\d{2}$/).optional()}).strict().parse(input);
    if(args.caseId!==task.caseId)throw new TrustedRejection('Case scope mismatch');
    if(externalResults.length>=4)throw new TrustedRejection('At most four external fetches per task');
    const mode=process.env.RYDE_EXTERNAL_LIVE==='1'?'live':'simulation';
    emit({kind:'tool_call_started',message:name,data:{callId:task.sessionId+':'+(++callNumber),input:{...args,mode}}});
    const response=await collectExternal({provider:args.provider,mode,date:args.date,time:args.time??'10:00:00'});
    externalResults.push(response);
    emit({kind:'external_fetched',message:`${args.provider} (${mode}): ${response.status}`,data:response});
    return {notice:'External response captured for this session only; it is not a packet source. Record what it shows or fails to show as an evidenceRequest with its status and the retrieval time.',response};
  }
  return { names, call:tracked, callAsync, close:()=>{closed=true;stopOutside.abort();}, result:()=>submitted, externalResults:()=>externalResults, outsideTrail:()=>outsideTrail };
}
