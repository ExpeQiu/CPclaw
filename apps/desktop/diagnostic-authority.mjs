/** Maintenance authority is issued by the host, never taken from model tool arguments. */
export const DIAGNOSTIC_AUTHORITY='system-diagnostic';
export function diagnosticOperationAllowed(service,request) {
  if(service?.id!=='dreamina'||service.builtin!==true||service.type!=='CLI')return false;
  if(request?.action==='discover'||request?.action==='recover_image')return true;
  if(request?.action!=='call'||!Array.isArray(request.args))return false;
  const [command,operation,id,projectFlag,projectId,...extra]=request.args;
  // The host owns all output paths and all submission identities. No generation or shell route.
  return (command==='operation'&&operation==='status'||command==='resource'&&['get','download'].includes(operation))
    &&typeof id==='string'&&/^[-\w]{1,128}$/.test(id)&&projectFlag==='--project-id'
    &&typeof projectId==='string'&&/^[a-f0-9-]{36}$/i.test(projectId)&&extra.length===0;
}
