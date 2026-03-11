const menu = document.getElementById("menu");
const panels = Array.from(document.querySelectorAll("[data-panel]"));

const configForm = document.getElementById("config-form");
const saveHint = document.getElementById("save-hint");
const statusUptime = document.getElementById("status-uptime");
const statusCache = document.getElementById("status-cache");
const statusLogs = document.getElementById("status-logs");
const statusCookies = document.getElementById("status-cookies");
const statusUsers = document.getElementById("status-users");
const statusTransferSuccess = document.getElementById("status-transfer-success");
const logsContainer = document.getElementById("logs");
const logsFilterInput = document.getElementById("logs-filter");
const logsClearButton = document.getElementById("logs-clear");
const logsViewAllButton = document.getElementById("logs-view-all");
const cacheClearButton = document.getElementById("cache-clear");
const cacheTableBody = document.getElementById("cache-table-body");
const cachePageSizeSelect = document.getElementById("cache-page-size");
const cachePrevButton = document.getElementById("cache-prev");
const cacheNextButton = document.getElementById("cache-next");
const cachePageInfo = document.getElementById("cache-page-info");
const refreshUsersButton = document.getElementById("refresh-users");
const usersMeta = document.getElementById("users-meta");
const usersTableBody = document.getElementById("users-table-body");
const profilesContainer = document.getElementById("cookie-profiles");
const addProfileButton = document.getElementById("add-cookie-profile");
const save115ConfigButton = document.getElementById("save-115-config");

const embyServersContainer = document.getElementById("emby-servers");
const addEmbyServerButton = document.getElementById("add-emby-server");
const saveEmbyConfigButton = document.getElementById("save-emby-config");
const embySaveHint = document.getElementById("emby-save-hint");
const user302Form = document.getElementById("user302-form");
const user302RulesContainer = document.getElementById("user302-rules");
const user302EnabledInput = document.getElementById("user302-enabled");
const addUser302RuleButton = document.getElementById("add-user302-rule");
const saveUser302ConfigButton = document.getElementById("save-user302-config");
const user302SaveHint = document.getElementById("user302-save-hint");

let currentLogs = [];
let logsPollTimer = null;
const expandedTraceIds = new Set();
const defaultLogsFetchLimit = 30;
let logsFetchLimit = defaultLogsFetchLimit;
let cachePage = 1;
let cachePageSize = 20;
let cacheTotal = 0;
let cacheTtlTimer = null;
let cachePollTimer = null;
let pathModal = null;
let usersLoading = false;
let currentCookieProfiles = [];
let currentUser302Rules = [];
let currentEmbyUsers = [];
let embyUsersLastFetchedAt = 0;

const EMBY_USERS_CACHE_KEY = "embyUsersCache:v1";
const EMBY_USERS_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const EMBY_USERS_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const EMPTY_AVATAR_DATA_URL = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='96' height='96' viewBox='0 0 96 96'%3E%3Ccircle cx='48' cy='48' r='48' fill='%23d4d4d4'/%3E%3C/svg%3E";

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function setActivePanel(panelName) {
  if (!menu) {
    return;
  }
  const menuItems = Array.from(menu.querySelectorAll(".menu-item"));
  for (const item of menuItems) {
    item.classList.toggle("active", item.dataset.section === panelName);
  }
  for (const panel of panels) {
    panel.classList.toggle("hidden", panel.dataset.panel !== panelName);
  }
}

function loadEmbyUsersCache() {
  try {
    const raw = localStorage.getItem(EMBY_USERS_CACHE_KEY);
    if (!raw) {
      return { users: [], fetchedAt: 0 };
    }
    const parsed = JSON.parse(raw);
    const fetchedAt = Number(parsed?.fetchedAt || 0);
    const users = Array.isArray(parsed?.users) ? parsed.users : [];
    if (!users.length || !Number.isFinite(fetchedAt)) {
      return { users: [], fetchedAt: 0 };
    }
    if (Date.now() - fetchedAt > EMBY_USERS_CACHE_MAX_AGE_MS) {
      return { users: [], fetchedAt: 0 };
    }
    return { users, fetchedAt };
  } catch (_error) {
    return { users: [], fetchedAt: 0 };
  }
}

function saveEmbyUsersCache(users, fetchedAt) {
  try {
    localStorage.setItem(EMBY_USERS_CACHE_KEY, JSON.stringify({ users, fetchedAt }));
  } catch (_error) {
    // ignore cache write errors
  }
}

function hydrateEmbyUsersFromCache() {
  const cached = loadEmbyUsersCache();
  if (!Array.isArray(cached.users) || cached.users.length === 0) {
    return;
  }
  currentEmbyUsers = cached.users;
  embyUsersLastFetchedAt = cached.fetchedAt;
}

async function refreshEmbyUsersOnAccess(panelName) {
  if (panelName !== "users" && panelName !== "playback") {
    return;
  }
  const now = Date.now();
  const stale = !embyUsersLastFetchedAt || now - embyUsersLastFetchedAt > EMBY_USERS_REFRESH_INTERVAL_MS;
  if (!stale) {
    return;
  }
  await loadEmbyUsers({ silent: panelName !== "users", force: true });
}

menu?.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const button = target.closest(".menu-item");
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }
  const panelName = button.dataset.section;
  if (panelName) {
    setActivePanel(panelName);
    syncLogPolling();
    syncCachePolling();
    if (panelName === "cache") {
      void loadCacheList();
    }
    void refreshEmbyUsersOnAccess(panelName);
  }
});

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setHint(element, text, isError) {
  if (!element) {
    return;
  }
  element.textContent = text;
  element.style.color = isError ? "#b24c3a" : "#6a6157";
}

function setButtonBusy(button, isBusy, busyText) {
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }
  if (isBusy) {
    button.dataset.originalText = button.textContent || "";
    button.textContent = busyText;
    button.disabled = true;
    return;
  }
  button.disabled = false;
  if (button.dataset.originalText) {
    button.textContent = button.dataset.originalText;
    delete button.dataset.originalText;
  }
}

function formatMessage(message) {
  if (!message) {
    return "无";
  }
  if (message === "redirect") {
    return "302重定向成功";
  }
  if (message === "proxy") {
    return "代理转发成功";
  }
  return message;
}

function formatStrategy(strategy) {
  if (strategy === "prefer302") {
    return "优先302";
  }
  if (strategy === "forceProxy") {
    return "强制代理";
  }
  return strategy || "未知";
}

function formatLogTime(rawTime) {
  if (!rawTime) {
    return "--:--:--,---";
  }
  const date = new Date(rawTime);
  if (Number.isNaN(date.getTime())) {
    return String(rawTime);
  }
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss},${ms}`;
}

function formatInlineObject(value) {
  if (!value || typeof value !== "object") {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value);
  }
}

function formatSeconds(totalSeconds) {
  const seconds = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  return `${seconds}s`;
}

function normalizeProfileCacheExpirySeconds(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return 1800;
  }
  return parsed;
}

function normalizeAutoDeleteCron(value) {
  const text = String(value || "").trim();
  return text || "0 4 * * *";
}

function normalizeAutoDeleteDirectories(value) {
  if (Array.isArray(value)) {
    return Array.from(new Set(value
      .map((item) => String(item || "").trim())
      .filter((item) => item.length > 0)));
  }
  return String(value || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .filter((item, index, list) => list.indexOf(item) === index);
}

function normalizeAutoDeleteSafeCode(value) {
  return String(value || "").replace(/\D+/g, "").slice(0, 6);
}

function formatAutoDeleteDirectories(value) {
  return normalizeAutoDeleteDirectories(value).join("\n");
}

function shortenMiddle(text, maxLength = 96, head = 46, tail = 28) {
  const raw = String(text || "");
  if (raw.length <= maxLength) {
    return raw;
  }
  const start = raw.slice(0, head);
  const end = raw.slice(-tail);
  return `${start}...${end}`;
}

function getFileNameFromPath(pathText) {
  const text = String(pathText || "").trim();
  if (!text) {
    return "";
  }
  const normalized = text.replaceAll("\\", "/");
  const segments = normalized.split("/").filter((item) => item.length > 0);
  return segments.length ? segments[segments.length - 1] : text;
}

function getDisplayNameFromUrl(rawUrl) {
  const text = String(rawUrl || "").trim();
  if (!text) {
    return "";
  }
  try {
    const url = new URL(text);
    const segments = url.pathname.split("/").filter((item) => item.length > 0);
    const fileName = segments.length ? decodeURIComponent(segments[segments.length - 1]) : "";
    return fileName || text;
  } catch (_error) {
    return text;
  }
}

function shortenCacheUrl(urlText) {
  const raw = String(urlText || "");
  if (raw.length <= 40) {
    return raw;
  }
  return `${raw.slice(0, 9)}...${raw.slice(-26)}`;
}

function ensurePathModal() {
  if (pathModal) {
    return pathModal;
  }
  const overlay = document.createElement("div");
  overlay.className = "path-modal-overlay hidden";
  overlay.innerHTML = `
    <div class="path-modal" role="dialog" aria-modal="true" aria-label="完整路径">
      <div class="path-modal-header">
        <strong id="path-modal-title">📁 完整路径</strong>
      </div>
      <pre class="path-modal-content" id="path-modal-content"></pre>
      <div class="path-modal-footer">
        <button type="button" class="path-modal-copy" data-role="copy-path-modal">复制</button>
        <button type="button" class="path-modal-close" data-role="close-path-modal">关闭</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    if (target === overlay || target.closest("[data-role='close-path-modal']")) {
      overlay.classList.add("hidden");
      return;
    }

    const copyButton = target.closest("[data-role='copy-path-modal']");
    if (copyButton instanceof HTMLButtonElement) {
      const text = overlay.dataset.fullPath || "";
      if (!text) {
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        setButtonBusy(copyButton, true, "已复制");
        setTimeout(() => setButtonBusy(copyButton, false, ""), 800);
      } catch (_error) {
        setButtonBusy(copyButton, true, "复制失败");
        setTimeout(() => setButtonBusy(copyButton, false, ""), 900);
      }
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      overlay.classList.add("hidden");
    }
  });
  pathModal = overlay;
  return overlay;
}

function showPathModal(fullPath) {
  const modal = ensurePathModal();
  modal.dataset.fullPath = String(fullPath || "-");
  const title = modal.querySelector("#path-modal-title");
  if (title) {
    title.textContent = "📁 完整路径";
  }
  const content = modal.querySelector("#path-modal-content");
  if (content) {
    content.textContent = modal.dataset.fullPath;
  }
  modal.classList.remove("hidden");
}

function showUrlModal(rawUrl) {
  const modal = ensurePathModal();
  modal.dataset.fullPath = String(rawUrl || "-");
  const title = modal.querySelector("#path-modal-title");
  if (title) {
    title.textContent = "重定向URL";
  }
  const content = modal.querySelector("#path-modal-content");
  if (content) {
    content.textContent = modal.dataset.fullPath;
  }
  modal.classList.remove("hidden");
}

function formatCacheCreatedAt(rawTime) {
  if (!rawTime) {
    return "-";
  }
  const date = new Date(rawTime);
  if (Number.isNaN(date.getTime())) {
    return String(rawTime);
  }
  const yyyy = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}/${m}/${d} ${hh}:${mm}:${ss}`;
}

function escapeAttribute(text) {
  return escapeHtml(text).replaceAll("`", "&#96;");
}

function updateCachePager() {
  const totalPages = Math.max(1, Math.ceil(cacheTotal / cachePageSize));
  cachePage = Math.min(Math.max(1, cachePage), totalPages);
  if (cachePageInfo) {
    cachePageInfo.textContent = `第 ${cachePage} 页 / 共 ${totalPages} 页（总 ${cacheTotal} 条）`;
  }
  if (cachePrevButton instanceof HTMLButtonElement) {
    cachePrevButton.disabled = cachePage <= 1;
  }
  if (cacheNextButton instanceof HTMLButtonElement) {
    cacheNextButton.disabled = cachePage >= totalPages;
  }
}

function renderCacheRows(items) {
  if (!cacheTableBody) {
    return;
  }
  cacheTableBody.textContent = "";
  if (!Array.isArray(items) || items.length === 0) {
    if (cacheTtlTimer) {
      clearInterval(cacheTtlTimer);
      cacheTtlTimer = null;
    }
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.textContent = "暂无缓存记录";
    row.appendChild(cell);
    cacheTableBody.appendChild(row);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const item of items) {
    const row = document.createElement("tr");
    const key = String(item.key || "");
    const sourcePath = String(item.sourcePath || "");
    const fileName = getFileNameFromPath(sourcePath);
    const rawUrl = String(item.directUrl || "");
    const urlName = shortenCacheUrl(rawUrl);
    const headersObj = item.headers && typeof item.headers === "object" ? item.headers : {};
    const userAgentText = String(headersObj["user-agent"] || "").trim() || "-";
    const expiresAt = String(item.expiresAt || "");
    row.innerHTML = `
      <td class="cache-path"><button type="button" class="cache-path-button" data-role="show-path" data-path="${escapeAttribute(sourcePath)}"><code>${escapeHtml(fileName || "-")}</code></button></td>
      <td class="cache-url"><button type="button" class="cache-path-button" data-role="show-url" data-url="${escapeAttribute(rawUrl)}"><code>${escapeHtml(urlName || "-")}</code></button></td>
      <td>${escapeHtml(formatCacheCreatedAt(item.createdAt))}</td>
      <td class="cache-ttl" data-expires-at="${escapeAttribute(expiresAt)}">${escapeHtml(formatSeconds(item.validSeconds || 0))}</td>
      <td class="cache-headers" title="${escapeAttribute(userAgentText)}"><code>${escapeHtml(userAgentText)}</code></td>
      <td><button type="button" data-role="delete-cache" data-key="${escapeAttribute(key)}">删除缓存</button></td>
    `;
    fragment.appendChild(row);
  }
  cacheTableBody.appendChild(fragment);
  refreshCacheTtlCountdown();
  ensureCacheTtlTimer();
}

function refreshCacheTtlCountdown() {
  if (!cacheTableBody) {
    return;
  }
  const ttlCells = Array.from(cacheTableBody.querySelectorAll(".cache-ttl"));
  let hasLiveEntry = false;
  const now = Date.now();
  for (const cell of ttlCells) {
    if (!(cell instanceof HTMLElement)) {
      continue;
    }
    const expiresAt = cell.dataset.expiresAt || "";
    const expiresTs = Date.parse(expiresAt);
    if (Number.isNaN(expiresTs)) {
      cell.textContent = "0s";
      continue;
    }
    const remainSec = Math.max(0, Math.floor((expiresTs - now) / 1000));
    if (remainSec > 0) {
      hasLiveEntry = true;
    }
    cell.textContent = formatSeconds(remainSec);
  }
  if (!hasLiveEntry && cacheTtlTimer) {
    clearInterval(cacheTtlTimer);
    cacheTtlTimer = null;
  }
}

