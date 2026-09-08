"use strict";

const API_BASE = location.protocol === "file:" ? "http://127.0.0.1:8000" : "";
const PUBLIC_DEMO =
  location.protocol !== "file:" &&
  !["localhost", "127.0.0.1"].includes(location.hostname);
const SESSION_KEY = "vocab-demo-session";

function demoSessionId() {
  if (!PUBLIC_DEMO) return "";
  let session = localStorage.getItem(SESSION_KEY);
  if (!session) {
    session =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(SESSION_KEY, session);
  }
  return session;
}

const state = {
  books: [],
  activeBookId: null,
  selectedUnits: new Set(),
  exportUnits: new Set(),
  order: "shuffle",
  exportMode: "all",
  exportContent: "blank",
  sessionCards: [],
  sessionIndex: 0,
  sessionRatings: { know: 0, fuzzy: 0, unknown: 0 },
  sessionRated: {},
  lastSession: [],
  previewCards: [],
  bookDirty: false,
  recordScope: null,
  recordCards: [],
  wordHistory: null,
  learnReturnView: "books",
  importAppendBookId: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function currentBook() {
  return state.books.find((b) => b.id === state.activeBookId) || null;
}

function activeViewName() {
  return document.querySelector(".view.active")?.dataset.viewPanel || "books";
}

async function api(path, options = {}) {
  const sessionId = demoSessionId();
  const headers = { ...(options.headers || {}) };
  if (sessionId) headers["X-Session-ID"] = sessionId;
  const resp = await fetch(API_BASE + path, { ...options, headers });
  const type = resp.headers.get("content-type") || "";
  let payload = null;
  if (type.includes("application/json")) {
    payload = await resp.json();
  } else {
    payload = await resp.blob();
  }
  if (!resp.ok) {
    throw new Error(payload?.error || `请求失败（${resp.status}）`);
  }
  return payload;
}

function jsonOptions(method, body) {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function showToast(text, type = "success") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = text;
  $("#toastRegion").appendChild(el);
  window.setTimeout(() => el.remove(), 3600);
}

async function refreshBooks(preferredId = null) {
  const data = await api("/api/books");
  state.books = data.books || [];
  state.bookDirty = false;
  if (!state.activeBookId || !state.books.some((b) => b.id === state.activeBookId)) {
    state.activeBookId = preferredId || state.books[0]?.id || null;
  }
  if (!state.books.some((b) => b.id === state.activeBookId)) {
    state.selectedUnits = new Set();
    state.exportUnits = new Set();
  }
  renderBooks();
  renderExport();
}

function renderBooks() {
  const book = currentBook();
  const hasBooks = state.books.length > 0;
  $("#emptyState").classList.toggle("hidden", hasBooks);
  $("#bookBody").classList.toggle("hidden", !hasBooks);
  $("#bookSelect").classList.toggle("hidden", !hasBooks);
  $("#renameBookBtn").classList.toggle("hidden", !hasBooks);
  $("#addBookBtn").classList.toggle("hidden", !hasBooks);
  $("#deleteBookBtn").classList.toggle("hidden", !hasBooks);
  $("#bookShortName").textContent = book ? `${book.name} · ${book.word_count} 词` : "本地词库";
  $("#bookTitle").textContent = book?.name || "我的词书";
  $("#bookSubtitle").textContent = book ? `${book.unit_count} 个单元` : "选择单元后开始背诵";

  const select = $("#bookSelect");
  select.innerHTML = "";
  state.books.forEach((b) => {
    const opt = document.createElement("option");
    opt.value = String(b.id);
    opt.textContent = `${b.name}（${b.word_count} 词）`;
    opt.selected = b.id === state.activeBookId;
    select.appendChild(opt);
  });

  if (!book) {
    return;
  }
  const selected = state.selectedUnits;
  selected.forEach((id) => {
    if (!book.units.some((u) => u.id === id)) selected.delete(id);
  });

  const stats = book.units.reduce(
    (acc, u) => {
      acc.words += u.word_count;
      acc.know += u.stats.know;
      acc.fuzzy += u.stats.fuzzy;
      acc.unknown += u.stats.unknown;
      return acc;
    },
    { words: 0, know: 0, fuzzy: 0, unknown: 0 },
  );
  const strip = $("#statStrip");
  strip.innerHTML = `
    <div class="stat-item"><strong>${stats.words}</strong><span>总单词数</span></div>
    <div class="stat-item"><strong>${book.units.length}</strong><span>单元数</span></div>
    <button class="stat-item stat-btn" data-record-status="know" type="button"><strong>${stats.know}</strong><span>已认识</span></button>
    <button class="stat-item stat-btn" data-record-status="fuzzy" type="button"><strong>${stats.fuzzy}</strong><span>模糊</span></button>
    <button class="stat-item stat-btn" data-record-status="unknown" type="button"><strong>${stats.unknown}</strong><span>不认识</span></button>
  `;

  const grid = $("#unitGrid");
  grid.innerHTML = "";
  book.units.forEach((unit) => {
    const card = document.createElement("div");
    card.className = "unit-card" + (selected.has(unit.id) ? " selected" : "");
    card.innerHTML = `
      <label class="unit-headline">
        <input type="checkbox" data-unit-id="${unit.id}" ${selected.has(unit.id) ? "checked" : ""}>
        <span class="unit-main">
          <span class="unit-name">${esc(unit.name)}</span>
          <span class="unit-word-count">${unit.word_count} 个单词</span>
        </span>
      </label>
      <span class="unit-mini">
        <button class="mini-state mini-btn know" data-open-record="${unit.id}" data-record-status="know" type="button">认识 ${unit.stats.know}</button>
        <button class="mini-state mini-btn fuzzy" data-open-record="${unit.id}" data-record-status="fuzzy" type="button">模糊 ${unit.stats.fuzzy}</button>
        <button class="mini-state mini-btn unknown" data-open-record="${unit.id}" data-record-status="unknown" type="button">不认识 ${unit.stats.unknown}</button>
      </span>
    `;
    grid.appendChild(card);
  });
  updateSelectionUi();
}

function selectedWords() {
  const book = currentBook();
  if (!book) return 0;
  return book.units
    .filter((u) => state.selectedUnits.has(u.id))
    .reduce((sum, u) => sum + u.word_count, 0);
}

function updateSelectionUi() {
  const count = state.selectedUnits.size;
  const words = selectedWords();
  $("#selectionText").textContent = `已选 ${count} 个单元`;
  $("#selectionWords").textContent = `${words} 个单词`;
  $("#startLearnBtn").disabled = count === 0 || words === 0;
}

function recordStatusLabel(status) {
  return { know: "认识", fuzzy: "模糊", unknown: "不认识" }[status] || "";
}

async function openWordRecords(scope) {
  const book = currentBook();
  if (!book) return;
  const status = scope.status;
  state.recordScope = {
    bookId: book.id,
    unitIds: scope.unitIds ? Array.from(scope.unitIds) : null,
    status,
  };
  state.recordCards = [];
  $("#recordSearch").value = "";
  updateRecordTabs();
  $("#recordDialog").showModal();
  await loadRecordCards();
}

function updateRecordTabs() {
  const status = state.recordScope?.status || "fuzzy";
  $$("#recordFilter [data-record-tab]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.recordTab === status);
  });
}

