// Поддержка прямо в приложении — на тикетах бота (Bedolaga, API кабинета
// /tickets). Своего сервера нет: обращение создаётся тем же входом, что и
// кабинет, бот сам шлёт админам «🎫 НОВЫЙ ТИКЕТ» с кнопкой «Ответить», ответ
// виден и в приложении, и в боте, и в кабинете.
//
// У бота один незакрытый тикет на человека — его и показываем как «разговор».
// Закрыли — следующее сообщение открывает новый. Ответы забираем опросом:
// раз в 5 с, пока раздел открыт, и раз в 1,5 мин в фоне, пока тикет открыт;
// о новом ответе — системное уведомление и точка на кнопке «Поддержка».
// Без входа в кабинет — только кнопка Telegram @vpnushka_manager.
// С 2.0.0: вкладки «Вопросы · Тарифы · Чат» (faq.js), кнопка в шапке окна и
// журнал подключения отдельным файлом (/media/upload → document в тикете).
//
// Грузится после app.js (el, on, show, view, prefs, savePrefs, invoke, say)
// и account.js (acc, accData, apiOk, ddmmyyyy, errText).

const SUP_TG = "https://t.me/vpnushka_manager";
const SUP_TEXT_MAX = 4000;
let supTicket = null;     // TicketDetailResponse
let supTimer = 0;
let supBusy = false;

const supOpen = () => supTicket && supTicket.status !== "closed";
const supLastAdmin = (t) => (t && t.messages || []).reduce((m, x) => (x.is_from_admin ? Math.max(m, x.id) : m), 0);

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

function renderSupport(pending) {
  const logged = typeof acc !== "undefined" && !!acc;
  el("sup-login").style.display = logged ? "none" : "";
  el("sup-form-in").style.display = logged ? "" : "none";
  const list = el("sup-list");
  list.querySelectorAll(".sup-msg, .sup-sys").forEach((n) => n.remove());
  const msgs = (supTicket && supTicket.messages || []).slice();
  if (pending) msgs.push({ id: "p", is_from_admin: false, message_text: pending, pending: true });
  el("sup-empty").style.display = logged && !msgs.length ? "" : "none";
  for (const m of msgs) {
    const b = document.createElement("div");
    b.className = "sup-msg " + (m.is_from_admin ? "out" : "in") + (m.pending ? " pending" : "");
    if (m.is_from_admin) {
      const who = document.createElement("b");
      who.textContent = "Поддержка";
      b.append(who);
    }
    b.append(document.createTextNode(supVisible(m.message_text) || (m.has_media ? "[вложение — откройте в боте]" : "")));
    const t = document.createElement("time");
    t.textContent = (m.pending ? "отправляю…" : supTime(m.created_at))
      + (m.has_media && !m.is_from_admin && m.media_type === "document" ? " · 📎 журнал приложен" : "");
    b.append(t);
    list.append(b);
  }
  if (supTicket && !pending) {
    const sys = supTicket.status === "closed" ? "Обращение закрыто. Новое сообщение откроет новое обращение."
      : supTicket.is_reply_blocked ? "Ответы в этом обращении временно ограничены поддержкой." : "";
    if (sys) {
      const s = document.createElement("div");
      s.className = "sup-sys hint";
      s.textContent = sys;
      list.append(s);
    }
  }
  const pane = el("view-support");
  if (pane && supTabNow === "chat") pane.scrollTop = pane.scrollHeight;
}

const supUnread = () => supLastAdmin(supTicket) > (prefs.supportSeen || 0);

function paintSupportDot() {
  const on = supUnread() ? "" : "none";
  for (const id of ["sup-dot", "sup-dot-tb", "sup-dot-tab"]) if (el(id)) el(id).style.display = on;
}

let supTabNow = "faq";
function supTab(name) {
  supTabNow = name;
  for (const b of document.querySelectorAll("#sup-tabs [data-sup]")) b.classList.toggle("on", b.dataset.sup === name);
  for (const n of ["faq", "prices", "chat"]) el("sup-" + n).hidden = n !== name;
  if (name === "chat") {
    renderSupport();
    if (supTicket) savePrefs({ supportSeen: supLastAdmin(supTicket) });
    paintSupportDot();
  }
  const pane = el("view-support");
  if (pane) pane.scrollTop = name === "chat" ? pane.scrollHeight : 0;
}

// Самый свежий тикет: незакрытый, если есть, иначе последний закрытый (чтобы
// человек видел ответ на прошлое обращение).
async function supLoad() {
  const r = await apiOk("GET", "/tickets?page=1&per_page=10");
  const items = (r && r.items || []).slice().sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  const pick = items.find((t) => t.status !== "closed") || items[0];
  supTicket = pick ? await apiOk("GET", "/tickets/" + pick.id) : null;
  return supTicket;
}

