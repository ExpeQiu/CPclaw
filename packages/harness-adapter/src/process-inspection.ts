import {execFileSync} from 'node:child_process';

export type ProcessInspection = { state: 'exited' | 'remaining' | 'unknown' };
/** A failed inspection is not evidence of a surviving child. */
export function inspectHarnessProcess(marker: string, run = (command: string, args: string[]) =>
  execFileSync(command, args, {encoding:'utf8',timeout:1000,maxBuffer:4*1024*1024})): ProcessInspection {
  if(process.platform === 'win32')return {state:'unknown'};
  try {
    const listing=run('/bin/ps',['-ax','-o','command=']);
    return {state:listing.includes(marker)?'remaining':'exited'};
  } catch {
    return {state:'unknown'};
  }
}
