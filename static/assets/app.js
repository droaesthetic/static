const tokenInput = document.getElementById("token");
const saveTokenButton = document.getElementById("saveToken");
const refreshButton = document.getElementById("refresh");
const playersNode = document.getElementById("players");
const template = document.getElementById("playerTemplate");
const statusNode = document.getElementById("status");

const storageKey = "dro-tunes-dashboard-token";
const dashboardRefreshMs = 5000;
const activeAuditGuilds = new Set();
const activeVoiceHistoryGuilds = new Set();
const auditRefreshTimers = new Map();
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit"
});

let dashboardRefreshTimer = null;
let isRefreshingPlayers = false;
let queuedPlayersRefresh = false;

tokenInput.value = localStorage.getItem(storageKey) || "";

saveTokenButton.addEventListener("click", async () => {
  localStorage.setItem(storageKey, tokenInput.value.trim());
  await refreshPlayers();
  startDashboardRefresh();
});

tokenInput.addEventListener("keydown", async (event) => {
  if (event.key === "Enter") {
    localStorage.setItem(storageKey, tokenInput.value.trim());
    await refreshPlayers();
    startDashboardRefresh();
  }
});

refreshButton.addEventListener("click", () => refreshPlayers({ force: true }));

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void refreshPlayers();
  }
});

function setStatus(message, tone = "") {
  statusNode.textContent = message;
  statusNode.className = "status-message";
  if (tone) {
    statusNode.classList.add(tone);
  }
}

