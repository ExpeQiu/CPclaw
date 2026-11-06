import {setTimeout as delay} from 'node:timers/promises';
export type ModelAttempt={attempt:number;httpStatus:number;waitMs:number};
/** Only rejected HTTP responses are retried. Never replay a partially received model stream. */
export async function fetchModel(url:string,init:RequestInit,onAttempt?:(attempt:ModelAttempt)=>void,budgetMs=300000):Promise<Response>{
 const started=Date.now();
 for(let attempt=1;;attempt++){
  const response=await fetch(url,init);
  const transient=[429,502,503,504,529].includes(response.status);
  const raw=response.headers.get('retry-after');
  const seconds=raw===null?NaN:Number(raw),date=raw?Date.parse(raw):NaN;
  const requested=Number.isFinite(seconds)?Math.max(0,seconds*1000):Number.isFinite(date)?Math.max(0,date-Date.now()):NaN;
  const waitMs=Number.isFinite(requested)?requested:Math.min(4000,500*2**(attempt-1))+Math.floor(Math.random()*200);
  const retry=transient&&attempt<3&&waitMs<=10000&&Date.now()-started+waitMs<budgetMs;
  try{onAttempt?.({attempt,httpStatus:response.status,waitMs:retry?waitMs:0});}catch{ /* Observers cannot repeat or fail model calls. */ }
  if(!retry)return response;
  await response.body?.cancel().catch(()=>{});
  await delay(waitMs,undefined,init.signal?{signal:init.signal}:undefined);
 }
}
