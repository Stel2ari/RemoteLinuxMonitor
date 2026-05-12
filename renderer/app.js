const state = {
  settings: null
};

const el = {
  app: document.getElementById("app"),
  status: document.getElementById("status"),
  host: document.getElementById("host"),
  port: document.getElementById("port"),
  username: document.getElementById("username"),
  password: document.getElementById("password"),
  privateKey: document.getElementById("privateKey"),
  autoStart: document.getElementById("autoStart"),
  bgColor: document.getElementById("bgColor"),
  bgOpacity: document.getElementById("bgOpacity"),
  fontSize: document.getElementById("fontSize"),
  fontFamily: document.getElementById("fontFamily"),
  cpuColor: document.getElementById("cpuColor"),
  memColor: document.getElementById("memColor"),
  netColor: document.getElementById("netColor"),
  bgImage: document.getElementById("bgImage"),
  btnConnect: document.getElementById("btn-connect"),
  btnSaveTheme: document.getElementById("btn-save-theme"),
  btnPickImage: document.getElementById("btn-pick-image"),
  btnMin: document.getElementById("btn-min"),
  btnClose: document.getElementById("btn-close"),
  cpuGauge: document.getElementById("cpuGauge"),
  memGauge: document.getElementById("memGauge"),
  netGauge: document.getElementById("netGauge"),
  cpuMeta: document.getElementById("cpuMeta"),
  memMeta: document.getElementById("memMeta"),
  netMeta: document.getElementById("netMeta"),
  topCpuList: document.getElementById("topCpuList"),
  topMemList: document.getElementById("topMemList"),
  topNetList: document.getElementById("topNetList")
};

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function fmtMB(mb) {
  if (!Number.isFinite(mb)) return "-";
  if (mb > 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(0)} MB`;
}

function fmtBps(bytes) {
  if (!Number.isFinite(bytes)) return "-";
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB/s`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(2)} KB/s`;
  return `${bytes.toFixed(0)} B/s`;
}

function renderRing(node, percent, color) {
  const safe = clamp(Number(percent) || 0, 0, 100);
  const visible = safe > 0 && safe < 0.1 ? 0.1 : safe;
  node.style.background = `conic-gradient(${color} ${visible * 3.6}deg, rgba(255,255,255,0.1) 0deg)`;
  node.innerHTML = `<span class="ring-value">${visible.toFixed(1)}%</span>`;
}

function renderList(node, rows, renderRight) {
  if (!rows || rows.length === 0) {
    node.innerHTML = `<li><span class="muted">暂无数据</span><span class="muted">-</span></li>`;
    return;
  }
  node.innerHTML = rows
    .map(
      (row) =>
        `<li><span title="${row.name}">${row.name}(${row.pid ?? "-"})</span><span>${renderRight(row)}</span></li>`
    )
    .join("");
}

function applyTheme(theme) {
  document.documentElement.style.setProperty("--bg-color", theme.backgroundColor);
  document.documentElement.style.setProperty("--bg-opacity", String(theme.backgroundOpacity));
  document.documentElement.style.setProperty("--font-size", `${theme.fontSize}px`);
  document.documentElement.style.setProperty("--font-family", theme.fontFamily);
  document.documentElement.style.setProperty("--ring-cpu", theme.ringColors.cpu);
  document.documentElement.style.setProperty("--ring-memory", theme.ringColors.memory);
  document.documentElement.style.setProperty("--ring-network", theme.ringColors.network);

  if (theme.backgroundImage) {
    el.app.style.backgroundImage = `linear-gradient(rgba(0,0,0,0.2),rgba(0,0,0,0.25)), url("file:///${theme.backgroundImage.replaceAll("\\", "/")}")`;
    el.app.style.backgroundSize = "cover";
    el.app.style.backgroundPosition = "center";
  } else {
    el.app.style.backgroundImage = "";
  }
}

function settingsFromForm() {
  return {
    ...state.settings,
    autoStart: el.autoStart.checked,
    ssh: {
      host: el.host.value.trim(),
      port: Number(el.port.value || 22),
      username: el.username.value.trim(),
      password: el.password.value,
      privateKey: el.privateKey.value.trim()
    },
    theme: {
      backgroundColor: el.bgColor.value,
      backgroundOpacity: Number(el.bgOpacity.value),
      fontSize: Number(el.fontSize.value),
      fontFamily: el.fontFamily.value.trim() || "Segoe UI",
      backgroundImage: el.bgImage.value.trim(),
      ringColors: {
        cpu: el.cpuColor.value,
        memory: el.memColor.value,
        network: el.netColor.value
      }
    }
  };
}

function fillForm(settings) {
  el.host.value = settings.ssh.host;
  el.port.value = settings.ssh.port;
  el.username.value = settings.ssh.username;
  el.password.value = settings.ssh.password;
  el.privateKey.value = settings.ssh.privateKey;
  el.autoStart.checked = !!settings.autoStart;
  el.bgColor.value = settings.theme.backgroundColor;
  el.bgOpacity.value = settings.theme.backgroundOpacity;
  el.fontSize.value = settings.theme.fontSize;
  el.fontFamily.value = settings.theme.fontFamily;
  el.bgImage.value = settings.theme.backgroundImage || "";
  el.cpuColor.value = settings.theme.ringColors.cpu;
  el.memColor.value = settings.theme.ringColors.memory;
  el.netColor.value = settings.theme.ringColors.network;
}

function renderMetrics(data) {
  renderRing(el.cpuGauge, data.cpu.usagePercent, state.settings.theme.ringColors.cpu);
  renderRing(el.memGauge, data.memory.usagePercent, state.settings.theme.ringColors.memory);
  renderRing(el.netGauge, data.network.usagePercent, state.settings.theme.ringColors.network);

  el.cpuMeta.textContent = `${data.cpu.model} | ${data.cpu.cores} 核 | ${data.cpu.frequencyMHz.toFixed(0)} MHz`;
  el.memMeta.textContent = `${fmtMB(data.memory.usedMB)} / ${fmtMB(data.memory.totalMB)}`;
  el.netMeta.textContent = `RX ${fmtBps(data.network.rxRateBytesPerSec)} | TX ${fmtBps(
    data.network.txRateBytesPerSec
  )}`;

  renderList(el.topCpuList, data.cpu.topProcesses, (row) => `${row.usage.toFixed(1)}%`);
  renderList(el.topMemList, data.memory.topProcesses, (row) => `${row.usage.toFixed(1)}%`);

  if (data.network.topMode === "traffic") {
    renderList(el.topNetList, data.network.topProcesses, (row) => `${row.totalKBps.toFixed(1)} KB/s`);
  } else {
    renderList(el.topNetList, data.network.topProcesses, (row) => `${row.connections} conn`);
  }
}

function setStatus(text, isError = false) {
  el.status.textContent = text;
  el.status.style.color = isError ? "#ff9ea7" : "#97c3ff";
}

async function boot() {
  state.settings = await window.desktopAPI.getSettings();
  fillForm(state.settings);
  applyTheme(state.settings.theme);

  const persist = async () => {
    state.settings = await window.desktopAPI.saveSettings(settingsFromForm());
    applyTheme(state.settings.theme);
  };

  el.btnConnect.addEventListener("click", async () => {
    await persist();
    await window.desktopAPI.startMonitor(state.settings.ssh);
    setStatus("监控已启动，每5秒刷新一次。");
  });

  el.btnSaveTheme.addEventListener("click", async () => {
    await persist();
    setStatus("主题已保存。");
  });

  el.btnPickImage.addEventListener("click", async () => {
    const selected = await window.desktopAPI.pickImage();
    if (selected) {
      el.bgImage.value = selected;
      await persist();
      setStatus("背景图已更新。");
    }
  });

  [el.bgColor, el.bgOpacity, el.fontSize, el.fontFamily, el.cpuColor, el.memColor, el.netColor].forEach((node) => {
    node.addEventListener("input", () => applyTheme(settingsFromForm().theme));
  });

  el.btnMin.addEventListener("click", () => window.desktopAPI.minimize());
  el.btnClose.addEventListener("click", () => window.desktopAPI.close());

  window.desktopAPI.onMetrics((payload) => {
    if (!payload.ok) {
      setStatus(`采集失败: ${payload.error}`, true);
      return;
    }
    setStatus(`上次更新: ${new Date(payload.data.timestamp).toLocaleTimeString()}`);
    renderMetrics(payload.data);
  });
}

boot();
