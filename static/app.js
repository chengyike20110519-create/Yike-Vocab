"use strict";

const API_BASE = location.protocol === "file:" ? "http://127.0.0.1:8000" : "";
const PUBLIC_DEMO =
  location.protocol !== "file:" &&
  !["localhost", "127.0.0.1"].includes(location.hostname);
const SESSION_KEY = "vocab-demo-session";
const LEARN_RESUME_KEY = "yike-learn-resume";
const LEARN_RESUME_LIST_KEY = "yike-learn-resumes";
const MAX_LEARN_RESUMES = 2;
const STUDY_LOG_KEY = "yike-study-log";
const SESSION_LOG_KEY = "yike-session-log";
const DEFAULT_BOOK_KEY = "yike-default-book";
const THEME_KEY = "yike-theme";
const WORD_SIDEBAR_KEY = "yike-word-sidebar";

function applyTheme(theme) {
  const dark = theme === "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  const button = $("#themeToggleBtn");
  if (!button) return;
  button.textContent = dark ? "浅色模式" : "深色模式";
  button.setAttribute("aria-label", dark ? "切换到浅色模式" : "切换到深色模式");
}

function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch (err) {
    // Use the system preference when storage is unavailable.
  }
  const theme = saved === "dark" || saved === "light"
    ? saved
    : (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  applyTheme(theme);
}

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
  learnMode: "normal",
  sessionCards: [],
  sessionIndex: 0,
  sessionRatings: { know: 0, fuzzy: 0, unknown: 0 },
  sessionRated: {},
  quizPool: [],
  lastSession: [],
  previewCards: [],
  bookDirty: false,
  recordScope: null,
  recordCards: [],
  wordHistory: null,
  learnReturnView: "books",
  importAppendBookId: null,
  resumeId: null,
  sessionStartedAt: null,
  sessionTimer: null,
  sessionLogSaved: false,
  calendarMetric: "word_count",
  calendarDays: [],
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

