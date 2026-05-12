const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const AutoLaunch = require("auto-launch");
const { Client } = require("ssh2");

const POLL_INTERVAL_MS = 5000;
const DEFAULT_NETWORK_CAPACITY_MBPS = 10;
let mainWindow = null;
let pollTimer = null;
let lastNetworkTotals = null;
let currentSSHConfig = null;

const defaultSettings = {
  autoStart: true,
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
  return {
    ...defaultSettings,
    ...input,
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
      ...(input?.ssh || {})
    }
  };
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
  mainWindow = new BrowserWindow({
    width: 1050,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

function ensureAutoLaunch(enabled) {
  const launcher = new AutoLaunch({
    name: "SSH Monitor Widget",
    path: app.getPath("exe")
  });

  launcher
    .isEnabled()
    .then((alreadyEnabled) => {
      if (enabled && !alreadyEnabled) {
        return launcher.enable();
      }
      if (!enabled && alreadyEnabled) {
        return launcher.disable();
      }
      return null;
    })
    .catch(() => {
      // Ignore autostart configuration failures silently.
    });
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

function execSSH(config, command) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const chunks = [];
    const errors = [];

    conn
      .on("ready", () => {
        conn.exec(command, (execError, stream) => {
          if (execError) {
            conn.end();
            reject(execError);
            return;
          }

          stream
            .on("close", () => {
              conn.end();
              if (chunks.length === 0 && errors.length > 0) {
                reject(new Error(errors.join("")));
                return;
              }
              resolve(chunks.join(""));
            })
            .on("data", (data) => chunks.push(data.toString()));

          stream.stderr.on("data", (data) => errors.push(data.toString()));
        });
      })
      .on("error", (error) => reject(error))
      .connect({
        host: config.host,
        port: Number(config.port || 22),
        username: config.username,
        password: config.password || undefined,
        privateKey: config.privateKey ? fs.readFileSync(config.privateKey, "utf8") : undefined,
        readyTimeout: 12000
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
    const refBytesPerSec = (DEFAULT_NETWORK_CAPACITY_MBPS * 1000 * 1000) / 8;
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
  lastNetworkTotals = null;

  if (!currentSSHConfig?.host || !currentSSHConfig?.username) {
    return;
  }

  const tick = async () => {
    try {
      const metrics = await collectMetrics(currentSSHConfig);
      mainWindow?.webContents.send("metrics:update", { ok: true, data: metrics });
    } catch (error) {
      mainWindow?.webContents.send("metrics:update", {
        ok: false,
        error: error.message || "SSH collect failed."
      });
    }
  };

  tick();
  pollTimer = setInterval(tick, POLL_INTERVAL_MS);
}

app.whenReady().then(() => {
  const settings = loadSettings();
  ensureAutoLaunch(Boolean(settings.autoStart));
  currentSSHConfig = settings.ssh;

  createWindow();

  ipcMain.handle("settings:get", () => loadSettings());

  ipcMain.handle("settings:save", (_, nextSettings) => {
    const merged = mergeSettings(nextSettings);
    saveSettings(merged);
    currentSSHConfig = merged.ssh;
    ensureAutoLaunch(Boolean(merged.autoStart));
    startPolling();
    return merged;
  });

  ipcMain.handle("monitor:start", (_, sshConfig) => {
    currentSSHConfig = { ...sshConfig };
    const saved = loadSettings();
    saveSettings({ ...saved, ssh: currentSSHConfig });
    startPolling();
    return true;
  });

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
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
