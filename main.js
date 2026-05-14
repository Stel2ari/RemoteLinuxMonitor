const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const AutoLaunch = require("auto-launch");
const { Client } = require("ssh2");
const log = require("electron-log/main");

const POLL_INTERVAL_MS = 5000;
const DEFAULT_NETWORK_CAPACITY_MBPS = 10;
const DEFAULT_RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECT_ATTEMPTS = 3;
let mainWindow = null;
let pollTimer = null;
let lastNetworkTotals = null;
let currentSSHConfig = null;
let sshConn = null;
let isSSHReady = false;
let pendingConnect = null;
let monitoringActive = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
let reconnecting = false;
let collectInFlight = false;
let networkCapacityMbps = DEFAULT_NETWORK_CAPACITY_MBPS;
let autoStartState = {
  requested: false,
  effective: false,
  message: ""
};

const defaultSettings = {
  autoStart: true,
  alwaysOnTop: true,
  networkCapacityMbps: DEFAULT_NETWORK_CAPACITY_MBPS,
  activeSettingsView: "connection",
  activeConnectionId: "default",
  connections: [
    {
      id: "default",
      name: "默认连接",
      ssh: {
        host: "",
        port: 22,
        username: "",
        password: "",
        privateKey: ""
      }
    }
  ],
  theme: {
    backgroundColor: "#0b1220",
    backgroundOpacity: 0.78,
    fontSize: 14,
    fontFamily: "Segoe UI",
    ringColors: {
      cpu: "#4cc9f0",
      memory: "#f72585",
      network: "#80ed99"
    },
    backgroundImage: ""
  },
  ssh: {
    host: "",
    port: 22,
    username: "",
    password: "",
    privateKey: ""
  }
};

function getSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function mergeSettings(input) {
  const nextConnections = Array.isArray(input?.connections) ? input.connections : [];
  const legacySsh = input?.ssh || {};
  const baseSsh = {
    ...defaultSettings.connections[0].ssh,
    ...legacySsh
  };

  const normalizedConnections = nextConnections
    .map((item, index) => {
      const id = String(item?.id || `conn-${index + 1}`);
      return {
        id,
        name: String(item?.name || "")
          .trim()
          .slice(0, 20) || `连接 ${index + 1}`,
        ssh: {
          ...defaultSettings.connections[0].ssh,
          ...(item?.ssh || {})
        }
      };
    })
    .filter((item) => item.id);

  if (normalizedConnections.length === 0) {
    normalizedConnections.push({
      id: "default",
      name: "默认连接",
      ssh: baseSsh
    });
  }

  const requestedActiveId = input?.activeConnectionId;
  const activeConnectionId = normalizedConnections.some((item) => item.id === requestedActiveId)
    ? requestedActiveId
    : normalizedConnections[0].id;
  const activeConnection = normalizedConnections.find((item) => item.id === activeConnectionId);

  return {
    ...defaultSettings,
    ...input,
    activeConnectionId,
    connections: normalizedConnections,
    theme: {
      ...defaultSettings.theme,
      ...(input?.theme || {}),
      ringColors: {
        ...defaultSettings.theme.ringColors,
        ...(input?.theme?.ringColors || {})
      }
    },
    ssh: {
      ...defaultSettings.ssh,
      ...(activeConnection?.ssh || {})
    }
  };
}

function sendMonitoringState(extra = {}) {
  mainWindow?.webContents.send("monitor:state", {
    active: monitoringActive,
    reconnecting,
    reconnectAttempts,
    autoStart: autoStartState,
    ...extra
  });
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(getSettingsPath(), "utf8");
    return mergeSettings(JSON.parse(raw));
  } catch {
    return { ...defaultSettings };
  }
}

function saveSettings(settings) {
  fs.writeFileSync(getSettingsPath(), JSON.stringify(mergeSettings(settings), null, 2), "utf8");
}