async function api(path, options = {}) {
  const token = tokenInput.value.trim();
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Request failed (${response.status})`);
  }

  return response.json();
}

function renderPlayers(players) {
  playersNode.replaceChildren();

  if (!players.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No servers are available yet. Use /play in Discord and refresh.";
    playersNode.append(empty);
    setStatus("Connected. No server snapshots yet.", "is-success");
    return;
  }

  setStatus("Connected. Dashboard data loaded.", "is-success");

  for (const player of players) {
    const fragment = template.content.cloneNode(true);
    const card = fragment.querySelector(".player-card");
    const guildName = fragment.querySelector(".guild-name");
    const statusLine = fragment.querySelector(".status-line");
    const volumePill = fragment.querySelector(".volume-pill");
    const serverMeta = fragment.querySelector(".server-meta");
    const nowPlaying = fragment.querySelector(".now-playing");
    const queue = fragment.querySelector(".queue");
    const voiceHistory = fragment.querySelector(".voice-history");
    const voiceHistoryButton = fragment.querySelector("[data-toggle-voice-history]");
    const auditList = fragment.querySelector(".audit-log-list");
    const auditButton = fragment.querySelector("[data-toggle-audit]");
    const slider = fragment.querySelector("[data-volume]");

    const playbackStatus = player.isPaused
      ? "Paused"
      : player.isPlaying
        ? "Playing"
        : "Idle";
    const voiceLabel = formatChannel(player.voiceChannelName, player.voiceChannelId);

    guildName.textContent = player.guildName;
    statusLine.textContent = voiceLabel ? `${playbackStatus} in ${voiceLabel}` : playbackStatus;
    volumePill.textContent = `${player.volume}%`;
    slider.value = player.volume;

    renderServerMeta(serverMeta, player);
    syncVoiceHistoryPanel(player, voiceHistoryButton, voiceHistory);

    if (player.current) {
      nowPlaying.replaceChildren(renderTrackBlock(player.current, "Playing now"));
    } else {
      nowPlaying.textContent = "Nothing is playing right now.";
    }

    if (player.upcoming.length) {
      player.upcoming.slice(0, 8).forEach((track, index) => {
        queue.append(renderTrackBlock(track, `Next ${String(index + 1).padStart(2, "0")}`));
      });

      if (player.upcoming.length > 8) {
        const more = document.createElement("div");
        more.className = "queue-more";
        more.textContent = `+ ${player.upcoming.length - 8} more not shown`;
        queue.append(more);
      }
    } else {
      queue.append(renderEmpty("Queue is empty."));
    }

    for (const button of fragment.querySelectorAll("[data-action]")) {
      button.addEventListener("click", async () => {
        await api(`/api/players/${player.guildId}/${button.dataset.action}`, { method: "POST" });
        await refreshPlayers();
      });
    }

    voiceHistoryButton.addEventListener("click", () => {
      if (activeVoiceHistoryGuilds.has(player.guildId)) {
        activeVoiceHistoryGuilds.delete(player.guildId);
      } else {
        activeVoiceHistoryGuilds.add(player.guildId);
      }

      syncVoiceHistoryPanel(player, voiceHistoryButton, voiceHistory);
    });

    syncAuditPanel(player.guildId, auditButton, auditList);

    auditButton.addEventListener("click", async () => {
      const isActive = activeAuditGuilds.has(player.guildId);
      if (isActive) {
        activeAuditGuilds.delete(player.guildId);
        stopAuditRefresh(player.guildId);
      } else {
        activeAuditGuilds.add(player.guildId);
      }

      syncAuditPanel(player.guildId, auditButton, auditList);
    });

    slider.addEventListener("change", async () => {
      await api(`/api/players/${player.guildId}/volume`, {
        method: "POST",
        body: JSON.stringify({ percent: Number(slider.value) })
      });
      await refreshPlayers();
    });

    playersNode.append(card);
  }
}

function renderServerMeta(node, player) {
  node.replaceChildren(
    renderStat("Voice channel", formatChannel(player.voiceChannelName, player.voiceChannelId) || "Not connected"),
    renderStat("VC members", typeof player.voiceChannelMemberCount === "number" ? String(player.voiceChannelMemberCount) : "Unknown"),
    renderStat("Updates channel", formatChannel(player.textChannelName, player.textChannelId) || "None"),
    renderStat("Filter", player.filterPreset || "off"),
    renderStat("Autoplay", player.autoplay ? "On" : "Off"),
    renderStat("Vote skip", player.voteSkipEnabled ? "On" : "Off")
  );
}

function renderStat(label, value) {
  const item = document.createElement("div");
  item.className = "stat-item";

  const labelNode = document.createElement("span");
  labelNode.textContent = label;

  const valueNode = document.createElement("strong");
  valueNode.textContent = value;

  item.append(labelNode, valueNode);
  return item;
}

function syncVoiceHistoryPanel(player, button, list) {
  const isActive = activeVoiceHistoryGuilds.has(player.guildId);
  list.classList.toggle("is-hidden", !isActive);
  button.textContent = isActive ? "Hide voice history" : "Show voice history";
  button.setAttribute("aria-expanded", String(isActive));

  if (isActive) {
    renderVoiceHistory(list, player.voiceHistory || []);
    return;
  }

  list.replaceChildren(renderEmpty("Select Show voice history to load voice channel changes."));
}

function renderVoiceHistory(node, history) {
  node.replaceChildren();

  if (!history.length) {
    node.append(renderEmpty("No voice channel changes recorded yet."));
    return;
  }

  for (const entry of history.slice(0, 8)) {
    node.append(renderActivityItem(describeVoiceChange(entry), [
      entry.memberName || entry.memberId,
      formatDate(entry.createdAt)
    ]));
  }
}

function describeVoiceChange(entry) {
  const from = formatChannel(entry.fromChannelName, entry.fromChannelId) || "No channel";
  const to = formatChannel(entry.toChannelName, entry.toChannelId) || "No channel";

  if (entry.action === "joined") {
    return `Joined ${to}`;
  }

  if (entry.action === "left") {
    return `Left ${from}`;
  }

  return `Moved from ${from} to ${to}`;
}

function renderAuditLogs(node, logs) {
  node.replaceChildren();

  if (!logs.length) {
    node.append(renderEmpty("No bot settings changes recorded yet."));
    return;
  }

  for (const entry of logs) {
    node.append(renderActivityItem(entry.action, [
      `${entry.oldValue} -> ${entry.newValue}`,
      formatDate(entry.createdAt)
    ]));
  }
}

function syncAuditPanel(guildId, button, list) {
  const isActive = activeAuditGuilds.has(guildId);
  list.classList.toggle("is-hidden", !isActive);
  button.textContent = isActive ? "Hide audit log" : "Show audit log";
  button.setAttribute("aria-expanded", String(isActive));

  if (!isActive) {
    return;
  }

  loadAuditLogs(guildId, list);
  startAuditRefresh(guildId, list);
}

async function loadAuditLogs(guildId, list) {
  list.replaceChildren(renderEmpty("Loading bot settings changes..."));

  try {
    const data = await api(`/api/players/${guildId}/audit-logs?limit=30`);
    renderAuditLogs(list, data.auditLogs || []);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load bot settings changes.";
    list.replaceChildren(renderEmpty(message));
  }
}

function startAuditRefresh(guildId, list) {
  stopAuditRefresh(guildId);
  const timer = window.setInterval(() => {
    if (!activeAuditGuilds.has(guildId) || !document.body.contains(list)) {
      stopAuditRefresh(guildId);
      return;
    }

    loadAuditLogs(guildId, list);
  }, 5000);
  auditRefreshTimers.set(guildId, timer);
}

function stopAuditRefresh(guildId) {
  const timer = auditRefreshTimers.get(guildId);
  if (timer) {
    window.clearInterval(timer);
    auditRefreshTimers.delete(guildId);
  }
}

function renderActivityItem(title, details) {
  const item = document.createElement("div");
  item.className = "activity-item";

  const titleNode = document.createElement("p");
  titleNode.className = "activity-title";
  titleNode.textContent = title;

  const meta = document.createElement("p");
  meta.className = "activity-meta";
  meta.textContent = details.filter(Boolean).join("  |  ");

  item.append(titleNode, meta);
  return item;
}

function renderTrackBlock(track, label) {
  const item = document.createElement("div");
  item.className = "queue-item";

  const labelNode = document.createElement("span");
  labelNode.className = "queue-label";
  labelNode.textContent = label;

  const title = document.createElement("p");
  title.className = "queue-title";
  title.textContent = track.title || "Unknown title";

  const meta = document.createElement("p");
  meta.className = "queue-meta";
  meta.textContent = [
    track.artist || "Unknown artist",
    formatDuration(track.durationInSeconds),
    track.requestedBy ? `Added by ${track.requestedBy}` : ""
  ].filter(Boolean).join("  |  ");

  item.append(labelNode, title, meta);
  return item;
}

function renderEmpty(message) {
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.textContent = message;
  return empty;
}

function formatChannel(name, id) {
  if (name) {
    return `#${name}`;
  }

  if (id) {
    return `Channel ${id}`;
  }

  return "";
}

