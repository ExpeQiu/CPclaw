const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cpclaw", {
  extensionAction(input) { return ipcRenderer.invoke('extension.action', input); },
  onExtensionEvent(callback) {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('extension.event', listener);
    return () => ipcRenderer.removeListener('extension.event', listener);
  },
  onChatEvent(callback) {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("chat.event", listener);
    return () => ipcRenderer.removeListener("chat.event", listener);
  },
  knowledgeAction(input) { return ipcRenderer.invoke('knowledge.action', input); },
  projectAction(input) { return ipcRenderer.invoke("project.action", input); },
  documentAction(input) { return ipcRenderer.invoke("document.action", input); },
  acceptTask(command) {
    return ipcRenderer.invoke("tasks.accept", command);
  },
  workspace(call) {
    return ipcRenderer.invoke("workspace.call", call);
  },
  runDoctor(input) {
    return ipcRenderer.invoke("doctor.run", input ?? {});
  },
  exportDiagnostic(payload) {
    return ipcRenderer.invoke("doctor.export", payload);
  },
});