function ensureCacheTtlTimer() {
  if (cacheTtlTimer) {
    return;
  }
  cacheTtlTimer = setInterval(() => {
    refreshCacheTtlCountdown();
  }, 1000);
}

async function loadCacheList() {
  const offset = (cachePage - 1) * cachePageSize;
  const payload = await fetchJson(`/api/cache?offset=${offset}&limit=${cachePageSize}`);
  cacheTotal = Number.isInteger(payload?.total) ? payload.total : 0;
  renderCacheRows(Array.isArray(payload?.items) ? payload.items : []);
  updateCachePager();
}

function renderUsersRows(items) {
  if (!usersTableBody) {
    return;
  }
  usersTableBody.textContent = "";
  if (!Array.isArray(items) || items.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.textContent = "暂无用户";
    row.appendChild(cell);
    usersTableBody.appendChild(row);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const item of items) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${escapeHtml(item.name || "-")}</td>
      <td><code>${escapeHtml(item.id || "-")}</code></td>
      <td>${item.administrator ? "是" : "否"}</td>
      <td>${item.disabled ? "是" : "否"}</td>
      <td>${item.hasPassword ? "是" : "否"}</td>
      <td>${escapeHtml(item.lastActivityDate ? formatCacheCreatedAt(item.lastActivityDate) : "-")}</td>
    `;
    fragment.appendChild(row);
  }
  usersTableBody.appendChild(fragment);
}

async function loadEmbyUsers(options = {}) {
  const silent = options && options.silent === true;
  const force = options && options.force === true;
  if (usersLoading) {
    return;
  }
  if (!force && embyUsersLastFetchedAt && Date.now() - embyUsersLastFetchedAt < EMBY_USERS_REFRESH_INTERVAL_MS) {
    return;
  }
  usersLoading = true;
  if (!silent) {
    setButtonBusy(refreshUsersButton, true, "刷新中...");
    setHint(usersMeta, "正在加载用户...", false);
  }
  try {
    const payload = await fetchJson("/api/emby/users");
    currentEmbyUsers = Array.isArray(payload?.users) ? payload.users : [];
    embyUsersLastFetchedAt = Date.now();
    saveEmbyUsersCache(currentEmbyUsers, embyUsersLastFetchedAt);
    renderUsersRows(currentEmbyUsers);
    const serverName = payload?.serverName || "当前服务器";
    const total = Number.isInteger(payload?.total) ? payload.total : 0;
    if (!silent) {
      setHint(usersMeta, `来源: ${serverName} | 用户总数: ${total}`, false);
    }
    if (user302RulesContainer) {
      const cards = Array.from(user302RulesContainer.querySelectorAll(".user302-rule-card"));
      cards.forEach((card) => {
        if (!(card instanceof HTMLElement)) {
          return;
        }
        const picker = card.querySelector("[data-role='user302EmbyUserPicker']");
        renderUser302UserPicker(card, getUser302PickerValue(picker));
      });
    }
  } catch (error) {
    if (!silent) {
      renderUsersRows(Array.isArray(currentEmbyUsers) ? currentEmbyUsers : []);
      setHint(usersMeta, error instanceof Error ? error.message : "加载失败", true);
    }
  } finally {
    usersLoading = false;
    if (!silent) {
      setButtonBusy(refreshUsersButton, false, "");
    }
  }
}

function syncCachePolling() {
  const shouldPoll = !document.hidden && isPanelActive("cache");

  if (!shouldPoll) {
    if (cachePollTimer) {
      clearInterval(cachePollTimer);
      cachePollTimer = null;
    }
    return;
  }

  if (!cachePollTimer) {
    void loadCacheList();
    cachePollTimer = setInterval(() => {
      void loadCacheList();
    }, 2000);
  }
}

function createLogDetailElement(detail) {
  const wrapper = document.createElement("div");
  wrapper.className = "log-detail";

  const detailRows = [
    ["收到播放请求", detail?.requestRaw || ""],
    ["请求头", detail?.headers ? JSON.stringify(detail.headers, null, 2) : ""],
    ["提取参数", detail?.extracted ? JSON.stringify(detail.extracted, null, 2) : ""],
    ["Emby源文件内容", detail?.embySource || ""],
    ["302直链", detail?.directUrl || ""],
    ["缓存键", detail?.cacheKey || ""]
  ];

  for (const [key, value] of detailRows) {
    if (!value) {
      continue;
    }
    const row = document.createElement("div");
    row.className = "log-detail-row";

    const keyEl = document.createElement("div");
    keyEl.className = "log-detail-key";
    keyEl.textContent = key;

    const valueEl = document.createElement("div");
    valueEl.className = "log-detail-value";
    valueEl.textContent = value;

    row.append(keyEl, valueEl);
    wrapper.appendChild(row);
  }

  if (!wrapper.childElementCount) {
    wrapper.textContent = "暂无详细日志";
  }

  if (Array.isArray(detail?.events) && detail.events.length > 0) {
    const timelineTitle = document.createElement("div");
    timelineTitle.className = "log-detail-key";
    timelineTitle.textContent = "事件时间线";
    wrapper.appendChild(timelineTitle);

    const timeline = document.createElement("div");
    timeline.className = "log-detail-value";
    timeline.textContent = detail.events
      .map((event) => `${event.clock} (+${event.sinceStartMs}ms) ${event.label}`)
      .join("\n");
    wrapper.appendChild(timeline);
  }

  return wrapper;
}

function isPanelActive(panelName) {
  return panels.some((panel) => {
    return panel.dataset.panel === panelName && !panel.classList.contains("hidden");
  });
}

function syncLogPolling() {
  const shouldPoll =
    !document.hidden &&
    isPanelActive("logs");

  if (!shouldPoll) {
    if (logsPollTimer) {
      clearInterval(logsPollTimer);
      logsPollTimer = null;
    }
    return;
  }

  if (!logsPollTimer) {
    void loadLogs();
    logsPollTimer = setInterval(() => {
      void loadLogs();
    }, 2000);
  }
}

function createProfileItem(profile, isActive) {
  const wrapper = document.createElement("div");
  wrapper.className = "cookie-profile";
  wrapper.dataset.id = uid();
  const displayName = profile.name || "未命名配置";

  wrapper.innerHTML = `
    <div class="cookie-profile-header">
      <div class="cookie-profile-title" data-role="card-title">配置 / ${escapeHtml(displayName)}</div>
      <div class="cookie-profile-tools">
        <button type="button" data-role="add-profile" title="新增配置">+</button>
        <button type="button" data-role="remove-profile" title="删除配置">-</button>
      </div>
    </div>
    <label>
      <span>名称</span>
      <input data-role="name" type="text" value="${escapeHtml(profile.name || "")}" placeholder="主账号" />
    </label>
    <label>
      <span>Cookies</span>
      <textarea data-role="cookies" rows="3" placeholder="UID=...; CID=...;">${escapeHtml(profile.cookies || "")}</textarea>
    </label>
    <label>
      <span>缓存过期时间</span>
      <input data-role="cacheExpirySeconds" type="number" min="0" value="${escapeHtml(String(normalizeProfileCacheExpirySeconds(profile.cacheExpirySeconds)))}" />
    </label>
    <div class="cookie-auto-delete">
      <div class="cookie-auto-delete-head">
        <div class="cookie-auto-delete-title">自动删除目录</div>
        <button type="button" data-role="cleanup-now" title="立刻删除">立刻删除</button>
      </div>
      <label class="emby-enable cookie-auto-delete-switch">
        <input data-role="autoDeleteEnabled" type="checkbox" ${profile?.autoDelete?.enabled ? "checked" : ""} />
        <span>启用自动删除目录</span>
      </label>
      <label>
        <span>Cron 表达式</span>
        <input data-role="autoDeleteCron" type="text" value="${escapeHtml(normalizeAutoDeleteCron(profile?.autoDelete?.cron))}" placeholder="0 4 * * *" />
      </label>
      <label>
        <span>自动删除目录（每行一条）</span>
        <textarea data-role="autoDeleteDirectories" rows="4" placeholder="/sha1cache\n/temporary">${escapeHtml(formatAutoDeleteDirectories(profile?.autoDelete?.directories || []))}</textarea>
      </label>
      <label>
        <span>115安全密钥（6位数字）</span>
        <input data-role="autoDeleteSafeCode" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" value="${escapeHtml(normalizeAutoDeleteSafeCode(profile?.autoDelete?.safeCode || ""))}" placeholder="000000" />
      </label>
    </div>
    <div class="cookie-profile-footer">
      <p class="hint" data-role="test-result"></p>
      <button type="button" data-role="test-profile">测试账号状态</button>
    </div>
    <p class="hint" data-role="cleanup-result"></p>
  `;

  return wrapper;
}

function refreshCookieCardMeta() {
  if (!profilesContainer) {
    return;
  }
  const cards = Array.from(profilesContainer.querySelectorAll(".cookie-profile"));
  cards.forEach((card, index) => {
    const nameInput = card.querySelector("[data-role='name']");
    const title = card.querySelector("[data-role='card-title']");
    if (!(title instanceof HTMLElement)) {
      return;
    }
    const name = nameInput instanceof HTMLInputElement
      ? nameInput.value.trim()
      : "";
    title.textContent = `配置 #${index + 1} / ${name || "未命名配置"}`;
  });
}

function ensureActiveProfile() {
  // Cookie profiles now default to first entry as active.
}

function collectProfiles() {
  if (!profilesContainer) {
    return {
      profiles: [{
        name: "default",
        cookies: "",
        cacheExpirySeconds: 1800,
        autoDelete: {
          enabled: false,
          cron: "0 4 * * *",
          directories: [],
          safeCode: ""
        }
      }],
      activeName: "default"
    };
  }

  const items = Array.from(profilesContainer.querySelectorAll(".cookie-profile"));
  const profiles = [];

  for (const item of items) {
    const nameInput = item.querySelector("[data-role='name']");
    const cookiesInput = item.querySelector("[data-role='cookies']");
    const cacheExpiryInput = item.querySelector("[data-role='cacheExpirySeconds']");
    const autoDeleteEnabledInput = item.querySelector("[data-role='autoDeleteEnabled']");
    const autoDeleteCronInput = item.querySelector("[data-role='autoDeleteCron']");
    const autoDeleteDirectoriesInput = item.querySelector("[data-role='autoDeleteDirectories']");
    const autoDeleteSafeCodeInput = item.querySelector("[data-role='autoDeleteSafeCode']");

    const name = nameInput && "value" in nameInput ? nameInput.value.trim() : "";
    const cookies = cookiesInput && "value" in cookiesInput ? cookiesInput.value.trim() : "";
    const cacheExpirySeconds = cacheExpiryInput && "value" in cacheExpiryInput
      ? normalizeProfileCacheExpirySeconds(cacheExpiryInput.value)
      : 1800;
    const autoDeleteEnabled = Boolean(autoDeleteEnabledInput && "checked" in autoDeleteEnabledInput
      ? autoDeleteEnabledInput.checked
      : false);
    const autoDeleteCron = normalizeAutoDeleteCron(autoDeleteCronInput && "value" in autoDeleteCronInput
      ? autoDeleteCronInput.value
      : "");
    const autoDeleteDirectories = normalizeAutoDeleteDirectories(autoDeleteDirectoriesInput && "value" in autoDeleteDirectoriesInput
      ? autoDeleteDirectoriesInput.value
      : "");
    const autoDeleteSafeCode = normalizeAutoDeleteSafeCode(autoDeleteSafeCodeInput && "value" in autoDeleteSafeCodeInput
      ? autoDeleteSafeCodeInput.value
      : "");

    const normalizedName = name || `cookie-${profiles.length + 1}`;
    profiles.push({
      name: normalizedName,
      cookies,
      cacheExpirySeconds,
      autoDelete: {
        enabled: autoDeleteEnabled,
        cron: autoDeleteCron,
        directories: autoDeleteDirectories,
        safeCode: autoDeleteSafeCode
      }
    });
  }

  if (!profiles.length) {
    profiles.push({
      name: "default",
      cookies: "",
      cacheExpirySeconds: 1800,
      autoDelete: {
        enabled: false,
        cron: "0 4 * * *",
        directories: [],
        safeCode: ""
      }
    });
    return { profiles, activeName: "default" };
  }

  return { profiles, activeName: profiles[0].name };
}

async function testCookieProfile(card) {
  const cookiesInput = card.querySelector("[data-role='cookies']");
  const nameInput = card.querySelector("[data-role='name']");
  const resultHint = card.querySelector("[data-role='test-result']");
  const testButton = card.querySelector("[data-role='test-profile']");
  if (!(cookiesInput instanceof HTMLTextAreaElement)) {
    return;
  }

  const cookies = cookiesInput.value.trim();
  const profileName = nameInput instanceof HTMLInputElement ? nameInput.value.trim() : "";
  const profileId = card.dataset.id || "";
  if (!cookies) {
    setHint(resultHint, "请先填写 Cookies", true);
    return;
  }

  setHint(resultHint, "检测中...", false);
  setButtonBusy(testButton, true, "检测中...");
  try {
    const result = await fetchJson("/api/p115/check-cookie", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cookies, profileName, profileId })
    });
    if (result?.profileId && result.profileId !== profileId) {
      return;
    }
    if (!result?.ok) {
      setHint(resultHint, result?.message || "检测失败", true);
      return;
    }
    const accountName = profileName || "未命名";
    const statusText = result?.message || (result?.expired ? "Cookies 已过期" : result?.riskControlled ? "账号疑似风控" : "账号状态正常");
    setHint(resultHint, `账号${accountName}${statusText}`, Boolean(result?.expired || result?.riskControlled));
  } catch (error) {
    setHint(resultHint, error instanceof Error ? error.message : "检测失败", true);
  } finally {
    setButtonBusy(testButton, false, "");
  }
}