async function loadRecordCards() {
  const scope = state.recordScope;
  const book = currentBook();
  if (!scope || !book) return;
  const units = scope.unitIds && scope.unitIds.length ? scope.unitIds.join(",") : "";
  const query = `/api/cards?book=${book.id}&units=${units}&status=${scope.status}`;
  try {
    const data = await api(query);
    state.recordCards = data.cards || [];
    state.recordCards.sort((a, b) => {
      const status = scope.status;
      return (b[`${status}_count`] || 0) - (a[`${status}_count`] || 0);
    });
  } catch (err) {
    state.recordCards = [];
    showToast(err.message, "error");
  }
  renderRecordList();
}

function renderRecordList() {
  const scope = state.recordScope;
  const book = currentBook();
  if (!scope || !book) return;
  const unitMap = new Map(book.units.map((u) => [u.id, u]));
  const unitLabel = scope.unitIds && scope.unitIds.length
    ? scope.unitIds.map((id) => unitMap.get(id)?.name).filter(Boolean).join("、")
    : "全部单元";
  $("#recordTitle").textContent = `${unitLabel} · ${recordStatusLabel(scope.status)}单词`;

  const keyword = ($("#recordSearch").value || "").trim().toLowerCase();
  const cards = state.recordCards.filter((card) => {
    if (!keyword) return true;
    return [card.word, card.meaning, card.meaning_en]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(keyword));
  });
  $("#recordPracticeBtn").disabled = state.recordCards.length === 0;
  $("#recordPracticeBtn").textContent = `开始背这一组（${state.recordCards.length}）`;

  const list = $("#recordList");
  list.innerHTML = "";
  if (!state.recordCards.length) {
    const empty = document.createElement("div");
    empty.className = "record-empty";
    empty.textContent = `这个分组里还没有单词记录`;
    list.appendChild(empty);
    return;
  }
  if (!cards.length) {
    const empty = document.createElement("div");
    empty.className = "record-empty";
    empty.textContent = "没有找到匹配的单词";
    list.appendChild(empty);
    return;
  }

  cards.forEach((card) => {
    const row = document.createElement("div");
    row.className = "record-row";
    row.dataset.wordId = String(card.id);
    row.innerHTML = `
      <button class="record-word" type="button" data-show-history="${card.id}" aria-label="查看点击记录">
        <strong>${esc(card.word)}</strong>
        <span class="record-meta">
          <span>${esc(card.unit_name)}</span>
          ${card.phonetic ? `<span>${esc(card.phonetic)}</span>` : ""}
          ${card.pos ? `<span>${esc(card.pos)}</span>` : ""}
          <span>${recordStatusLabel(card.status)}</span>
          <span>认识 ${card.know_count || 0} · 模糊 ${card.fuzzy_count || 0} · 不认识 ${card.unknown_count || 0}</span>
        </span>
        <span class="record-meaning">${esc(card.meaning || card.meaning_en || "暂无释义")}</span>
      </button>
      <div class="record-actions">
        <button class="record-state-btn know ${card.status === "know" ? "active" : ""}" data-mark-status="know" data-word-id="${card.id}" type="button">认识</button>
        <button class="record-state-btn fuzzy ${card.status === "fuzzy" ? "active" : ""}" data-mark-status="fuzzy" data-word-id="${card.id}" type="button">模糊</button>
        <button class="record-state-btn unknown ${card.status === "unknown" ? "active" : ""}" data-mark-status="unknown" data-word-id="${card.id}" type="button">不认识</button>
      </div>
    `;
    list.appendChild(row);
  });
}