function formatDate(value) {
  if (!value) {
    return "Unknown time";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown time";
  }

  return dateFormatter.format(date);
}

function formatDuration(totalSeconds) {
  if (!totalSeconds || totalSeconds < 1) {
    return "live";
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function startDashboardRefresh() {
  if (dashboardRefreshTimer) {
    window.clearInterval(dashboardRefreshTimer);
  }

  dashboardRefreshTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") {
      void refreshPlayers();
    }
  }, dashboardRefreshMs);
}

async function refreshPlayers({ force = false } = {}) {
  if (!force && !tokenInput.value.trim()) {
    return;
  }

  if (isRefreshingPlayers) {
    queuedPlayersRefresh = true;
    return;
  }

  isRefreshingPlayers = true;
  refreshButton.disabled = true;

  try {
    const data = await api("/api/players");
    renderPlayers(data.players || []);
  } catch (error) {
    playersNode.replaceChildren();
    const message = document.createElement("p");
    message.className = "empty";
    const text = error instanceof Error ? error.message : "Unable to load players.";
    message.textContent = text;
    playersNode.append(message);
    if (/unauthorized/i.test(text)) {
      setStatus("That token was rejected. Check DASHBOARD_AUTH_TOKEN and try again.", "is-error");
      return;
    }
    if (/starting up/i.test(text)) {
      setStatus("The bot service is still starting up. Wait a moment and refresh.", "is-error");
      return;
    }
    setStatus(text, "is-error");
  } finally {
    isRefreshingPlayers = false;
    refreshButton.disabled = false;

    if (queuedPlayersRefresh) {
      queuedPlayersRefresh = false;
      void refreshPlayers();
    }
  }
}

refreshPlayers();
startDashboardRefresh();