async function cleanupCookieProfileNow(card) {
  const cookiesInput = card.querySelector("[data-role='cookies']");
  const nameInput = card.querySelector("[data-role='name']");
  const directoriesInput = card.querySelector("[data-role='autoDeleteDirectories']");
  const safeCodeInput = card.querySelector("[data-role='autoDeleteSafeCode']");
  const resultHint = card.querySelector("[data-role='cleanup-result']");
  const button = card.querySelector("[data-role='cleanup-now']");

  const cookies = cookiesInput instanceof HTMLTextAreaElement ? cookiesInput.value.trim() : "";
  const profileName = nameInput instanceof HTMLInputElement ? nameInput.value.trim() : "";
  const directories = normalizeAutoDeleteDirectories(directoriesInput && "value" in directoriesInput
    ? directoriesInput.value
    : "");
  const safeCode = normalizeAutoDeleteSafeCode(safeCodeInput && "value" in safeCodeInput
    ? safeCodeInput.value
    : "");

  if (!cookies) {
    setHint(resultHint, "请先填写 Cookies", true);
    return;
  }
  if (directories.length === 0) {
    setHint(resultHint, "请先填写自动删除目录", true);
    return;
  }

  setHint(resultHint, "执行中...", false);
  setButtonBusy(button, true, "执行中...");
  try {
    const result = await fetchJson("/api/p115/cleanup-now", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        profileName,
        cookies,
        directories,
        safeCode
      })
    });

    const warning = Array.isArray(result?.errors) && result.errors.length > 0
      ? `，警告：${result.errors.join("；")}`
      : "";
    setHint(
      resultHint,
      `删除完成：目录 ${result?.directories || directories.length} 个，删除条目 ${result?.deletedCount || 0}，回收站${result?.recycleCleared ? "已清空" : "未清空"}${warning}`,
      !result?.ok
    );
  } catch (error) {
    setHint(resultHint, error instanceof Error ? error.message : "执行失败", true);
  } finally {
    setButtonBusy(button, false, "");
  }
}

async function save115Config() {
  if (!(configForm instanceof HTMLFormElement)) {
    return;
  }
  setHint(saveHint, "正在保存...", false);

  const cookieData = collectProfiles();
  const payload = {
    p115: {
      cookieProfiles: cookieData.profiles,
      activeCookieName: cookieData.activeName
    },
    playback: {
      defaultStrategy: "prefer302",
      allowProxy: false
    }
  };

  setButtonBusy(save115ConfigButton, true, "保存中...");
  try {
    await fetchJson("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    setHint(saveHint, "配置已保存", false);
    await loadConfig();
    await loadStatus();
  } catch (error) {
    setHint(saveHint, error instanceof Error ? error.message : "保存失败", true);
  } finally {
    setButtonBusy(save115ConfigButton, false, "");
  }
}

function renderProfiles(profiles, activeName) {
  if (!profilesContainer) {
    return;
  }
  const list = Array.isArray(profiles) && profiles.length
    ? profiles
    : [{
      name: "default",
      cookies: "",
      cacheExpirySeconds: 1800,
      autoDelete: {
        enabled: false,
        cron: "0 4 * * *",
        directories: [],
        safeCode: ""
      }
    }];

  const fragment = document.createDocumentFragment();
  for (const profile of list) {
    fragment.appendChild(createProfileItem(profile, profile.name === activeName));
  }

  profilesContainer.replaceChildren(fragment);
  ensureActiveProfile();
  refreshCookieCardMeta();
}

function normalizeSinglePort(text) {
  return String(text || "").trim();
}

function normalizePathRules(text) {
  return String(text || "")
    .split(/[;\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(";");
}

function createUser302RuleCard(rule, index) {
  const item = document.createElement("div");
  item.className = "user302-rule-card";
  item.dataset.id = rule.id || uid();
  const options = buildCookieProfileOptions(rule.targetCookieName || "");
  const initialUserId = typeof rule.embyUserId === "string" ? rule.embyUserId.trim() : "";
  item.innerHTML = `
    <div class="user302-rule-head">
      <strong>规则 #${index + 1}</strong>
      <button type="button" data-role="remove-user302-rule">删除</button>
    </div>
    <div class="user302-rule-grid">
      <label>
        <span>规则名称</span>
        <input data-role="name" type="text" value="${escapeHtml(rule.name || "")}" placeholder="例如：家庭用户A" />
      </label>
      <div class="emby-field user302-user-field">
        <span>Emby用户（显示用户名，按ID匹配）</span>
        <div class="multi-picker" data-role="user302EmbyUserPicker" data-selected-user-id="" tabindex="0" aria-expanded="false">
          <div class="multi-picker-values" data-role="user302-picker-values"></div>
          <span class="multi-picker-arrow">▾</span>
          <div class="multi-picker-menu" data-role="user302-picker-menu"></div>
        </div>
      </div>
      <label>
        <span>目标Cookies账号</span>
        <select data-role="targetCookieName">${options}</select>
      </label>
      <label>
        <span>目标目录</span>
        <input data-role="targetPath" type="text" value="${escapeHtml(rule.targetPath || "/sha1cache")}" placeholder="/sha1cache" />
      </label>
    </div>
    <label class="emby-enable user302-enable">
      <input data-role="enabled" type="checkbox" ${rule.enabled !== false ? "checked" : ""} />
      <span>启用该规则</span>
      </label>
  `;
  renderUser302UserPicker(item, initialUserId);
  return item;
}

function renderUser302Rules(rules) {
  if (!user302RulesContainer) {
    return;
  }
  const source = Array.isArray(rules) ? rules : [];
  const list = source.length
    ? source
    : [{ id: uid(), name: "", embyUserId: "", targetCookieName: "", targetPath: "/sha1cache", enabled: true }];
  const fragment = document.createDocumentFragment();
  list.forEach((rule, index) => {
    fragment.appendChild(createUser302RuleCard(rule, index));
  });
  user302RulesContainer.replaceChildren(fragment);
}

function collectUser302Rules() {
  if (!user302RulesContainer) {
    return [];
  }
  const cards = Array.from(user302RulesContainer.querySelectorAll(".user302-rule-card"));
  return cards.map((card) => {
    const id = card.dataset.id || uid();
    const nameInput = card.querySelector("[data-role='name']");
    const userPicker = card.querySelector("[data-role='user302EmbyUserPicker']");
    const targetCookieInput = card.querySelector("[data-role='targetCookieName']");
    const targetPathInput = card.querySelector("[data-role='targetPath']");
    const enabledInput = card.querySelector("[data-role='enabled']");
    return {
      id,
      name: nameInput && "value" in nameInput ? nameInput.value.trim() : "",
      embyUserId: getUser302PickerValue(userPicker),
      targetCookieName: targetCookieInput && "value" in targetCookieInput ? targetCookieInput.value.trim() : "",
      targetPath: targetPathInput && "value" in targetPathInput ? targetPathInput.value.trim() || "/sha1cache" : "/sha1cache",
      enabled: Boolean(enabledInput && "checked" in enabledInput ? enabledInput.checked : true)
    };
  });
}

function getUser302Candidates() {
  return (Array.isArray(currentEmbyUsers) ? currentEmbyUsers : [])
    .map((item) => {
      const id = typeof item?.id === "string" ? item.id.trim() : "";
      const name = typeof item?.name === "string" ? item.name.trim() : "";
      return {
        id,
        name: name || id
      };
    })
    .filter((item) => item.id.length > 0);
}

function getUser302PickerValue(picker) {
  if (!(picker instanceof HTMLElement)) {
    return "";
  }
  return String(picker.dataset.selectedUserId || "").trim();
}

function renderUser302UserPicker(card, selectedUserId) {
  const picker = card.querySelector("[data-role='user302EmbyUserPicker']");
  if (!(picker instanceof HTMLElement)) {
    return;
  }
  const candidates = getUser302Candidates();
  const selected = String(selectedUserId || "").trim();
  const selectedItem = candidates.find((item) => item.id === selected);
  picker.dataset.selectedUserId = selected;

  const valuesNode = picker.querySelector("[data-role='user302-picker-values']");
  if (valuesNode instanceof HTMLElement) {
    if (selectedItem) {
      valuesNode.innerHTML = `<span class=\"picker-chip\">${escapeHtml(selectedItem.name)}</span>`;
    } else if (selected) {
      valuesNode.innerHTML = `<span class=\"picker-chip\">${escapeHtml(selected)}（已失效）</span>`;
    } else {
      valuesNode.innerHTML = "<span class=\"picker-placeholder\">请选择Emby用户</span>";
    }
  }

  const menuNode = picker.querySelector("[data-role='user302-picker-menu']");
  if (menuNode instanceof HTMLElement) {
    if (!candidates.length) {
      menuNode.innerHTML = "<div class=\"picker-empty\">请先刷新用户列表</div>";
    } else {
      menuNode.innerHTML = candidates
        .map((item) => {
          const checked = item.id === selected;
          return `
            <button type=\"button\" class=\"picker-option\" data-role=\"user302-user-option\" data-user-id=\"${escapeAttribute(item.id)}\">
              <span class=\"picker-option-name\">${escapeHtml(item.name)}</span>
              <span class=\"picker-check ${checked ? "is-checked" : ""}\">${checked ? "✓" : ""}</span>
            </button>
          `;
        })
        .join("");
    }
  }
}

function closeAllUser302Pickers() {
  if (!user302RulesContainer) {
    return;
  }
  const pickers = user302RulesContainer.querySelectorAll("[data-role='user302EmbyUserPicker']");
  pickers.forEach((picker) => {
    if (!(picker instanceof HTMLElement)) {
      return;
    }
    picker.classList.remove("is-open");
    picker.setAttribute("aria-expanded", "false");
  });
}

function validateUser302Rules(rules) {
  const selectableProfiles = getSelectableCookieProfiles();
  const profileNames = new Set(selectableProfiles.map((item) => item.name));
  if (!profileNames.size) {
    return "去cookies配置里添加cookies！";
  }

  const usedUserIds = new Set();
  for (const rule of rules) {
    if (!rule.enabled) {
      continue;
    }
    if (!rule.embyUserId) {
      return "用户302规则必须填写 Emby用户ID";
    }
    if (usedUserIds.has(rule.embyUserId)) {
      return `用户302规则重复的 Emby用户ID: ${rule.embyUserId}`;
    }
    usedUserIds.add(rule.embyUserId);
    if (!rule.targetCookieName) {
      return `用户 ${rule.embyUserId} 未选择目标Cookies账号`;
    }
    if (!profileNames.has(rule.targetCookieName)) {
      return `目标Cookies账号不存在: ${rule.targetCookieName}`;
    }
    if (!rule.targetPath.startsWith("/")) {
      return `目标目录需以 / 开头: ${rule.targetPath}`;
    }
  }
  return "";
}

async function saveUser302Config() {
  const rules = collectUser302Rules();
  const error = validateUser302Rules(rules);
  if (error) {
    setHint(user302SaveHint, error, true);
    return;
  }
  const enabled = user302EnabledInput instanceof HTMLInputElement ? user302EnabledInput.checked : true;
  setHint(user302SaveHint, "正在保存...", false);
  setButtonBusy(saveUser302ConfigButton, true, "保存中...");
  try {
    await fetchJson("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        user302: {
          enabled,
          rules
        }
      })
    });
    currentUser302Rules = rules;
    setHint(user302SaveHint, "配置已保存", false);
    await loadConfig();
  } catch (error) {
    setHint(user302SaveHint, error instanceof Error ? error.message : "保存失败", true);
  } finally {
    setButtonBusy(saveUser302ConfigButton, false, "");
  }
}

function buildCookieProfileOptions(selectedName) {
  const selected = String(selectedName || "").trim();
  const list = getSelectableCookieProfiles();
  const emptyHint = list.length
    ? "请选择资源cookies！"
    : "去cookies配置里添加cookies！";
  const options = [
    `<option value=""${selected ? "" : " selected"} disabled>${emptyHint}</option>`
  ];
  let hasSelected = false;
  for (const profile of list) {
    const name = typeof profile?.name === "string" ? profile.name.trim() : "";
    if (!name) {
      continue;
    }
    const selectedAttr = name === selected ? " selected" : "";
    if (name === selected) {
      hasSelected = true;
    }
    options.push(`<option value="${escapeAttribute(name)}"${selectedAttr}>${escapeHtml(name)}</option>`);
  }
  if (selected && !hasSelected) {
    options.push(`<option value="${escapeAttribute(selected)}" selected>${escapeHtml(selected)}（已删除）</option>`);
  }
  return options.join("");
}

function getAntiRiskCandidates(excludedName) {
  const excluded = String(excludedName || "").trim();
  return getSelectableCookieProfiles()
    .map((profile) => (typeof profile?.name === "string" ? profile.name.trim() : ""))
    .filter((name) => name && name !== excluded);
}

function normalizeNameList(input) {
  if (!Array.isArray(input)) {
    return [];
  }
  return Array.from(new Set(input
    .map((item) => String(item || "").trim())
    .filter((item) => item.length > 0)));
}

function getAntiRiskPickerValues(picker) {
  if (!(picker instanceof HTMLElement)) {
    return [];
  }
  const raw = picker.dataset.selectedNames || "[]";
  try {
    return normalizeNameList(JSON.parse(raw));
  } catch (_error) {
    return [];
  }
}

function getSelectableCookieProfiles() {
  const source = Array.isArray(currentCookieProfiles) ? currentCookieProfiles : [];
  return source.filter((item) => {
    const name = typeof item?.name === "string" ? item.name.trim() : "";
    const cookies = typeof item?.cookies === "string" ? item.cookies.trim() : "";
    return Boolean(name && cookies);
  });
}

function formatStorageText(remainBytes, totalBytes) {
  if (!(remainBytes > 0) || !(totalBytes > 0)) {
    return "剩余空间：--";
  }
  return `剩余空间：${formatBytes(remainBytes)}/${formatBytes(totalBytes)}`;
}

function formatBytes(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size < 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const fixed = value >= 100 || unitIndex === 0 ? 0 : 2;
  return `${value.toFixed(fixed)} ${units[unitIndex]}`;
}

function setEmbyCookieProfileInfo(card, data) {
  if (!(card instanceof HTMLElement)) {
    return;
  }
  const avatar = card.querySelector("[data-role='cookie-avatar']");
  const userName = card.querySelector("[data-role='cookie-user-name']");
  const vip = card.querySelector("[data-role='cookie-vip']");
  const space = card.querySelector("[data-role='cookie-space']");

  if (avatar instanceof HTMLImageElement) {
    avatar.src = data.avatarUrl || EMPTY_AVATAR_DATA_URL;
    avatar.onerror = () => {
      avatar.src = EMPTY_AVATAR_DATA_URL;
      avatar.classList.add("is-empty");
    };
    avatar.classList.toggle("is-empty", !data.avatarUrl);
  }
  if (userName) {
    userName.textContent = data.userName || "未选择账号";
  }
  if (vip) {
    vip.textContent = data.vipLabel || "--";
    vip.classList.toggle("is-vip", data.vipLabel === "VIP");
  }
  if (space) {
    space.textContent = data.spaceText || "剩余空间：--";
  }
}