async function supPoll(background) {
  if (typeof acc === "undefined" || !acc) { supTicket = null; paintSupportDot(); return; }
  const before = supLastAdmin(supTicket) || prefs.supportSeen || 0;
  try {
    const t = supTicket && supOpen() ? (supTicket = await apiOk("GET", "/tickets/" + supTicket.id)) : await supLoad();
    if (!t) return;
    const fresh = (t.messages || []).filter((m) => m.is_from_admin && m.id > before);
    if (view === "support" && supTabNow === "chat") {
      renderSupport();
      savePrefs({ supportSeen: supLastAdmin(t) });
    } else if (prefs.supportNotified == null) {
      savePrefs({ supportNotified: supLastAdmin(t) });   // первый запуск: старые ответы не звоним
    } else if (background && fresh.length && supLastAdmin(t) > prefs.supportNotified) {
      savePrefs({ supportNotified: supLastAdmin(t) });
      const last = supVisible(fresh[fresh.length - 1].message_text) || "новое сообщение";
      invoke("notify", { title: "ВПНушка · поддержка", body: last.length > 140 ? last.slice(0, 140) + "…" : last })
        .catch(() => {});
    }
    paintSupportDot();
  } catch (_) { /* тихо: в фоне сеть бывает недоступна */ }
  supSchedule();
}

function supSchedule() {
  clearInterval(supTimer);
  if (typeof acc === "undefined" || !acc) return;
  const open = view === "support";
  if (open || supOpen()) supTimer = setInterval(() => supPoll(!open), open ? 5000 : 90000);
}

// вызывает show() из app.js при каждой смене раздела
function supportViewChanged(v) {
  if (v === "support") {
    // журнал файлом умеет нативная часть с 2.0.0 — у старой остаётся хвост в тексте
    const fileLog = nativeAtLeast("2.0.0");
    el("sup-log-row").style.display = fileLog ? "" : "none";
    el("sup-diag-sub").textContent = fileLog ? "версия, система, сервер и подписка — текстом в сообщении"
      : "версия, система, сервер и последние строки журнала — так быстрее разобраться";
    supTab(supUnread() ? "chat" : supTabNow);   // новый ответ — сразу в переписку
    supPoll(false);
  }
  supSchedule();
}

async function supDiag() {
  const os = el("about-os").textContent || T.platform || "";
  const lines = [
    "Приложение: " + (el("about-ver").textContent || nativeVer || "?") + (os ? " · " + os : ""),
    "Сервер: " + (liveExit || current || "—") + (state === "on" ? " · подключено" : state === "connecting" ? " · подключается" : " · отключено"),
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

// Текст + диагностика, не длиннее лимита бота: журнал обрезаем с начала.
// withLog=false — журнал уже уходит файлом, в тексте только сведения.
async function supCompose(text, withLog) {
  if (!el("sup-diag").checked) return text.slice(0, SUP_TEXT_MAX);
  const d = await supDiag();
  if (withLog === false) d.log = [];
  let body = "";
  for (let n = d.log.length; n >= 0; n -= 5) {
    body = text + SUP_DIAG_MARK + d.head + (n ? "\nЖурнал:\n" + d.log.slice(-n).join("\n") : "");
    if (body.length <= SUP_TEXT_MAX) return body;
  }
  return text.slice(0, SUP_TEXT_MAX);
}

function supTitle(text) {
  const first = text.split("\n")[0].trim();
  const t = first.length > 60 ? first.slice(0, 57) + "…" : first;
  return t.length >= 3 ? t : "Обращение из приложения";
}

async function supSend() {
  const box = el("sup-text");
  const text = box.value.trim();
  if (!text || supBusy) return;
  supBusy = true;
  el("sup-send").disabled = true;
  el("sup-status").textContent = "";
  renderSupport(text);
  try {
    let media = null;
    try { media = await supLogFile(); } catch (e) {
      el("sup-status").textContent = "Журнал не приложился (" + errText(e) + ") — отправляю последние строки текстом.";
    }
    const message = await supCompose(text, !media);
    const body = media ? { message, ...media } : { message };
    if (!supOpen()) await supLoad().catch(() => {});   // вдруг тикет открыт из бота
    if (supOpen()) {
      await apiOk("POST", "/tickets/" + supTicket.id + "/messages", body);
    } else {
      try {
        await apiOk("POST", "/tickets", { title: supTitle(text), ...body });
      } catch (e) {
        if (e.status !== 409) throw e;                 // уже есть открытый — пишем в него
        await supLoad();
        await apiOk("POST", "/tickets/" + supTicket.id + "/messages", body);
      }
    }
    box.value = "";
    await supLoad();
    el("sup-diag").checked = false;   // журнал нужен один раз на обращение
    el("sup-log").checked = false;
    el("sup-status").textContent = "Отправлено. Ответ придёт сюда, в бот и уведомлением.";
  } catch (e) {
    el("sup-status").textContent = "Не отправилось: " + errText(e) + ". Можно написать в Telegram — кнопка ниже.";
  } finally {
    supBusy = false;
    el("sup-send").disabled = false;
    renderSupport();
    supSchedule();
  }
}

on(el("sup-send"), "click", supSend);
on(el("sup-text"), "keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); supSend(); }
});
on(el("sup-tg"), "click", () => invoke("open_url", { url: SUP_TG }).catch((e) => say(errText(e), true)));
on(el("sup-login-btn"), "click", () => show("account"));
document.querySelectorAll("#sup-tabs [data-sup]").forEach((b) => on(b, "click", () => supTab(b.dataset.sup)));
document.querySelectorAll("[data-sup-go]").forEach((b) => on(b, "click", () => supTab(b.dataset.supGo)));
document.querySelectorAll("[data-sup-go-view]").forEach((b) => on(b, "click", () => show(b.dataset.supGoView)));

(async () => {
  for (let i = 0; i < 50 && !(prefs && Object.keys(prefs).length); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  setTimeout(() => supPoll(true), 10000);
})();
