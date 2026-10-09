// Поддержка прямо в приложении — на тикетах бота (Bedolaga, API кабинета
// /tickets). Своего сервера нет: обращение создаётся тем же входом, что и
// кабинет, бот сам шлёт админам «🎫 НОВЫЙ ТИКЕТ» с кнопкой «Ответить», ответ
// виден и в приложении, и в боте, и в кабинете.
//
// С 2.1: вкладка «Обращения» — список тикетов со статусами, у каждого своя
// переписка. Правила бота: незакрытым может быть только ОДНО обращение
// (второе — 409), закрывает его поддержка, в закрытое писать нельзя (400).
// Поэтому: пока есть открытое — «Новое обращение» ведёт в него; у закрытого
// поля ввода нет, только «+ Новое обращение».
//
// Ответы забираем опросом: раз в 5 с, пока открыто обращение, раз в 15 с на
// списке и раз в 1,5 мин в фоне, пока есть незакрытое; о новом ответе —
// системное уведомление и точка на кнопке «Поддержка».
// Без входа в кабинет — только кнопка Telegram @vpnushka_manager.
//
// Грузится после app.js (el, on, show, view, prefs, savePrefs, invoke, say)
// и account.js (acc, accData, apiOk, ddmmyyyy, errText).

const SUP_TG = "https://t.me/vpnushka_manager";
const SUP_TEXT_MAX = 4000;
let supTickets = [];      // TicketResponse[] — список, свежие сверху
let supTicket = null;     // TicketDetailResponse — открытое на экране
let supScreen = "home";   // home | new | thread
let supCat = "";
let supTimer = 0;
let supBusy = false;
let supLoaded = false;    // список хоть раз пришёл — до того «обращений нет» не пишем

const SUP_STATUS = {
  open:     ["Ждёт ответа", "wait"],
  pending:  ["В работе", "wait"],
  answered: ["Есть ответ", "live"],
  closed:   ["Закрыто", "off"],
};
const supStatus = (t) => SUP_STATUS[t && t.status] || [String(t && t.status || ""), ""];
const supActive = () => supTickets.find((t) => t.status !== "closed") || null;
const logged = () => typeof acc !== "undefined" && !!acc;

function supTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return new Date().toDateString() === d.toDateString()
    ? d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

// Служебный хвост (диагностика) человеку в его же переписке не показываем.
const SUP_DIAG_MARK = "\n\n— — — диагностика — — —\n";
const supVisible = (text) => String(text || "").split(SUP_DIAG_MARK)[0];

/* ── прочитано / не прочитано ─────────────────────────────────────────────
   prefs.supSeen = {id тикета: id последнего прочитанного ответа поддержки}.
   До 2.1 был один счётчик prefs.supportSeen — он служит нижней границей. */
function seenOf(id) {
  return Math.max((prefs.supSeen || {})[id] || 0, prefs.supportSeen || 0);
}
function lastAdminOf(t) {
  if (t.messages) return t.messages.reduce((m, x) => (x.is_from_admin ? Math.max(m, x.id) : m), 0);
  const lm = t.last_message;
  return lm && lm.is_from_admin ? lm.id : 0;
}
const unreadOf = (t) => lastAdminOf(t) > seenOf(t.id);
const supUnread = () => supTickets.some(unreadOf);

function markSeen(t) {
  const last = lastAdminOf(t);
  if (!last || last <= seenOf(t.id)) return;
  savePrefs({ supSeen: Object.assign({}, prefs.supSeen, { [t.id]: last }) });
}

function paintSupportDot() {
  const n = supTickets.filter(unreadOf).length;
  for (const id of ["sup-dot", "sup-dot-tb", "sup-dot-tab"]) if (el(id)) el(id).style.display = n ? "" : "none";
  // подпись пункта «Поддержка» в настройках — сразу видно, что с обращением
  const sub = el("support-sub");
  if (sub) {
    const a = supActive();
    sub.textContent = n ? "новый ответ поддержки"
      : a ? "открыто обращение №" + a.id + " · " + supStatus(a)[0].toLowerCase()
      : "обращения в поддержку, вопросы и тарифы";
  }
}

/* ── вкладки «Вопросы · Тарифы · Обращения» ───────────────────────────────── */