async function refreshEmbyCookieProfileInfo(card) {
  if (!(card instanceof HTMLElement)) {
    return;
  }
  const select = card.querySelector("select[data-role='p115CookieName']");
  const selectedName = select instanceof HTMLSelectElement ? select.value.trim() : "";
  if (!selectedName) {
    const hasCookies = getSelectableCookieProfiles().length > 0;
    setEmbyCookieProfileInfo(card, {
      avatarUrl: "",
      userName: hasCookies ? "请选择资源cookies！" : "去cookies配置里添加cookies！",
      vipLabel: "--",
      spaceText: "剩余空间：--"
    });
    return;
  }

  const requestId = uid();
  card.dataset.cookieInfoRequestId = requestId;
  setEmbyCookieProfileInfo(card, {
    avatarUrl: "",
    userName: `${selectedName}（读取中）`,
    vipLabel: "--",
    spaceText: "剩余空间：--"
  });
  try {
    const result = await fetchJson("/api/p115/profile-summary", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileName: selectedName })
    });
    if (card.dataset.cookieInfoRequestId !== requestId) {
      return;
    }
    setEmbyCookieProfileInfo(card, {
      avatarUrl: typeof result?.avatarUrl === "string" ? result.avatarUrl : "",
      userName: typeof result?.userName === "string" ? result.userName : selectedName,
      vipLabel: result?.vip ? "VIP" : "普通",
      spaceText: formatStorageText(result?.remainBytes, result?.totalBytes)
    });
  } catch (_error) {
    if (card.dataset.cookieInfoRequestId !== requestId) {
      return;
    }
    setEmbyCookieProfileInfo(card, {
      avatarUrl: "",
      userName: `${selectedName}（读取失败）`,
      vipLabel: "--",
      spaceText: "剩余空间：--"
    });
  }
}

async function refreshAllEmbyCookieProfileInfo() {
  if (!embyServersContainer) {
    return;
  }
  const cards = Array.from(embyServersContainer.querySelectorAll(".emby-server-card"));
  await Promise.all(cards.map((card) => refreshEmbyCookieProfileInfo(card)));
}

function syncAntiRiskSelectForCard(card) {
  const sourceSelect = card.querySelector("select[data-role='p115CookieName']");
  const antiRiskPicker = card.querySelector("[data-role='antiRiskCookieNamesPicker']");
  if (!(sourceSelect instanceof HTMLSelectElement) || !(antiRiskPicker instanceof HTMLElement)) {
    return;
  }
  renderAntiRiskPicker(card, getAntiRiskPickerValues(antiRiskPicker));
}

function renderAntiRiskPicker(card, selectedNames) {
  const sourceSelect = card.querySelector("select[data-role='p115CookieName']");
  const picker = card.querySelector("[data-role='antiRiskCookieNamesPicker']");
  if (!(sourceSelect instanceof HTMLSelectElement) || !(picker instanceof HTMLElement)) {
    return;
  }
  const candidates = getAntiRiskCandidates(sourceSelect.value);
  const candidateSet = new Set(candidates);
  const selected = normalizeNameList(selectedNames).filter((name) => candidateSet.has(name));
  picker.dataset.selectedNames = JSON.stringify(selected);

  const valuesNode = picker.querySelector("[data-role='picker-values']");
  if (valuesNode instanceof HTMLElement) {
    if (!selected.length) {
      valuesNode.innerHTML = "<span class=\"picker-placeholder\">未选择（可不选）</span>";
    } else {
      valuesNode.innerHTML = selected
        .map((name) => `<span class=\"picker-chip\">${escapeHtml(name)}</span>`)
        .join("");
    }
  }

  const menuNode = picker.querySelector("[data-role='picker-menu']");
  if (menuNode instanceof HTMLElement) {
    if (!candidates.length) {
      menuNode.innerHTML = "<div class=\"picker-empty\">无可选账号</div>";
    } else {
      menuNode.innerHTML = candidates
        .map((name) => {
          const checked = selected.includes(name);
          return `
            <button type=\"button\" class=\"picker-option\" data-role=\"picker-option\" data-value=\"${escapeAttribute(name)}\">
              <span class=\"picker-option-name\">${escapeHtml(name)}</span>
              <span class=\"picker-check ${checked ? "is-checked" : ""}\">${checked ? "✓" : ""}</span>
            </button>
          `;
        })
        .join("");
    }
  }
}

function closeAllAntiRiskPickers() {
  if (!embyServersContainer) {
    return;
  }
  const pickers = embyServersContainer.querySelectorAll("[data-role='antiRiskCookieNamesPicker']");
  pickers.forEach((picker) => {
    if (!(picker instanceof HTMLElement)) {
      return;
    }
    picker.classList.remove("is-open");
    picker.setAttribute("aria-expanded", "false");
  });
}

function createEmbyServerCard(server, index) {
  const wrapper = document.createElement("div");
  wrapper.className = "emby-server-card";
  wrapper.dataset.id = server.id || uid();

  const portsText = Array.isArray(server.reverseProxyPorts)
    ? (server.reverseProxyPorts[0] || "")
    : "";
  const pathRulesText = typeof server.pathPrefixRules === "string"
    ? server.pathPrefixRules.replace(/;/g, "\n")
    : "";
  const enabled = server.enabled !== false;
  const displayName = server.name || `未命名${index + 1}`;
  const cookieOptions = buildCookieProfileOptions(server.p115CookieName);
  const antiRiskNames = normalizeNameList(server.antiRiskCookieNames);
  const regexText = typeof server.customPickcodeRegex === "string"
    ? server.customPickcodeRegex
    : "";

  wrapper.innerHTML = `
    <div class="emby-server-header">
      <div class="emby-server-title" data-role="card-title">配置 #${index + 1} / ${escapeHtml(displayName)}</div>
      <div class="emby-server-tools">
        <button type="button" data-role="add-server" title="新增配置">+</button>
        <button type="button" data-role="remove-server" title="删除配置">-</button>
      </div>
    </div>
    <label>
      <span>名称</span>
      <input data-role="name" type="text" value="${escapeHtml(server.name || "")}" placeholder="家庭主机" />
    </label>
    <div class="emby-address-port-row">
      <label>
        <span>Emby 地址</span>
        <input data-role="serverUrl" type="text" value="${escapeHtml(server.serverUrl || "")}" placeholder="http://127.0.0.1:8096" />
      </label>
      <span class="emby-address-port-arrow">=&gt;</span>
      <label>
        <span>反代端口</span>
        <input data-role="reverseProxyPorts" type="text" inputmode="numeric" pattern="[0-9]*" value="${escapeHtml(portsText)}" placeholder="5088" />
      </label>
    </div>
    <label>
      <span>Emby API 密钥</span>
      <input data-role="apiKey" type="text" value="${escapeHtml(server.apiKey || "")}" placeholder="在emby服务器后台新建API 密钥" />
    </label>
    <label>
      <span>存储资源的115Cookies（按端口命中后优先使用）</span>
    </label>
    <div class="emby-cookie-row">
      <div class="emby-cookie-account-card" data-role="cookie-account-card">
        <img class="emby-cookie-avatar is-empty" data-role="cookie-avatar" alt="用户头像" src="" />
        <div class="emby-cookie-account-meta">
          <div class="emby-cookie-account-top">
            <span class="emby-cookie-user-name" data-role="cookie-user-name">未选择账号</span>
            <span class="emby-cookie-vip" data-role="cookie-vip">--</span>
          </div>
          <div class="emby-cookie-space" data-role="cookie-space">剩余空间：--</div>
        </div>
      </div>
      <label>
        <span>选择Cookies（来源于cookies池）</span>
        <select data-role="p115CookieName">${cookieOptions}</select>
      </label>
    </div>
    <div class="emby-field emby-anti-risk-full">
      <span>防风控秒传播放（可多选，可不选）</span>
      <div class="multi-picker" data-role="antiRiskCookieNamesPicker" data-selected-names="[]" tabindex="0" aria-expanded="false">
        <div class="multi-picker-values" data-role="picker-values"></div>
        <span class="multi-picker-arrow">▾</span>
        <div class="multi-picker-menu" data-role="picker-menu"></div>
      </div>
    </div>
    <label>
      <span>路径替换规则（每行一条，格式：旧前缀=>新前缀）</span>
      <textarea data-role="pathPrefixRules" rows="3" placeholder="">${escapeHtml(pathRulesText)}</textarea>
    </label>
    <label>
      <span>自定义pc码提取正则（一行一个）</span>
      <textarea data-role="customPickcodeRegex" rows="3" placeholder="">${escapeHtml(regexText)}</textarea>
    </label>
    <div class="emby-server-footer">
      <label class="emby-enable">
        <input data-role="enabled" type="checkbox" ${enabled ? "checked" : ""} />
        <span>启用服务器</span>
      </label>
      <button type="button" data-role="test-server">连接测试</button>
    </div>
    <p class="hint" data-role="test-result"></p>
  `;

  renderAntiRiskPicker(wrapper, antiRiskNames);
  return wrapper;
}

function ensureAtLeastOneEnabledServer() {
  if (!embyServersContainer) {
    return;
  }
  const switches = Array.from(embyServersContainer.querySelectorAll("input[data-role='enabled']"));
  if (!switches.length) {
    return;
  }
  const hasEnabled = switches.some((node) => node instanceof HTMLInputElement && node.checked);
  if (!hasEnabled) {
    const first = switches[0];
    if (first instanceof HTMLInputElement) {
      first.checked = true;
    }
  }
}

function refreshEmbyCardMeta() {
  if (!embyServersContainer) {
    return;
  }
  const cards = Array.from(embyServersContainer.querySelectorAll(".emby-server-card"));
  cards.forEach((card, index) => {
    const title = card.querySelector("[data-role='card-title']");
    const nameInput = card.querySelector("[data-role='name']");
    const name = nameInput && "value" in nameInput ? nameInput.value.trim() : "";
    if (title) {
      title.textContent = `配置 #${index + 1} / ${name || `未命名${index + 1}`}`;
    }
  });
}

function renderEmbyServers(servers, activeId) {
  if (!embyServersContainer) {
    return;
  }

  const list = Array.isArray(servers) && servers.length
    ? servers
      : [{ id: uid(), name: "默认Emby", serverUrl: "", apiKey: "", p115CookieName: "", antiRiskCookieNames: [], customPickcodeRegex: "", p115Cookie: "", enabled: true, reverseProxyPorts: [], pathPrefixRules: "" }];

  const fragment = document.createDocumentFragment();
  list.forEach((server, index) => {
    const item = {
      id: server.id || uid(),
      name: server.name || "",
      serverUrl: server.serverUrl || "",
      apiKey: server.apiKey || "",
      p115CookieName: typeof server.p115CookieName === "string" ? server.p115CookieName : "",
      antiRiskCookieNames: normalizeNameList(server.antiRiskCookieNames),
      customPickcodeRegex: typeof server.customPickcodeRegex === "string" ? server.customPickcodeRegex : "",
      p115Cookie: typeof server.p115Cookie === "string" ? server.p115Cookie : "",
      enabled: server.enabled !== false,
      reverseProxyPorts: Array.isArray(server.reverseProxyPorts) ? server.reverseProxyPorts : [],
      pathPrefixRules: typeof server.pathPrefixRules === "string" ? server.pathPrefixRules : ""
    };
    fragment.appendChild(createEmbyServerCard(item, index));
  });
  embyServersContainer.replaceChildren(fragment);
  Array.from(embyServersContainer.querySelectorAll(".emby-server-card")).forEach((card) => {
    if (card instanceof HTMLElement) {
      syncAntiRiskSelectForCard(card);
    }
  });
  refreshEmbyCardMeta();
  void refreshAllEmbyCookieProfileInfo();
  if (activeId) {
    const matched = list.find((item) => item.id === activeId && item.enabled !== false);
    if (!matched) {
      ensureAtLeastOneEnabledServer();
    }
  } else {
    ensureAtLeastOneEnabledServer();
  }
}

function collectEmbyServers() {
  if (!embyServersContainer) {
    return {
      servers: [],
      activeId: ""
    };
  }

  const cards = Array.from(embyServersContainer.querySelectorAll(".emby-server-card"));
  const servers = [];
  let activeId = "";

  for (const card of cards) {
    const cardId = card.dataset.id || uid();
    const nameInput = card.querySelector("[data-role='name']");
    const urlInput = card.querySelector("[data-role='serverUrl']");
    const keyInput = card.querySelector("[data-role='apiKey']");
    const cookieNameInput = card.querySelector("[data-role='p115CookieName']");
    const antiRiskCookieNamesInput = card.querySelector("[data-role='antiRiskCookieNamesPicker']");
    const portsInput = card.querySelector("[data-role='reverseProxyPorts']");
    const rulesInput = card.querySelector("[data-role='pathPrefixRules']");
    const regexInput = card.querySelector("[data-role='customPickcodeRegex']");
    const enabledInput = card.querySelector("input[data-role='enabled']");

    const name = nameInput && "value" in nameInput ? nameInput.value.trim() : "";
    const serverUrl = urlInput && "value" in urlInput ? urlInput.value.trim() : "";
    const apiKey = keyInput && "value" in keyInput ? keyInput.value.trim() : "";
    const p115CookieName = cookieNameInput && "value" in cookieNameInput ? cookieNameInput.value.trim() : "";
    const antiRiskCookieNames = getAntiRiskPickerValues(antiRiskCookieNamesInput);
    const portsText = portsInput && "value" in portsInput ? portsInput.value : "";
    const singlePort = normalizeSinglePort(portsText);
    const rulesText = rulesInput && "value" in rulesInput ? rulesInput.value : "";
    const customPickcodeRegex = regexInput && "value" in regexInput ? regexInput.value : "";
    const enabled = enabledInput && "checked" in enabledInput ? enabledInput.checked : true;

    servers.push({
      id: cardId,
      name: name || `emby-${servers.length + 1}`,
      serverUrl,
      apiKey,
      p115CookieName,
      antiRiskCookieNames,
      customPickcodeRegex,
      p115Cookie: "",
      enabled,
      reverseProxyPorts: singlePort ? [singlePort] : [],
      pathPrefixRules: normalizePathRules(rulesText)
    });

    if (!activeId && enabled) {
      activeId = cardId;
    }
  }

  if (!servers.length) {
    const fallbackId = uid();
    return {
      servers: [{ id: fallbackId, name: "默认Emby", serverUrl: "", apiKey: "", p115CookieName: "", antiRiskCookieNames: [], customPickcodeRegex: "", p115Cookie: "", enabled: true, reverseProxyPorts: [], pathPrefixRules: "" }],
      activeId: fallbackId
    };
  }

  if (!activeId) {
    const firstEnabled = servers.find((item) => item.enabled);
    activeId = firstEnabled ? firstEnabled.id : servers[0].id;
  }

  return { servers, activeId };
}