function readDefaultBookId() {
  try {
    const value = Number(localStorage.getItem(DEFAULT_BOOK_KEY));
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch (err) {
    return null;
  }
}

function writeDefaultBookId(bookId) {
  try {
    if (bookId) localStorage.setItem(DEFAULT_BOOK_KEY, String(bookId));
    else localStorage.removeItem(DEFAULT_BOOK_KEY);
  } catch (err) {
    // Some browsers restrict storage for file:// pages.
  }
}

function resumeStorageKey(bookId) {
  return `${LEARN_RESUME_KEY}:${bookId}`;
}

function resumeId() {
  return `resume-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function validLearnResume(resume) {
  return Boolean(
    resume &&
      Array.isArray(resume.cards) &&
      resume.cards.length > 0 &&
      Number.isInteger(resume.index) &&
      resume.index >= 0 &&
      resume.index < resume.cards.length &&
      Number.isInteger(Number(resume.bookId)),
  );
}

function readResumeList() {
  try {
    const raw = localStorage.getItem(LEARN_RESUME_LIST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(validLearnResume) : [];
  } catch (err) {
    return [];
  }
}

function readLegacyResumes() {
  const resumes = [];
  const prefix = LEARN_RESUME_KEY + ":";
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(prefix)) continue;
    try {
      const raw = localStorage.getItem(key);
      const resume = raw ? JSON.parse(raw) : null;
      if (validLearnResume(resume)) {
        resumes.push({ ...resume, id: `legacy-${resume.bookId}` });
      }
    } catch (err) {
      // Skip invalid entries while preserving the remaining saved records.
    }
  }
  return resumes;
}

function readLearnResume(bookId) {
  if (!bookId) return null;
  return readAllResumes().find((resume) => Number(resume.bookId) === Number(bookId)) || null;
}

function saveLearnResume() {
  const book = currentBook();
  if (!book || !state.sessionCards.length || state.sessionIndex >= state.sessionCards.length) return;
  const resume = {
    id: state.resumeId || resumeId(),
    bookId: book.id,
    bookName: book.name,
    cards: state.sessionCards,
    index: state.sessionIndex,
    rated: state.sessionRated,
    mode: state.learnMode,
    quizPool: state.quizPool,
    savedAt: Date.now(),
  };
  try {
    state.resumeId = resume.id;
    const resumes = readAllResumes().filter((item) => item.id !== resume.id);
    resumes.push(resume);
    resumes.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    localStorage.setItem(
      LEARN_RESUME_LIST_KEY,
      JSON.stringify(resumes.slice(0, MAX_LEARN_RESUMES)),
    );
    readLegacyResumes().forEach((legacy) => {
      localStorage.removeItem(resumeStorageKey(legacy.bookId));
    });
  } catch (err) {
    // Some browsers restrict storage for file:// pages; the running session still works.
  }
}

function clearLearnResume(bookId = currentBook()?.id, targetResumeId = state.resumeId) {
  if (!bookId && !targetResumeId) return;
  try {
    const resumes = readAllResumes().filter((resume) => {
      if (targetResumeId) return resume.id !== targetResumeId;
      return Number(resume.bookId) !== Number(bookId);
    });
    localStorage.setItem(LEARN_RESUME_LIST_KEY, JSON.stringify(resumes));
    if (bookId) localStorage.removeItem(resumeStorageKey(bookId));
    if (targetResumeId === state.resumeId) state.resumeId = null;
  } catch (err) {
    // Ignore storage restrictions while finishing the session.
  }
}

function readAllResumes() {
  const stored = readResumeList();
  const resumes = [...(stored || []), ...readLegacyResumes()];
  const unique = resumes.filter(
    (resume, index, all) => all.findIndex((item) => item.id === resume.id) === index,
  );
  unique.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  return unique.slice(0, MAX_LEARN_RESUMES);
}

function renderLearnResume() {
  const panel = $("#resumeLearnPanel");
  if (!panel) return;
  const resumes = readAllResumes();
  if (!resumes.length) {
    panel.classList.add("hidden");
    panel.innerHTML = "";
    return;
  }
  panel.classList.remove("hidden");
  panel.innerHTML = resumes
    .map((resume) => {
      const completed = resume.index;
      const total = resume.cards.length;
      const percent = Math.round((completed / total) * 100);
      return `
        <div class="resume-card">
          <div class="resume-learn-copy">
            <strong>${esc(resume.bookName || "未命名词书")}</strong>
            <span>已完成 ${completed} / ${total} 个单词，${learnModeLabel(resume.mode)}</span>
          </div>
          <div class="resume-learn-progress" aria-label="速记进度">
            <div style="width: ${percent}%"></div>
          </div>
          <button class="primary-btn resume-continue-btn" data-resume-id="${esc(resume.id)}" type="button">继续速记</button>
          <button class="ghost-btn resume-delete-btn" data-delete-resume-id="${esc(resume.id)}" data-delete-book="${resume.bookId}" type="button">删除</button>
        </div>
      `;
    })
    .join("");
  panel.onclick = (e) => {
    const go = e.target.closest(".resume-continue-btn");
    if (go) {
      const resume = resumes.find((r) => r.id === go.dataset.resumeId);
      if (!resume) return;
      state.activeBookId = resume.bookId;
      state.resumeId = resume.id;
      beginSession(
        resume.cards,
        resume.index,
        resume.rated || {},
        resume.mode || "normal",
        resume.quizPool || resume.cards,
      );
      switchView("learn");
      renderBooks();
      return;
    }
    const del = e.target.closest(".resume-delete-btn");
    if (del) {
      const bookId = Number(del.dataset.deleteBook);
      clearLearnResume(bookId, del.dataset.deleteResumeId);
      renderLearnResume();
    }
  };
}

function updateLearnModeButtons() {
  $$("#learnModeSwitch .seg-btn").forEach((item) => {
    item.classList.toggle("active", item.dataset.learnMode === state.learnMode);
  });
}

function learnModeLabel(mode) {
  return { quiz: "三选一速记", type: "打字默写" }[mode] || "普通卡片";
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
    const defaultId = readDefaultBookId();
    state.activeBookId =
      preferredId ||
      (defaultId && state.books.some((b) => b.id === defaultId) ? defaultId : null) ||
      state.books[0]?.id ||
      null;
    if (defaultId && !state.books.some((b) => b.id === defaultId)) writeDefaultBookId(null);
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
  $("#defaultBookBtn").classList.toggle("hidden", !hasBooks);
  $("#renameBookBtn").classList.toggle("hidden", !hasBooks);
  $("#addBookBtn").classList.toggle("hidden", !hasBooks);
  $("#deleteBookBtn").classList.toggle("hidden", !hasBooks);
  $("#bookShortName").textContent = book ? `${book.name} · ${book.word_count} 词` : "本地词库";
  $("#bookTitle").textContent = book?.name || "我的词书";
  $("#bookSubtitle").textContent = book ? `${book.unit_count} 个单元` : "选择单元后开始背诵";
  const defaultBookId = readDefaultBookId();
  $("#defaultBookBtn").textContent = book && defaultBookId === book.id ? "已设为默认" : "设为默认";
  $("#defaultBookBtn").disabled = Boolean(book && defaultBookId === book.id);

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
  renderLearnResume();

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
    ever: false,
  };
  state.recordCards = [];
  $("#recordSearch").value = "";
  updateRecordTabs();
  $("#recordDialog").showModal();
  await loadRecordCards();
}

function updateRecordTabs() {
  const scope = state.recordScope;
  if (!scope) return;
  $$("#recordFilter [data-record-tab]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.recordTab === scope.status);
  });
  $$("#recordScope [data-record-scope]").forEach((btn) => {
    btn.classList.toggle("active", (btn.dataset.recordScope === "ever") === Boolean(scope.ever));
  });
}

async function loadRecordCards() {
  const scope = state.recordScope;
  const book = currentBook();
  if (!scope || !book) return;
  const units = scope.unitIds && scope.unitIds.length ? scope.unitIds.join(",") : "";
  const query = `/api/cards?book=${book.id}&units=${units}&status=${scope.status}${scope.ever ? "&ever=1" : ""}`;
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
  const scopeLabel = scope.ever
    ? `历史标记过${recordStatusLabel(scope.status)}`
    : recordStatusLabel(scope.status);
  $("#recordTitle").textContent = `${unitLabel} · ${scopeLabel}单词`;

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

  const unitOrder = new Map(book.units.map((unit, index) => [unit.id, index]));
  const grouped = new Map();
  cards.forEach((card) => {
    const key = card.unit_id ?? card.unit_name;
    if (!grouped.has(key)) grouped.set(key, { name: card.unit_name, cards: [] });
    grouped.get(key).cards.push(card);
  });

  Array.from(grouped.values())
    .sort((a, b) => {
      const aId = a.cards[0]?.unit_id;
      const bId = b.cards[0]?.unit_id;
      return (unitOrder.get(aId) ?? Number.MAX_SAFE_INTEGER) -
        (unitOrder.get(bId) ?? Number.MAX_SAFE_INTEGER);
    })
    .forEach((group) => {
      const section = document.createElement("section");
      section.className = "record-unit-group";
      section.innerHTML = `
        <div class="record-unit-heading">
          <strong>${esc(group.name || "未分组")}</strong>
          <span>${group.cards.length} 个单词</span>
        </div>
      `;
      const rows = document.createElement("div");
      rows.className = "record-unit-words";
      group.cards.forEach((card) => {
        const row = document.createElement("div");
        row.className = "record-row";
        row.dataset.wordId = String(card.id);
        row.innerHTML = `
          <button class="record-word" type="button" data-show-history="${card.id}" aria-label="查看点击记录">
            <strong>${esc(card.word)}</strong>
            <span class="record-meta">
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
        rows.appendChild(row);
      });
      section.appendChild(rows);
      list.appendChild(section);
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
    let quizPool = data.cards;
    if (state.learnMode === "quiz") {
      const allCards = await api(`/api/cards?book=${book.id}&shuffle=0`);
      quizPool = allCards.cards;
    }
    state.resumeId = null;
    beginSession(data.cards, 0, {}, state.learnMode, quizPool);
    switchView("learn");
  } catch (err) {
    showToast(err.message, "error");
    renderLearnSetup();
  }
}

