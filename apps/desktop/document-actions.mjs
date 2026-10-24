import { writeFileSync, lstatSync, constants, openSync, closeSync, fsyncSync, ftruncateSync } from 'node:fs';
import { extname, resolve } from 'node:path';

/** 文件目标只来自系统保存对话框；源文件必须先由当前账号文档存储鉴权。 */
export async function performDocumentAction({ input, actor, request, isCurrent, dialog, shell, parent }) {
  if (!actor) return { ok: false, message: '请先登录' };
  if (!['open','reveal','saveAs'].includes(input?.action)) return { ok: false, message: '未知文档操作' };
  try {
    const result = await request({ method: 'document.read', input: { id: input.id }, actorId: actor });
    if (!result.ok) return result;
    if (!isCurrent(actor)) throw Error('账号已变化，请重新选择文档');
    const { artifact } = result;
    if (input.action === 'open') { const error = await shell.openPath(artifact.path); if (error) throw Error(error); return { ok: true }; }
    if (input.action === 'reveal') { shell.showItemInFolder(artifact.path); return { ok: true }; }
    const choice = await dialog.showSaveDialog(parent, { title: '另存为 Markdown 文档', defaultPath: artifact.name, filters: [{ name: 'Markdown 文档', extensions: ['md'] }], properties: ['createDirectory','showOverwriteConfirmation'] });
    if (choice.canceled || !choice.filePath) return { ok: true, cancelled: true };
    if (!isCurrent(actor)) throw Error('账号已变化，已取消另存为');
    const destination = resolve(choice.filePath);
    if (extname(destination).toLowerCase() !== '.md') throw Error('请选择 .md 文件名');
    if (destination === artifact.path) throw Error('原文件已保存在此位置，请选择其他位置');
    // 在对话框关闭后重读，避免导出对话框打开期间已变更的旧内容。
    const latest = await request({ method: 'document.read', input: { id: input.id }, actorId: actor });
    if (!latest.ok) return latest;
    if (!isCurrent(actor)) throw Error('账号已变化，已取消另存为');
    let exists = false;
    try { const stat=lstatSync(destination); if(!stat.isFile() || stat.isSymbolicLink())throw Error('目标不是普通文件'); exists=true; } catch(error) { if(error.code!=='ENOENT')throw error; }
    const fd = openSync(destination, constants.O_WRONLY | constants.O_NOFOLLOW | (exists ? 0 : constants.O_CREAT | constants.O_EXCL), 0o600);
    try { writeFileSync(fd, latest.artifact.body); ftruncateSync(fd,Buffer.byteLength(latest.artifact.body));fsyncSync(fd); } finally { closeSync(fd); }
    return { ok: true, path: destination };
  } catch(error) { return { ok: false, message: error.message || '文档操作失败' }; }
}