function validateEmbyServers(data) {
  const seenPorts = new Set();
  const enabledCount = data.servers.filter((item) => item.enabled).length;
  const selectableProfiles = getSelectableCookieProfiles();
  if (!selectableProfiles.length) {
    return "去cookies配置里添加cookies！";
  }
  if (enabledCount === 0) {
    return "至少启用一个服务器";
  }

  for (const server of data.servers) {
    if (!server.serverUrl) {
      return "请为每个 Emby 服务器填写地址";
    }
    let parsed;
    try {
      parsed = new URL(server.serverUrl);
    } catch (_error) {
      return `Emby 地址格式不合法: ${server.serverUrl}`;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return `Emby 地址必须是 http/https: ${server.serverUrl}`;
    }

    const portRaw = Array.isArray(server.reverseProxyPorts) ? String(server.reverseProxyPorts[0] || "").trim() : "";
    if (!portRaw) {
      return `请填写反代端口（服务器：${server.name || server.id}）`;
    }
    if (!/^\d+$/.test(portRaw)) {
      return `反代端口只能填写数字: ${portRaw}`;
    }
    const port = Number.parseInt(portRaw, 10);
    if (port < 1 || port > 65535) {
      return `反代端口超出范围(1-65535): ${portRaw}`;
    }
    if (seenPorts.has(portRaw)) {
      return `反代端口重复: ${portRaw}`;
    }
    seenPorts.add(portRaw);

    if (!server.p115CookieName) {
      return "请选择资源cookies！";
    }
    const exists = selectableProfiles.some((item) => item.name === server.p115CookieName);
    if (!exists) {
      return `Cookies配置不存在: ${server.p115CookieName}`;
    }
    const antiRiskCookieNames = normalizeNameList(server.antiRiskCookieNames);
    for (const antiRiskName of antiRiskCookieNames) {
      if (antiRiskName === server.p115CookieName) {
        return `防风控Cookies不能与资源cookies相同: ${antiRiskName}`;
      }
      const antiRiskExists = selectableProfiles.some((item) => item.name === antiRiskName);
      if (!antiRiskExists) {
        return `防风控Cookies配置不存在: ${antiRiskName}`;
      }
    }

    if (server.pathPrefixRules) {
      const lines = server.pathPrefixRules.split(/[;\r\n]+/).map((line) => line.trim()).filter(Boolean);
      for (const line of lines) {
        if (!line.includes("=>")) {
          return `路径替换规则格式错误: ${line}`;
        }
      }
    }
  }

  return "";
}

function normalizeEmbyConfigFromBackend(emby) {
  const rawServers = Array.isArray(emby?.servers) ? emby.servers : [];
  const servers = rawServers
    .filter((item) => item && typeof item === "object")
    .map((item, index) => ({
      id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : uid(),
      name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : `emby-${index + 1}`,
      serverUrl: typeof item.serverUrl === "string" ? item.serverUrl.trim() : "",
      apiKey: typeof item.apiKey === "string" ? item.apiKey.trim() : "",
      p115CookieName: typeof item.p115CookieName === "string" ? item.p115CookieName.trim() : "",
      antiRiskCookieNames: normalizeNameList(
        Array.isArray(item.antiRiskCookieNames)
          ? item.antiRiskCookieNames
          : (typeof item.antiRiskCookieName === "string" ? [item.antiRiskCookieName] : [])
      ),
      customPickcodeRegex: typeof item.customPickcodeRegex === "string" ? item.customPickcodeRegex : "",
      p115Cookie: typeof item.p115Cookie === "string" ? item.p115Cookie : "",
      enabled: item.enabled !== false,
      reverseProxyPorts: Array.isArray(item.reverseProxyPorts)
        ? item.reverseProxyPorts.map((port) => String(port).trim()).filter((port) => port)
        : [],
      pathPrefixRules: typeof item.pathPrefixRules === "string" ? item.pathPrefixRules : ""
    }))
    .filter((item) => item.serverUrl.length > 0);

  if (!servers.length) {
    const fallbackId = uid();
    return {
      activeId: fallbackId,
      servers: [{
        id: fallbackId,
        name: "默认Emby",
        serverUrl: emby?.serverUrl || "",
        apiKey: "",
        p115CookieName: "",
        antiRiskCookieNames: [],
        customPickcodeRegex: "",
        p115Cookie: "",
        enabled: true,
        reverseProxyPorts: [],
        pathPrefixRules: ""
      }]
    };
  }

  const activeId =
    typeof emby?.activeServerId === "string" && servers.some((item) => item.id === emby.activeServerId && item.enabled)
      ? emby.activeServerId
      : (servers.find((item) => item.enabled)?.id || servers[0].id);

  return {
    activeId,
    servers
  };
}

async function fetchJson(url, options) {
  const merged = {
    cache: "no-store",
    ...options
  };
  const response = await fetch(url, merged);
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      const payload = text ? JSON.parse(text) : null;
      if (payload && typeof payload === "object" && typeof payload.error === "string") {
        message = payload.error;
      }
    } catch (_error) {
      message = text;
    }
    throw new Error(message || "请求失败");
  }
  return response.json();
}

async function testEmbyServer(card) {
  const resultElement = card.querySelector("[data-role='test-result']");
  const testButton = card.querySelector("[data-role='test-server']");
  const urlInput = card.querySelector("[data-role='serverUrl']");
  const keyInput = card.querySelector("[data-role='apiKey']");

  const serverUrl = urlInput && "value" in urlInput ? urlInput.value.trim() : "";
  const apiKey = keyInput && "value" in keyInput ? keyInput.value.trim() : "";

  if (!resultElement) {
    return;
  }
  if (!serverUrl) {
    setHint(resultElement, "请先填写 Emby 地址", true);
    return;
  }

  if (testButton instanceof HTMLButtonElement) {
    testButton.disabled = true;
    testButton.textContent = "测试中...";
  }
  setHint(resultElement, "正在测试连接...", false);

  try {
    const result = await fetchJson("/api/emby/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverUrl, apiKey })
    });
    const name = result.serverName ? ` ${result.serverName}` : "";
    const version = result.version ? ` v${result.version}` : "";
    setHint(resultElement, `连接成功${name}${version}`, false);
  } catch (error) {
    setHint(resultElement, error instanceof Error ? error.message : "连接失败", true);
  } finally {
    if (testButton instanceof HTMLButtonElement) {
      testButton.disabled = false;
      testButton.textContent = "连接测试";
    }
  }
}

async function loadConfig() {
  const config = await fetchJson("/api/config");
  hydrateEmbyUsersFromCache();
  currentCookieProfiles = Array.isArray(config?.p115?.cookieProfiles)
    ? config.p115.cookieProfiles
    : [];
  currentUser302Rules = Array.isArray(config?.user302?.rules)
    ? config.user302.rules
    : [];
  renderProfiles(config.p115.cookieProfiles || [], config.p115.activeCookieName || "");
  renderUser302Rules(currentUser302Rules);
  if (user302EnabledInput instanceof HTMLInputElement) {
    user302EnabledInput.checked = config?.user302?.enabled !== false;
  }

  const embyConfig = normalizeEmbyConfigFromBackend(config.emby || {});
  renderEmbyServers(embyConfig.servers, embyConfig.activeId);
  await refreshEmbyUsersOnAccess("playback");
}

async function loadStatus() {
  const status = await fetchJson("/api/status");
  if (statusUptime) {
    statusUptime.textContent = `${status.uptimeSeconds}s`;
  }
  if (statusCache) {
    statusCache.textContent = String(status.cacheSize);
  }
  if (statusLogs) {
    statusLogs.textContent = String(status.logSize);
  }
  if (statusCookies) {
    statusCookies.textContent = String(status.cookieCount ?? 0);
  }
  if (statusUsers) {
    statusUsers.textContent = String(status.userCount ?? 0);
  }
  if (statusTransferSuccess) {
    statusTransferSuccess.textContent = String(status.fastTransferSuccessCount ?? 0);
  }
}

function renderLogs(items) {
  if (!logsContainer) {
    return;
  }
  const keyword = logsFilterInput instanceof HTMLInputElement
    ? logsFilterInput.value.trim().toLowerCase()
    : "";

  const source = keyword
    ? items.filter((item) => {
      const detailText = item.detail ? JSON.stringify(item.detail) : "";
      const traceId = resolveLogTraceId(item);
      return [item.route, item.message, item.strategy, String(item.status), detailText, traceId]
        .join(" ")
        .toLowerCase()
        .includes(keyword);
    })
    : items;

  logsContainer.textContent = "";
  if (!source.length) {
    logsContainer.textContent = "暂无日志";
    return;
  }

  const chains = buildTraceChains(source)
    .filter((chain) => {
      if (!keyword) {
        return true;
      }
      const text = [
        chain.traceId,
        chain.summary.statusText,
        chain.summary.currentStage,
        chain.summary.itemId,
        chain.summary.mediaSourceId,
        chain.summary.strategy,
        chain.summary.serverName,
        chain.summary.userLabel,
        chain.summary.playFileName,
        chain.summary.transferLink,
        chain.summary.embySource,
        chain.summary.finalUrl,
        chain.requestInfo.requestUrl,
        chain.requestInfo.headersLine,
        JSON.stringify(chain.parameterExtract),
        chain.steps.map((step) => step.text).join("\n")
      ].join(" ").toLowerCase();
      return text.includes(keyword);
    });

  const fragment = document.createDocumentFragment();
  for (const chain of chains) {
    const card = document.createElement("section");
    card.className = "log-trace-group";

    const title = document.createElement("div");
    title.className = "log-trace-title";
    const traceIdLabel = document.createElement("span");
    traceIdLabel.className = "log-trace-id";
    traceIdLabel.textContent = `追踪ID：${chain.traceId}`;
    const traceStartTime = document.createElement("span");
    traceStartTime.className = "log-trace-start-time";
    traceStartTime.textContent = `开始时间：${chain.summary.requestTime || "-"}`;
    title.append(traceIdLabel, traceStartTime);
    card.appendChild(title);

    const summary = document.createElement("div");
    summary.className = "log-summary-grid";
    const summaryStrategy = formatSummaryStrategy(chain.summary, chain.urlResolve);
    const statusClass = chain.summary.statusKind === "failure"
      ? "is-error"
      : (chain.summary.statusKind === "success" ? "is-ok" : "");
    appendSummaryBlock(summary, [
      `状态：${chain.summary.statusText}   服务器：${chain.summary.serverName || "-"}   用户：${chain.summary.userLabel || "-"}`,
      `播放内容：[${chain.summary.mediaSourceId || "-"}] | ${chain.summary.playFileName || "-"}`,
      `媒体源缓存：${chain.summary.mediaCacheHit ? "命中" : "未命中"}　|　URL缓存：${chain.summary.urlCacheHit ? "命中" : "未命中"}`,
      "",
      `播放策略：${summaryStrategy}`,
      `复制链路：${chain.summary.transferLink || "-"}`,
      `重定向URL：${chain.summary.finalUrl || "-"}`
    ], statusClass);
    card.appendChild(summary);

    const detailsWrap = document.createElement("details");
    detailsWrap.className = "log-details-wrap";
    if (expandedTraceIds.has(chain.traceId)) {
      detailsWrap.open = true;
    }
    const detailsSummary = document.createElement("summary");
    detailsSummary.className = "log-details-toggle";
    detailsSummary.textContent = detailsWrap.open ? "收起详情" : "展开详情";
    detailsWrap.appendChild(detailsSummary);
    detailsWrap.addEventListener("toggle", () => {
      if (detailsWrap.open) {
        expandedTraceIds.add(chain.traceId);
      } else {
        expandedTraceIds.delete(chain.traceId);
      }
      detailsSummary.textContent = detailsWrap.open ? "收起详情" : "展开详情";
    });

    if (chain.summary.failureReason) {
      const fail = document.createElement("div");
      fail.className = "log-trace-failure";
      fail.textContent = `失败原因：${chain.summary.failureReason}`;
      detailsWrap.appendChild(fail);
    }

    const moduleGrid = document.createElement("div");
    moduleGrid.className = "log-module-grid";

    moduleGrid.appendChild(createModulePanel("请求信息", [
      `请求URL：${chain.requestInfo.requestUrl || "-"}`,
      `请求头：${chain.requestInfo.headersLine || "-"}`,
      `客户端：${chain.requestInfo.client || "-"}`,
      `UserId：${chain.requestInfo.userId || "-"}`,
      `DeviceId：${chain.requestInfo.deviceId || "-"}`,
      `PlaySessionId：${chain.requestInfo.playSessionId || "-"}`
    ]));

    moduleGrid.appendChild(createModulePanel("提取参数", [
      `DeviceId=${chain.parameterExtract.DeviceId || ""}`,
      `ItemId=${chain.parameterExtract.ItemId || ""}`,
      `x-emby-source=${chain.parameterExtract["x-emby-source"] || ""}`,
      `MediaSourceId=${chain.parameterExtract.MediaSourceId || ""}`,
      `PlaySessionId=${chain.parameterExtract.PlaySessionId || ""}`,
      `api_key=${chain.parameterExtract.api_key || ""}`,
      `X-Emby-Token=${chain.parameterExtract["X-Emby-Token"] || ""}`,
      `UserId=${chain.parameterExtract.UserId || ""}`
    ]));

    moduleGrid.appendChild(createModulePanel("媒体源解析", [
      `MediaSourceId缓存：${chain.mediaResolve.cacheHit ? "命中" : "未命中"}`,
      `path：${chain.mediaResolve.path || "-"}`,
      `写入缓存：${chain.mediaResolve.cacheWrite ? chain.mediaResolve.cacheWrite : "否"}`
    ]));

    moduleGrid.appendChild(createModulePanel("URL解析", [
      `重定向URL缓存：${chain.urlResolve.cacheHit ? "命中" : "未命中"}`,
      `最终URL：${chain.urlResolve.finalUrl || "-"}`,
      `获取方式：${chain.urlResolve.method || "-"}`
    ]));

    moduleGrid.appendChild(createModulePanel("策略执行", [
      `播放策略：${chain.strategy.strategy || "-"}　|　动作：${chain.strategy.action || "-"}`,
      `原账号：${chain.strategy.sourceAccount || "-"}　|　目标账号：${chain.strategy.targetAccount || "-"}`,
      `文件大小：${chain.strategy.fileSize || "-"}　|　SHA1：${chain.strategy.sha1 || "-"}`,
      `Range验证：${chain.strategy.rangeVerified ? "是" : "否"}　|　结果：${normalizeStrategyResultText(chain.strategy.result) || "-"}`,
      `目标文件：${chain.strategy.fileNameResolved || chain.summary.playFileName || "-"}（${chain.strategy.pickecode || "-"}）`
    ]));

    moduleGrid.appendChild(createModulePanel("返回结果", [
      `HTTP状态码：${chain.result.httpStatus}`,
      `Location：${chain.result.location || "-"}`,
      `总耗时：${chain.result.elapsedMs} ms`
    ]));

    detailsWrap.appendChild(moduleGrid);

    const timeline = document.createElement("div");
    timeline.className = "log-timeline-box";
    const tTitle = document.createElement("div");
    tTitle.className = "log-module-title";
    tTitle.textContent = "关键时间线";
    timeline.appendChild(tTitle);
    chain.timeline.forEach((line, idx) => {
      const row = document.createElement("div");
      row.className = "log-row";
      const timeCol = document.createElement("div");
      timeCol.className = "log-row-time";
      timeCol.textContent = line.time;
      const actionCol = document.createElement("div");
      actionCol.className = "log-row-action";
      const seq = document.createElement("span");
      seq.className = "log-seq-badge";
      seq.textContent = String(idx + 1);
      const text = document.createElement("span");
      text.className = "log-row-text";
      text.textContent = line.text;
      text.title = line.text;
      actionCol.append(seq, text);
      row.append(timeCol, actionCol);
      timeline.appendChild(row);
    });
    detailsWrap.appendChild(timeline);
    card.appendChild(detailsWrap);

    fragment.appendChild(card);
  }

  logsContainer.replaceChildren(fragment);
}
function resolveLogTraceId(item) {
  const top = typeof item?.trace_id === "string" ? item.trace_id.trim() : "";
  if (top) {
    return top;
  }
  const nested = typeof item?.detail?.trace_summary?.trace_id === "string"
    ? item.detail.trace_summary.trace_id.trim()
    : "";
  if (nested) {
    return nested;
  }
  const eventTrace = Array.isArray(item?.detail?.events)
    ? item.detail.events.find((event) => typeof event?.trace_id === "string" && event.trace_id.trim())?.trace_id
    : "";
  if (eventTrace) {
    return eventTrace.trim();
  }
  return item?.id || `trace-${uid()}`;
}