function beginSession(cards, startIndex = 0, rated = {}, mode = state.learnMode, quizPool = cards) {
  state.sessionCards = cards;
  state.sessionIndex = startIndex;
  state.sessionRated = { ...(rated || {}) };
  state.sessionRatings = { know: 0, fuzzy: 0, unknown: 0 };
  Object.values(state.sessionRated).forEach((status) => {
    if (Object.prototype.hasOwnProperty.call(state.sessionRatings, status)) {
      state.sessionRatings[status] += 1;
    }
  });
  state.learnMode = ["quiz", "type"].includes(mode) ? mode : "normal";
  state.quizPool = Array.isArray(quizPool) && quizPool.length ? quizPool : cards;
  state.sessionStartedAt = Date.now();
  state.sessionLogSaved = false;
  startSessionTimer();
  updateLearnModeButtons();
  buildWordSidebar();
  state.lastSession = cards;
  $("#learnFinished").classList.add("hidden");
  $("#learnRunning").classList.remove("hidden");
  $("#exitLearnBtn").textContent = "退出";
  renderCard();
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function sessionElapsedSeconds() {
  return state.sessionStartedAt ? Math.floor((Date.now() - state.sessionStartedAt) / 1000) : 0;
}

function updateSessionTimer() {
  const timer = $("#learnTimer");
  if (timer) timer.textContent = formatDuration(sessionElapsedSeconds());
}

function startSessionTimer() {
  if (state.sessionTimer) clearInterval(state.sessionTimer);
  updateSessionTimer();
  state.sessionTimer = setInterval(updateSessionTimer, 1000);
}

function stopSessionTimer() {
  if (state.sessionTimer) clearInterval(state.sessionTimer);
  state.sessionTimer = null;
  updateSessionTimer();
}

function readSessionLogs() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSION_LOG_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function normalizeSessionLog(log) {
  return {
    ...log,
    units: Array.isArray(log.units) ? log.units : [],
    ratings: {
      know: Number(log.ratings?.know) || 0,
      fuzzy: Number(log.ratings?.fuzzy) || 0,
      unknown: Number(log.ratings?.unknown) || 0,
    },
    words: Array.isArray(log.words) ? log.words : [],
    duration: Number(log.duration) || 0,
    wordCount: Number(log.wordCount) || 0,
    score: Number(log.score) || 0,
  };
}

function saveSessionLog(completed = true) {
  if (state.sessionLogSaved || !state.sessionCards.length) return;
  const studiedCards = state.sessionCards.filter((card) => state.sessionRated[card.id]);
  if (!studiedCards.length && !completed) return;
  const duration = sessionElapsedSeconds();
  const ratings = state.sessionRatings;
  const total = state.sessionCards.length;
  const studied = completed ? total : studiedCards.length;
  const completion = total ? Math.min(100, (studied / total) * 100) : 0;
  const recognition = studied ? (ratings.know / studied) * 100 : 0;
  const efficiency = duration > 0 ? Math.min(100, (studied / duration) * 60) : 0;
  const score = Math.round(completion * 0.4 + recognition * 0.4 + efficiency * 0.2);
  const book = currentBook();
  const log = {
    id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    completed,
    duration,
    wordCount: studied,
    totalWords: total,
    score,
    ratings: { ...ratings },
    bookName: book?.name || "未命名词书",
    units: [...new Set(state.sessionCards.map((card) => card.unit_name).filter(Boolean))],
    words: state.sessionCards.map((card) => ({
      word: card.word,
      meaning: card.meaning || "",
      unit: card.unit_name || "",
      status: state.sessionRated[card.id] || "未标记",
    })),
  };
  try {
    const logs = [log, ...readSessionLogs()].slice(0, 100);
    localStorage.setItem(SESSION_LOG_KEY, JSON.stringify(logs));
    state.sessionLogSaved = true;
  } catch (err) {
    // Keep the running session usable when browser storage is unavailable.
  }
}

function renderStudyLogs() {
  const list = $("#studyLogList");
  const empty = $("#studyLogEmpty");
  const summary = $("#logSummary");
  if (!list || !empty || !summary) return;
  const logs = readSessionLogs().map(normalizeSessionLog);
  empty.classList.toggle("hidden", logs.length > 0);
  list.classList.toggle("hidden", logs.length === 0);
  const totalWords = logs.reduce((sum, log) => sum + (log.wordCount || 0), 0);
  const totalSeconds = logs.reduce((sum, log) => sum + (log.duration || 0), 0);
  summary.textContent = `${logs.length} 次学习 · ${totalWords} 个单词 · ${formatDuration(totalSeconds)}`;
  list.innerHTML = logs.map((log) => {
    const date = new Date(log.createdAt);
    const dateText = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    return `<button class="study-log-row" type="button" data-session-log-id="${esc(log.id)}">
      <span class="study-log-main"><strong>${esc(log.bookName)}</strong><span>${esc(log.units.join("、"))}</span></span>
      <span class="study-log-metric"><strong>${log.wordCount}</strong><small>个单词</small></span>
      <span class="study-log-metric"><strong>${formatDuration(log.duration)}</strong><small>学习时长</small></span>
      <span class="study-log-score"><strong>${log.score}</strong><small>综合分</small></span>
      <time>${dateText}</time>
    </button>`;
  }).join("");
}

function openStudyLogDetail(id) {
  const log = readSessionLogs().map(normalizeSessionLog).find((item) => item.id === id);
  if (!log) return;
  const detail = $("#studyLogDetail");
  if (!detail) return;
  const completion = log.totalWords ? Math.round((log.wordCount / log.totalWords) * 100) : 0;
  const recognition = log.wordCount ? Math.round((log.ratings.know / log.wordCount) * 100) : 0;
  const efficiency = log.duration ? Math.min(100, Math.round((log.wordCount / log.duration) * 60)) : 0;
  detail.innerHTML = `<div class="log-detail-head"><strong>${esc(log.bookName)}</strong><span>${log.completed ? "本轮完成" : "中途退出"} · ${formatDuration(log.duration)} · 综合分 ${log.score}</span></div>
    <p class="subtle">单元：${esc(log.units.join("、"))} · 认识 ${log.ratings.know} · 模糊 ${log.ratings.fuzzy} · 不认识 ${log.ratings.unknown}</p>
    <div class="log-score-breakdown"><span>完成度 ${completion}%</span><span>认识率 ${recognition}%</span><span>学习效率 ${efficiency}%</span><small>综合分 = 完成度 40% + 认识率 40% + 学习效率 20%</small></div>
    <div class="log-word-list">${log.words.map((word) => `<div><strong>${esc(word.word)}</strong><span>${esc(word.unit)} · ${esc(word.meaning)} · ${statusLabel(word.status)}</span></div>`).join("")}</div>`;
  $("#studyLogDialog").showModal();
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
  $("#cardBackWord").textContent = card.word;
  $("#cardBackPhonetic").textContent = card.phonetic || "";
  $("#cardBackPos").textContent = card.pos ? `（${card.pos}）` : "";
  $("#cardMeaning").textContent = card.meaning || "暂无中文释义";
  $("#cardEnglish").textContent = card.meaning_en ? `English：${card.meaning_en}` : "";
  $("#cardMemory").textContent = card.memory ? `助记：${card.memory}` : "";
  $("#quizWord").textContent = card.word;
  $("#quizPhonetic").textContent = card.phonetic || "";
  $("#quizPos").textContent = card.pos ? `（${card.pos}）` : "";
  $("#cardArea").classList.toggle("hidden", state.learnMode === "quiz");
  $("#quizPanel").classList.toggle("hidden", state.learnMode !== "quiz");
  $(".rating-row").classList.toggle("hidden", state.learnMode === "quiz");
  if (state.learnMode === "quiz") renderQuiz(card);
  $("#cardArea").classList.remove("revealed");
  resetTypePanel();
  $("#cardArea").scrollTop = 0;
  $("#learnUnitName").textContent = card.unit_name;
  $("#learnCounter").textContent = `${state.sessionIndex + 1} / ${state.sessionCards.length}`;
  $("#learnProgress").style.width = `${((state.sessionIndex + 1) / state.sessionCards.length) * 100}%`;
  updateWordSidebar();
  $("#sessionStatus").classList.add("hidden");
  $("#sessionStatus").textContent = "";
  $("#prevCardBtn").disabled = state.sessionIndex === 0;
  saveLearnResume();
}

function wordSimilarity(left, right) {
  const a = String(left || "").toLowerCase().replace(/[^a-z]/g, "");
  const b = String(right || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!a || !b) return 0;
  let prefix = 0;
  while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix]) prefix += 1;
  const chars = new Set(a);
  const overlap = [...new Set(b)].filter((char) => chars.has(char)).length;
  return prefix * 4 + overlap / Math.max(a.length, b.length);
}