async function openWordHistory(wordId) {
  $("#historyDialog").showModal();
  $("#historyList").innerHTML = `<div class="record-empty">正在读取记录...</div>`;
  $("#historySummary").innerHTML = "";
  $("#historyTitle").textContent = "点击记录";
  try {
    const data = await api(`/api/word-history?word_id=${wordId}`);
    state.wordHistory = data;
    renderWordHistory();
  } catch (err) {
    state.wordHistory = null;
    $("#historyTitle").textContent = "点击记录";
    $("#historyList").innerHTML = `<div class="record-empty">${esc(err.message)}</div>`;
  }
}

function renderWordHistory() {
  const data = state.wordHistory;
  if (!data) return;
  $("#historyTitle").textContent = `${data.word} · 点击记录`;
  $("#historySummary").innerHTML = `
    <span class="history-state know">认识 ${data.counts.know} 次</span>
    <span class="history-state fuzzy">模糊 ${data.counts.fuzzy} 次</span>
    <span class="history-state unknown">不认识 ${data.counts.unknown} 次</span>
    <span class="subtle">${esc(data.unit_name)}</span>
  `;
  const list = $("#historyList");
  list.innerHTML = "";
  if (!data.events.length) {
    list.innerHTML = `<div class="record-empty">还没有点击记录</div>`;
    return;
  }
  data.events.forEach((event) => {
    const row = document.createElement("div");
    row.className = "history-row";
    const status = document.createElement("span");
    status.className = `history-state ${event.status}`;
    status.textContent = recordStatusLabel(event.status);
    const time = document.createElement("span");
    time.className = "history-time";
    time.textContent = event.created_at;
    row.append(status, time);
    list.appendChild(row);
  });
}

function renderExport() {
  const book = currentBook();
  const hasUnits = book && book.units.length > 0;
  $("#exportSubtitle").textContent = book ? `词书：${book.name}` : "先导入一本词书";
  const list = $("#exportUnitList");
  list.innerHTML = "";
  if (!hasUnits) {
    list.innerHTML = `<div class="subtle">没有可选的单元</div>`;
    $("#exportPdfBtn").disabled = true;
    return;
  }
  if (state.exportUnits.size === 0) {
    state.exportUnits = new Set(book.units.map((u) => u.id));
  }
  book.units.forEach((unit) => {
    const row = document.createElement("label");
    row.className = "check-row";
    row.innerHTML = `
      <input type="checkbox" data-export-unit="${unit.id}" ${state.exportUnits.has(unit.id) ? "checked" : ""}>
      <span>
        <strong>${esc(unit.name)}</strong>
        <span>${unit.word_count} 个单词</span>
      </span>
    `;
    list.appendChild(row);
  });
  updateExportSummary();
}

function updateExportSummary() {
  const book = currentBook();
  if (!book) return;
  const units = book.units.filter((u) => state.exportUnits.has(u.id));
  const words = units.reduce((s, u) => s + u.word_count, 0);
  $("#exportUnitText").textContent = `${units.length} 个单元`;
  $("#exportCountText").textContent = `${words} 个单词`;
  $("#exportPdfBtn").disabled = units.length === 0 || words === 0;
  $("#exportUnitList").querySelectorAll("input[data-export-unit]").forEach((input) => {
    const id = Number(input.dataset.exportUnit);
    input.checked = state.exportUnits.has(id);
  });
  refreshPreview();
}

async function refreshPreview() {
  const book = currentBook();
  if (!book || state.exportUnits.size === 0) {
    $("#exportPreview").innerHTML = `<div class="subtle">没有可预览的内容</div>`;
    return;
  }
  const units = Array.from(state.exportUnits).join(",");
  const data = await api(`/api/cards?book=${book.id}&units=${units}&shuffle=1`).catch(() => null);
  state.previewCards = data?.cards || [];
  renderPreview(data?.count || 0);
}