function buildTraceChains(items) {
  const byTrace = new Map();
  for (const item of items) {
    const traceId = resolveLogTraceId(item);
    if (!byTrace.has(traceId)) {
      byTrace.set(traceId, []);
    }
    byTrace.get(traceId).push(item);
  }

  const chains = [];
  for (const [traceId, entries] of byTrace.entries()) {
    const sorted = entries.slice().sort((a, b) => Date.parse(a.time || "") - Date.parse(b.time || ""));
    const first = sorted[0];
    const latest = sorted[sorted.length - 1];
    const dedupSteps = dedupeSteps(sorted.map(toStep).filter(Boolean));
    const parameterExtract = findParams(sorted);
    const mediaResolve = findMediaResolve(sorted);
    const urlResolve = findUrlResolve(sorted);
    const strategy = findStrategy(sorted, urlResolve.finalUrl);
    const result = findResult(sorted);
    const timeline = buildKeyTimeline(dedupSteps, result.elapsedMs);
    const serverUser = findServerUser(sorted, parameterExtract);
    const transferLink = findTransferLink(sorted, strategy);
    const playFileName = getFileNameFromPath(mediaResolve.path || "");

    chains.push({
      traceId,
      latestTs: Date.parse(latest.time || "") || 0,
      summary: {
        statusKind: result.statusKind,
        statusText: result.statusKind === "success"
          ? "成功302"
          : (result.statusKind === "failure"
            ? `失败${result.httpStatus ? `(${result.httpStatus})` : ""}`
            : "处理中"),
        failed: result.statusKind === "failure",
        currentStage: dedupSteps.length ? dedupSteps[dedupSteps.length - 1].label : "无",
        requestTime: formatLogTime(first.time),
        itemId: parameterExtract.ItemId || pickExtracted(latest, "提取ItemId"),
        mediaSourceId: parameterExtract.MediaSourceId || pickExtracted(latest, "提取MediaSourceId"),
        strategy: strategy.strategy,
        serverName: serverUser.serverName,
        userLabel: serverUser.userLabel,
        playFileName,
        transferLink,
        embySource: mediaResolve.path,
        finalUrl: result.location || urlResolve.finalUrl,
        mediaCacheHit: mediaResolve.cacheHit,
        urlCacheHit: urlResolve.cacheHit,
        failureReason: result.statusKind === "failure" ? result.failureReason : ""
      },
      latestItem: latest,
      requestInfo: findRequestInfo(sorted, parameterExtract),
      parameterExtract,
      mediaResolve,
      urlResolve,
      strategy,
      result,
      steps: dedupSteps,
      timeline
    });
  }

  chains.sort((a, b) => b.latestTs - a.latestTs);
  return chains;
}

function toStep(item) {
  const text = String(item?.message || "").trim();
  if (!text) {
    return null;
  }
  return {
    time: formatLogTime(item?.time),
    label: classifyStepLabel(text),
    text,
    raw: item,
    key: classifyStepKey(text)
  };
}

function classifyStepLabel(text) {
  if (text.startsWith("拦截请求")) return "收到播放请求";
  if (text.startsWith("提取的参数")) return "提取播放参数";
  if (text.startsWith("命中缓存")) return "媒体源缓存命中";
  if (text.startsWith("向Emby确定源文件")) return "向Emby回源";
  if (text.startsWith("使用缓存的重定向URL")) return "重定向URL缓存命中";
  if (text.includes("重新获取重定向URL")) return "重定向URL缓存未命中";
  if (text.startsWith("播放策略")) return "选择播放策略";
  if (text.includes("开始秒传")) return "执行秒传";
  if (text.includes("复制同播")) return "执行复制";
  if (text.startsWith("重定向URL")) return "获取重定向URL";
  if (text.includes("302重定向成功")) return "返回302";
  return text;
}

function classifyStepKey(text) {
  if (text.startsWith("拦截请求")) return "request_enter";
  if (text.startsWith("请求头")) return "request_headers";
  if (text.startsWith("提取的参数")) return "request_params";
  if (text.startsWith("命中缓存")) return "media_cache_hit";
  if (text.startsWith("向Emby确定源文件")) return "emby_query";
  if (text.startsWith("Emby源文件")) return "emby_source";
  if (text.startsWith("写入媒体源缓存")) return "media_cache_write";
  if (text.startsWith("使用缓存的重定向URL")) return "url_cache_hit";
  if (text.includes("重新获取重定向URL")) return "url_cache_miss";
  if (text.includes("重新获取重定向URL")) return "url_refresh";
  if (text.startsWith("播放策略")) return "strategy";
  if (text.includes("开始秒传")) return "transfer_start";
  if (text.includes("文件信息")) return "transfer_info";
  if (text.includes("range验证")) return "transfer_range";
  if (text.includes("秒传成功")) return "transfer_success";
  if (text.includes("复制同播")) return "copy_action";
  if (text.startsWith("重定向URL")) return "redirect_url";
  if (text.includes("302重定向成功")) return "request_end";
  return text;
}

function dedupeSteps(steps) {
  const seen = new Map();
  const out = [];
  for (const step of steps) {
    const payload = JSON.stringify(step.raw?.detail?.extracted || {}) + `|${step.text}`;
    const prev = seen.get(step.key);
    if (prev === payload) {
      continue;
    }
    seen.set(step.key, payload);
    out.push(step);
  }
  return out;
}

function buildKeyTimeline(steps, elapsedMs) {
  const wanted = [
    "request_enter",
    "request_params",
    "media_cache_hit",
    "emby_query",
    "url_cache_hit",
    "url_cache_miss",
    "strategy",
    "transfer_start",
    "transfer_success",
    "copy_action",
    "redirect_url",
    "request_end"
  ];
  const out = [];
  for (const key of wanted) {
    const hit = steps.find((step) => step.key === key);
    if (hit) {
      const text = formatTimelineEntry(hit, elapsedMs);
      if (!text) {
        continue;
      }
      out.push({
        time: hit.time,
        text
      });
    }
  }
  return out;
}

function formatTimelineEntry(step, elapsedMs) {
  const message = String(step?.text || "").trim();
  const extracted = step?.raw?.detail?.extracted && typeof step.raw.detail.extracted === "object"
    ? step.raw.detail.extracted
    : {};
  if (step.key === "request_enter") {
    const url = pickObj(extracted, "请求url原文") || pickFromMessage(message, "拦截请求：") || "-";
    return `收到播放请求：${url}`;
  }
  if (step.key === "request_params") {
    const pairs = [
      `DeviceId=${pickObj(extracted, "DeviceId") || "-"}`,
      `ItemId=${pickObj(extracted, "ItemId") || "-"}`,
      `MediaSourceId=${pickObj(extracted, "MediaSourceId") || "-"}`,
      `PlaySessionId=${pickObj(extracted, "PlaySessionId") || "-"}`,
      `UserId=${pickObj(extracted, "UserId") || "-"}`
    ];
    return `提取到的播放参数：${pairs.join(", ")}`;
  }
  if (step.key === "media_cache_hit") {
    const mediaSourceId = pickObj(extracted, "MediaSourceId")
      || pickFromMessage(message, "命中缓存：").split("（")[0].trim()
      || "-";
    return `媒体源缓存命中：${mediaSourceId}`;
  }
  if (step.key === "url_cache_miss") {
    return "缓存不存在或已过期，重新获取重定向URL";
  }
  if (step.key === "strategy") {
    const strategy = pickFromMessage(message, "播放策略：") || message;
    return `选择播放策略：${strategy}`;
  }
  if (step.key === "transfer_start") {
    return message;
  }
  if (step.key === "transfer_success") {
    const pickcode = pickObj(extracted, "pickcode") || extractPickecodeFromText(message) || "";
    if (!pickcode) {
      return "";
    }
    const successText = sanitizeTransferSuccessText(message, extracted, pickcode);
    return `${successText}（${pickcode}）`;
  }
  if (step.key === "request_end") {
    const base = step.label === step.text ? message : `${step.label}：${message}`;
    return `${base}，总耗时：${Math.max(0, Number(elapsedMs || 0))} ms`;
  }
  return step.label === step.text ? message : `${step.label}：${message}`;
}

function sanitizeTransferSuccessText(message, extracted, pickcode) {
  const requested = pickObj(extracted, "请求目标文件名") || pickObj(extracted, "新文件名") || "";
  if (requested) {
    return `秒传成功：${requested}`;
  }
  let text = String(message || "").trim();
  text = text.replace(/秒传成功\s*[:：]?\s*/g, "秒传成功：");
  if (pickcode) {
    const escaped = pickcode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`${escaped}$`), "").trim();
  }
  return text;
}

function pickExtracted(item, key) {
  const ex = item?.detail?.extracted;
  return ex && typeof ex === "object" && typeof ex[key] === "string" ? ex[key] : "";
}

function findRequestInfo(entries, params) {
  const requestLine = entries.find((e) => String(e.message || "").startsWith("拦截请求"));
  const headersLine = entries.find((e) => String(e.message || "").startsWith("请求头"));
  const requestUrl = requestLine?.detail?.extracted?.["请求url原文"] || pickFromMessage(requestLine?.message, "拦截请求：") || "";
  const headerRaw = headersLine?.detail?.extracted?.["请求头原文"] || pickFromMessage(headersLine?.message, "请求头：") || "";
  const headersLineSingle = String(headerRaw || "").replace(/\s+/g, " ").trim();
  const headerObj = safeJsonParseObject(headerRaw);
  const headerUserId = pickHeaderValue(headerObj, ["x-emby-user-id", "x-user-id", "x-emby-userid"]);
  const authUserId = parseEmbyAuthField(pickHeaderValue(headerObj, ["x-emby-authorization", "authorization"]), "UserId");
  const headerUserName = pickHeaderValue(headerObj, ["x-emby-username", "x-user-name", "x-emby-user-name"]);
  const authUserName = parseEmbyAuthField(pickHeaderValue(headerObj, ["x-emby-authorization", "authorization"]), "UserName");
  return {
    requestUrl,
    headersLine: headersLineSingle,
    client: String((headerObj["user-agent"] || "")).trim(),
    userName: headerUserName || authUserName || "",
    userId: params.UserId || headerUserId || authUserId || "",
    deviceId: params.DeviceId || "",
    playSessionId: params.PlaySessionId || ""
  };
}

function findParams(entries) {
  const row = entries.find((e) => String(e.message || "").startsWith("提取的参数"));
  const ex = row?.detail?.extracted;
  return {
    DeviceId: pickObj(ex, "DeviceId"),
    ItemId: pickObj(ex, "ItemId"),
    "x-emby-source": pickObj(ex, "x-emby-source"),
    MediaSourceId: pickObj(ex, "MediaSourceId"),
    PlaySessionId: pickObj(ex, "PlaySessionId"),
    api_key: pickObj(ex, "api_key"),
    "X-Emby-Token": pickObj(ex, "X-Emby-Token"),
    UserId: pickObj(ex, "UserId")
  };
}

function findMediaResolve(entries) {
  const hitRow = entries.find((e) => String(e.message || "").startsWith("命中缓存："));
  const missRow = entries.find((e) => String(e.message || "").startsWith("向Emby确定源文件："));
  const sourceRow = entries.find((e) => String(e.message || "").startsWith("Emby源文件"));
  const writeRow = entries.find((e) => String(e.message || "").startsWith("写入媒体源缓存"));
  return {
    cacheHit: Boolean(hitRow),
    path: pickObj(hitRow?.detail?.extracted, "Emby源文件") || pickObj(missRow?.detail?.extracted, "Emby源文件") || pickFromMessage(sourceRow?.message, "Emby源文件：") || "",
    cacheWrite: pickObj(missRow?.detail?.extracted, "已缓存") || pickFromMessage(writeRow?.message, "写入媒体源缓存：") || ""
  };
}

