export const DEFAULT_HARNESS_BODY_BYTES=8*1024*1024;
/** HTTP bytes are independent of the model token window. Read once at startup. */
export function resolveHarnessBodyLimit(value: string | number | undefined): number {
  if(value===undefined)return DEFAULT_HARNESS_BODY_BYTES;
  const n=typeof value==='string'&&/^\d+$/.test(value)?Number(value):value;
  if(typeof n!=='number'||!Number.isSafeInteger(n)||n<262144||n>32*1024*1024)throw Error('CPCLAW_HARNESS_MAX_BODY_BYTES 必须为262144至33554432的整数字节数');
  return n;
}