function createWindow() {
  const settings = loadSettings();
  mainWindow = new BrowserWindow({
    width: 1050,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: Boolean(settings.alwaysOnTop),
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

async function ensureAutoLaunch(enabled) {
  const launcher = new AutoLaunch({
    name: "SSH Monitor Widget",
    path: app.getPath("exe")
  });

  autoStartState = {
    requested: Boolean(enabled),
    effective: false,
    message: ""
  };

  try {
    const alreadyEnabled = await launcher.isEnabled();
    if (enabled && !alreadyEnabled) {
      await launcher.enable();
    } else if (!enabled && alreadyEnabled) {
      await launcher.disable();
    }
    const effective = await launcher.isEnabled();
    autoStartState = {
      requested: Boolean(enabled),
      effective,
      message: enabled && !effective ? "未生效，可能需要管理员权限" : ""
    };
    if (enabled && !effective) {
      log.warn("Autostart requested but not effective");
    } else {
      log.info("Autostart state updated", autoStartState);
    }
  } catch (error) {
    autoStartState = {
      requested: Boolean(enabled),
      effective: false,
      message: `配置失败: ${error.message || "unknown error"}`
    };
    log.error("Autostart configuration failed", error);
  }

  sendMonitoringState();
}

function buildCollectorScript() {
  return `#!/usr/bin/env bash
set +e

cpu_model="$(awk -F: '/model name/{gsub(/^[ \\t]+/, "", $2); print $2; exit}' /proc/cpuinfo 2>/dev/null)"
cpu_cores="$(nproc 2>/dev/null || echo 0)"
cpu_freq="$(awk -F: '/cpu MHz/{gsub(/^[ \\t]+/, "", $2); print $2; exit}' /proc/cpuinfo 2>/dev/null)"
if [[ -z "$cpu_freq" ]]; then
  cpu_freq="$(lscpu 2>/dev/null | awk -F: '/CPU max MHz/{gsub(/^[ \\t]+/, "", $2); print $2; exit}')"
fi
if [[ -z "$cpu_freq" ]]; then
  cpu_freq="0"
fi

cpu_usage="$(top -bn1 2>/dev/null | awk -F',' '/Cpu\\(s\\)/{for(i=1;i<=NF;i++){if($i ~ /id/){gsub(/[^0-9.]/, "", $i); print 100-$i; exit}}}')"
if [[ -z "$cpu_usage" ]]; then
  cpu_usage="0"
fi

mem_total_kb="$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null)"
mem_avail_kb="$(awk '/^MemAvailable:/{print $2}' /proc/meminfo 2>/dev/null)"
if [[ -z "$mem_avail_kb" ]]; then
  mem_free_kb="$(awk '/^MemFree:/{print $2}' /proc/meminfo 2>/dev/null)"
  mem_buffers_kb="$(awk '/^Buffers:/{print $2}' /proc/meminfo 2>/dev/null)"
  mem_cached_kb="$(awk '/^Cached:/{print $2}' /proc/meminfo 2>/dev/null)"
  mem_avail_kb=$(( \${mem_free_kb:-0} + \${mem_buffers_kb:-0} + \${mem_cached_kb:-0} ))
fi
if [[ -z "$mem_total_kb" ]]; then mem_total_kb="0"; fi
if [[ -z "$mem_avail_kb" ]]; then mem_avail_kb="0"; fi
mem_used_kb=$(( mem_total_kb - mem_avail_kb ))
if (( mem_used_kb < 0 )); then mem_used_kb=0; fi
mem_total_mb="$(awk -v kb="$mem_total_kb" 'BEGIN{printf "%.0f", kb/1024}')"
mem_used_mb="$(awk -v kb="$mem_used_kb" 'BEGIN{printf "%.0f", kb/1024}')"
mem_usage="$(awk -v t="$mem_total_mb" -v u="$mem_used_mb" 'BEGIN{if(t>0){printf "%.2f", (u/t)*100}else{print "0"}}')"

net_rx_bytes="$(awk -F'[: ]+' '$1 !~ /lo/ && $1 ~ /[a-zA-Z0-9_.-]+/ {sum += $3} END{print sum+0}' /proc/net/dev 2>/dev/null)"
net_tx_bytes="$(awk -F'[: ]+' '$1 !~ /lo/ && $1 ~ /[a-zA-Z0-9_.-]+/ {sum += $11} END{print sum+0}' /proc/net/dev 2>/dev/null)"

echo "CPU_MODEL=$cpu_model"
echo "CPU_CORES=$cpu_cores"
echo "CPU_FREQ_MHZ=$cpu_freq"
echo "CPU_USAGE=$cpu_usage"
echo "MEM_TOTAL_MB=$mem_total_mb"
echo "MEM_USED_MB=$mem_used_mb"
echo "MEM_USAGE=$mem_usage"
echo "NET_RX_BYTES=$net_rx_bytes"
echo "NET_TX_BYTES=$net_tx_bytes"

echo "TOP_CPU_BEGIN"
ps -eo pid,comm,%cpu --sort=-%cpu 2>/dev/null | sed 1d | head -n 5 | awk '{printf "%s|%s|%s\\n", $1, $2, $3}'
echo "TOP_CPU_END"

echo "TOP_MEM_BEGIN"
ps -eo pid,comm,%mem,rss --sort=-%mem 2>/dev/null | sed 1d | head -n 5 | awk '{printf "%s|%s|%s|%s\\n", $1, $2, $3, $4}'
echo "TOP_MEM_END"

if command -v nethogs >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
  echo "TOP_NET_MODE=traffic"
  echo "TOP_NET_BEGIN"
  sudo -n nethogs -t -c 1 2>/dev/null | awk '/\\//{if(NF>=3){name=$1;sent=$(NF-1);recv=$NF;gsub(/KB\\/sec/, "", sent);gsub(/KB\\/sec/, "", recv);split(name, a, "/");printf "%s|%s|%s\\n", a[1], sent, recv}}' | head -n 5
  echo "TOP_NET_END"
else
  echo "TOP_NET_MODE=connections"
  echo "TOP_NET_BEGIN"
  ss -tunp 2>/dev/null | awk -F'"' '/users:\\(\\(/ {if ($2 != "") cnt[$2]++} END{for (n in cnt) print n "|" cnt[n]}' | sort -t'|' -k2 -nr | head -n 5
  echo "TOP_NET_END"
fi
`;
}

function buildConnectOptions(config) {
  return {
    host: config.host,
    port: Number(config.port || 22),
    username: config.username,
    password: config.password || undefined,
    privateKey: config.privateKey ? fs.readFileSync(config.privateKey, "utf8") : undefined,
    readyTimeout: 12000,
    keepaliveInterval: 8000,
    keepaliveCountMax: 3
  };
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function closeActiveConnection() {
  clearReconnectTimer();
  pendingConnect = null;
  const closing = sshConn;
  if (sshConn) {
    try {
      sshConn.removeAllListeners();
      sshConn.end();
    } catch {
      // Ignore close errors during teardown.
    }
  }
  sshConn = null;
  isSSHReady = false;
  return closing;
}

function scheduleReconnect(reason) {
  if (!monitoringActive || reconnecting) {
    return;
  }
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    monitoringActive = false;
    reconnecting = false;
    clearReconnectTimer();
    mainWindow?.webContents.send("metrics:update", {
      ok: false,
      error: `连接失败，已重试 ${MAX_RECONNECT_ATTEMPTS} 次：${reason || "unknown"}`
    });
    sendMonitoringState();
    return;
  }
  reconnecting = true;
  reconnectAttempts += 1;
  sendMonitoringState({ reconnectReason: reason || "" });
  clearReconnectTimer();
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await ensureConnection(currentSSHConfig);
      reconnecting = false;
      reconnectAttempts = 0;
      sendMonitoringState();
      log.info("SSH reconnect succeeded");
    } catch (error) {
      reconnecting = false;
      log.warn("SSH reconnect failed", error?.message || error);
      scheduleReconnect(error?.message || "reconnect failed");
    }
  }, DEFAULT_RECONNECT_DELAY_MS);
}