function findUrlResolve(entries) {
  const cacheHit = entries.find((e) => String(e.message || "").startsWith("使用缓存的重定向URL"));
  const cacheMiss = entries.find((e) => String(e.message || "").includes("重新获取重定向URL"));
  const direct = entries.filter((e) => String(e.message || "").startsWith("重定向URL:")).slice(-1)[0];
  const useCached = entries.find((e) => String(e.message || "").startsWith("使用缓存的重定向URL"));
  const latest = entries[entries.length - 1] || {};
  const finalUrl = pickObj(direct?.detail?.extracted, "重定向URL")
    || pickFromMessage(direct?.message, "重定向URL:")
    || pickFromMessage(useCached?.message, "使用缓存的重定向URL:")
    || String(latest?.detail?.directUrl || "")
    || "";
  return {
    cacheHit: Boolean(cacheHit),
    finalUrl,
    method: cacheHit ? "缓存复用" : (cacheMiss ? "重新获取" : "未知")
  };
}

function findStrategy(entries, fallbackUrl) {
  const strategyLine = entries.find((e) => String(e.message || "").startsWith("播放策略："));
  const strategy = pickFromMessage(strategyLine?.message, "播放策略：") || "";
  const start = entries.find((e) => String(e.message || "").includes("开始秒传"));
  const info = entries.find((e) => String(e.message || "").includes("文件信息"));
  const success = entries.find((e) => String(e.message || "").includes("秒传成功") || String(e.message || "").includes("复制成功"));
  const range = entries.find((e) => String(e.message || "").includes("range验证"));
  const accountMatch = String(start?.message || "").match(/开始秒传[:：]\s*(.*?)\s*(?:=》|=>)\s*(.*)$/);
  const requestedFileName = pickObj(success?.detail?.extracted, "请求目标文件名") || "";
  const returnedFileName = pickObj(success?.detail?.extracted, "秒传返回文件名") || "";
  const newFileName = pickObj(success?.detail?.extracted, "新文件名") || "";
  return {
    strategy: strategy || (start ? "防风控秒传" : (entries.some((e) => String(e.message || "").includes("复制同播")) ? "同播复制" : "直接播放")),
    action: start ? "秒传" : (entries.some((e) => String(e.message || "").includes("复制同播")) ? "复制" : "直接播放"),
    sourceAccount: pickObj(start?.detail?.extracted, "源账号")
      || pickObj(start?.detail?.extracted, "源账号id")
      || accountMatch?.[1]
      || "",
    targetAccount: pickObj(start?.detail?.extracted, "目标账号")
      || pickObj(start?.detail?.extracted, "目标账号id")
      || accountMatch?.[2]
      || "",
    fileSize: pickObj(info?.detail?.extracted, "大小") || "",
    sha1: pickObj(info?.detail?.extracted, "SHA1") || "",
    rangeVerified: Boolean(range),
    result: success ? success.message : "",
    pickecode: extractPickecode(entries, fallbackUrl),
    fileNameRequested: requestedFileName,
    fileNameReturned: returnedFileName,
    fileNameNew: newFileName,
    fileNameResolved: requestedFileName || returnedFileName || newFileName || ""
  };
}

function extractPickecode(entries, fallbackUrl) {
  const keyCandidates = [
    "pickecode",
    "pickcode",
    "pick_code",
    "pc",
    "target_pickcode",
    "source_pickcode",
    "目标pickcode",
    "源pickcode"
  ];
  for (const entry of entries) {
    const extracted = entry?.detail?.extracted;
    if (extracted && typeof extracted === "object") {
      for (const key of keyCandidates) {
        const value = pickObj(extracted, key);
        if (value) {
          return value;
        }
      }
    }
    const messageValue = extractPickecodeFromText(String(entry?.message || ""));
    if (messageValue) {
      return messageValue;
    }

    const events = entry?.detail?.events;
    if (Array.isArray(events)) {
      for (const event of events) {
        const data = event?.data;
        if (data && typeof data === "object") {
          for (const key of [
            "pickecode",
            "pickcode",
            "pick_code",
            "pc",
            "target_pickcode",
            "source_pickcode",
            "targetPickcode",
            "sourcePickcode"
          ]) {
            const value = pickObj(data, key);
            if (value) {
              return value;
            }
          }
        }
      }
    }
  }
  return extractPickecodeFromText(String(fallbackUrl || ""));
}

function extractPickecodeFromText(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return "";
  }
  const inline = raw.match(/(?:pickecode|pickcode|pick_code|\bpc\b)\s*[:=]\s*([a-z0-9]+)/i);
  if (inline?.[1]) {
    return inline[1];
  }
  try {
    const parsed = new URL(raw);
    return parsed.searchParams.get("pickcode")
      || parsed.searchParams.get("pick_code")
      || parsed.searchParams.get("pc")
      || "";
  } catch (_error) {
    return "";
  }
}

function normalizeStrategyResultText(resultText) {
  const text = String(resultText || "").trim();
  if (!text) {
    return "";
  }
  const successIndex = text.indexOf("秒传成功");
  if (successIndex >= 0) {
    return text.slice(0, successIndex + "秒传成功".length).trim();
  }
  const copyIndex = text.indexOf("复制成功");
  if (copyIndex >= 0) {
    return text.slice(0, copyIndex + "复制成功".length).trim();
  }
  return text;
}

function findResult(entries) {
  const latest = entries[entries.length - 1] || {};
  const successRow = entries.find((e) => Number(e?.status || 0) === 302 || String(e?.message || "").includes("302重定向成功"));
  const failureRow = entries.slice().reverse().find((e) => {
    const text = String(e?.message || "");
    const status = Number(e?.status || 0);
    return text.includes("处理失败") || status >= 400;
  });
  const direct = entries.filter((e) => String(e.message || "").startsWith("重定向URL:")).slice(-1)[0];
  const location = pickObj(direct?.detail?.extracted, "重定向URL")
    || pickFromMessage(direct?.message, "重定向URL:")
    || pickObj(latest?.detail?.extracted, "重定向URL")
    || String(latest?.detail?.directUrl || "")
    || "";
  const firstTs = Date.parse(entries[0]?.time || "") || 0;
  const lastTs = Date.parse(latest?.time || "") || firstTs;
  let statusKind = "pending";
  let statusCode = Number(latest?.status || 0);
  let failureReason = "";
  if (successRow) {
    statusKind = "success";
    statusCode = 302;
  } else if (failureRow) {
    statusKind = "failure";
    statusCode = Number(failureRow?.status || statusCode || 500);
    failureReason = String(failureRow?.message || "");
  }
  return {
    statusKind,
    httpStatus: statusCode,
    location,
    elapsedMs: Math.max(0, lastTs - firstTs),
    failureReason
  };
}

function pickObj(obj, key) {
  return obj && typeof obj === "object" && typeof obj[key] === "string" ? obj[key] : "";
}

function pickFromMessage(message, prefix) {
  const text = String(message || "");
  if (!text.startsWith(prefix)) {
    return "";
  }
  return text.slice(prefix.length).trim();
}

function safeJsonParseObject(text) {
  try {
    const parsed = JSON.parse(String(text || ""));
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch (_error) {
    return {};
  }
  return {};
}

function appendSummary(container, key, value, statusClass = "") {
  const row = document.createElement("div");
  row.className = "log-summary-row";
  const k = document.createElement("span");
  k.className = "log-summary-key";
  k.textContent = key;
  const v = document.createElement("span");
  v.className = `log-summary-value ${statusClass}`.trim();
  v.textContent = value || "-";
  row.append(k, v);
  container.appendChild(row);
}

function appendSummaryLine(container, text, statusClass = "") {
  const row = document.createElement("div");
  row.className = "log-summary-row";
  const value = document.createElement("span");
  value.className = `log-summary-value ${statusClass}`.trim();
  value.textContent = text || "-";
  row.appendChild(value);
  container.appendChild(row);
}

function appendSummaryBlock(container, lines, statusClass = "") {
  const row = document.createElement("div");
  row.className = "log-summary-block";
  const normalized = Array.isArray(lines)
    ? lines.map((line) => String(line || ""))
    : [String(lines || "-")];
  normalized.forEach((line, index) => {
    const lineNode = document.createElement("div");
    lineNode.className = "log-summary-line";
    if (!line.trim()) {
      lineNode.innerHTML = "&nbsp;";
      row.appendChild(lineNode);
      return;
    }
    if (index === 0 && statusClass) {
      const headerMatch = line.match(/^状态：([^\s]+)\s+服务器：(.*?)\s+用户：(.*)$/);
      if (headerMatch) {
        const statusWrap = document.createElement("span");
        statusWrap.className = "log-summary-head-part";
        const prefix = document.createElement("span");
        prefix.className = "log-summary-value";
        prefix.textContent = "状态：";
        const status = document.createElement("span");
        status.className = `log-summary-value ${statusClass}`.trim();
        status.textContent = headerMatch[1];
        statusWrap.append(prefix, status);

        const serverPart = document.createElement("span");
        serverPart.className = "log-summary-head-part log-summary-value";
        serverPart.textContent = `服务器：${headerMatch[2] || "-"}`;

        const userPart = document.createElement("span");
        userPart.className = "log-summary-head-part log-summary-value";
        userPart.textContent = `用户：${headerMatch[3] || "-"}`;

        lineNode.classList.add("is-head");
        lineNode.append(statusWrap, serverPart, userPart);
        row.appendChild(lineNode);
        return;
      }
      const match = line.match(/^状态：([^\s]+)(\s+.*)$/);
      if (match) {
        const prefix = document.createElement("span");
        prefix.className = "log-summary-value";
        prefix.textContent = "状态：";
        const status = document.createElement("span");
        status.className = `log-summary-value ${statusClass}`.trim();
        status.textContent = match[1];
        const suffix = document.createElement("span");
        suffix.className = "log-summary-value";
        suffix.textContent = match[2];
        lineNode.append(prefix, status, suffix);
        row.appendChild(lineNode);
        return;
      }
    }
    if (line.startsWith("重定向URL：")) {
      const prefix = document.createElement("span");
      prefix.className = "log-summary-value log-summary-url-prefix";
      prefix.textContent = "重定向URL：";
      const urlNode = document.createElement("span");
      urlNode.className = "log-summary-value log-summary-url-value";
      const fullUrl = line.slice("重定向URL：".length).trim();
      urlNode.textContent = middleEllipsis(fullUrl, 110);
      urlNode.title = fullUrl;
      lineNode.classList.add("is-url");
      lineNode.append(prefix, urlNode);
      row.appendChild(lineNode);
      return;
    }
    const textNode = document.createElement("span");
    textNode.className = "log-summary-value";
    textNode.textContent = line;
    lineNode.appendChild(textNode);
    row.appendChild(lineNode);
  });
  container.appendChild(row);
}

function middleEllipsis(text, maxLength = 110) {
  const value = String(text || "");
  if (value.length <= maxLength) {
    return value;
  }
  const head = Math.max(20, Math.floor(maxLength * 0.55));
  const tail = Math.max(14, maxLength - head - 1);
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function formatSummaryStrategy(summary, urlResolve) {
  if (urlResolve?.cacheHit) {
    return "缓存复用";
  }
  const text = String(summary?.strategy || "").trim();
  if (!text) {
    return "直接播放";
  }
  return text;
}

function findServerUser(entries, params) {
  const serverName = pickLatestExtracted(entries, "匹配服务器");
  const requestInfo = findRequestInfo(entries, params);
  const extractedUser = pickLatestExtracted(entries, "提取UserId");
  const extractedUserName = pickLatestExtracted(entries, "UserName") || pickLatestExtracted(entries, "提取UserName");
  const userId = String(params.UserId || extractedUser || requestInfo.userId || "").trim();
  const mappedUserName = findEmbyUserNameById(userId);
  const userName = String(mappedUserName || extractedUserName || requestInfo.userName || "").trim();
  let userLabel = "-";
  if (userName && userId) {
    userLabel = `${userName} (${userId})`;
  } else if (userName) {
    userLabel = userName;
  } else if (userId) {
    userLabel = userId;
  }
  return {
    serverName,
    userLabel
  };
}

function findEmbyUserNameById(userId) {
  const targetId = String(userId || "").trim();
  if (!targetId || !Array.isArray(currentEmbyUsers) || !currentEmbyUsers.length) {
    return "";
  }
  const hit = currentEmbyUsers.find((item) => String(item?.id || "").trim() === targetId);
  return hit && typeof hit?.name === "string" ? hit.name.trim() : "";
}

function pickHeaderValue(headers, keys) {
  if (!headers || typeof headers !== "object" || !Array.isArray(keys)) {
    return "";
  }
  for (const key of keys) {
    const value = headers[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function parseEmbyAuthField(authHeader, fieldName) {
  const text = String(authHeader || "");
  if (!text || !fieldName) {
    return "";
  }
  const pattern = new RegExp(`${fieldName}="([^"]+)"`, "i");
  const match = text.match(pattern);
  return match?.[1] ? String(match[1]).trim() : "";
}

function findTransferLink(entries, strategy) {
  const sourceName = pickNamedAccount(
    pickLatestExtracted(entries, "秒传源账号"),
    strategy.sourceAccount
  );
  const targetName = pickNamedAccount(
    pickLatestExtracted(entries, "秒传目标账号"),
    strategy.targetAccount
  );
  if (!sourceName || !targetName) {
    return "";
  }
  return `${sourceName} =》 ${targetName}`;
}

function pickNamedAccount(primary, fallback) {
  const first = String(primary || "").trim();
  if (first) {
    return first;
  }
  const second = String(fallback || "").trim();
  if (second && !isLikelyUid(second)) {
    return second;
  }
  return "";
}

function isLikelyUid(value) {
  return /^\d{3,}$/.test(String(value || "").trim());
}

function pickLatestExtracted(entries, key) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const value = pickObj(entries[index]?.detail?.extracted, key);
    if (value) {
      return value;
    }
  }
  return "";
}

function createModulePanel(title, lines) {
  const panel = document.createElement("div");
  panel.className = "log-module-panel";
  const h = document.createElement("div");
  h.className = "log-module-title";
  h.textContent = title;
  panel.appendChild(h);
  lines.forEach((line) => {
    const row = document.createElement("div");
    row.className = "log-module-line";
    row.textContent = line;
    panel.appendChild(row);
  });
  return panel;
}

async function loadLogs() {
  const logs = await fetchJson(`/api/logs?offset=0&limit=${logsFetchLimit}&_ts=${Date.now()}`);
  currentLogs = Array.isArray(logs) ? logs : [];
  renderLogs(currentLogs);
}

addProfileButton?.addEventListener("click", () => {
  if (!profilesContainer) {
    return;
  }
  profilesContainer.appendChild(createProfileItem({
    name: "",
    cookies: "",
    cacheExpirySeconds: 1800,
    autoDelete: {
      enabled: false,
      cron: "0 4 * * *",
      directories: [],
      safeCode: ""
    }
  }, false));
  ensureActiveProfile();
  refreshCookieCardMeta();
});

profilesContainer?.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !profilesContainer) {
    return;
  }
  const card = target.closest(".cookie-profile");
  if (!(card instanceof HTMLElement)) {
    return;
  }

  const addButton = target.closest("[data-role='add-profile']");
  if (addButton instanceof HTMLButtonElement) {
    const index = Array.from(profilesContainer.querySelectorAll(".cookie-profile")).indexOf(card);
    const nextCard = createProfileItem({
      name: "",
      cookies: "",
      cacheExpirySeconds: 1800,
      autoDelete: {
        enabled: false,
        cron: "0 4 * * *",
        directories: [],
        safeCode: ""
      }
    }, false);
    card.insertAdjacentElement("afterend", nextCard);
    ensureActiveProfile();
    refreshCookieCardMeta();
    return;
  }

  const removeButton = target.closest("[data-role='remove-profile']");
  if (removeButton instanceof HTMLButtonElement) {
    const cards = profilesContainer.querySelectorAll(".cookie-profile");
    if (cards.length <= 1) {
      setHint(saveHint, "至少保留一组 Cookies 配置", true);
      return;
    }
    card.remove();
    ensureActiveProfile();
    refreshCookieCardMeta();
    return;
  }

  const testButton = target.closest("[data-role='test-profile']");
  if (testButton instanceof HTMLButtonElement) {
    void testCookieProfile(card);
    return;
  }

  const cleanupButton = target.closest("[data-role='cleanup-now']");
  if (cleanupButton instanceof HTMLButtonElement) {
    void cleanupCookieProfileNow(card);
  }
});