function randomize(items) {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function buildQuizOptions(card) {
  const correct = String(card.meaning || "暂无中文释义").trim();
  const pool = state.quizPool.filter((item) => item.id !== card.id && item.meaning);
  const sameUnit = pool.filter((item) => item.unit_id === card.unit_id);
  const ranked = (sameUnit.length >= 2 ? sameUnit : pool)
    .map((item) => ({ item, score: wordSimilarity(card.word, item.word) + Math.random() * 1.5 }))
    .sort((a, b) => b.score - a.score);
  const meanings = [correct];
  ranked.forEach(({ item }) => {
    const meaning = String(item.meaning || "").trim();
    if (meaning && !meanings.includes(meaning) && meanings.length < 3) meanings.push(meaning);
  });
  return randomize(meanings);
}

function renderQuiz(card) {
  const options = buildQuizOptions(card);
  const box = $("#quizOptions");
  const result = $("#quizResult");
  box.innerHTML = "";
  result.className = "quiz-result hidden";
  result.textContent = "";
  options.forEach((meaning) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "quiz-option";
    button.dataset.meaning = meaning;
    button.textContent = meaning;
    box.appendChild(button);
  });
  if (options.length < 3) {
    const note = document.createElement("div");
    note.className = "quiz-result";
    note.textContent = "当前选词范围不足 3 个不同释义，已显示可用选项";
    box.appendChild(note);
  }
}

function answerQuiz(meaning) {
  const card = state.sessionCards[state.sessionIndex];
  if (!card || state.learnMode !== "quiz") return;
  const buttons = $$("#quizOptions .quiz-option");
  if (buttons.some((button) => button.disabled)) return;
  const correct = String(card.meaning || "暂无中文释义").trim();
  const isCorrect = meaning === correct;
  buttons.forEach((button) => {
    button.disabled = true;
    if (button.dataset.meaning === correct) button.classList.add("correct");
    if (button.dataset.meaning === meaning && !isCorrect) button.classList.add("wrong");
  });
  const result = $("#quizResult");
  result.className = `quiz-result ${isCorrect ? "correct" : "wrong"}`;
  result.textContent = isCorrect ? "答对了" : `答错了，正确答案：${correct}`;
  markAnswered(isCorrect ? "know" : "unknown");
  setTimeout(advanceCard, 700);
}

function markAnswered(rating) {
  const card = state.sessionCards[state.sessionIndex];
  if (!card) return;
  const previousRating = state.sessionRated[card.id];
  if (!previousRating || previousRating === "skip") state.sessionRatings[rating] += 1;
  else if (previousRating !== rating) {
    state.sessionRatings[previousRating] = Math.max(0, state.sessionRatings[previousRating] - 1);
    state.sessionRatings[rating] += 1;
  }
  state.sessionRated[card.id] = rating;
  state.bookDirty = true;
  recordStudyEvent(card, rating);
  api("/api/mark", jsonOptions("POST", { word_id: card.id, status: rating })).catch(
    (err) => showToast(err.message, "error"),
  );
}

function openMeaningEditor() {
  const card = state.sessionCards[state.sessionIndex];
  if (!card) return;
  $("#meaningWordLabel").textContent = card.word;
  $("#meaningInput").value = card.meaning || "";
  $("#meaningStatus").textContent = "";
  $("#saveMeaningBtn").disabled = false;
  $("#meaningDialog").showModal();
  $("#meaningInput").focus();
}

async function saveMeaning() {
  const card = state.sessionCards[state.sessionIndex];
  const meaning = $("#meaningInput").value.trim();
  if (!card || !meaning) {
    $("#meaningStatus").textContent = "中文释义不能为空";
    return;
  }
  const button = $("#saveMeaningBtn");
  button.disabled = true;
  $("#meaningStatus").textContent = "正在保存...";
  try {
    await api("/api/update-meaning", jsonOptions("POST", {
      word_id: card.id,
      meaning,
    }));
    state.sessionCards.forEach((item) => {
      if (item.id === card.id) item.meaning = meaning;
    });
    $("#meaningDialog").close();
    renderCard();
    showToast("中文释义已保存，之后会继续使用新释义");
  } catch (err) {
    $("#meaningStatus").textContent = err.message;
    button.disabled = false;
  }
}

