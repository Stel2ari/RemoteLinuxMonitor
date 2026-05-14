const state = {
  settings: null,
  selectedConnectionId: "",
  selectedConnection: null,
  onlineIds: new Set(),
  connectionQuery: "",
  highlightedConnectionId: "",
  monitorState: {
    active: false,
    reconnecting: false,
    reconnectAttempts: 0,
    autoStart: {
      requested: false,
      effective: false,
      message: ""
    }
  },
  errorStreak: 0
};

const el = {
  app: document.getElementById("app"),
  status: document.getElementById("status"),
  host: document.getElementById("host"),
  port: document.getElementById("port"),
  username: document.getElementById("username"),
  password: document.getElementById("password"),
  privateKey: document.getElementById("privateKey"),
  connectionSearch: document.getElementById("connectionSearch"),
  btnClearSearch: document.getElementById("btn-clear-search"),
  tabConnection: document.getElementById("tab-connection"),
  tabTheme: document.getElementById("tab-theme"),
  viewConnection: document.getElementById("view-connection"),
  viewTheme: document.getElementById("view-theme"),
  connectionTabs: document.getElementById("connectionTabs"),
  connectionName: document.getElementById("connectionName"),
  btnFavConn: document.getElementById("btn-fav-conn"),
  btnNewConn: document.getElementById("btn-new-conn"),
  btnDeleteConn: document.getElementById("btn-delete-conn"),
  autoStart: document.getElementById("autoStart"),
  alwaysOnTop: document.getElementById("alwaysOnTop"),
  bgColor: document.getElementById("bgColor"),
  bgOpacity: document.getElementById("bgOpacity"),
  fontSize: document.getElementById("fontSize"),
  fontFamily: document.getElementById("fontFamily"),
  cpuColor: document.getElementById("cpuColor"),
  memColor: document.getElementById("memColor"),
  netColor: document.getElementById("netColor"),
  networkCapacity: document.getElementById("networkCapacity"),
  bgImage: document.getElementById("bgImage"),
  btnConnect: document.getElementById("btn-connect"),
  btnTestConnect: document.getElementById("btn-test-connect"),
  autoStartState: document.getElementById("autoStartState"),
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
  topNetList: document.getElementById("topNetList"),
  metricsPanel: document.querySelector(".metrics-panel")
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
  const selectedId = state.selectedConnectionId || state.settings.activeConnectionId;
  const now = Date.now();
  const normalizedName = (el.connectionName.value || "").trim().slice(0, 20);
  const nextConnections = (state.settings.connections || []).map((item) =>
    item.id === selectedId
      ? {
          ...item,
          name: normalizedName || item.name,
          lastUsedAt: now,
          ssh: {
            host: el.host.value.trim(),
            port: Number(el.port.value || 22),
            username: el.username.value.trim(),
            password: el.password.value,
            privateKey: el.privateKey.value.trim()
          }
        }
      : item
  );

  return {
    ...state.settings,
    autoStart: el.autoStart.checked,
    alwaysOnTop: el.alwaysOnTop.checked,
    networkCapacityMbps: Number(el.networkCapacity.value || 10),
    activeSettingsView: state.settings.activeSettingsView || "connection",
    activeConnectionId: selectedId,
    connections: nextConnections,
    ssh: nextConnections.find((item) => item.id === selectedId)?.ssh || state.settings.ssh,
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

function updateMonitorButton() {
  if (state.monitorState.active) {
    el.btnConnect.textContent = "停止监控";
    el.btnConnect.classList.add("danger");
  } else {
    el.btnConnect.textContent = "启动监控";
    el.btnConnect.classList.remove("danger");
  }
}

function renderAutoStartState() {
  const info = state.monitorState.autoStart || {};
  let text = "开机自启动状态：";
  if (info.requested) {
    text += info.effective ? "已开启" : "未生效";
  } else {
    text += "已关闭";
  }
  if (info.message) {
    text += `（${info.message}）`;
  }
  el.autoStartState.textContent = text;
}

function updateMonitorState(nextState = {}) {
  state.monitorState = {
    ...state.monitorState,
    ...nextState,
    autoStart: {
      ...(state.monitorState.autoStart || {}),
      ...(nextState.autoStart || {})
    }
  };
  updateMonitorButton();
  renderAutoStartState();
}

function getDisplayConnections(settings) {
  const list = [...(settings.connections || [])];
  list.sort((a, b) => {
    const aFav = a.favorite ? 1 : 0;
    const bFav = b.favorite ? 1 : 0;
    if (aFav !== bFav) return bFav - aFav;
    const aUsed = Number(a.lastUsedAt || 0);
    const bUsed = Number(b.lastUsedAt || 0);
    if (aUsed !== bUsed) return bUsed - aUsed;
    return String(a.name || "").localeCompare(String(b.name || ""), "zh-CN");
  });
  return list;
}

function getFilteredConnections(settings) {
  const display = getDisplayConnections(settings);
  const keyword = state.connectionQuery.trim().toLowerCase();
  if (!keyword) return display;
  return display.filter((item) => {
    const name = String(item.name || "").toLowerCase();
    const host = String(item.ssh?.host || "").toLowerCase();
    const user = String(item.ssh?.username || "").toLowerCase();
    return name.includes(keyword) || host.includes(keyword) || user.includes(keyword);
  });
}

function renderConnectionTabs(settings) {
  const filtered = getFilteredConnections(settings);
  if (filtered.length === 0) {
    state.highlightedConnectionId = "";
    el.connectionTabs.innerHTML = `<span class="muted">未找到匹配连接</span>`;
    return;
  }
  const hasHighlighted = filtered.some((item) => item.id === state.highlightedConnectionId);
  if (!hasHighlighted) {
    state.highlightedConnectionId = filtered[0].id;
  }
  el.connectionTabs.innerHTML = filtered
    .map((item) => {
      const activeClass = item.id === settings.activeConnectionId ? "active" : "";
      const kbdClass = item.id === state.highlightedConnectionId ? "kbd-active" : "";
      const favClass = item.favorite ? "favorite" : "";
      const onlineClass = state.onlineIds.has(item.id) ? "online" : "";
      const safeName = String(item.name || "").slice(0, 20);
      return `<button type="button" class="connection-tab ${activeClass} ${kbdClass}" data-conn-id="${item.id}" title="${safeName}">
        <span class="connection-tab-dot ${favClass} ${onlineClass}"></span>
        <span>${safeName}</span>
      </button>`;
    })
    .join("");
}

function fillForm(settings) {
  const activeId = settings.activeConnectionId || settings.connections?.[0]?.id || "";
  const selected = settings.connections?.find((item) => item.id === activeId);
  const ssh = selected?.ssh || settings.ssh;
  state.selectedConnectionId = activeId;
  state.selectedConnection = selected || null;
  renderConnectionTabs(settings);
  el.btnClearSearch.classList.toggle("visible", Boolean(state.connectionQuery.trim()));
  el.btnFavConn.classList.toggle("active", Boolean(selected?.favorite));
  el.btnFavConn.textContent = selected?.favorite ? "★" : "☆";
  el.connectionName.value = selected?.name || "默认连接";
  el.host.value = ssh.host;
  el.port.value = ssh.port;
  el.username.value = ssh.username;
  el.password.value = ssh.password;
  el.privateKey.value = ssh.privateKey;
  el.autoStart.checked = !!settings.autoStart;
  el.alwaysOnTop.checked = settings.alwaysOnTop !== false;
  el.bgColor.value = settings.theme.backgroundColor;
  el.bgOpacity.value = settings.theme.backgroundOpacity;
  el.fontSize.value = settings.theme.fontSize;
  el.fontFamily.value = settings.theme.fontFamily;
  el.bgImage.value = settings.theme.backgroundImage || "";
  el.cpuColor.value = settings.theme.ringColors.cpu;
  el.memColor.value = settings.theme.ringColors.memory;
  el.netColor.value = settings.theme.ringColors.network;
  el.networkCapacity.value = Number(settings.networkCapacityMbps || 10);
}

function randomConnId() {
  return `conn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
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
  el.status.classList.toggle("status-error", isError);
  el.metricsPanel.classList.toggle("metrics-panel-error", isError);
}

function setSettingsView(mode) {
  const showConnection = mode === "connection";
  el.tabConnection.classList.toggle("active", showConnection);
  el.tabTheme.classList.toggle("active", !showConnection);
  el.viewConnection.classList.toggle("hidden", !showConnection);
  el.viewTheme.classList.toggle("hidden", showConnection);
  const activeView = showConnection ? el.viewConnection : el.viewTheme;
  activeView.classList.remove("fade-in");
  void activeView.offsetWidth;
  activeView.classList.add("fade-in");
  state.settings = {
    ...state.settings,
    activeSettingsView: showConnection ? "connection" : "theme"
  };
}

async function activateConnection(targetId, messagePrefix = "已切换到连接") {
  state.selectedConnectionId = targetId;
  state.highlightedConnectionId = targetId;
  const next = {
    ...state.settings,
    activeConnectionId: targetId,
    connections: (state.settings.connections || []).map((item) =>
      item.id === targetId
        ? {
            ...item,
            lastUsedAt: Date.now()
          }
        : item
    )
  };
  state.settings = await window.desktopAPI.saveSettings(next);
  fillForm(state.settings);
  const selected = state.settings.connections.find((item) => item.id === targetId);
  if (state.monitorState.active) {
    setStatus(`已切换并继续监控：${selected?.name || "-"}`);
  } else {
    setStatus(`${messagePrefix}：${selected?.name || "-"}`);
  }
}

async function boot() {
  state.settings = await window.desktopAPI.getSettings();
  updateMonitorState(await window.desktopAPI.getMonitorState());
  fillForm(state.settings);
  applyTheme(state.settings.theme);

  const persist = async () => {
    state.settings = await window.desktopAPI.saveSettings(settingsFromForm());
    state.selectedConnectionId = state.settings.activeConnectionId;
    applyTheme(state.settings.theme);
    fillForm(state.settings);
    updateMonitorState(await window.desktopAPI.getMonitorState());
  };

  el.autoStart.addEventListener("change", async () => {
    await persist();
    setStatus(el.autoStart.checked ? "已开启开机自启动。" : "已关闭开机自启动。");
  });

  el.alwaysOnTop.addEventListener("change", async () => {
    await persist();
    setStatus(el.alwaysOnTop.checked ? "已开启窗口置顶。" : "已关闭窗口置顶。");
  });

  el.btnConnect.addEventListener("click", async () => {
    if (state.monitorState.active) {
      await window.desktopAPI.stopMonitor();
      updateMonitorState({ active: false, reconnecting: false, reconnectAttempts: 0 });
      setStatus("监控已停止。");
      return;
    }
    await persist();
    const selected = state.settings.connections.find((item) => item.id === state.settings.activeConnectionId);
    await window.desktopAPI.startMonitor({
      connectionId: state.settings.activeConnectionId,
      sshConfig: selected?.ssh || state.settings.ssh
    });
    updateMonitorState({ active: true, reconnecting: false, reconnectAttempts: 0 });
    setStatus(`监控已启动：${selected?.name || "当前连接"}（每5秒刷新）`);
  });

  el.btnTestConnect.addEventListener("click", async () => {
    const draft = settingsFromForm();
    const selected = draft.connections.find((item) => item.id === draft.activeConnectionId);
    setStatus("正在测试 SSH 连接...");
    const result = await window.desktopAPI.testMonitor({
      sshConfig: selected?.ssh || draft.ssh
    });
    if (result.ok) {
      setStatus(`连接测试成功，握手耗时 ${result.elapsedMs}ms`);
    } else {
      setStatus(`连接测试失败：${result.error || "unknown"}（${result.elapsedMs}ms）`, true);
    }
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

  el.connectionSearch.addEventListener("input", () => {
    state.connectionQuery = el.connectionSearch.value;
    const filtered = getFilteredConnections(state.settings);
    state.highlightedConnectionId = filtered[0]?.id || "";
    el.btnClearSearch.classList.toggle("visible", Boolean(state.connectionQuery.trim()));
    renderConnectionTabs(state.settings);
  });

  el.connectionSearch.addEventListener("keydown", async (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!state.connectionQuery.trim()) return;
      state.connectionQuery = "";
      el.connectionSearch.value = "";
      el.btnClearSearch.classList.remove("visible");
      renderConnectionTabs(state.settings);
      setStatus("搜索已清空。");
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const filtered = getFilteredConnections(state.settings);
      if (filtered.length === 0) {
        setStatus("没有可切换的匹配连接。", true);
      } else if (state.highlightedConnectionId) {
        await activateConnection(state.highlightedConnectionId, "已快速切换到连接");
      } else if (filtered.length === 1) {
        await activateConnection(filtered[0].id, "已快速切换到连接");
      } else {
        setStatus("请继续输入，直到只剩一个匹配项。");
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const filtered = getFilteredConnections(state.settings);
      if (filtered.length === 0) return;
      const currentIndex = Math.max(
        0,
        filtered.findIndex((item) => item.id === state.highlightedConnectionId)
      );
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex = (currentIndex + delta + filtered.length) % filtered.length;
      state.highlightedConnectionId = filtered[nextIndex].id;
      renderConnectionTabs(state.settings);
    }
  });

  el.btnClearSearch.addEventListener("click", () => {
    if (!state.connectionQuery.trim()) return;
    state.connectionQuery = "";
    el.connectionSearch.value = "";
    state.highlightedConnectionId = "";
    el.btnClearSearch.classList.remove("visible");
    renderConnectionTabs(state.settings);
    setStatus("搜索已清空。");
  });

  el.tabConnection.addEventListener("click", async () => {
    setSettingsView("connection");
    state.settings = await window.desktopAPI.saveSettings(state.settings);
  });
  el.tabTheme.addEventListener("click", async () => {
    setSettingsView("theme");
    state.settings = await window.desktopAPI.saveSettings(state.settings);
  });

  el.connectionTabs.addEventListener("click", async (event) => {
    const button = event.target.closest(".connection-tab");
    if (!button) return;
    const targetId = button.dataset.connId;
    if (!targetId) return;
    await activateConnection(targetId);
  });

  el.connectionName.addEventListener("blur", async () => {
    if (el.connectionName.value.length > 20) {
      el.connectionName.value = el.connectionName.value.slice(0, 20);
    }
    await persist();
  });

  el.btnFavConn.addEventListener("click", async () => {
    const targetId = state.settings.activeConnectionId;
    state.settings = await window.desktopAPI.saveSettings({
      ...state.settings,
      connections: (state.settings.connections || []).map((item) =>
        item.id === targetId
          ? {
              ...item,
              favorite: !item.favorite
            }
          : item
      )
    });
    fillForm(state.settings);
    const current = state.settings.connections.find((item) => item.id === targetId);
    setStatus(current?.favorite ? "已收藏当前连接。" : "已取消收藏当前连接。");
  });

  el.btnNewConn.addEventListener("click", async () => {
    if ((state.settings.connections || []).length >= 5) {
      setStatus("最多只能创建 5 个连接。", true);
      return;
    }
    const newId = randomConnId();
    const nextConnections = [
      ...(state.settings.connections || []),
      {
        id: newId,
        name: `连接 ${(state.settings.connections || []).length + 1}`,
        favorite: false,
        lastUsedAt: Date.now(),
        ssh: {
          host: "",
          port: 22,
          username: "",
          password: "",
          privateKey: ""
        }
      }
    ];
    state.settings = await window.desktopAPI.saveSettings({
      ...state.settings,
      activeConnectionId: newId,
      connections: nextConnections
    });
    fillForm(state.settings);
    setStatus("已新增连接，请填写 SSH 信息。");
  });

  el.btnDeleteConn.addEventListener("click", async () => {
    if ((state.settings.connections || []).length <= 1) {
      setStatus("至少保留一个连接。", true);
      return;
    }
    const targetId = state.settings.activeConnectionId;
    const remaining = state.settings.connections.filter((item) => item.id !== targetId);
    const nextActiveId = remaining[0].id;
    state.settings = await window.desktopAPI.saveSettings({
      ...state.settings,
      activeConnectionId: nextActiveId,
      connections: remaining
    });
    fillForm(state.settings);
    setStatus("已删除当前连接。");
  });

  el.btnMin.addEventListener("click", () => window.desktopAPI.minimize());
  el.btnClose.addEventListener("click", () => window.desktopAPI.close());

  window.desktopAPI.onMetrics((payload) => {
    if (!payload.ok) {
      state.errorStreak += 1;
      state.onlineIds.delete(state.settings.activeConnectionId);
      const suffix = state.errorStreak >= 3 ? "（已连续失败，请检查 SSH 配置或网络）" : "";
      setStatus(`采集失败: ${payload.error}${suffix}`, true);
      renderConnectionTabs(state.settings);
      return;
    }
    state.errorStreak = 0;
    state.onlineIds.add(state.settings.activeConnectionId);
    renderConnectionTabs(state.settings);
    setStatus(`上次更新: ${new Date(payload.data.timestamp).toLocaleString()}`);
    renderMetrics(payload.data);
  });

  window.desktopAPI.onMonitorState((nextState) => {
    updateMonitorState(nextState);
    if (nextState.reconnecting) {
      setStatus(`连接断开，正在重连...（第 ${nextState.reconnectAttempts || 0} 次）`, true);
    }
  });

  setSettingsView(state.settings.activeSettingsView || "connection");
}

boot();
