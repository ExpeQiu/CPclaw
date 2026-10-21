const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cpclaw", {
  acceptTask(command) {
    return ipcRenderer.invoke("tasks.accept", command);
  },
  workspace(call) {
    return ipcRenderer.invoke("workspace.call", call);
  },
});