function renderPreview(total) {
  const mode = state.exportMode;
  const count = Math.max(1, Number($("#exportCount").value) || 20);
  const box = $("#exportPreview");
  box.innerHTML = "";
  if (!total) {
    box.innerHTML = `<div class="subtle">没有可预览的内容</div>`;
    return;
  }
  let preview = [];
  let summary = `${total} 个`;
  if (mode === "total") {
    preview = state.previewCards.slice(0, Math.min(count, 24));
    summary = count < total ? `${count} / ${total} 个` : `${total} 个`;
  } else if (mode === "per_unit") {
    preview = [];
    const groups = {};
    state.previewCards.forEach((c) => (groups[c.unit_name] ||= []).push(c));
    Object.values(groups).forEach((group) => {
      preview.push(...group.slice(0, Math.min(count, 4)));
    });
    preview = preview.slice(0, 24);
    summary = `每单元最多 ${count} 个`;
  } else {
    preview = state.previewCards.slice(0, 24);
  }
  $("#exportCountText").textContent = summary;
  if (!preview.length) {
    box.innerHTML = `<div class="subtle">当前单元还没有词条</div>`;
    return;
  }
  preview.forEach((card) => {
    const row = document.createElement("div");
    row.className = "preview-row";
    const unit = document.createElement("span");
    unit.textContent = card.unit_name;
    const word = document.createElement("strong");
    word.textContent = card.word;
    const meaning = document.createElement("span");
    meaning.textContent = state.exportContent === "blank" ? "" : card.meaning || card.meaning_en || "";
    row.append(unit, word, meaning);
    box.appendChild(row);
  });
  if (total > preview.length || (mode === "total" && count > preview.length)) {
    const more = document.createElement("div");
    more.className = "subtle";
    more.textContent = "生成 PDF 时会包含全部抽查内容";
    box.appendChild(more);
  }
}

async function startLearn(order) {
  state.learnReturnView = activeViewName() === "learn" ? state.learnReturnView : activeViewName();
  const book = currentBook();
  if (!book || state.selectedUnits.size === 0) return;
  const units = Array.from(state.selectedUnits).join(",");
  $("#learnSetup").classList.add("hidden");
  $("#learnFinished").classList.add("hidden");
  $("#learnRunning").classList.remove("hidden");
  const shuffle = order === "shuffle";
  try {
    const data = await api(`/api/cards?book=${book.id}&units=${units}&shuffle=${shuffle ? 1 : 0}`);
    if (!data.cards.length) {
      showToast("所选单元里没有单词", "error");
      renderLearnSetup();
      return;
    }
    beginSession(data.cards);
    switchView("learn");
  } catch (err) {
    showToast(err.message, "error");
    renderLearnSetup();
  }
}

function beginSession(cards) {
  state.sessionCards = cards;
  state.sessionIndex = 0;
  state.sessionRatings = { know: 0, fuzzy: 0, unknown: 0 };
  state.sessionRated = {};
  state.lastSession = cards;
  $("#learnFinished").classList.add("hidden");
  $("#learnRunning").classList.remove("hidden");
  $("#exitLearnBtn").textContent = "退出";
  renderCard();
}

function renderCard() {
  const card = state.sessionCards[state.sessionIndex];
  if (!card) {
    finishSession();
    return;
  }
  $("#cardWord").textContent = card.word;
  $("#cardPhonetic").textContent = card.phonetic || "";
  $("#cardPos").textContent = card.pos ? `（${card.pos}）` : "";
  $("#cardMeaning").textContent = card.meaning || "暂无中文释义";
  $("#cardEnglish").textContent = card.meaning_en ? `English：${card.meaning_en}` : "";
  $("#cardMemory").textContent = card.memory ? `助记：${card.memory}` : "";
  $("#cardArea").classList.remove("revealed");
  $("#cardArea").scrollTop = 0;
  $("#learnUnitName").textContent = card.unit_name;
  $("#learnCounter").textContent = `${state.sessionIndex + 1} / ${state.sessionCards.length}`;
  $("#learnProgress").style.width = `${((state.sessionIndex + 1) / state.sessionCards.length) * 100}%`;
  $("#sessionStatus").classList.add("hidden");
  $("#sessionStatus").textContent = "";
  $("#prevCardBtn").disabled = state.sessionIndex === 0;
}

async function rateCurrent(rating) {
  const card = state.sessionCards[state.sessionIndex];
  if (!card) return;
  if (!$("#cardArea").classList.contains("revealed")) {
    revealCard();
    return;
  }
  const previousRating = state.sessionRated[card.id];
  const alreadyCounted = previousRating && previousRating !== "skip";
  if (alreadyCounted && previousRating !== rating) {
    state.sessionRatings[previousRating] = Math.max(0, state.sessionRatings[previousRating] - 1);
    state.sessionRatings[rating] += 1;
  } else if (!alreadyCounted) {
    state.sessionRatings[rating] += 1;
  }
  state.sessionRated[card.id] = rating;
  $("#sessionStatus").textContent = `${card.word} 已标记`;
  $("#sessionStatus").classList.remove("hidden");
  state.bookDirty = true;
  api("/api/mark", jsonOptions("POST", { word_id: card.id, status: rating })).catch(
    (err) => showToast(err.message, "error"),
  );
  advanceCard();
}

function previousCard() {
  if (state.sessionIndex <= 0) return;
  state.sessionIndex -= 1;
  renderCard();
}

function revealCard() {
  $("#cardArea").classList.add("revealed");
}