let supTabNow = "faq";
function supTab(name) {
  supTabNow = name;
  for (const b of document.querySelectorAll("#sup-tabs [data-sup]")) b.classList.toggle("on", b.dataset.sup === name);
  for (const n of ["faq", "prices", "chat"]) el("sup-" + n).hidden = n !== name;
  if (name === "chat") {
    supGo(supScreen);
    supRefresh(false);
  }
  const pane = el("view-support");
  if (pane) pane.scrollTop = 0;
}

/* ── экраны: список, новое, обращение ─────────────────────────────────────── */

function supGo(screen) {
  supScreen = screen;
  const ok = logged();
  el("sup-login").style.display = ok ? "none" : "";
  for (const s of ["home", "new", "thread"]) el("sup-" + s).hidden = !ok || s !== screen;
  if (!ok) return;
  if (screen === "home") renderTickets();
  if (screen === "thread") renderThread();
  if (screen === "new") renderNew();
  supSchedule();
}

function renderTickets() {
  const box = el("sup-tickets");
  box.textContent = "";
  el("sup-tickets-empty").hidden = !supLoaded || supTickets.length > 0;
  if (!supLoaded) { el("sup-count").textContent = "загружаю…"; }
  else el("sup-count").textContent = supTickets.length ? String(supTickets.length) : "";
  const a = supActive();
  const note = el("sup-active");
  note.hidden = !a;
  el("sup-new-btn").hidden = !!a;
  if (a) {
    note.textContent = "";
    const b = document.createElement("b");
    b.textContent = "Открыто обращение №" + a.id;
    const h = document.createElement("span");
    h.className = "hint";
    h.textContent = "Пока поддержка его не закрыла, пишите в него — второе открыть нельзя.";
    const go = document.createElement("button");
    go.className = "btn primary wide";
    go.textContent = "Перейти к обращению";
    go.addEventListener("click", () => openTicket(a.id));
    note.append(b, h, go);
  }
  for (const t of supTickets) {
    const [label, tone] = supStatus(t);
    const row = document.createElement("button");
    row.className = "sup-ticket" + (t.status === "closed" ? " closed" : "") + (unreadOf(t) ? " unread" : "");
    const top = document.createElement("span");
    top.className = "st-top";
    const title = document.createElement("b");
    title.textContent = t.title || "Обращение";
    const badge = document.createElement("span");
    badge.className = "sup-badge " + tone;
    badge.textContent = label;
    top.append(title, badge);
    const last = document.createElement("span");
    last.className = "st-last";
    const lm = t.last_message;
    last.textContent = lm ? (lm.is_from_admin ? "Поддержка: " : "Вы: ")
      + (supVisible(lm.message_text).replace(/\s+/g, " ").trim() || (lm.has_media ? "вложение" : "…")) : "";
    const meta = document.createElement("span");
    meta.className = "st-meta";
    meta.textContent = "№" + t.id + " · " + supTime(t.updated_at || t.created_at)
      + (t.messages_count ? " · сообщений: " + t.messages_count : "");
    row.append(top, last, meta);
    if (unreadOf(t)) {
      const dot = document.createElement("span");
      dot.className = "dot live st-dot";
      row.append(dot);
    }
    row.addEventListener("click", () => openTicket(t.id));
    box.append(row);
  }
}

async function openTicket(id) {
  supTicket = supTicket && supTicket.id === id ? supTicket : { id, title: "", status: "", messages: [] };
  el("sup-status").textContent = "";
  supGo("thread");
  try {
    supTicket = await apiOk("GET", "/tickets/" + id);
    markSeen(supTicket);
    renderThread();
    paintSupportDot();
  } catch (e) { el("sup-t-meta").textContent = "не загрузилось: " + errText(e); }
}