async function rateCurrent(rating) {
  if (state.learnMode === "quiz") return;
  const card = state.sessionCards[state.sessionIndex];
  if (!card) return;
  if (!$("#cardArea").classList.contains("revealed")) {
    revealCard();
  }
  if (state.learnMode === "type") {
    const knowBtn = $(".rating-btn.know");
    if (knowBtn && knowBtn.disabled) {
      showToast("请先把单词打一遍再标记");
      $("#typeInput").focus();
      return;
    }
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
  updateWordSidebar();
  $("#sessionStatus").textContent = `${card.word} 已标记`;
  $("#sessionStatus").classList.remove("hidden");
  state.bookDirty = true;
  recordStudyEvent(card, rating);
  api("/api/mark", jsonOptions("POST", { word_id: card.id, status: rating })).catch(
    (err) => showToast(err.message, "error"),
  );
  advanceCard();
}

function previousCard() {
  if (state.sessionIndex <= 0) return;
  state.sessionIndex -= 1;
  renderCard();
  saveLearnResume();
}

function revealCard() {
  $("#cardArea").classList.add("revealed");
  if (state.learnMode === "type") openTypePanel();
}

function setRatingEnabled(enabled) {
  $$(".rating-btn").forEach((btn) => {
    btn.disabled = !enabled;
  });
}

function resetTypePanel() {
  const panel = $("#typePanel");
  if (!panel) return;
  panel.classList.add("hidden");
  if (state.learnMode !== "type") {
    setRatingEnabled(true);
    return;
  }
  const input = $("#typeInput");
  input.value = "";
  const feedback = $("#typeFeedback");
  feedback.textContent = "";
  feedback.className = "type-feedback";
  setRatingEnabled(false);
}

function openTypePanel() {
  const panel = $("#typePanel");
  if (!panel) return;
  panel.classList.remove("hidden");
  const input = $("#typeInput");
  input.value = "";
  const feedback = $("#typeFeedback");
  feedback.textContent = "";
  feedback.className = "type-feedback";
  setRatingEnabled(false);
  input.focus();
}

function checkTypeAnswer() {
  if (state.learnMode !== "type") return;
  const card = state.sessionCards[state.sessionIndex];
  if (!card || !$("#cardArea").classList.contains("revealed")) return;
  const input = $("#typeInput");
  const feedback = $("#typeFeedback");
  const typed = input.value.trim().toLowerCase();
  if (!typed) {
    feedback.className = "type-feedback";
    feedback.textContent = "先把这个单词打一遍，再按回车确认";
    return;
  }
  if (typed === String(card.word || "").trim().toLowerCase()) {
    feedback.className = "type-feedback correct";
    feedback.textContent = "拼写正确，现在可以标记认识、模糊或不认识了";
    setRatingEnabled(true);
    input.blur();
  } else {
    feedback.className = "type-feedback wrong";
    feedback.textContent = "还没对，对照卡片上的英文再试一次";
    input.select();
  }
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

function shuffleDifferent(cards, previousCards = []) {
  const shuffled = cards.slice();
  if (shuffled.length < 2) return shuffled;
  const previous = previousCards.map((card) => card.id).join(",");
  for (let attempt = 0; attempt < 8; attempt += 1) {
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    if (shuffled.map((card) => card.id).join(",") !== previous) return shuffled;
  }
  return shuffled.slice(1).concat(shuffled[0]);
}

function applyWordSidebar() {
  const aside = $("#wordSidebar");
  const wrap = $("#learnRunning");
  const toggle = $("#wordSidebarToggle");
  if (!aside || !wrap || !toggle) return;
  let saved = null;
  try {
    saved = localStorage.getItem(WORD_SIDEBAR_KEY);
  } catch (err) {
    // Storage unavailable, fall back to the screen width.
  }
  const narrow = window.matchMedia?.("(max-width: 900px)").matches;
  const open = saved ? saved === "open" : !narrow;
  wrap.classList.toggle("sidebar-open", open);
  aside.classList.toggle("hidden", !open);
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
  toggle.classList.toggle("active", open);
}

function buildWordSidebar() {
  const aside = $("#wordSidebar");
  const list = $("#wordSidebarList");
  const count = $("#wordSidebarCount");
  if (!aside || !list) return;
  list.textContent = "";
  const cards = state.sessionCards || [];
  const unitNames = [];
  cards.forEach((card) => {
    if (!unitNames.includes(card.unit_name)) unitNames.push(card.unit_name);
  });
  cards.forEach((card, index) => {
    if (unitNames.length > 1 && (index === 0 || cards[index - 1].unit_name !== card.unit_name)) {
      const label = document.createElement("div");
      label.className = "word-group-label";
      label.textContent = card.unit_name;
      list.appendChild(label);
    }
    const item = document.createElement("button");
    item.type = "button";
    item.className = "word-item";
    item.dataset.index = String(index);
    const num = document.createElement("span");
    num.className = "word-index";
    num.textContent = String(index + 1);
    const text = document.createElement("span");
    text.className = "word-text";
    text.textContent = card.word;
    const dot = document.createElement("span");
    dot.className = "word-status-dot";
    dot.setAttribute("aria-hidden", "true");
    item.append(num, text, dot);
    item.setAttribute("aria-label", `跳到第 ${index + 1} 个：${card.word}`);
    item.addEventListener("click", () => {
      if (state.sessionIndex === index) return;
      state.sessionIndex = index;
      renderCard();
      saveLearnResume();
    });
    list.appendChild(item);
  });
  if (count) count.textContent = `${cards.length} 个`;
}

function updateWordSidebar() {
  const aside = $("#wordSidebar");
  if (!aside || aside.classList.contains("hidden")) return;
  const cards = state.sessionCards || [];
  const items = Array.from(aside.querySelectorAll(".word-item"));
  if (items.length !== cards.length) return;
  items.forEach((item, index) => {
    const status = state.sessionRated[cards[index].id];
    item.classList.toggle("active", index === state.sessionIndex);
    item.classList.toggle("rated-know", status === "know");
    item.classList.toggle("rated-fuzzy", status === "fuzzy");
    item.classList.toggle("rated-unknown", status === "unknown");
  });
  const active = items[state.sessionIndex];
  if (active) active.scrollIntoView({ block: "nearest" });
}

function finishSession() {
  saveSessionLog(true);
  stopSessionTimer();
  clearLearnResume();
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
  const nextRoundBtn = document.createElement("button");
  nextRoundBtn.className = "primary-btn";
  nextRoundBtn.textContent = "再来一轮（换个顺序）";
  nextRoundBtn.addEventListener("click", () => {
    state.resumeId = null;
    const nextCards = shuffleDifferent(state.sessionCards, state.sessionCards);
    beginSession(nextCards, 0, {}, state.learnMode, state.quizPool);
  });
  const weakBtn = document.createElement("button");
  weakBtn.className = "ghost-btn";
  weakBtn.textContent = `复习模糊与不认识（${weak}）`;
  weakBtn.disabled = weak === 0;
  weakBtn.addEventListener("click", () => {
    state.resumeId = null;
    const weakCards = shuffleDifferent(state.sessionCards.filter(isWeak));
    beginSession(weakCards, 0, {}, state.learnMode, state.quizPool);
  });
  const copyWeakBtn = document.createElement("button");
  copyWeakBtn.className = "ghost-btn";
  copyWeakBtn.textContent = `复制不熟悉的单词（${weak}）`;
  copyWeakBtn.disabled = weak === 0;
  copyWeakBtn.addEventListener("click", async () => {
    const weakWords = state.sessionCards
      .filter(isWeak)
      .map((card) => `${card.word}${card.meaning ? ` ${card.meaning}` : ""}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(weakWords);
      showToast("不熟悉的单词已复制");
    } catch (err) {
      const helper = document.createElement("textarea");
      helper.value = weakWords;
      helper.setAttribute("readonly", "");
      helper.style.position = "fixed";
      helper.style.opacity = "0";
      document.body.appendChild(helper);
      helper.select();
      const copied = document.execCommand("copy");
      helper.remove();
      showToast(copied ? "不熟悉的单词已复制" : "复制失败，请重试", copied ? "" : "error");
    }
  });
  const backBtn = document.createElement("button");
  backBtn.className = "ghost-btn";
  backBtn.textContent = "回到开始学习";
  backBtn.addEventListener("click", () => switchView("books"));
  actions.append(nextRoundBtn, weakBtn, copyWeakBtn, backBtn);
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

function localDateKey(value = new Date()) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateKey(value) {
  const [year, month, day] = String(value || "").split("-").map(Number);
  return new Date(year, month - 1, day);
}

function dayLogLabel(value) {
  const today = new Date();
  const todayKey = localDateKey(today);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (value === todayKey) return "今天";
  if (value === localDateKey(yesterday)) return "昨天";
  const target = parseDateKey(value);
  const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][target.getDay()];
  return `${target.getMonth() + 1}月${target.getDate()}日 ${weekday}`;
}

function statusLabel(status) {
  return { know: "认识", fuzzy: "模糊", unknown: "不认识" }[status] || "未标记";
}

const STUDY_STATUSES = ["know", "fuzzy", "unknown"];
const LOCAL_LOG_LIMIT = 10000;

function recordStudyEvent(card, rating) {
  if (!card || !STUDY_STATUSES.includes(rating)) return;
  try {
    const raw = localStorage.getItem(STUDY_LOG_KEY);
    const log = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(log)) return;
    const book = currentBook();
    log.push({
      t: Date.now(),
      id: card.id,
      word: card.word,
      meaning: card.meaning || "",
      status: rating,
      book: book ? book.name : "",
      unit: card.unit_name || "",
    });
    if (log.length > LOCAL_LOG_LIMIT) log.splice(0, log.length - LOCAL_LOG_LIMIT);
    localStorage.setItem(STUDY_LOG_KEY, JSON.stringify(log));
  } catch (err) {
    // file:// 页面可能禁用 localStorage，忽略即可。
  }
}

function localDateTimeKey(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${localDateKey(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function buildLocalStudyLog(days = 84, recentLimit = 20) {
  let events = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(STUDY_LOG_KEY) || "[]");
    if (Array.isArray(parsed)) events = parsed.filter((e) => e && Number.isFinite(e.t));
  } catch (err) {
    events = [];
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayKey = localDateKey(today);

  const sorted = [...events].sort((a, b) => a.t - b.t);
  const byDay = new Map();
  const seenWords = new Set();
  sorted.forEach((event) => {
    const key = localDateKey(new Date(event.t));
    if (!byDay.has(key)) {
      byDay.set(key, { date: key, total: 0, know: 0, fuzzy: 0, unknown: 0, words: new Set(), new_words: 0 });
    }
    const day = byDay.get(key);
    day.total += 1;
    if (STUDY_STATUSES.includes(event.status)) day[event.status] += 1;
    day.words.add(event.id);
    if (!seenWords.has(event.id)) {
      seenWords.add(event.id);
      day.new_words += 1;
    }
  });

  const activeDates = new Set(byDay.keys());
  const sortedDates = Array.from(activeDates).sort();
  let longestStreak = 0;
  let running = 0;
  let previous = null;
  sortedDates.forEach((key) => {
    running = previous && key === localDateKey(new Date(previous.getTime() + 86400000)) ? running + 1 : 1;
    longestStreak = Math.max(longestStreak, running);
    previous = parseDateKey(key);
  });
  const streakFrom = (anchor) => {
    let streak = 0;
    let cursor = new Date(anchor.getTime());
    while (activeDates.has(localDateKey(cursor))) {
      streak += 1;
      cursor = new Date(cursor.getTime() - 86400000);
    }
    return streak;
  };
  const yesterday = new Date(today.getTime() - 86400000);
  const currentStreak = activeDates.has(todayKey)
    ? streakFrom(today)
    : activeDates.has(localDateKey(yesterday))
      ? streakFrom(yesterday)
      : 0;

  const windowStart = new Date(today.getTime() - (days - 1) * 86400000);
  const windowKey = localDateKey(windowStart);
  const dayList = Array.from(byDay.values())
    .filter((day) => day.date >= windowKey)
    .map((day) => ({
      date: day.date,
      total: day.total,
      know: day.know,
      fuzzy: day.fuzzy,
      unknown: day.unknown,
      word_count: day.words.size,
      new_words: day.new_words,
    }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  const todayLog = byDay.get(todayKey);
  const todayBooks = new Map();
  events
    .filter((event) => localDateKey(new Date(event.t)) === todayKey)
    .forEach((event) => {
      const bookName = event.book || "未命名词书";
      const unitName = event.unit || "未命名单元";
      if (!todayBooks.has(bookName)) todayBooks.set(bookName, new Map());
      const units = todayBooks.get(bookName);
      if (!units.has(unitName)) units.set(unitName, new Set());
      units.get(unitName).add(event.id);
    });
  const todayScope = Array.from(todayBooks, ([book_name, units]) => ({
    book_name,
    units: Array.from(units, ([unit_name, words]) => ({ unit_name, word_count: words.size })),
  }));
  return {
    local: true,
    summary: {
      current_streak: currentStreak,
      longest_streak: longestStreak,
      active_days: activeDates.size,
      total_events: events.length,
      learned_words: seenWords.size,
      touched_books: new Set(events.map((e) => e.book).filter(Boolean)).size,
      today_events: todayLog ? todayLog.total : 0,
      today_words: todayLog ? todayLog.words.size : 0,
      today_new_words: todayLog ? todayLog.new_words : 0,
      today_checked_in: Boolean(todayLog),
    },
    today_books: todayScope,
    days: dayList,
    recent_events: sorted.slice(-recentLimit).reverse().map((event) => ({
      created_at: localDateTimeKey(event.t),
      status: event.status,
      word: event.word,
      meaning: event.meaning || "",
      unit_name: event.unit || "",
      book_name: event.book || "",
    })),
  };
}

function renderStatsLine(summary, local) {
  const el = $("#statsLine");
  if (!el) return;
  const headline = $("#checkinHeadline");
  const todayWords = summary.today_words || 0;
  // current_streak already preserves a streak through yesterday, so an unstudied
  // today must not make the existing consecutive-study history look erased.
  const currentStreak = summary.current_streak || 0;
  if (headline) {
    headline.textContent = `连续打卡 ${currentStreak} 天`;
  }
  el.textContent = `今天背了 ${todayWords} 个单词${local ? " · 本机记录" : ""}`;
}

function renderTodayScope(books) {
  const el = $("#todayScope");
  if (!el) return;
  if (!books || books.length === 0) {
    el.textContent = "词书和单元：暂无";
    return;
  }
  el.textContent = books.map((book) => {
    const units = (book.units || [])
      .map((unit) => `${unit.unit_name}（${unit.word_count}）`)
      .join("、");
    return `词书：${book.book_name}｜单元：${units}`;
  }).join("；");
}

function heatLevel(total) {
  if (!total) return 0;
  if (total <= 5) return 1;
  if (total <= 15) return 2;
  if (total <= 30) return 3;
  return 4;
}

function calendarMetricInfo(metric = state.calendarMetric) {
  return {
    word_count: { label: "单词数量", unit: "个", empty: "暂无学习" },
    duration: { label: "学习时长", unit: "", empty: "暂无学习" },
    score: { label: "综合分", unit: "分", empty: "暂无学习" },
  }[metric] || { label: "单词数量", unit: "个", empty: "暂无学习" };
}

function calendarDaysWithSessions(days) {
  const merged = new Map((days || []).map((day) => [day.date, {
    ...day,
    word_count: Number(day.word_count) || 0,
    duration: Number(day.duration) || 0,
    score: Number(day.score) || 0,
  }]));
  const sessionDays = new Map();
  readSessionLogs().map(normalizeSessionLog).forEach((log) => {
    const date = localDateKey(new Date(log.createdAt));
    const day = sessionDays.get(date) || {
      date,
      total: 0,
      word_count: 0,
      duration: 0,
      scoreTotal: 0,
      sessionCount: 0,
    };
    day.word_count += log.wordCount;
    day.duration += log.duration;
    day.scoreTotal += log.score;
    day.sessionCount += 1;
    day.score = Math.round(day.scoreTotal / day.sessionCount);
    sessionDays.set(date, day);
  });
  sessionDays.forEach((day, date) => merged.set(date, day));
  return [...merged.values()];
}

function renderStudyCalendar(days) {
  const grid = $("#statsCalendar");
  if (!grid) return;
  const calendarDays = calendarDaysWithSessions(days);
  const byDate = new Map(calendarDays.map((day) => [day.date, day]));
  const metric = calendarMetricInfo();
  const values = calendarDays.map((day) => Number(day[state.calendarMetric]) || 0).filter((value) => value > 0);
  const maxValue = Math.max(...values, 0);
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  $("#statsCalendarTitle").textContent = `${year} 年 ${month + 1} 月 · ${metric.label}`;
  const hint = $("#calendarMetricHint");
  if (hint) hint.textContent = `颜色越深表示当天${metric.label}越高。点击或悬停日期可查看当天数据。`;
  grid.innerHTML = "";

  const headRow = document.createElement("div");
  headRow.className = "cal-weekdays";
  ["一", "二", "三", "四", "五", "六", "日"].forEach((label) => {
    const item = document.createElement("span");
    item.textContent = label;
    headRow.appendChild(item);
  });
  grid.appendChild(headRow);

  const cells = document.createElement("div");
  cells.className = "cal-cells";
  const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7;
  for (let i = 0; i < firstWeekday; i += 1) {
    const blank = document.createElement("div");
    blank.className = "cal-cell blank";
    cells.appendChild(blank);
  }
  const todayKey = localDateKey(now);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  for (let d = 1; d <= daysInMonth; d += 1) {
    const key = localDateKey(new Date(year, month, d));
    const day = byDate.get(key);
    const value = day ? Number(day[state.calendarMetric]) || 0 : 0;
    const level = value > 0 && maxValue > 0 ? Math.max(1, Math.ceil((value / maxValue) * 4)) : 0;
    const cell = document.createElement("div");
    cell.className = `cal-cell level-${level}`;
    if (key === todayKey) cell.classList.add("today");
    const num = document.createElement("span");
    num.className = "cal-day-num";
    num.textContent = String(d);
    cell.appendChild(num);
    if (day) {
      const meta = document.createElement("span");
      meta.className = "cal-day-meta";
      meta.textContent = state.calendarMetric === "duration"
        ? formatDuration(day.duration)
        : `${value}${metric.unit}`;
      cell.appendChild(meta);
      cell.title = `${key}：${metric.label} ${meta.textContent}`;
    } else {
      cell.title = `${key}：${metric.empty}`;
    }
    cell.setAttribute("aria-label", cell.title);
    cells.appendChild(cell);
  }
  grid.appendChild(cells);
}

async function refreshStudyLog() {
  let data = null;
  let local = false;
  try {
    data = await api("/api/study-log?days=84&events=200");
  } catch (err) {
    data = buildLocalStudyLog(84, 200);
    local = true;
  }
  renderStatsLine(data.summary, local);
  renderTodayScope(data.today_books);
  state.calendarDays = data.days || [];
  renderStudyCalendar(data.days);
}

function switchView(name) {
  $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  $$(".view").forEach((v) => v.classList.toggle("active", v.dataset.viewPanel === name));
  if (name === "books") {
    refreshStudyLog().catch(() => {});
    if (state.bookDirty) {
      refreshBooks().finally(() => renderBooks()).catch(() => {});
    } else {
      renderBooks();
    }
  }
  if (name === "export") renderExport();
  if (name === "log") {
    renderStudyLogs();
    refreshStudyLog().catch(() => {});
  }
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
  // Capture the destination before reading a file; the picker is asynchronous.
  const appendBookId = state.importAppendBookId;
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
  if (appendBookId !== null) {
    payload.append_book_id = appendBookId;
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
    const actionText = appendBookId !== null ? "已添加到本书" : "已导入";
    const duplicateHint = result.word_count === 0 && result.duplicate_count
      ? "，这些单词已经在本书中"
      : dup;
    showToast(`${actionText} ${result.word_count} 个单词 / ${result.unit_count} 个单元${duplicateHint}`);
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
  $("#themeToggleBtn").addEventListener("click", () => {
    const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (err) {
      // The current theme still applies for this visit.
    }
  });
  window.addEventListener("beforeunload", saveLearnResume);
  window.addEventListener("pagehide", saveLearnResume);
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
  $("#defaultBookBtn").addEventListener("click", () => {
    const book = currentBook();
    if (!book) return;
    writeDefaultBookId(book.id);
    renderBooks();
    showToast(`已将「${book.name}」设为默认词书`);
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
  $("#recordScope").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-record-scope]");
    if (!btn || !state.recordScope) return;
    state.recordScope.ever = btn.dataset.recordScope === "ever";
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
    state.resumeId = null;
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
  $("#learnModeSwitch").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-learn-mode]");
    if (!btn) return;
    state.learnMode = ["quiz", "type"].includes(btn.dataset.learnMode) ? btn.dataset.learnMode : "normal";
    updateLearnModeButtons();
  });
  $("#startLearnBtn").addEventListener("click", () => startLearn(state.order));
  $("#wordSidebarToggle").addEventListener("click", () => {
    const aside = $("#wordSidebar");
    const wrap = $("#learnRunning");
    if (!aside || !wrap) return;
    const open = !wrap.classList.contains("sidebar-open");
    wrap.classList.toggle("sidebar-open", open);
    aside.classList.toggle("hidden", !open);
    $("#wordSidebarToggle").setAttribute("aria-expanded", open ? "true" : "false");
    $("#wordSidebarToggle").classList.toggle("active", open);
    try {
      localStorage.setItem(WORD_SIDEBAR_KEY, open ? "open" : "closed");
    } catch (err) {
      // Storage unavailable, keep the in-memory state only.
    }
    if (open) {
      if (!aside.querySelector(".word-item")) buildWordSidebar();
      updateWordSidebar();
    }
  });
  $("#exitLearnBtn").addEventListener("click", () => {
    $("#learnRunning").classList.remove("sidebar-open");
    $("#wordSidebar").classList.add("hidden");
    saveSessionLog(false);
    stopSessionTimer();
    saveLearnResume();
    state.sessionCards = [];
    switchView(state.learnReturnView);
  });
  $("#studyLogList").addEventListener("click", (e) => {
    const row = e.target.closest("[data-session-log-id]");
    if (row) openStudyLogDetail(row.dataset.sessionLogId);
  });
  $("#calendarMetric").addEventListener("change", (e) => {
    state.calendarMetric = e.target.value;
    renderStudyCalendar(state.calendarDays);
  });
  $("#editMeaningBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    openMeaningEditor();
  });
  $("#saveMeaningBtn").addEventListener("click", saveMeaning);
  $("#meaningInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveMeaning();
  });
  $("#cardArea").addEventListener("click", (e) => {
    if (e.target.closest("#editMeaningBtn")) return;
    if (!$("#cardArea").classList.contains("revealed")) revealCard();
  });
  $("#cardArea").addEventListener("keydown", (e) => {
    if (e.target.closest("#typePanel, #editMeaningBtn")) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      if (!$("#cardArea").classList.contains("revealed")) revealCard();
    }
  });
  $(".rating-row").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-rating]");
    if (btn) rateCurrent(btn.dataset.rating);
  });
  $("#typeSubmitBtn").addEventListener("click", checkTypeAnswer);
  $("#typeInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      checkTypeAnswer();
    }
  });
  $("#quizOptions").addEventListener("click", (e) => {
    const btn = e.target.closest(".quiz-option");
    if (btn) answerQuiz(btn.dataset.meaning);
  });
  $("#skipCardBtn").addEventListener("click", skipCard);
  $("#prevCardBtn").addEventListener("click", previousCard);
  document.addEventListener("keydown", (e) => {
    if (!$("#view-learn").classList.contains("active")) return;
    if ($("#learnRunning").classList.contains("hidden")) return;
    const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
    if (typing && !["ArrowUp", "ArrowDown"].includes(e.key)) return;
    if (e.code === "Space") {
      e.preventDefault();
      if (state.learnMode !== "quiz" && !$("#cardArea").classList.contains("revealed")) {
        revealCard();
      }
    } else if (e.key === "1") {
      rateCurrent("know");
    } else if (e.key === "2") {
      rateCurrent("fuzzy");
    } else if (e.key === "3") {
      rateCurrent("unknown");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      previousCard();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
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
  applyWordSidebar();
  refreshStudyLog().catch(() => {});
  try {
    await refreshBooks();
    switchView("books");
    if (!state.books.length) {
      $("#bookSubtitle").textContent = "先导入一本词书";
    }
  } catch (err) {
    $("#emptyState").classList.remove("hidden");
    $("#bookBody").classList.add("hidden");
    $("#bookSubtitle").textContent = "词书加载失败，请重新启动本地服务";
    showToast(`词书加载失败：${err.message}`, "error");
  }
}

initTheme();
init();
