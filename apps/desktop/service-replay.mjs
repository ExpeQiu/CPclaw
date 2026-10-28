/** Only proven read operations may be repeated after an interrupted model turn. */
const dreaminaReads=/^(model( list| find)?|voice list|canvas (current|ls)|node (find|show|quote)|operation (status|wait)|resource get|auth (status|account)|version)$/;
export function serviceReplaySafe(records=[]) {
  return records.every(record=>{
    const request=record.request||{};
    if(request.action==='discover')return ['dreamina','local-terminal','browser-page'].includes(record.service?.id);
    if(record.service?.id!=='dreamina'||request.action!=='call'||!Array.isArray(request.args))return false;
    const args=request.args;if(!args.length||args.some(a=>typeof a!=='string'))return false;
    const flag=args.findIndex(a=>a.startsWith('--')),path=args.slice(0,flag<0?args.length:flag);
    // Positional IDs/model names follow the declared command, so match the longest known prefix.
    return [3,2,1].some(length=>dreaminaReads.test(path.slice(0,length).join(' ')))
      &&!args.some(a=>/^--(run|yes|force|output|credit-token|credit-ceiling)$/.test(a));
  });
}