function ensureConnection(config) {
  if (!config?.host || !config?.username) {
    return Promise.reject(new Error("请先填写 Host 和 Username"));
  }
  if (isSSHReady && sshConn) {
    return Promise.resolve(sshConn);
  }
  if (pendingConnect) {
    return pendingConnect;
  }

  pendingConnect = new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;

    const finalizeReject = (error) => {
      if (settled) return;
      settled = true;
      pendingConnect = null;
      isSSHReady = false;
      if (sshConn === conn) {
        sshConn = null;
      }
      reject(error);
    };

    conn
      .on("ready", () => {
        settled = true;
        sshConn = conn;
        isSSHReady = true;
        pendingConnect = null;
        reconnectAttempts = 0;
        log.info("SSH connected", { host: config.host, user: config.username });
        resolve(conn);
      })
      .on("error", (error) => {
        isSSHReady = false;
        if (!settled) {
          finalizeReject(error);
          return;
        }
        log.warn("SSH connection error", error?.message || error);
        scheduleReconnect(error?.message || "ssh error");
      })
      .on("close", () => {
        isSSHReady = false;
        if (sshConn === conn) {
          sshConn = null;
        }
        if (!settled) {
          finalizeReject(new Error("SSH 连接已关闭"));
          return;
        }
        scheduleReconnect("SSH 连接断开");
      });

    try {
      conn.connect(buildConnectOptions(config));
    } catch (error) {
      finalizeReject(error);
    }
  });

  return pendingConnect;
}

