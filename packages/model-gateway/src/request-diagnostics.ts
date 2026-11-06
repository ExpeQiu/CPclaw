import type {TokenUsage} from '@cpclaw/contracts';
/** Metadata only: never persist prompts, tool arguments, headers or provider error bodies. */
export type RequestDiagnostic = {
  requestBytes?: number; requestLimitBytes?: number; transportCode?: string; code: string; stage: string; outcome: string; model: string; durationMs: number;
  httpStatus: number; providerRequestId: string; finishReason: string; sawDone: boolean;
  normalEof: boolean; chunks: number; responseBytes: number; textChars: number; reasoningChars?: number;
  toolName: string; toolArgumentBytes: number; toolJsonValid: boolean | null;
  lastDataAgeMs: number; outputLimit: number; attempts?: {attempt:number;httpStatus:number;waitMs:number}[];
};
export type DiagnosticObserver = (record: RequestDiagnostic) => void;
export function newRequestDiagnostic(outputLimit: number): RequestDiagnostic {
  return {code:'',stage:'model_connect',outcome:'running',model:'MiniMax-M3',durationMs:0,httpStatus:0,providerRequestId:'',finishReason:'',sawDone:false,normalEof:false,chunks:0,responseBytes:0,textChars:0,toolName:'',toolArgumentBytes:0,toolJsonValid:null,lastDataAgeMs:0,outputLimit};
}
export class RequestDiagnosticError extends Error {
  constructor(message: string, readonly diagnostic: RequestDiagnostic) { super(message); this.name='RequestDiagnosticError'; }
}
/** Observer failures must not replace model results or mask the original error. */
export function notifyDiagnostic(observer: DiagnosticObserver | undefined, record: RequestDiagnostic): void {
  try { observer?.({...record}); } catch { process.stderr.write('{"event":"diagnostic_observer_failed"}\n'); }
}
export function diagnosticCode(error: unknown, record: RequestDiagnostic, aborted: boolean): string {
  if(record.code)return record.code;
  if(aborted)return 'REQUEST_CANCELLED';
  if(record.httpStatus>=400)return 'MODEL_HTTP_ERROR';
  if(record.finishReason==='length')return 'MODEL_OUTPUT_LIMIT';
  if(error instanceof SyntaxError)return record.stage==='tool_validate'?'TOOL_ARGUMENTS_INVALID':'MODEL_EVENT_INVALID';
  if(record.stage==='tool_validate')return 'TOOL_ARGUMENTS_INVALID';
  if(record.stage==='delivery')return 'DELIVERY_FAILED';
  return record.stage==='model_connect'?'MODEL_CONNECTION_FAILED':'MODEL_STREAM_INCOMPLETE';
}
/** Validate remote evidence before storing it in desktop logs or showing diagnostics. */
export function cleanRequestDiagnostic(value: unknown): Partial<RequestDiagnostic> {
  if(!value||typeof value!=='object')return {};
  const input=value as Record<string,unknown>,out: Record<string,string|number|boolean|null>={};
  for(const key of ['code','stage','outcome','model','providerRequestId','finishReason','toolName']){
    const v=input[key];if(typeof v==='string'&&/^[A-Za-z0-9._:-]{0,128}$/.test(v))out[key]=v;
  }
  for(const key of ['durationMs','httpStatus','chunks','responseBytes','textChars','reasoningChars','toolArgumentBytes','lastDataAgeMs','outputLimit','requestBytes','requestLimitBytes']){
    const v=input[key];if(typeof v==='number'&&Number.isFinite(v)&&v>=0)out[key]=v;
  }
  for(const key of ['sawDone','normalEof','toolJsonValid']){const v=input[key];if(typeof v==='boolean'||key==='toolJsonValid'&&v===null)out[key]=v;}
  const transport=input.transportCode;if(typeof transport==='string'&&/^(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EPIPE|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT)$/.test(transport))out.transportCode=transport;
  const result=out as Partial<RequestDiagnostic>;
  if(Array.isArray(input.attempts))result.attempts=input.attempts.slice(0,3).filter(v=>v&&typeof v==='object'&&['attempt','httpStatus','waitMs'].every(k=>typeof v[k]==='number'&&Number.isFinite(v[k])&&v[k]>=0)).map(v=>({attempt:v.attempt,httpStatus:v.httpStatus,waitMs:v.waitMs}));
  return result;
}
/** Code locations only; exception messages may contain private payloads. */
export function errorMetadata(error: unknown): {errorType:string;failureSite:string} {
  const value=error instanceof Error?error:undefined;
  return {errorType:value&&/^[A-Za-z0-9_]{1,60}$/.test(value.name)?value.name:'Error',failureSite:(value?.stack?.split('\n').slice(1).join('\n').match(/[A-Za-z0-9_.-]+\.(?:mjs|cjs|js|ts):\d+:\d+/g)||[]).slice(0,3).join(',').slice(0,200)};
}

/** Displayable final-answer text, kept as task data rather than diagnostic metadata. */
export class HarnessFinalCheckpointError extends RequestDiagnosticError {
  constructor(diagnostic:RequestDiagnostic,readonly content:string,readonly usage:TokenUsage){super('内核最终答复达到长度上限，正文可从检查点续接',diagnostic);this.name='HarnessFinalCheckpointError';}
}