function renderThread(pending) {
  const t = supTicket || {};
  const [label, tone] = supStatus(t);
  el("sup-t-title").textContent = t.title || "Обращение";
  const badge = el("sup-t-status");
  badge.textContent = label;
  badge.className = "sup-badge " + tone;
  el("sup-t-meta").textContent = t.id ? "№" + t.id + (t.created_at ? " · создано " + supTime(t.created_at) : "")
    + (t.closed_at ? " · закрыто " + supTime(t.closed_at) : "") : "";
  const list = el("sup-list");
  list.textContent = "";
  const msgs = (t.messages || []).slice();
  if (pending) msgs.push({ id: "p", is_from_admin: false, message_text: pending, pending: true });
  for (const m of msgs) {
    const b = document.createElement("div");
    b.className = "sup-msg " + (m.is_from_admin ? "out" : "in") + (m.pending ? " pending" : "");
    if (m.is_from_admin) {
      const who = document.createElement("b");
      who.textContent = "Поддержка";
      b.append(who);
    }
    b.append(document.createTextNode(supVisible(m.message_text) || (m.has_media ? "[вложение — откройте в боте]" : "")));
    const tm = document.createElement("time");
    tm.textContent = (m.pending ? "отправляю…" : supTime(m.created_at))
      + (m.has_media && !m.is_from_admin && m.media_type === "document" ? " · 📎 журнал приложен" : "");
    b.append(tm);
    list.append(b);
  }
  const closed = t.status === "closed";
  el("sup-closed").hidden = !closed;
  el("sup-reply").hidden = closed || !t.status;
  el("sup-closed").querySelector("[data-sup-new]").hidden = !!supActive();
  if (!closed && t.is_reply_blocked) {
    el("sup-reply").hidden = true;
    el("sup-closed").hidden = false;
    el("sup-closed").querySelector("b").textContent = "Ответы временно ограничены";
  } else {
    el("sup-closed").querySelector("b").textContent = "Обращение закрыто";
  }
  const pane = el("view-support");
  if (pane && !pending) requestAnimationFrame(() => { pane.scrollTop = pane.scrollHeight; });
}

function renderNew() {
  for (const b of document.querySelectorAll("#sup-cats [data-cat]")) b.classList.toggle("on", b.dataset.cat === supCat);
  el("sup-new-status").textContent = "";
}

// «+ Новое обращение»: есть незакрытое — оно и есть место для нового вопроса
function supNew(text) {
  show("support");
  if (supTabNow !== "chat") supTab("chat");
  const a = supActive();
  if (a) {
    openTicket(a.id);
    if (text) { el("sup-text").value = text; el("sup-r-diag").checked = true; }
    say("у вас уже открыто обращение №" + a.id + " — пишите в него");
    return;
  }
  supGo("new");
  if (text) el("sup-new-text").value = text;
  el("sup-new-text").focus();
}

/* ── данные ───────────────────────────────────────────────────────────────── */

async function supLoadList() {
  const r = await apiOk("GET", "/tickets?page=1&per_page=50");
  supTickets = (r && r.items || []).slice()
    .sort((a, b) => (a.status === "closed") - (b.status === "closed")
      || String(b.updated_at).localeCompare(String(a.updated_at)));
  supLoaded = true;
  // первый запуск 2.1: прошлые закрытые обращения не светим «новыми» — до 2.1
  // их ответы человек видел в общем чате
  if (prefs.supSeen == null) {
    const seen = {};
    for (const t of supTickets) if (t.status === "closed" && lastAdminOf(t)) seen[t.id] = lastAdminOf(t);
    savePrefs({ supSeen: seen });
  }
  return supTickets;
}

async function supRefresh(background) {
  if (!logged()) { supTickets = []; supTicket = null; paintSupportDot(); return; }
  const notifiedBefore = prefs.supportNotified;
  try {
    await supLoadList();
    const here = view === "support" && supTabNow === "chat";
    if (here && supScreen === "thread" && supTicket && supTicket.id) {
      const t = await apiOk("GET", "/tickets/" + supTicket.id);
      const grew = (t.messages || []).length !== (supTicket.messages || []).length || t.status !== supTicket.status;
      supTicket = t;
      markSeen(t);
      if (grew) renderThread();
    } else if (here && supScreen === "home") {
      renderTickets();
    }
    // уведомление о новом ответе — по самому свежему ответу поддержки
    const maxAdmin = supTickets.reduce((m, t) => Math.max(m, lastAdminOf(t)), 0);
    if (notifiedBefore == null) {
      savePrefs({ supportNotified: maxAdmin });            // первый запуск: старые ответы не звоним
    } else if (maxAdmin > notifiedBefore) {
      savePrefs({ supportNotified: maxAdmin });
      const t = supTickets.find((x) => lastAdminOf(x) === maxAdmin);
      if (background && t && unreadOf(t)) {
        const last = supVisible(t.last_message && t.last_message.message_text) || "новое сообщение";
        invoke("notify", { title: "ВПНушка · ответ по обращению №" + t.id,
                           body: last.length > 140 ? last.slice(0, 140) + "…" : last }).catch(() => {});
      }
    }
    paintSupportDot();
  } catch (_) { /* тихо: в фоне сеть бывает недоступна */ }
  supSchedule();
}