function skipCard() {
  const card = state.sessionCards[state.sessionIndex];
  if (card) {
    state.sessionRated[card.id] = state.sessionRated[card.id] || "skip";
  }
  advanceCard();
}

function advanceCard() {
  state.sessionIndex += 1;
  if (state.sessionIndex >= state.sessionCards.length) {
    finishSession();
  } else {
    renderCard();
  }
}

function finishSession() {
  $("#learnRunning").classList.add("hidden");
  $("#learnFinished").classList.remove("hidden");
  const ratings = state.sessionRatings;
  const isWeak = (c) => ["fuzzy", "unknown"].includes(state.sessionRated[c.id] || c.status || "");
  const weak = state.sessionCards.filter(isWeak).length;
  const panel = $("#learnFinished");
  panel.innerHTML = "";
  const title = document.createElement("h2");
  title.textContent = "本轮完成";
  const summary = document.createElement("div");
  summary.className = "finish-summary";
  summary.innerHTML = `
    <div class="stat-item"><strong>${state.sessionCards.length}</strong><span>本轮</span></div>
    <div class="stat-item"><strong>${ratings.know}</strong><span>认识</span></div>
    <div class="stat-item"><strong>${ratings.fuzzy}</strong><span>模糊</span></div>
    <div class="stat-item"><strong>${ratings.unknown}</strong><span>不认识</span></div>
  `;
  const actions = document.createElement("div");
  actions.className = "finish-actions";
  const weakBtn = document.createElement("button");
  weakBtn.className = "primary-btn";
  weakBtn.textContent = `复习模糊与不认识（${weak}）`;
  weakBtn.disabled = weak === 0;
  weakBtn.addEventListener("click", () => {
    const weakCards = state.sessionCards.filter(isWeak);
    beginSession(weakCards);
  });
  const backBtn = document.createElement("button");
  backBtn.className = "ghost-btn";
  backBtn.textContent = "回到词书";
  backBtn.addEventListener("click", () => switchView("books"));
  actions.append(weakBtn, backBtn);
  panel.append(title, summary, actions);
}

function renderLearnSetup() {
  const book = currentBook();
  const box = $("#learnSetup");
  if (!book) {
    box.innerHTML = `
      <div>
        <strong>还没有词书</strong>
        <button class="primary-btn" data-open-import type="button">导入词书</button>
      </div>
    `;
    box.classList.remove("hidden");
    return;
  }
  if (state.selectedUnits.size === 0) {
    box.innerHTML = `
      <div>
        <strong>还没有选择单元</strong>
        <button class="primary-btn" data-go-books type="button">去选择单元</button>
      </div>
    `;
    box.classList.remove("hidden");
    return;
  }
  box.classList.add("hidden");
}

function selectedSummaryText() {
  const book = currentBook();
  if (!book) return "";
  const names = book.units
    .filter((u) => state.selectedUnits.has(u.id))
    .map((u) => u.name);
  return `词书：${book.name}\n单元：${names.slice(0, 8).join("、")}${names.length > 8 ? ` 等 ${names.length} 个` : ""}`;
}