async function execSSH(config, command) {
  const conn = await ensureConnection(config);
  return new Promise((resolve, reject) => {
    const chunks = [];
    const errors = [];
    conn.exec(command, (execError, stream) => {
      if (execError) {
        reject(execError);
        return;
      }
      stream
        .on("close", () => {
          if (chunks.length === 0 && errors.length > 0) {
            reject(new Error(errors.join("")));
            return;
          }
          resolve(chunks.join(""));
        })
        .on("data", (data) => chunks.push(data.toString()));
      stream.stderr.on("data", (data) => errors.push(data.toString()));
    });
  });
}

function parseTopBlock(lines, startTag, endTag, parser) {
  const startIndex = lines.indexOf(startTag);
  const endIndex = lines.indexOf(endTag);
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return [];
  }
  return lines.slice(startIndex + 1, endIndex).filter(Boolean).map(parser).filter(Boolean);
}

function parseCollectorOutput(raw, previousTotals) {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const map = {};
  lines.forEach((line) => {
    if (!line.includes("=")) {
      return;
    }
    const idx = line.indexOf("=");
    const key = line.slice(0, idx);
    const value = line.slice(idx + 1);
    map[key] = value;
  });

  const rxBytes = Number(map.NET_RX_BYTES || 0);
  const txBytes = Number(map.NET_TX_BYTES || 0);
  const totalBytes = rxBytes + txBytes;
  let netUsagePercent = 0;
  let rxRate = 0;
  let txRate = 0;

  if (previousTotals) {
    const deltaRx = Math.max(0, rxBytes - previousTotals.rxBytes);
    const deltaTx = Math.max(0, txBytes - previousTotals.txBytes);
    rxRate = deltaRx / (POLL_INTERVAL_MS / 1000);
    txRate = deltaTx / (POLL_INTERVAL_MS / 1000);
    const totalRate = rxRate + txRate;
    const refBytesPerSec = (networkCapacityMbps * 1000 * 1000) / 8;
    netUsagePercent = Math.min(100, (totalRate / refBytesPerSec) * 100);
  }

  const topCPU = parseTopBlock(lines, "TOP_CPU_BEGIN", "TOP_CPU_END", (line) => {
    const [pid, name, cpu] = line.split("|");
    if (!pid || !name) return null;
    return { pid: Number(pid), name, usage: Number(cpu || 0) };
  });

  const topMemory = parseTopBlock(lines, "TOP_MEM_BEGIN", "TOP_MEM_END", (line) => {
    const [pid, name, memoryPercent, rssKb] = line.split("|");
    if (!pid || !name) return null;
    return {
      pid: Number(pid),
      name,
      usage: Number(memoryPercent || 0),
      rssMb: Number(rssKb || 0) / 1024
    };
  });

  const netMode = map.TOP_NET_MODE || "connections";
  const topNetwork = parseTopBlock(lines, "TOP_NET_BEGIN", "TOP_NET_END", (line) => {
    const values = line.split("|");
    if (netMode === "traffic") {
      const [name, sent, recv] = values;
      if (!name) return null;
      return {
        name,
        sentKBps: Number(sent || 0),
        recvKBps: Number(recv || 0),
        totalKBps: Number(sent || 0) + Number(recv || 0)
      };
    }
    const [name, connections] = values;
    if (!name) return null;
    return {
      name,
      connections: Number(connections || 0)
    };
  });

  return {
    timestamp: Date.now(),
    cpu: {
      model: map.CPU_MODEL || "-",
      cores: Number(map.CPU_CORES || 0),
      frequencyMHz: Number(map.CPU_FREQ_MHZ || 0),
      usagePercent: Number(map.CPU_USAGE || 0),
      topProcesses: topCPU
    },
    memory: {
      totalMB: Number(map.MEM_TOTAL_MB || 0),
      usedMB: Number(map.MEM_USED_MB || 0),
      usagePercent: Number(map.MEM_USAGE || 0),
      topProcesses: topMemory
    },
    network: {
      rxBytes,
      txBytes,
      totalBytes,
      rxRateBytesPerSec: rxRate,
      txRateBytesPerSec: txRate,
      usagePercent: netUsagePercent,
      topMode: netMode,
      topProcesses: topNetwork
    },
    _totals: {
      rxBytes,
      txBytes
    }
  };
}