function supSchedule() {
  clearInterval(supTimer);
  if (!logged()) return;
  const here = view === "support" && supTabNow === "chat";
  const ms = here ? (supScreen === "thread" ? 5000 : 15000) : supActive() ? 90000 : 0;
  if (ms) supTimer = setInterval(() => supRefresh(!here), ms);
}

// вызывает show() из app.js при каждой смене раздела
function supportViewChanged(v) {
  if (v === "support") {
    // журнал файлом умеет нативная часть с 2.0.0 — у старой остаётся хвост в тексте
    const fileLog = nativeAtLeast("2.0.0");
    el("sup-log-row").style.display = fileLog ? "" : "none";
    el("sup-diag-sub").textContent = fileLog ? "версия, система, сервер и подписка — текстом в сообщении"
      : "версия, система, сервер и последние строки журнала — так быстрее разобраться";
    supTab(supUnread() ? "chat" : supTabNow);   // новый ответ — сразу к обращениям
    if (supUnread() && supScreen !== "thread") supGo("home");
  }
  supSchedule();
}

/* ── сведения и журнал ────────────────────────────────────────────────────── */

async function supDiag() {
  const os = el("about-os").textContent || T.platform || "";
  const lines = [
    "Приложение: " + (el("about-ver").textContent || nativeVer || "?") + (os ? " · " + os : ""),
    "Сервер: " + (liveExit || current || "—") + (state === "on" ? " · подключено" : state === "connecting" ? " · подключается" : " · отключено"),
    "Режим: " + (ROUTE_MODES[prefs.routeMode || "Global"] || "—") + (prefs.mode === "proxy" ? " · прокси" : ""),
  ];
  const s = typeof accData !== "undefined" ? accData.sub : null;
  if (s) lines.push("Подписка: " + (s.is_active ? "до " + ddmmyyyy(s.end_date) : s.status)
    + (s.traffic_limit_gb ? " · " + (s.traffic_used_gb || 0).toFixed(1) + "/" + s.traffic_limit_gb + " ГБ" : ""));
  let log = [];
  try { log = await invoke("engine_log"); } catch (_) {}
  return { head: lines.join("\n"), log: log.slice(-40).map((l) => (l.length > 160 ? l.slice(0, 160) + "…" : l)) };
}

// Журнал файлом: шапка сведений + весь журнал этого запуска (до 2 МБ — лимит
// бота 10 МБ, а поддержке хватит и хвоста). → {media_type, media_file_id} или null.
async function supLogFile() {
  if (!(el("sup-log-row").style.display !== "none" && el("sup-log").checked)) return null;
  const d = await supDiag();
  let log = [];
  try { log = await invoke("engine_log"); } catch (_) {}
  let text = "ВПНушка — журнал подключения\n" + new Date().toISOString() + "\n" + d.head + "\n\n" + log.join("\n");
  if (text.length > 2e6) text = text.slice(0, 2000) + "\n…\n" + text.slice(-1.9e6);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const r = await apiOk("POST", "/media/upload", null,
    { fields: { media_type: "document" }, filename: "vpnushka-log-" + stamp + ".txt", text });
  return r && r.file_id ? { media_type: "document", media_file_id: r.file_id } : null;
}

// Текст + сведения, не длиннее лимита бота: журнал обрезаем с начала.
async function supCompose(text, diag, withLog) {
  if (!diag) return text.slice(0, SUP_TEXT_MAX);
  const d = await supDiag();
  if (!withLog) d.log = [];
  let body = "";
  for (let n = d.log.length; n >= 0; n -= 5) {
    body = text + SUP_DIAG_MARK + d.head + (n ? "\nЖурнал:\n" + d.log.slice(-n).join("\n") : "");
    if (body.length <= SUP_TEXT_MAX) return body;
  }
  return text.slice(0, SUP_TEXT_MAX);
}

/* ── отправка ─────────────────────────────────────────────────────────────── */