function switchView(name) {
  $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  $$(".view").forEach((v) => v.classList.toggle("active", v.dataset.viewPanel === name));
  if (name === "books") {
    if (state.bookDirty) {
      refreshBooks().finally(() => renderBooks()).catch(() => {});
    } else {
      renderBooks();
    }
  }
  if (name === "export") renderExport();
  if (name === "learn") {
    if (state.sessionCards.length > 0 && $("#learnFinished").classList.contains("hidden")) {
      $("#learnRunning").classList.remove("hidden");
      $("#learnSetup").classList.add("hidden");
      renderCard();
    } else if (!state.sessionCards.length) {
      $("#learnRunning").classList.add("hidden");
      renderLearnSetup();
    }
  }
  window.scrollTo({ top: 0 });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

async function runImport({ file, text } = {}) {
  const status = $("#importStatus");
  const nameInput = $("#importName");
  const replaceSame = $("#replaceSame").checked;
  status.textContent = "";
  const name = nameInput.value.trim();
  let filename = file?.name || "";
  if (file) {
    if (!name) nameInput.value = filename.replace(/\.[^.]+$/, "");
    if (!nameInput.value.trim()) nameInput.value = "我的词书";
  } else {
    filename = "粘贴文本";
    if (!name) nameInput.value = "粘贴词书";
  }
  const payload = {
    name: nameInput.value.trim(),
    replace_same: replaceSame,
    filename,
  };
  if (state.importAppendBookId !== null) {
    payload.append_book_id = state.importAppendBookId;
  }
  if (file) {
    $("#doImportBtn").disabled = true;
    status.textContent = "正在读取文件...";
    try {
      payload.file_base64 = await fileToBase64(file);
    } catch (err) {
      status.textContent = err.message;
      $("#doImportBtn").disabled = false;
      return;
    }
  } else {
    payload.text = $("#importText").value;
    if (!payload.text.trim()) {
      status.textContent = "请先粘贴单词文本";
      return;
    }
  }
  $("#doImportBtn").disabled = true;
  status.textContent = "正在解析并写入词库...";
  try {
    const result = await api("/api/import", jsonOptions("POST", payload));
    const dup = result.duplicate_count ? `，跳过重复 ${result.duplicate_count}` : "";
    const actionText = state.importAppendBookId !== null ? "已添加" : "已导入";
    showToast(`${actionText} ${result.word_count} 个单词 / ${result.unit_count} 个单元${dup}`);
    const dialog = $("#importDialog");
    dialog.close();
    resetImportDialog();
    state.importAppendBookId = null;
    state.activeBookId = result.book_id;
    state.selectedUnits = new Set();
    state.exportUnits = new Set();
    state.sessionCards = [];
    await refreshBooks(result.book_id);
    const book = currentBook();
    if (book) {
      state.selectedUnits = new Set(book.units.map((u) => u.id));
      state.exportUnits = new Set(book.units.map((u) => u.id));
      renderBooks();
      renderExport();
    }
  } catch (err) {
    status.textContent = err.message;
  } finally {
    $("#doImportBtn").disabled = false;
  }
}

function resetImportDialog() {
  $("#fileInput").value = "";
  $("#importText").value = "";
  $("#importName").value = "";
  $("#importStatus").textContent = "";
  $("#fileMeta").textContent = "";
  $("#importDialogTitle").textContent = "导入词书";
  $("#importNameLabel").textContent = "词书名";
  $("#replaceSameLabel").textContent = "同名词书直接覆盖旧版本";
  $("#importName").disabled = false;
  $("#replaceSame").disabled = false;
  $("#doImportBtn").textContent = "开始导入";
}

function openImportDialog(mode = "file", appendBookId = null) {
  resetImportDialog();
  state.importAppendBookId = appendBookId;
  $("#importDialog").showModal();
  if (appendBookId !== null) {
    const book = state.books.find((item) => item.id === appendBookId);
    $("#importDialogTitle").textContent = `向「${book?.name || "当前词书"}」添加单词`;
    $("#importNameLabel").textContent = "当前词书";
    $("#importName").value = book?.name || "";
    $("#importName").disabled = true;
    $("#replaceSame").checked = false;
    $("#replaceSame").disabled = true;
    $("#replaceSameLabel").textContent = "重复单词自动跳过，已有学习记录不会改变";
    $("#doImportBtn").textContent = "添加到本书";
  }
  setImportMode(mode);
  setTimeout(() => {
    if (mode === "file") $("#fileInput").click();
    else $("#importText").focus();
  }, 80);
}

function setImportMode(mode) {
  $$(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.importMode === mode));
  $$(".import-mode").forEach((m) => m.classList.toggle("active", m.id === `import${mode === "file" ? "File" : "Text"}Mode`));
}