profilesContainer?.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  if (target.matches("[data-role='name']")) {
    refreshCookieCardMeta();
    return;
  }
  if (target.matches("[data-role='autoDeleteSafeCode']") && "value" in target) {
    target.value = normalizeAutoDeleteSafeCode(target.value);
  }
});

addEmbyServerButton?.addEventListener("click", () => {
  if (!embyServersContainer) {
    return;
  }
  const card = createEmbyServerCard({
    id: uid(),
    name: "",
    serverUrl: "",
    apiKey: "",
    p115CookieName: "",
    antiRiskCookieNames: [],
    customPickcodeRegex: "",
    p115Cookie: "",
    enabled: true,
    reverseProxyPorts: [],
    pathPrefixRules: ""
  }, embyServersContainer.querySelectorAll(".emby-server-card").length);
  embyServersContainer.appendChild(card);
  refreshEmbyCardMeta();
  ensureAtLeastOneEnabledServer();
  void refreshEmbyCookieProfileInfo(card);
});

embyServersContainer?.addEventListener("click", (event) => {
  const rawTarget = event.target;
  const target = rawTarget instanceof HTMLElement ? rawTarget : rawTarget instanceof Node ? rawTarget.parentElement : null;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const option = target.closest("[data-role='picker-option']");
  if (option instanceof HTMLButtonElement) {
    const card = option.closest(".emby-server-card");
    const picker = option.closest("[data-role='antiRiskCookieNamesPicker']");
    if (card instanceof HTMLElement && picker instanceof HTMLElement) {
      event.preventDefault();
      event.stopPropagation();
      const value = (option.dataset.value || "").trim();
      const selected = new Set(getAntiRiskPickerValues(picker));
      if (value) {
        if (selected.has(value)) {
          selected.delete(value);
        } else {
          selected.add(value);
        }
      }
      renderAntiRiskPicker(card, Array.from(selected));
      picker.classList.add("is-open");
      picker.setAttribute("aria-expanded", "true");
    }
    return;
  }

  const picker = target.closest("[data-role='antiRiskCookieNamesPicker']");
  if (picker instanceof HTMLElement) {
    event.stopPropagation();
    const nextOpen = !picker.classList.contains("is-open");
    closeAllAntiRiskPickers();
    if (nextOpen) {
      picker.classList.add("is-open");
      picker.setAttribute("aria-expanded", "true");
    }
    return;
  }

  closeAllAntiRiskPickers();

  const card = target.closest(".emby-server-card");
  if (!(card instanceof HTMLElement)) {
    return;
  }

  const addButton = target.closest("[data-role='add-server']");
  if (addButton instanceof HTMLButtonElement) {
    const index = Array.from(embyServersContainer.querySelectorAll(".emby-server-card")).indexOf(card);
    const newCard = createEmbyServerCard({
      id: uid(),
      name: "",
      serverUrl: "",
      apiKey: "",
      p115CookieName: "",
      antiRiskCookieNames: [],
      customPickcodeRegex: "",
      p115Cookie: "",
      enabled: true,
      reverseProxyPorts: [],
      pathPrefixRules: ""
    }, index + 1);
    card.insertAdjacentElement("afterend", newCard);
    refreshEmbyCardMeta();
    ensureAtLeastOneEnabledServer();
    void refreshEmbyCookieProfileInfo(newCard);
    return;
  }

  const removeButton = target.closest("[data-role='remove-server']");
  if (removeButton instanceof HTMLButtonElement) {
    const cards = embyServersContainer.querySelectorAll(".emby-server-card");
    if (cards.length <= 1) {
      setHint(embySaveHint, "至少保留一套 Emby 配置", true);
      return;
    }
    card.remove();
    refreshEmbyCardMeta();
    ensureAtLeastOneEnabledServer();
    return;
  }

  const testButton = target.closest("[data-role='test-server']");
  if (testButton instanceof HTMLButtonElement) {
    void testEmbyServer(card);
  }
});

document.addEventListener("click", (event) => {
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  const clickedInsidePicker = path.some((node) => {
    if (!(node instanceof HTMLElement)) {
      return false;
    }
    const role = node.getAttribute("data-role");
    return role === "antiRiskCookieNamesPicker" || role === "user302EmbyUserPicker";
  });
  if (clickedInsidePicker) {
    return;
  }
  closeAllAntiRiskPickers();
  closeAllUser302Pickers();
});

embyServersContainer?.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  if (target.matches("[data-role='name']")) {
    refreshEmbyCardMeta();
    return;
  }
  if (target.matches("[data-role='reverseProxyPorts']") && "value" in target) {
    target.value = target.value.replace(/\D+/g, "");
  }
});

embyServersContainer?.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  if (target.matches("[data-role='enabled']")) {
    ensureAtLeastOneEnabledServer();
    return;
  }
  if (target.matches("[data-role='p115CookieName']")) {
    const card = target.closest(".emby-server-card");
    if (card instanceof HTMLElement) {
      syncAntiRiskSelectForCard(card);
      void refreshEmbyCookieProfileInfo(card);
    }
  }
});

saveEmbyConfigButton?.addEventListener("click", async () => {
  setHint(embySaveHint, "正在保存...", false);
  setButtonBusy(saveEmbyConfigButton, true, "保存中...");
  const data = collectEmbyServers();
  const validationError = validateEmbyServers(data);
  if (validationError) {
    setHint(embySaveHint, validationError, true);
    setButtonBusy(saveEmbyConfigButton, false, "");
    return;
  }
  const activeServer = data.servers.find((item) => item.id === data.activeId) || data.servers[0];
  if (!activeServer?.serverUrl) {
    setHint(embySaveHint, "请至少填写一个可用的 Emby 地址", true);
    setButtonBusy(saveEmbyConfigButton, false, "");
    return;
  }

  try {
    const next = await fetchJson("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        emby: {
          serverUrl: activeServer.serverUrl,
          activeServerId: data.activeId,
          servers: data.servers.map((item) => ({
            id: item.id,
            name: item.name,
            serverUrl: item.serverUrl,
            apiKey: item.apiKey,
            p115CookieName: item.p115CookieName,
            antiRiskCookieNames: normalizeNameList(item.antiRiskCookieNames),
            customPickcodeRegex: item.customPickcodeRegex,
            p115Cookie: item.p115Cookie,
            enabled: item.enabled,
            reverseProxyPorts: item.reverseProxyPorts,
            pathPrefixRules: item.pathPrefixRules
          }))
        }
      })
    });

    const embyConfig = normalizeEmbyConfigFromBackend(next.emby || {});
    renderEmbyServers(embyConfig.servers, embyConfig.activeId);
    setHint(embySaveHint, "Emby 配置已保存（反代端口会由服务自动监听）", false);
    await loadStatus();
  } catch (error) {
    setHint(embySaveHint, error instanceof Error ? error.message : "保存失败", true);
  } finally {
    setButtonBusy(saveEmbyConfigButton, false, "");
  }
});

configForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  await save115Config();
});

save115ConfigButton?.addEventListener("click", async () => {
  await save115Config();
});

addUser302RuleButton?.addEventListener("click", () => {
  if (!user302RulesContainer) {
    return;
  }
  user302RulesContainer.appendChild(createUser302RuleCard({
    id: uid(),
    name: "",
    embyUserId: "",
    targetCookieName: "",
    targetPath: "/sha1cache",
    enabled: true
  }, user302RulesContainer.querySelectorAll(".user302-rule-card").length));
});

user302RulesContainer?.addEventListener("click", (event) => {
  const rawTarget = event.target;
  const target = rawTarget instanceof HTMLElement ? rawTarget : rawTarget instanceof Node ? rawTarget.parentElement : null;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const userOption = target.closest("[data-role='user302-user-option']");
  if (userOption instanceof HTMLButtonElement) {
    event.preventDefault();
    event.stopPropagation();
    const card = userOption.closest(".user302-rule-card");
    const picker = userOption.closest("[data-role='user302EmbyUserPicker']");
    if (card instanceof HTMLElement && picker instanceof HTMLElement) {
      const pickedUserId = String(userOption.dataset.userId || "").trim();
      const currentUserId = getUser302PickerValue(picker);
      const nextUserId = pickedUserId && pickedUserId !== currentUserId ? pickedUserId : "";
      renderUser302UserPicker(card, nextUserId);
      picker.classList.add("is-open");
      picker.setAttribute("aria-expanded", "true");
    }
    return;
  }

  const picker = target.closest("[data-role='user302EmbyUserPicker']");
  if (picker instanceof HTMLElement) {
    event.preventDefault();
    event.stopPropagation();
    const nextOpen = !picker.classList.contains("is-open");
    closeAllUser302Pickers();
    if (nextOpen) {
      picker.classList.add("is-open");
      picker.setAttribute("aria-expanded", "true");
    }
    return;
  }

  closeAllUser302Pickers();

  const button = target.closest("[data-role='remove-user302-rule']");
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }
  const card = button.closest(".user302-rule-card");
  if (card) {
    card.remove();
  }
  const cards = Array.from(user302RulesContainer.querySelectorAll(".user302-rule-card"));
  cards.forEach((item, index) => {
    const title = item.querySelector(".user302-rule-head strong");
    if (title) {
      title.textContent = `规则 #${index + 1}`;
    }
  });
});

saveUser302ConfigButton?.addEventListener("click", async () => {
  await saveUser302Config();
});

user302Form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveUser302Config();
});

logsFilterInput?.addEventListener("input", () => {
  renderLogs(currentLogs);
});

logsClearButton?.addEventListener("click", async () => {
  setButtonBusy(logsClearButton, true, "清空中...");
  try {
    await fetchJson("/api/logs/clear", { method: "POST" });
    logsFetchLimit = defaultLogsFetchLimit;
    currentLogs = [];
    renderLogs(currentLogs);
    await loadStatus();
  } catch (_error) {
    // ignore
  } finally {
    setButtonBusy(logsClearButton, false, "");
  }
});

logsViewAllButton?.addEventListener("click", async () => {
  setButtonBusy(logsViewAllButton, true, "加载中...");
  try {
    const status = await fetchJson("/api/status");
    const logSize = Number.isInteger(status?.logSize) ? status.logSize : defaultLogsFetchLimit;
    logsFetchLimit = Math.max(defaultLogsFetchLimit, logSize);
    await loadLogs();
  } finally {
    setButtonBusy(logsViewAllButton, false, "");
  }
});

cachePageSizeSelect?.addEventListener("change", () => {
  const next = Number.parseInt(cachePageSizeSelect.value, 10);
  cachePageSize = Number.isNaN(next) ? 20 : Math.max(1, next);
  cachePage = 1;
  void loadCacheList();
});

cachePrevButton?.addEventListener("click", () => {
  cachePage = Math.max(1, cachePage - 1);
  void loadCacheList();
});

cacheNextButton?.addEventListener("click", () => {
  cachePage += 1;
  void loadCacheList();
});

cacheClearButton?.addEventListener("click", async () => {
  setButtonBusy(cacheClearButton, true, "清空中...");
  try {
    await fetchJson("/api/cache/clear", { method: "POST" });
    cachePage = 1;
    await Promise.all([loadCacheList(), loadStatus()]);
  } finally {
    setButtonBusy(cacheClearButton, false, "");
  }
});

refreshUsersButton?.addEventListener("click", async () => {
  await loadEmbyUsers();
});

cacheTableBody?.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const pathButton = target.closest("button[data-role='show-path']");
  if (pathButton instanceof HTMLButtonElement) {
    showPathModal(pathButton.dataset.path || "");
    return;
  }
  const urlButton = target.closest("button[data-role='show-url']");
  if (urlButton instanceof HTMLButtonElement) {
    showUrlModal(urlButton.dataset.url || "");
    return;
  }
  const button = target.closest("button[data-role='delete-cache']");
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }
  const key = button.dataset.key || "";
  if (!key) {
    return;
  }
  try {
    setButtonBusy(button, true, "删除中...");
    await fetchJson("/api/cache/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key })
    });
    const row = button.closest("tr");
    row?.remove();
    cacheTotal = Math.max(0, cacheTotal - 1);
    updateCachePager();
    await loadStatus();
  } catch (_error) {
    setButtonBusy(button, true, "删除失败");
    setTimeout(() => setButtonBusy(button, false, ""), 900);
    return;
  }
  setButtonBusy(button, false, "");
});

document.addEventListener("visibilitychange", () => {
  syncLogPolling();
  syncCachePolling();
});

setActivePanel("home");
syncLogPolling();
syncCachePolling();

if (cachePageSizeSelect instanceof HTMLSelectElement) {
  const parsed = Number.parseInt(cachePageSizeSelect.value, 10);
  cachePageSize = Number.isNaN(parsed) ? 20 : Math.max(1, parsed);
}
updateCachePager();

Promise.all([loadConfig(), loadStatus(), loadLogs()]).catch((error) => {
  setHint(user302SaveHint, error instanceof Error ? error.message : "加载失败", true);
});
