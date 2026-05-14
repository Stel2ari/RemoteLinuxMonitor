const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopAPI", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  startMonitor: (payload) => ipcRenderer.invoke("monitor:start", payload),
  stopMonitor: () => ipcRenderer.invoke("monitor:stop"),
  testMonitor: (payload) => ipcRenderer.invoke("monitor:test", payload),
  getMonitorState: () => ipcRenderer.invoke("monitor:state"),
  pickImage: () => ipcRenderer.invoke("dialog:pickImage"),
  onMetrics: (handler) => {
    const wrapped = (_, payload) => handler(payload);
    ipcRenderer.on("metrics:update", wrapped);
    return () => ipcRenderer.removeListener("metrics:update", wrapped);
  },
  onMonitorState: (handler) => {
    const wrapped = (_, payload) => handler(payload);
    ipcRenderer.on("monitor:state", wrapped);
    return () => ipcRenderer.removeListener("monitor:state", wrapped);
  },
  minimize: () => ipcRenderer.send("window:minimize"),
  close: () => ipcRenderer.send("window:close")
});
