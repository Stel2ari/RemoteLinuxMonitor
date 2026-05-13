const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopAPI", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  startMonitor: (payload) => ipcRenderer.invoke("monitor:start", payload),
  pickImage: () => ipcRenderer.invoke("dialog:pickImage"),
  onMetrics: (handler) => {
    const wrapped = (_, payload) => handler(payload);
    ipcRenderer.on("metrics:update", wrapped);
    return () => ipcRenderer.removeListener("metrics:update", wrapped);
  },
  minimize: () => ipcRenderer.send("window:minimize"),
  close: () => ipcRenderer.send("window:close")
});