async function supCreate() {
  const box = el("sup-new-text");
  const text = box.value.trim();
  const status = el("sup-new-status");
  if (!supCat) { status.textContent = "Выберите тему — так обращение быстрее попадёт к нужному человеку."; return; }
  if (text.length < 3) { status.textContent = "Опишите, что случилось, хотя бы парой слов."; return; }
  if (supBusy) return;
  supBusy = true;
  el("sup-create").disabled = true;
  status.textContent = "отправляю…";
  try {
    let media = null;
    try { media = await supLogFile(); } catch (e) {
      status.textContent = "Журнал не приложился (" + errText(e) + ") — отправляю последние строки текстом.";
    }
    const message = await supCompose(text, el("sup-diag").checked, !media);
    const body = media ? { message, ...media } : { message };
    let t;
    try {
      t = await apiOk("POST", "/tickets", { title: supCat, ...body });
    } catch (e) {
      if (e.status !== 409) throw e;
      // открытое уже есть (например, из бота) — дописываем в него
      await supLoadList();
      const a = supActive();
      if (!a) throw e;
      await apiOk("POST", "/tickets/" + a.id + "/messages", body);
      t = a;
      say("у вас уже было открыто обращение №" + a.id + " — сообщение добавлено в него");
    }
    box.value = "";
    supCat = "";
    await supLoadList();
    await openTicket(t.id);
    el("sup-status").textContent = "Отправлено. Ответ придёт сюда, в бот и уведомлением.";
  } catch (e) {
    status.textContent = "Не отправилось: " + errText(e) + ". Можно написать в Telegram — кнопка ниже.";
  } finally {
    supBusy = false;
    el("sup-create").disabled = false;
  }
}

async function supSend() {
  const box = el("sup-text");
  const text = box.value.trim();
  if (!text || supBusy || !supTicket || supTicket.status === "closed") return;
  supBusy = true;
  el("sup-send").disabled = true;
  el("sup-status").textContent = "";
  renderThread(text);
  try {
    const message = await supCompose(text, el("sup-r-diag").checked, true);
    await apiOk("POST", "/tickets/" + supTicket.id + "/messages", { message });
    box.value = "";
    el("sup-r-diag").checked = false;
    supTicket = await apiOk("GET", "/tickets/" + supTicket.id);
    await supLoadList().catch(() => {});
    el("sup-status").textContent = "Отправлено. Ответ придёт сюда, в бот и уведомлением.";
  } catch (e) {
    el("sup-status").textContent = e.status === 400
      ? "Обращение уже закрыто — создайте новое."
      : "Не отправилось: " + errText(e) + ". Можно написать в Telegram — кнопка ниже.";
    if (e.status === 400) supTicket = await apiOk("GET", "/tickets/" + supTicket.id).catch(() => supTicket);
  } finally {
    supBusy = false;
    el("sup-send").disabled = false;
    renderThread();
    supSchedule();
  }
}

on(el("sup-send"), "click", supSend);
on(el("sup-create"), "click", supCreate);
on(el("sup-text"), "keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); supSend(); }
});
on(el("sup-new-text"), "keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); supCreate(); }
});
document.querySelectorAll("#sup-cats [data-cat]").forEach((b) => on(b, "click", () => {
  supCat = b.dataset.cat;
  renderNew();
}));
document.querySelectorAll("[data-sup-new]").forEach((b) => on(b, "click", () => supNew()));
document.querySelectorAll("[data-sup-home]").forEach((b) => on(b, "click", () => { supGo("home"); supRefresh(false); }));
on(el("sup-tg"), "click", () => invoke("open_url", { url: SUP_TG }).catch((e) => say(errText(e), true)));
on(el("sup-login-btn"), "click", () => show("account"));
on(el("faq-open"), "click", () => { show("support"); supTab("faq"); });
document.querySelectorAll("#sup-tabs [data-sup]").forEach((b) => on(b, "click", () => supTab(b.dataset.sup)));
document.querySelectorAll("[data-sup-go]").forEach((b) => on(b, "click", () => supTab(b.dataset.supGo)));
document.querySelectorAll("[data-sup-go-view]").forEach((b) => on(b, "click", () => show(b.dataset.supGoView)));

(async () => {
  for (let i = 0; i < 50 && !(prefs && Object.keys(prefs).length); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  setTimeout(() => supRefresh(true), 10000);
})();