async function collectMetrics(config) {
  const script = buildCollectorScript();
  const encoded = Buffer.from(script, "utf8").toString("base64");
  const command = `bash -lc "echo '${encoded}' | base64 -d | bash"`;
  const output = await execSSH(config, command);
  const parsed = parseCollectorOutput(output, lastNetworkTotals);
  lastNetworkTotals = parsed._totals;
  delete parsed._totals;
  return parsed;
}

function startPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  clearReconnectTimer();
  reconnectAttempts = 0;
  reconnecting = false;
  collectInFlight = false;
  lastNetworkTotals = null;

  if (!currentSSHConfig?.host || !currentSSHConfig?.username) {
    monitoringActive = false;
    sendMonitoringState();
    return;
  }

  const tick = async () => {
    if (!monitoringActive || collectInFlight || reconnecting) {
      return;
    }
    collectInFlight = true;
    try {
      const metrics = await collectMetrics(currentSSHConfig);
      mainWindow?.webContents.send("metrics:update", { ok: true, data: metrics });
      reconnectAttempts = 0;
    } catch (error) {
      scheduleReconnect(error.message || "collect failed");
      mainWindow?.webContents.send("metrics:update", {
        ok: false,
        error: error.message || "SSH collect failed."
      });
      log.warn("Collect metrics failed", error?.message || error);
    } finally {
      collectInFlight = false;
    }
  };

  monitoringActive = true;
  sendMonitoringState();
  tick();
  pollTimer = setInterval(tick, POLL_INTERVAL_MS);
  log.info("Polling started");
}

function stopPolling() {
  monitoringActive = false;
  reconnecting = false;
  reconnectAttempts = 0;
  collectInFlight = false;
  clearReconnectTimer();
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  closeActiveConnection();
  sendMonitoringState();
  log.info("Polling stopped");
}

