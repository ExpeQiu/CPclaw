/** Bounded per-process protection. A distributed deployment should provide a shared limiter at its ingress. */
export class LoginGuard {
 private buckets = new Map<string,{failures:number;until:number}>();
 constructor(private now=Date.now,private accountLimit=10,private ipLimit=100,private windowMs=15*60*1000){}
 private keys(ip:string,employee:string){return ['ip:'+ip,'account:'+ip+':'+employee.slice(0,64)];}
 retryAfter(ip:string,employee:string):number{
  const at=this.now();let retry=0;
  for(const [i,key]of this.keys(ip,employee).entries()){const b=this.buckets.get(key);if(b&&b.until<=at)this.buckets.delete(key);else if(b&&b.failures>=(i===0?this.ipLimit:this.accountLimit))retry=Math.max(retry,Math.ceil((b.until-at)/1000));}return retry;
 }
 record(ip:string,employee:string,success:boolean):void{
  const keys=this.keys(ip,employee);if(success){this.buckets.delete(keys[1]!);return;}
  const at=this.now();for(const key of keys){if(!this.buckets.has(key)&&this.buckets.size>=5000){for(const [k,b]of this.buckets){if(b.until<=at)this.buckets.delete(k);}if(this.buckets.size>=5000)this.buckets.delete(this.buckets.keys().next().value!);}const b=this.buckets.get(key);this.buckets.set(key,{failures:(b&&b.until>at?b.failures:0)+1,until:b&&b.until>at?b.until:at+this.windowMs});}
 }
}
