import type { CasePacket } from './contracts';
import { organiserFacts } from './organiser';
import { isDatasetPacket } from '../case-packet/dataset';
import { datasetFacts } from '../evidence-collection/observations';
import type { Branch } from './checklists';
export type Cite = {sourceId:string;startLine:number;endLine:number};
export type Fact = {id:string;value:unknown;explanation:string;citations:Cite[]};
/** branch: facts version 4 and later only (checklists.ts); it chose requiredCriteria. */
export type Facts = {category:string;facts:Fact[];allowedPolicyIds:string[];requiredCriteria:string[];requiredSourceIds:string[];cashCeiling:number|null;pendingRefund:boolean;branch?:Branch};
const iso=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;
export function deriveFacts(packet:CasePacket):Facts {
  if(isDatasetPacket(packet))return datasetFacts(packet);
  if(packet.policyBasis==='reviewed-public'){
    const raw=deriveFacts({...packet, policyBasis:undefined, caseId:packet.caseId, datasetKind:undefined});
    return {...raw, allowedPolicyIds:packet.policies.map(p=>p.rule_id), requiredCriteria:['policy_applicability',...raw.requiredCriteria], facts:raw.facts.filter(f=>f.id!=='wait_threshold_met')};
  }
  if(packet.datasetKind)return organiserFacts(packet);
  const source=(id:string)=>packet.sources.find(s=>s.id===id);
  const json=(id:string):any=>{try{return JSON.parse(source(id)?.text??'null');}catch{return null;}};
  const cite=(id:string,needle?:string):Cite=>{const s=source(id)!;const i=needle?s.lines.findIndex(l=>l.includes(needle)):-1;return {sourceId:id,startLine:i<0?1:i+1,endLine:i<0?s.lines.length:i+1};};
  const facts:Fact[]=[];
  const add=(id:string,value:unknown,explanation:string,citations:Cite[])=>facts.push({id,value,explanation,citations});
  const intake=json('evidence/intake.json'),dispatch=json('evidence/dispatch.json'),payment=json('evidence/payment-events.json');
  const category=intake?.category??'unknown';
  const events=Array.isArray(dispatch?.events)?dispatch.events:[];
  const arrivals=events.filter((e:any)=>e.type==='driver_marked_arrived'),cancels=events.filter((e:any)=>e.type==='cancel_driver_rider_absent');
  const arrival=arrivals.length===1?arrivals[0]:null,cancel=cancels.length===1?cancels[0]:null;
  if(arrival&&cancel&&iso.test(arrival.at)&&iso.test(cancel.at)&&Number.isFinite(Date.parse(arrival.at))&&Number.isFinite(Date.parse(cancel.at))){
    const seconds=(Date.parse(cancel.at)-Date.parse(arrival.at))/1000;
    add('recorded_wait_seconds',seconds,'Difference between the recorded server arrival and cancellation; does not independently prove physical arrival.',[cite('evidence/dispatch.json',arrival.at),cite('evidence/dispatch.json',cancel.at)]);
    if(category==='no_show'&&packet.policyProfile.includes('LAB-ADJUDICATION-2'))add('wait_threshold_met',seconds>180,'Selected laboratory profile uses strictly more than three minutes. This only verifies duration after the recorded arrival.',[cite('evidence/dispatch.json',arrival.at),cite('evidence/dispatch.json',cancel.at)]);
  }
  const starts=events.filter((e:any)=>e.type==='trip_started');
  if(starts.length===1&&starts[0].at===null)add('trip_not_started',true,'The dispatch explicitly records no trip start; a fee that requires a completed trip is inapplicable.',[cite('evidence/dispatch.json','"trip_started"'),cite('evidence/dispatch.json','"at": null')]);
  let cashCeiling:number|null=null,pendingRefund=false;
  if(Array.isArray(payment?.events)){
    const rows=payment.events;const amountsValid=rows.every((e:any)=>Number.isInteger(e.amount_cents)&&e.amount_cents>=0);
    if(amountsValid){
      const total=(type:string,status:string)=>rows.filter((e:any)=>e.type===type&&e.status===status).reduce((a:number,e:any)=>a+e.amount_cents,0);
      const captured=total('capture','settled'),refunded=total('refund','settled');pendingRefund=rows.some((e:any)=>e.type==='refund'&&e.status==='pending');
      const totals=payment.processor_totals;
      const reconciled=!!totals&&totals.captured_cents===captured&&totals.settled_refund_cents===refunded&&totals.pending_refund_cents===total('refund','pending');
      cashCeiling=reconciled&&!pendingRefund?Math.max(0,captured-refunded):null;
      add('payment_reconciled',reconciled&&!pendingRefund,'Hold/authorization is excluded. Event sums must match processor totals; pending refunds require reconciliation. This does not determine refund entitlement.',[cite('evidence/payment-events.json')]);
      add('cash_refund_ceiling_cents',cashCeiling,'Maximum additional cash recommendation under the selected laboratory accounting rule, not an entitlement.',[cite('evidence/payment-events.json')]);
    }
  }
  const receipt=source('extractions/source-document.pdf.txt');
  if(receipt&&cancel&&iso.test(cancel.at)){
    const match=receipt.text.match(/Cancellation recorded (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d))/);
    if(match){
      add('receipt_same_instant',Date.parse(match[1])===Date.parse(cancel.at),'Normalize explicit timezone offsets before comparing receipt and cancellation timestamps.',[cite(receipt.id,match[1]),cite('evidence/dispatch.json',cancel.at)]);
      const refs=(payment?.events??[]).filter((e:any)=>e.type==='capture').map((e:any)=>e.reference).filter((x:unknown)=>typeof x==='string');
      if(typeof intake?.trip_id==='string'&&refs.length===1)add('receipt_matches_trip_and_charge',receipt.text.includes(intake.trip_id)&&receipt.text.includes(refs[0]),'Match the supplied receipt transcription against the intake trip ID and captured-charge reference. This verifies recorded identifiers, not authenticity.',[cite(receipt.id,intake.trip_id),cite(receipt.id,refs[0]),cite('evidence/intake.json','"trip_id"'),cite('evidence/payment-events.json',refs[0])]);
    }
  }
  const allowedPolicyIds=packet.policies.filter(p=>{
    if(category==='no_show')return /^RYDE-(CANCEL-|PAYMENT-|REFUND-)/.test(p.rule_id);
    if(category==='route_deviation')return /^RYDE-(FIXED-|EDIT-|SURGE|PROMO-|PAYMENT-|REFUND-|ERP|FARE)/.test(p.rule_id);
    return true;
  }).map(p=>p.rule_id);
  const requiredCriteria=category==='no_show'?['arrival_at_pickup','wait_threshold','trip_not_completed','charge_reconciliation']:['route_entitlement','charge_reconciliation'];
  const relevant=['evidence/intake.json','evidence/dispatch.json','evidence/telemetry.csv','evidence/chat.json','evidence/rider-statement.txt','evidence/driver-statement.txt','evidence/payment-events.json','evidence/support-audit.txt','extractions/chat-capture.png.txt','extractions/source-document.pdf.txt'];
  return {category,facts,allowedPolicyIds,requiredCriteria,requiredSourceIds:relevant.filter(id=>!!source(id)),cashCeiling,pendingRefund};
}