function updateOrderButtons() {
  $$("#orderSwitch .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.order === state.order));
}

function updateExportModeButtons() {
  $$("#exportModeSwitch .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === state.exportMode));
}

function updateExportContentUi() {
  $$("#exportContentSwitch .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.pdfStyle === state.exportContent));
  $("#exportContentHint").textContent =
    state.exportContent === "blank"
      ? "每页 50 个，编号和英文在左，右侧留空手写中文"
      : "带中文释义，也保留英文释义";
}

function bindEvents() {
  $$(".nav-btn").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));
  document.addEventListener("click", (e) => {
    const importTarget = e.target.closest("[data-open-import]");
    if (importTarget) {
      openImportDialog("file");
    }
    const goBooks = e.target.closest("[data-go-books]");
    if (goBooks) switchView("books");
  });
  $("#bookSelect").addEventListener("change", async (e) => {
    state.activeBookId = Number(e.target.value);
    state.selectedUnits = new Set();
    state.exportUnits = new Set();
    state.sessionCards = [];
    await refreshBooks(state.activeBookId);
  });
  const openRenameBook = () => {
    const book = currentBook();
    if (!book) return;
    $("#renameInput").value = book.name;
    $("#renameStatus").textContent = "";
    $("#renameDialog").showModal();
    $("#renameInput").focus();
  };
  $("#saveRenameBtn").addEventListener("click", async () => {
    const book = currentBook();
    const input = $("#renameInput");
    const name = input.value.trim();
    if (!book || !name) {
      $("#renameStatus").textContent = "请输入词书名";
      return;
    }
    if (name === book.name) {
      $("#renameDialog").close();
      return;
    }
    try {
      await api("/api/rename-book", jsonOptions("POST", {
        book_id: book.id,
        name,
      }));
      $("#renameDialog").close();
      await refreshBooks(book.id);
      showToast("词书名称已更新");
    } catch (err) {
      $("#renameStatus").textContent = err.message;
    }
  });
  $("#renameBookBtn").addEventListener("click", openRenameBook);
  $("#addBookBtn").addEventListener("click", () => {
    const book = currentBook();
    if (book) openImportDialog("file", book.id);
  });
  $("#deleteBookBtn").addEventListener("click", () => {
    const book = currentBook();
    if (!book) return;
    $("#deleteBookName").textContent = book.name;
    $("#deleteBookStatus").textContent = "";
    $("#deleteBookDialog").showModal();
  });
  $("#confirmDeleteBookBtn").addEventListener("click", async () => {
    const book = currentBook();
    if (!book) return;
    const button = $("#confirmDeleteBookBtn");
    button.disabled = true;
    $("#deleteBookStatus").textContent = "正在删除...";
    try {
      await api("/api/delete-book", jsonOptions("POST", { book_id: book.id }));
      $("#deleteBookDialog").close();
      state.activeBookId = null;
      state.selectedUnits = new Set();
      state.exportUnits = new Set();
      state.sessionCards = [];
      await refreshBooks();
      showToast("词书已删除");
    } catch (err) {
      $("#deleteBookStatus").textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });
  $("#unitGrid").addEventListener("change", (e) => {
    const input = e.target.closest("input[data-unit-id]");
    if (!input) return;
    const id = Number(input.dataset.unitId);
    if (input.checked) state.selectedUnits.add(id);
    else state.selectedUnits.delete(id);
    renderBooks();
  });
  $("#unitGrid").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-open-record]");
    if (!btn) return;
    openWordRecords({
      unitIds: [Number(btn.dataset.openRecord)],
      status: btn.dataset.recordStatus,
    });
  });
  $("#statStrip").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-record-status]");
    if (!btn) return;
    openWordRecords({
      unitIds: null,
      status: btn.dataset.recordStatus,
    });
  });
  $("#recordFilter").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-record-tab]");
    if (!btn || !state.recordScope) return;
    state.recordScope.status = btn.dataset.recordTab;
    updateRecordTabs();
    loadRecordCards();
  });
  $("#recordSearch").addEventListener("input", renderRecordList);
  $("#recordSearch").addEventListener("keydown", (e) => {
    if (e.key === "Enter") e.preventDefault();
  });
  $("#recordList").addEventListener("click", async (e) => {
    const historyBtn = e.target.closest("[data-show-history]");
    if (historyBtn) {
      openWordHistory(Number(historyBtn.dataset.showHistory));
      return;
    }
    const btn = e.target.closest("[data-mark-status]");
    if (!btn) return;
    const wordId = Number(btn.dataset.wordId);
    const newStatus = btn.dataset.markStatus;
    if (!state.recordScope || (btn.classList.contains("active") && state.recordScope.status === newStatus)) {
      return;
    }
    btn.disabled = true;
    try {
      await api("/api/mark", jsonOptions("POST", { word_id: wordId, status: newStatus }));
      state.bookDirty = true;
      if (state.recordScope.status !== newStatus) {
        await loadRecordCards();
      } else {
        const card = state.recordCards.find((c) => c.id === wordId);
        if (card) card.status = newStatus;
        renderRecordList();
      }
    } catch (err) {
      showToast(err.message, "error");
      btn.disabled = false;
    }
  });
  $("#recordPracticeBtn").addEventListener("click", () => {
    const cards = state.recordCards.slice();
    if (!cards.length) return;
    $("#recordDialog").close();
    beginSession(cards);
    switchView("learn");
  });
  $("#recordDialog").addEventListener("close", () => {
    if (state.bookDirty) {
      refreshBooks().catch(() => {});
    }
  });
  $("#selectAllBtn").addEventListener("click", () => {
    const book = currentBook();
    state.selectedUnits = new Set((book?.units || []).map((u) => u.id));
    renderBooks();
  });
  $("#clearSelectBtn").addEventListener("click", () => {
    state.selectedUnits = new Set();
    renderBooks();
  });
  $("#orderSwitch").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-order]");
    if (!btn) return;
    state.order = btn.dataset.order;
    updateOrderButtons();
  });
  $("#startLearnBtn").addEventListener("click", () => startLearn(state.order));
  $("#exitLearnBtn").addEventListener("click", () => {
    state.sessionCards = [];
    switchView(state.learnReturnView);
  });
  $("#cardArea").addEventListener("click", () => {
    if (!$("#cardArea").classList.contains("revealed")) revealCard();
  });
  $(".rating-row").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-rating]");
    if (btn) rateCurrent(btn.dataset.rating);
  });
  $("#skipCardBtn").addEventListener("click", skipCard);
  $("#prevCardBtn").addEventListener("click", previousCard);
  document.addEventListener("keydown", (e) => {
    if (!$("#view-learn").classList.contains("active")) return;
    if ($("#learnRunning").classList.contains("hidden")) return;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
    if (e.code === "Space") {
      e.preventDefault();
      revealCard();
    } else if (e.key === "1") {
      rateCurrent("know");
    } else if (e.key === "2") {
      rateCurrent("fuzzy");
    } else if (e.key === "3") {
      rateCurrent("unknown");
    } else if (e.key === "ArrowLeft") {
      previousCard();
    } else if (e.key === "ArrowRight") {
      skipCard();
    }
  });

  // Export
  $("#exportUnitList").addEventListener("change", (e) => {
    const input = e.target.closest("input[data-export-unit]");
    if (!input) return;
    const id = Number(input.dataset.exportUnit);
    if (input.checked) state.exportUnits.add(id);
    else state.exportUnits.delete(id);
    updateExportSummary();
  });
  $("#exportSelectAllBtn").addEventListener("click", () => {
    const book = currentBook();
    state.exportUnits = new Set((book?.units || []).map((u) => u.id));
    updateExportSummary();
  });
  $("#exportClearBtn").addEventListener("click", () => {
    state.exportUnits = new Set();
    updateExportSummary();
  });
  $("#exportModeSwitch").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-mode]");
    if (!btn) return;
    state.exportMode = btn.dataset.mode;
    $("#countField").classList.toggle("hidden", state.exportMode === "all");
    updateExportModeButtons();
    updateExportSummary();
  });
  $("#exportContentSwitch").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-pdf-style]");
    if (!btn) return;
    state.exportContent = btn.dataset.pdfStyle;
    updateExportContentUi();
    refreshPreview();
  });
  $("#exportCount").addEventListener("change", updateExportSummary);
  $("#refreshPreviewBtn").addEventListener("click", refreshPreview);
  $("#exportPdfBtn").addEventListener("click", async () => {
    const book = currentBook();
    if (!book || !state.exportUnits.size) return;
    const btn = $("#exportPdfBtn");
    btn.disabled = true;
    btn.textContent = "生成中...";
    try {
      const blob = await api("/api/export-pdf", jsonOptions("POST", {
        book_id: book.id,
        book_name: book.name,
        unit_ids: Array.from(state.exportUnits),
        mode: state.exportMode,
        count: Number($("#exportCount").value) || 20,
        blank_mode: state.exportContent === "blank",
      }));
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${book.name}-抽查-${new Date().toISOString().slice(0, 10)}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      showToast("PDF 已生成");
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "生成 PDF";
    }
  });

  // Import
  $("#importBtn").addEventListener("click", () => openImportDialog("file"));
  $$(".tab-btn").forEach((btn) => btn.addEventListener("click", () => setImportMode(btn.dataset.importMode)));
  const drop = $("#dropZone");
  const fileInput = $("#fileInput");
  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (file) {
      $("#fileMeta").textContent = `${file.name} · ${(file.size / 1024).toFixed(0)} KB`;
      if (!$("#importName").value) $("#importName").value = file.name.replace(/\.[^.]+$/, "");
    }
  });
  ["dragenter", "dragover"].forEach((evt) =>
    drop.addEventListener(evt, (e) => {
      e.preventDefault();
      drop.classList.add("dragging");
    }),
  );
  ["dragleave", "drop"].forEach((evt) =>
    drop.addEventListener(evt, (e) => {
      e.preventDefault();
      drop.classList.remove("dragging");
    }),
  );
  drop.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event("change"));
  });
  $("#doImportBtn").addEventListener("click", () => {
    const mode = $$(".tab-btn").find((b) => b.classList.contains("active")).dataset.importMode;
    const file = mode === "file" ? fileInput.files[0] : null;
    if (mode === "file" && !file) {
      $("#importStatus").textContent = "请先选择一个词书文件";
      return;
    }
    runImport({ file, text: mode === "text" ? $("#importText").value : "" });
  });
  $("#sampleBookBtn").addEventListener("click", async () => {
    const sample = [
      "Unit 1",
      "abandon [əˈbændən] vt. 放弃；抛弃",
      "benefit [ˈbenɪfɪt] n. 好处；益处 vt. 使受益",
      "challenge [ˈtʃælɪndʒ] n. 挑战 vt. 向...挑战",
      "declare [dɪˈkleə(r)] vt. 宣布；声明",
      "efficient [ɪˈfɪʃnt] adj. 高效的",
      "Unit 2",
      "generate [ˈdʒenəreɪt] vt. 产生；生成",
      "highlight [ˈhaɪlaɪt] n. 最精彩部分 vt. 强调",
      "inspire [ɪnˈspaɪə(r)] vt. 鼓舞；启发",
      "justify [ˈdʒʌstɪfaɪ] vt. 证明...正确",
    ].join("\n");
    try {
      const result = await api("/api/import", jsonOptions("POST", {
        name: "体验词书",
        filename: "内置体验",
        text: sample,
        replace_same: true,
      }));
      showToast(`示例已导入：${result.unit_count} 个单元 / ${result.word_count} 个单词`);
      await refreshBooks(result.book_id);
      const book = currentBook();
      if (book) {
        state.selectedUnits = new Set(book.units.map((u) => u.id));
        state.exportUnits = new Set(book.units.map((u) => u.id));
        state.sessionCards = [];
        renderBooks();
        renderExport();
      }
    } catch (err) {
      showToast(err.message, "error");
    }
  });

}

async function init() {
  bindEvents();
  try {
    await refreshBooks();
    switchView("books");
    if (!state.books.length) {
      $("#bookSubtitle").textContent = "先导入一本词书";
    }
  } catch (err) {
    showToast(`初始化失败：${err.message}`, "error");
  }
}

init();