app.whenReady().then(() => {
  const settings = loadSettings();
  networkCapacityMbps = Math.max(1, Number(settings.networkCapacityMbps || DEFAULT_NETWORK_CAPACITY_MBPS));
  ensureAutoLaunch(Boolean(settings.autoStart));
  currentSSHConfig = settings.ssh;

  createWindow();

  ipcMain.handle("settings:get", () => loadSettings());

  ipcMain.handle("settings:save", async (_, nextSettings) => {
    const previous = mergeSettings(loadSettings());
    const merged = mergeSettings(nextSettings);
    saveSettings(merged);
    const active = merged.connections.find((item) => item.id === merged.activeConnectionId);
    currentSSHConfig = active?.ssh || merged.ssh;
    networkCapacityMbps = Math.max(1, Number(merged.networkCapacityMbps || DEFAULT_NETWORK_CAPACITY_MBPS));
    mainWindow?.setAlwaysOnTop(Boolean(merged.alwaysOnTop));
    await ensureAutoLaunch(Boolean(merged.autoStart));
    if (monitoringActive) {
      const prevActive = previous.connections.find((item) => item.id === previous.activeConnectionId);
      const prevSSH = prevActive?.ssh || previous.ssh || {};
      const nextSSH = active?.ssh || merged.ssh || {};
      const sshChanged =
        prevSSH.host !== nextSSH.host ||
        Number(prevSSH.port || 22) !== Number(nextSSH.port || 22) ||
        prevSSH.username !== nextSSH.username ||
        prevSSH.password !== nextSSH.password ||
        prevSSH.privateKey !== nextSSH.privateKey;
      if (sshChanged) {
        closeActiveConnection();
      }
      startPolling();
    }
    log.info("Settings saved");
    return merged;
  });

  ipcMain.handle("monitor:start", (_, payload) => {
    const targetId = payload?.connectionId;
    const inputSSH = payload?.sshConfig || {};
    const saved = mergeSettings(loadSettings());
    const selectedId = saved.connections.some((item) => item.id === targetId)
      ? targetId
      : saved.activeConnectionId;

    const updatedConnections = saved.connections.map((item) =>
      item.id === selectedId
        ? {
            ...item,
            ssh: {
              ...item.ssh,
              ...inputSSH
            }
          }
        : item
    );

    const merged = mergeSettings({
      ...saved,
      activeConnectionId: selectedId,
      connections: updatedConnections
    });
    saveSettings(merged);
    const active = merged.connections.find((item) => item.id === merged.activeConnectionId);
    currentSSHConfig = active?.ssh || merged.ssh;
    closeActiveConnection();
    startPolling();
    return true;
  });

  ipcMain.handle("monitor:stop", () => {
    stopPolling();
    return true;
  });

  ipcMain.handle("monitor:test", async (_, payload) => {
    const startedAt = Date.now();
    const sshConfig = payload?.sshConfig || {};
    const probe = `bash -lc "echo ok"`;
    let tempConn = null;
    try {
      const output = await new Promise((resolve, reject) => {
        const conn = new Client();
        tempConn = conn;
        const chunks = [];
        conn
          .on("ready", () => {
            conn.exec(probe, (execError, stream) => {
              if (execError) {
                conn.end();
                reject(execError);
                return;
              }
              stream
                .on("close", () => {
                  conn.end();
                  resolve(chunks.join(""));
                })
                .on("data", (data) => chunks.push(data.toString()));
            });
          })
          .on("error", (error) => reject(error))
          .connect(buildConnectOptions(sshConfig));
      });
      log.info("SSH test succeeded", { elapsedMs: Date.now() - startedAt, output: String(output).trim() });
      return { ok: true, elapsedMs: Date.now() - startedAt };
    } catch (error) {
      log.warn("SSH test failed", error?.message || error);
      return { ok: false, elapsedMs: Date.now() - startedAt, error: error.message || "SSH 测试失败" };
    } finally {
      if (tempConn) {
        try {
          tempConn.end();
        } catch {
          // Ignore close errors.
        }
      }
    }
  });

  ipcMain.handle("monitor:state", () => ({
    active: monitoringActive,
    reconnecting,
    reconnectAttempts,
    autoStart: autoStartState
  }));

  ipcMain.handle("dialog:pickImage", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return "";
    }
    return result.filePaths[0];
  });

  ipcMain.on("window:minimize", () => mainWindow?.minimize());
  ipcMain.on("window:close", () => mainWindow?.close());

  startPolling();
  sendMonitoringState();
});

app.on("window-all-closed", () => {
  stopPolling();
  if (process.platform !== "darwin") {
    app.quit();
  }
});
