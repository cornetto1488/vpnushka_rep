// VPNUSHKA desktop — the whole UI over two things: the Rust backend (profile,
// preferences, advanced settings, engine control) and sing-box's Clash API
// (live server list, live switching, traffic counters).
//
// Disconnected, the server list comes from the subscription (ofx-connect
// -list); connected, it comes from the Clash API on 127.0.0.1:9090, so
// switching a server is instant and needs no reconnect.
const T = window.__TAURI__ || {};
const invoke = T.core?.invoke ?? (async () => { throw new Error("нет связи с приложением"); });
const listen = T.event?.listen;
const appWindow = T.window?.getCurrentWindow?.();
const CLASH = "http://127.0.0.1:9090";
// The same UI runs in the Android app (android/) and on iPhone (ios/):
// android.js / ios.js build this __TAURI__ over the native bridge and say so
// here. Both are phones: no windows, no per-program rules, no silent updates.
const IS_ANDROID = T.platform === "android" || T.platform === "ios";
// ПК — горизонтальное окно со своей раскладкой (style.css, html.pc)
document.documentElement.classList.toggle("pc", !IS_ANDROID);
// Компактный вид везде (ПК и телефоны): разделы открываются из заголовка,
// нижних вкладок нет (style.css). Кнопки окна телефоны прячут сами.
document.documentElement.classList.add("desk");

const el = (id) => document.getElementById(id);
const on = (node, ev, fn) => node && node.addEventListener(ev, fn);

let state = "off";          // off | connecting | on
let prefs = {};             // persisted in the backend (settings.json)
let tweaks = {};            // persisted in the backend (tweaks.json = engine input)
let profile = null;         // {name, hasToken, sub, hasDoc, doc}
let servers = [];           // [{name, delay, pinged, pinging}]
let info = {};              // name -> {desc, type}
let current = null;         // chosen server tag
let selectorName = null;    // live sing-box selector tag, when connected
let since = 0;              // connected-at, for the session timer
let liveType = {};          // name -> Clash API type (URLTest = автовыбор), when connected
let autoRetry = 0, autoTimer = null, watchFails = 0;   // Auto: попытки переподключения
let stats = { down: 0, up: 0, dRate: 0, uRate: 0, at: 0 };
let ruleKind = "apps";
let ruleVerdict = "proxy";

const VERDICTS = { proxy: "Через VPN", direct: "Мимо VPN", block: "Блокировать" };
const ROUTE_MODES = { Rule: "Фирменный пресет", Global: "Всё через VPN", Direct: "Напрямую" };
// Что писать в «Исключениях» при каждом режиме — иначе кажется, будто правило
// нужно заводить на каждую программу.
const RULE_HINTS = {
  Global: "Сейчас в тоннеле всё. Добавляйте сюда только то, что должно ходить МИМО VPN — "
        + "банк-клиент, госуслуги, игры.",
  Rule:   "Сейчас работает фирменный пресет. Добавляйте сюда то, что он не покрывает: "
        + "«через VPN» — если сайт не открывается, «мимо VPN» — если наоборот тормозит.",
  Direct: "Сейчас трафик идёт мимо тоннеля. Добавляйте сюда то, что должно ходить ЧЕРЕЗ VPN — "
        + "остальное останется напрямую.",
};
// Человеческие имена списков, которые отдаёт подписка.
const SET_NAMES = {
  "ru-bundle": "зарубежные сервисы",
  "geosite-telegram": "Telegram", "geoip-telegram": "Telegram",
  "geosite-whatsapp": "WhatsApp", "geosite-tiktok": "TikTok",
  "discord-voice-ip-list": "Discord", "viber_aws_ip": "Viber",
};
const setNames = (list) => [...new Set((list || []).map((t) => SET_NAMES[t] || t))].join(", ");
let baseline = null;   // что маршрутизирует сама подписка

/* ── helpers ─────────────────────────────────────────────────────────────── */

let toastTimer = 0;
function say(msg, isErr) {
  const t = el("toast");
  if (!msg) { t.className = "toast"; return; }
  t.textContent = msg;
  t.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = "toast"; }, isErr ? 9000 : 3800);
}
const errText = (e) => String(e && e.message ? e.message : e).replace(/^Error:\s*/, "");

function bytes(n) {
  if (!n) return "0 Б";
  const u = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (n < 10 && i ? n.toFixed(1) : Math.round(n)) + " " + u[i];
}
function rate(n) {
  if (!n) return "0 Кб/с";
  const bits = n * 8;
  if (bits < 1e6) return Math.round(bits / 1e3) + " Кбит/с";
  return (bits / 1e6).toFixed(bits < 1e7 ? 1 : 0) + " Мбит/с";
}
// The panel names servers "🇳🇱 Нидерланды · Основной" — the flag is already there.
function flagOf(name) {
  const m = (name || "").match(/\p{Regional_Indicator}\p{Regional_Indicator}/u);
  if (m) return m[0];
  if (isOfx(name)) return "📱";
  if (/auto|авто/i.test(name || "")) return "⚡️";
  return "🌐";
}
// Windows has no flag glyphs in its emoji font: "🇳🇱" renders as the letters
// "NL". So country flags are drawn from bundled SVGs (flags/<cc>.svg, the
// flag-icons set), and everything else stays an emoji.
const GLYPH = {
  mobile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M5 19v-3M10 19v-6M15 19V9M20 19V5"/></svg>',
  auto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.6 2.4 14.4 0 17M12 3.5c-2.4 2.6-2.4 14.4 0 17"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 5 6v5.5c0 4.3 3 7.7 7 9 4-1.3 7-4.7 7-9V6l-7-3Z"/></svg>',
  compass: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="m15.5 8.5-2.2 4.8-4.8 2.2 2.2-4.8 4.8-2.2Z"/></svg>',
};

function paintFlag(node, name) {
  const f = flagOf(name);
  const cc = [...f].map((ch) => ch.codePointAt(0) - 0x1F1E6);
  node.textContent = "";
  if (cc.length === 2 && cc.every((n) => n >= 0 && n < 26)) {
    const img = document.createElement("img");
    img.src = "flags/" + String.fromCharCode(97 + cc[0], 97 + cc[1]) + ".svg";
    img.alt = f;
    img.onerror = () => { node.textContent = f; };
    node.appendChild(img);
    node.classList.remove("glyph");
  } else {
    node.innerHTML = isOfx(name) ? GLYPH.mobile : /auto|авто/i.test(name || "") ? GLYPH.auto : GLYPH.globe;
    node.classList.add("glyph");
  }
}
// the flag is drawn separately, so it is stripped off the label here
const cleanName = (n) =>
  (n || "").replace(/^[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u200D\s]+/u, "").trim() || (n || "");
// канал OpenFlux; в панели он называется «📱 Мобильные операторы»
const isOfx = (n) => /openflux|мобильн/i.test(n || "");
const byName = (n) => servers.find((s) => s.name === n);

async function clash(path, opts) {
  const r = await fetch(CLASH + path, opts);
  if (!r.ok) throw new Error("clash " + r.status);
  return r.status === 204 ? null : r.json();
}

/* ── views ───────────────────────────────────────────────────────────────── */

// На ПК нет нижних вкладок: раздел открывается из заголовка, «назад» ведёт к
// родителю (правила и канал живут внутри настроек).
const VIEW_TITLES = { servers: "Серверы", channel: "Мобильные операторы", rules: "Маршрутизация",
                      account: "Кабинет", more: "Настройки", news: "Новости", invite: "Пригласи друга",
                      support: "Поддержка" };
const VIEW_PARENT = { rules: "more", channel: "more", news: "home", invite: "account", support: "more" };
const TABS = ["home", "servers", "account", "more"];
let view = "home";
let cameFrom = "more";   // вложенный раздел (правила, канал) открыт из настроек или из серверов

function show(next) {
  if (!TABS.includes(next) && TABS.includes(view)) cameFrom = view;
  view = next;
  document.documentElement.dataset.view = view;
  el("tb-title").textContent = VIEW_TITLES[view] || "";
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("on", v.id === "view-" + view));
  const tab = TABS.includes(view) ? view : cameFrom;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === tab));
  const pane = el("view-" + view);
  if (pane && pane.scrollTop) pane.scrollTop = 0;
  if (view === "servers") renderList();
  if (view === "home" && typeof fitHero === "function") fitHero();
  if (view === "more") { loadLog(); loadSubInfo(); }
  if (view === "rules") renderRules();
  if (view === "news" && typeof openNewsView === "function") openNewsView();
  if (view === "invite" && typeof openInvite === "function") openInvite();
  if (typeof supportViewChanged === "function") supportViewChanged(view);
}
document.querySelectorAll("#tabs button").forEach((b) => on(b, "click", () => show(b.dataset.view)));
const goBack = () => show(TABS.includes(view) ? "home" : (cameFrom || VIEW_PARENT[view] || "home"));
document.querySelectorAll("[data-back]").forEach((b) => on(b, "click", goBack));
// щипок на iPhone (WKWebView) — не масштабировать интерфейс
["gesturestart", "gesturechange"].forEach((ev) => document.addEventListener(ev, (e) => e.preventDefault(), { passive: false }));
// главная прокручена — заголовок перестаёт быть прозрачным, чтобы текст не просвечивал
on(el("view-home"), "scroll", () => {
  document.documentElement.classList.toggle("home-scrolled", el("view-home").scrollTop > 120);
}, { passive: true });
// системная «Назад» на Android: false — уже на главной, пусть сворачивает
window.__ofxViewBack = () => { if (view === "home") return false; goBack(); return true; };
on(el("tb-back"), "click", goBack);
on(el("win-acc"), "click", () => show(view === "account" ? "home" : "account"));
on(el("win-more"), "click", () => show(view === "more" ? "home" : "more"));
document.querySelectorAll("[data-go]").forEach((b) => on(b, "click", () => show(b.dataset.go)));
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || view === "home") return;
  if (document.querySelector(".sheet.open")) return;   // шторку закрывает её крестик
  goBack();
});

// Окно фиксированного размера. Штатная drag-область Tauri по двойному клику
// разворачивает окно — поэтому тащим сами и двойной клик глушим; масштаб
// (Ctrl+колесо, Ctrl +/−/0) тоже выключен.
if (!IS_ANDROID) {
  on(el("titlebar"), "mousedown", (e) => {
    if (e.button !== 0 || e.target.closest("button")) return;
    e.preventDefault();
    if (e.detail === 1 && appWindow) appWindow.startDragging().catch(() => {});
  });
  on(el("titlebar"), "dblclick", (e) => e.preventDefault());
  window.addEventListener("wheel", (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && ["+", "=", "-", "_", "0"].includes(e.key)) e.preventDefault();
    if (e.key === "F11") e.preventDefault();
  });
}

on(el("win-min"), "click", () => invoke("minimize_window").catch(() => appWindow && appWindow.minimize()));
on(el("win-close"), "click", async () => {
  if (prefs.trayOnClose === false) { await invoke("quit_app").catch(() => {}); return; }
  invoke("hide_window").catch(() => {});
});
// В шапке — поддержка (2.0.0); тема переехала в Настройки → Оформление.
on(el("win-support"), "click", () => show("support"));
document.querySelectorAll("[data-theme-pick]").forEach((b) =>
  on(b, "click", () => setTheme(b.dataset.themePick, true)));

function setTheme(theme, save) {
  document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
  document.querySelectorAll("[data-theme-pick]").forEach((b) =>
    b.classList.toggle("on", b.dataset.themePick === document.documentElement.dataset.theme));
  if (save) savePrefs({ theme: document.documentElement.dataset.theme });
}

/* ── connection state ────────────────────────────────────────────────────── */

// Заголовок поверх картины: при подключении — сервер, через который реально идёт
// трафик (при автовыборе — тот, что выбрал движок, а не слово «авто»)
let liveExit = "";          // имя сервера-выхода из Clash API
let liveExitAuto = false;   // выбран автовыбором

function paintHero() {
  const h = el("hero-head");
  if (state === "on") {
    const name = cleanName(liveExit || current || "");
    const i = name.indexOf(" · ");
    h.innerHTML = "";
    if (i > 0) {
      h.append(name.slice(0, i) + " ");
      const em = document.createElement("em"); em.textContent = name.slice(i + 3); h.append(em);
    } else {
      const em = document.createElement("em"); em.textContent = name || "Подключено"; h.append(em);
    }
  } else if (state === "connecting") {
    h.innerHTML = "Подключаю<em>…</em>";
  } else {
    h.innerHTML = "VPN <em>выключен</em>";
  }
  fitHero();
}

// Заголовок поверх картины — капслоком и крупно, но целыми словами: длинное
// имя сервера («Турция · Скоростной») уменьшает шрифт, пока каждое слово не
// влезет в строку и всё не уляжется максимум в две строки.
function fitHero() {
  const h = el("hero-head");
  if (!h) return;
  h.style.fontSize = "";
  if (!h.clientWidth) return;            // главная скрыта — подгоним, когда откроют
  const base = parseFloat(getComputedStyle(h).fontSize) || 36;
  const lineH = () => parseFloat(getComputedStyle(h).lineHeight) || base * 0.92;
  let size = base;
  for (let i = 0; i < 24 && size > 16; i++) {
    const tooWide = h.scrollWidth > h.clientWidth + 1;
    const tooTall = h.offsetHeight > lineH() * 2 + 2;
    if (!tooWide && !tooTall) break;
    size -= 1.5;
    h.style.fontSize = size + "px";
  }
}
window.addEventListener("resize", () => fitHero());
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => fitHero());

// Clash API: группа автовыбора (urltest) отвечает, кого выбрала сейчас (.now)
async function resolveExit() {
  if (state !== "on" || !current) { liveExit = ""; liveExitAuto = false; return; }
  let name = current, auto = false;
  try {
    for (let i = 0; i < 4; i++) {
      const p = await clash("/proxies/" + encodeURIComponent(name));
      if (!p || !p.now || !["URLTest", "Selector", "Fallback", "urltest", "selector"].includes(p.type)) break;
      if (/urltest|fallback/i.test(p.type)) auto = true;
      name = p.now;
    }
  } catch (_) { /* движок ещё не поднялся — покажем выбранный */ }
  if (name !== liveExit || auto !== liveExitAuto) { liveExit = name; liveExitAuto = auto; paintHero(); tick(); }
}
setInterval(() => { if (state === "on") resolveExit(); }, 15000);

/* ── проверка связи через выбранный выход (2.0.0) ─────────────────────────
   «Подключено» — только когда через сервер реально проходит запрос. Раньше
   хватало поднятого Clash API: при автовыборе группа ещё не нашла живой
   сервер, а приложение уже писало «подключено». Теперь: замер задержки через
   Clash API (группе — /group/…/delay, она заодно перевыберет лучший), пока
   не ответит; не ответил за 40 с — туннель держим, но честно пишем «нет
   связи с сервером» и перепроверяем в фоне. */
const PROBE_URL = "https://www.gstatic.com/generate_204";
let linkBad = false;          // туннель поднят, но выход не отвечает
let probeMsg = "";            // что сейчас делаем, пока подключаемся
let probeFails = 0;

async function probeExit() {
  let name = current, isGroup = false;
  const q = "?url=" + encodeURIComponent(PROBE_URL) + "&timeout=5000";
  try {
    for (let i = 0; i < 4 && name; i++) {
      const p = await clash("/proxies/" + encodeURIComponent(name));
      if (!p || !["URLTest", "Selector", "Fallback", "urltest", "selector"].includes(p.type)) break;
      if (/urltest|fallback/i.test(p.type)) {
        isGroup = true;
        // замер всей группы: она перевыберет живой сервер, если текущий умер
        await clash("/group/" + encodeURIComponent(name) + "/delay" + q).catch(() => null);
        const g = await clash("/proxies/" + encodeURIComponent(name)).catch(() => p);
        name = (g && g.now) || p.now;
        continue;
      }
      name = p.now;
    }
    if (!name) return { ok: false, isGroup };
    const r = await clash("/proxies/" + encodeURIComponent(name) + "/delay" + q);
    return { ok: !!(r && r.delay > 0), delay: r && r.delay, name, isGroup };
  } catch (_) {
    return { ok: false, name, isGroup };
  }
}

// Ждём рабочий выход до limitMs; true — нашёлся.
async function waitForExit(limitMs) {
  const until = Date.now() + limitMs;
  for (let n = 0; Date.now() < until; n++) {
    const r = await probeExit();
    if (r.ok) return true;
    probeMsg = r.isGroup ? "ищу рабочий сервер…" : "сервер не отвечает, пробую ещё…";
    tick();
    if ((await invoke("get_status").catch(() => "on")) === "off") return false;
    await new Promise((res) => setTimeout(res, n < 3 ? 1500 : 3000));
  }
  return false;
}

function setLinkBad(bad) {
  if (linkBad === bad) return;
  linkBad = bad;
  probeFails = 0;
  const tb = el("tb-state");
  if (state === "on") {
    tb.textContent = bad ? "нет связи с сервером" : "подключено";
    tb.className = "tb-state show" + (bad ? " warn" : " on");
  }
  document.documentElement.classList.toggle("link-bad", bad && state === "on");
  if (bad) say("сервер не отвечает — подождите или выберите другой в «Серверах»", true);
  tick();
}

// Пока подключено — раз в 45 с (при проблеме — раз в 10 с) проверяем связь.
let probeBusy = false;
setInterval(async () => {
  if (state !== "on" || probeBusy) return;
  if (!linkBad && Date.now() % 45000 >= 10000) return;
  probeBusy = true;
  try {
    const r = await probeExit();
    if (r.ok) { setLinkBad(false); resolveExit(); }
    else if (++probeFails >= 2) setLinkBad(true);
  } finally { probeBusy = false; }
}, 10000);

function setState(s) {
  state = s;
  document.documentElement.dataset.conn = s;
  if (s !== "on") { liveExit = ""; liveExitAuto = false; }
  paintHero();
  if (s === "on") resolveExit();
  el("power").className = "power " + s;
  el("power-label").textContent =
    s === "on" ? "VPN включён" : s === "connecting" ? "Подключаю…" : "VPN выключен";
  el("power").title =
    s === "on" ? "Нажмите, чтобы отключиться" : s === "connecting" ? "" : "Нажмите, чтобы подключиться";
  el("canvas").className = "canvas " + s;
  if (s !== "on") { linkBad = false; document.documentElement.classList.remove("link-bad"); }
  if (s !== "connecting") probeMsg = "";
  const tb = el("tb-state");
  tb.textContent = s === "on" ? (linkBad ? "нет связи с сервером" : "подключено") : s === "connecting" ? "подключение" : "";
  tb.className = "tb-state" + (s === "off" ? "" : " show") + (s === "on" ? (linkBad ? " warn" : " on") : "");
  if (s === "on") {
    if (!since) since = Date.now();
  } else {
    since = 0;
    stats = { down: 0, up: 0, dRate: 0, uRate: 0, at: 0 };
    el("m-down").textContent = rate(0);
    el("m-up").textContent = rate(0);
    resetSpark();
    el("chip-ip").className = "chip";
    el("chip-traffic").className = "chip";
    el("chip-proxy").className = "chip tap";
  }
  invoke("set_tray_state", { on: s === "on", server: current || "" }).catch(() => {});
  if (typeof paintGuest === "function") paintGuest();
  paintQuick();
  paintCurrent();
  tick();
}

function tick() {
  const sub = el("state-sub");
  if (state === "on" && since) {
    const t = Math.floor((Date.now() - since) / 1000);
    const hh = Math.floor(t / 3600);
    const mm = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
    const ss = String(t % 60).padStart(2, "0");
    el("m-time").textContent = (hh ? hh + ":" : "") + mm + ":" + ss;
    sub.textContent = linkBad ? "сервер не отвечает — подождите или выберите другой"
      : liveExitAuto ? "автовыбор: самый быстрый сейчас" : "сервер выбран вручную";
  } else if (state === "connecting") {
    sub.textContent = probeMsg || "пара секунд";
    el("m-time").textContent = "00:00";
  } else {
    el("m-time").textContent = "00:00";
    sub.textContent = profile && profile.sub ? "нажмите кнопку, чтобы подключиться" : "сначала войдите в кабинет";
  }
}
setInterval(tick, 1000);

on(el("power"), "click", () => toggleConnection());

async function toggleConnection() {
  if (state === "connecting") return;
  if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
  if (state === "on") {
    autoRetry = 0;
    setState("off");
    try { await invoke("disconnect"); } catch (e) { say(errText(e), true); }
    await loadServers();
    return;
  }
  if (guestExpired()) await endGuest("время временного доступа вышло");   // guest.js
  if (!profile || !profile.sub) {
    show("account");
    say("войдите в кабинет — подписка подключится сама (или вставьте ссылку в настройках)", true);
    return;
  }
  const guest = guestActive();
  setState("connecting");
  try {
    await invoke("connect", {
      fullTunnel: guest ? false : (prefs.routeMode || "Global") === "Global",
      server: guest ? null : current || null,
      mode: prefs.mode === "proxy" ? "proxy" : "tun",
    });
    let up = false;
    for (let i = 0; i < 90 && !up; i++) {      // the engine fetches the subscription first
      try { await clash("/proxies"); up = true; } catch { await new Promise((r) => setTimeout(r, 400)); }
      if ((await invoke("get_status")) === "off" && i > 4) break;   // it died on the way up
    }
    // Saying "connected" when the engine gave up leaves the customer browsing
    // on their real IP, so the truth is what the engine and its API report.
    if (!up || (await invoke("get_status")) !== "on") {
      try { await invoke("disconnect"); } catch (_) {}
      const why = await invoke("last_error").catch(() => "");
      throw new Error(why || "не удалось подключиться — подробности в журнале (Настройки → Журнал)");
    }
    const want = guest ? null : current;
    if (guest) await clash("/configs", { method: "PATCH", headers: { "content-type": "application/json" },
                                         body: JSON.stringify({ mode: "Rule" }) }).catch(() => {});
    else await applyRouteMode(prefs.routeMode || "Global", true);
    await loadServers();
    // ядро могло поднять прошлый выбор из своего кеша — ставим тот, что выбран
    if (want && selectorName && current !== want && byName(want) && !isOfx(want) === !isOfx(current)) {
      try {
        await clash("/proxies/" + encodeURIComponent(selectorName), {
          method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: want }),
        });
        current = want;
        paintCurrent(); renderList();
      } catch (_) {}
    }
    // «подключено» — только когда через выход прошёл запрос (канал
    // «Мобильные операторы» поднимается дольше — ему больше времени)
    probeMsg = "проверяю сервер…"; tick();
    const ok = await waitForExit(isOfx(current) ? 60000 : 40000);
    if ((await invoke("get_status").catch(() => "on")) === "off") throw new Error(
      (await invoke("last_error").catch(() => "")) || "соединение оборвалось при подключении");
    linkBad = !ok;
    setState("on");
    if (!ok) { linkBad = false; setLinkBad(true); }
    showEgress();
  } catch (e) {
    setState("off");
    if (!handleDeviceLimit(errText(e), true)) say(errText(e), true);   // devices.js
    loadLog();
  }
}

/* ── режим «Прокси»: адрес и проверка, что Windows его принял ────────────── */

const PROXY_ADDR = "127.0.0.1:10808";

// В режиме прокси в тоннель идут только те программы, что уважают системный
// прокси. Если Windows его не принял (политика домена, PAC-файл, вход под другой
// учёткой) — всё продолжает ходить напрямую, а выглядит это как «ничего не
// работает». Поэтому адрес показываем всегда: его можно вписать в программу
// руками, и это спасает даже когда системную настройку перебили.
async function showProxyChip() {
  const box = el("chip-proxy");
  if (prefs.mode !== "proxy" || state !== "on") { box.className = "chip tap"; return; }
  box.textContent = "";
  box.append("прокси ", Object.assign(document.createElement("b"), { textContent: PROXY_ADDR }));
  box.className = "chip tap show";
  const st = await invoke("system_proxy_state").catch(() => "unknown");
  if (st === "ours") return;
  if (st === "foreign") {
    box.className = "chip tap show warn";
    say("системный прокси занят другой программой — впишите " + PROXY_ADDR + " вручную или включите TUN", true);
    return;
  }
  if (st === "off") {
    // Попробуем выставить сами — sing-box пишет настройку от своего пользователя,
    // и при запуске с чужими админскими правами она уходит не в ту ветку реестра.
    const fixed = await invoke("set_system_proxy").catch(() => false);
    if (!fixed) {
      box.className = "chip tap show warn";
      say("Windows не принял системный прокси — впишите " + PROXY_ADDR + " вручную или включите TUN", true);
    }
  }
}

on(el("chip-proxy"), "click", () => {
  navigator.clipboard.writeText(PROXY_ADDR)
    .then(() => say("адрес прокси скопирован: " + PROXY_ADDR))
    .catch(() => say(PROXY_ADDR));
});

/* ── live traffic counters + egress ──────────────────────────────────────── */

async function pollStats() {
  if (state !== "on") return;
  try {
    const c = await clash("/connections");
    const now = Date.now();
    const d = c.downloadTotal || 0;
    const u = c.uploadTotal || 0;
    if (stats.at) {
      const dt = Math.max(0.2, (now - stats.at) / 1000);
      stats.dRate = Math.max(0, (d - stats.down) / dt);
      stats.uRate = Math.max(0, (u - stats.up) / dt);
    }
    stats.down = d; stats.up = u; stats.at = now;
    el("m-down").textContent = rate(stats.dRate);
    el("m-up").textContent = rate(stats.uRate);
    pushSpark(stats.dRate, stats.uRate);
    const tr = el("chip-traffic");
    tr.textContent = "";
    tr.append("за сессию ↓ ", Object.assign(document.createElement("b"), { textContent: bytes(d) }),
              "  ↑ ", Object.assign(document.createElement("b"), { textContent: bytes(u) }));
    tr.className = "chip show";
  } catch (_) { /* engine not answering: syncStatus will notice */ }
}
setInterval(pollStats, 1000);

/* ── график скорости: последние 60 секунд ─────────────────────────────────── */
// Две серии в одних единицах (бит/с) и на одной оси: приём — площадь, отдача —
// линия. Шкала растёт сама по пику окна, подписи — у легенды над графиком.
const SPARK_N = 60;
let spark = [];

function resetSpark() {
  spark = [];
  drawSpark();
}

function pushSpark(d, u) {
  spark.push({ d: d * 8, u: u * 8, t: Date.now() });
  if (spark.length > SPARK_N) spark.shift();
  drawSpark();
}

function niceMax(v) {
  if (v <= 0) return 1e6;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}

function bitRate(b) {
  if (b < 1e6) return Math.round(b / 1e3) + " Кбит/с";
  return (b / 1e6).toFixed(b < 1e7 ? 1 : 0) + " Мбит/с";
}

function drawSpark() {
  const svg = el("spark");
  if (!svg) return;
  const W = 300, H = 56;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  el("spark-wrap").classList.toggle("idle", spark.length < 2);
  if (spark.length < 2) { svg.innerHTML = ""; return; }
  const max = niceMax(Math.max(...spark.map((p) => Math.max(p.d, p.u))));
  const x = (i) => ((SPARK_N - spark.length + i) / (SPARK_N - 1)) * W;
  const y = (v) => H - 3 - (v / max) * (H - 8);
  const line = (k) => spark.map((p, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(p[k]).toFixed(1)).join("");
  const last = spark.length - 1;
  svg.innerHTML =
    `<line class="grid" x1="0" x2="${W}" y1="${y(max / 2).toFixed(1)}" y2="${y(max / 2).toFixed(1)}"/>` +
    `<line class="base" x1="0" x2="${W}" y1="${H - 3}" y2="${H - 3}"/>` +
    `<path class="area d" d="${line("d")}L${x(last).toFixed(1)} ${H - 3}L${x(0).toFixed(1)} ${H - 3}Z"/>` +
    `<path class="ln d" d="${line("d")}"/>` +
    `<path class="ln u" d="${line("u")}"/>` +
    `<circle class="end d" cx="${x(last).toFixed(1)}" cy="${y(spark[last].d).toFixed(1)}" r="2.6"/>` +
    `<text class="scale" x="2" y="${(y(max / 2) - 3).toFixed(1)}">${bitRate(max / 2)}</text>` +
    `<line class="cross" id="spark-x" x1="0" x2="0" y1="0" y2="${H}" visibility="hidden"/>`;
}

// наведение: вертикаль и подсказка со значениями за ту секунду
(function () {
  const wrap = el("spark-wrap");
  if (!wrap) return;
  const tip = el("spark-tip");
  wrap.addEventListener("pointermove", (e) => {
    if (spark.length < 2) return;
    const r = wrap.getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const i = Math.round(fx * (SPARK_N - 1)) - (SPARK_N - spark.length);
    if (i < 0 || i >= spark.length) { tip.hidden = true; return; }
    const p = spark[i];
    const cx = ((SPARK_N - spark.length + i) / (SPARK_N - 1)) * 300;
    const cross = el("spark-x");
    if (cross) { cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.setAttribute("visibility", "visible"); }
    const ago = Math.round((Date.now() - p.t) / 1000);
    tip.innerHTML = `<span>${ago ? ago + " с назад" : "сейчас"}</span>` +
      `<b class="d">↓ ${bitRate(p.d)}</b><b class="u">↑ ${bitRate(p.u)}</b>`;
    tip.hidden = false;
    const left = Math.min(r.width - tip.offsetWidth - 2, Math.max(2, e.clientX - r.left + 10));
    tip.style.left = left + "px";
  });
  wrap.addEventListener("pointerleave", () => {
    tip.hidden = true;
    const cross = el("spark-x");
    if (cross) cross.setAttribute("visibility", "hidden");
  });
})();

async function showEgress() {
  try {
    const r = await fetch("https://api.ipify.org", { cache: "no-store" });
    const ip = (await r.text()).trim();
    const box = el("chip-ip");
    box.textContent = "";
    box.append("выход ", Object.assign(document.createElement("b"), { textContent: ip }));
    box.className = "chip show";
  } catch (_) { /* no network yet */ }
}

/* ── servers ─────────────────────────────────────────────────────────────── */

function delayLabel(s) {
  // пока идёт замер, прежнее значение остаётся (приглушённым) — иначе строка мигает
  if (s.pinging) return [s.delay > 0 ? s.delay + " мс" : "…", "wait"];
  if (s.delay > 0) return [s.delay + " мс", s.delay < 150 ? "good" : s.delay < 400 ? "mid" : "bad"];
  const t = (info[s.name] || {}).type;
  if (s.delay < 0) return [isOfx(s.name) ? "после подключения" : "", ""];
  if (s.pinged) return [t === "hysteria2" || t === "tuic" ? "UDP не проходит" : "нет ответа", "bad"];
  return ["", ""];
}

// Подменю «Сервер» в трее (ПК): подписи без флагов-эмодзи (в меню Windows они
// выходят буквами), выбор приходит индексом в trayList.
let trayList = [];
let trayKey = "";
function syncTray() {
  if (IS_ANDROID || !servers.length) return;
  const fav = prefs.favorites || [];
  const list = servers.slice().sort((a, b) => (fav.includes(b.name) ? 1 : 0) - (fav.includes(a.name) ? 1 : 0))
    .map((s) => s.name);
  const labels = list.map((n) => ((info[n] || {}).type === "urltest" ? "Автовыбор" : cleanName(n)) + (fav.includes(n) ? " ★" : ""));
  const key = JSON.stringify([labels, current]);
  if (key === trayKey) return;
  trayKey = key;
  trayList = list;
  const cur = list.indexOf(current);
  invoke("set_tray_servers", { servers: labels, current: cur >= 0 ? labels[cur] : null }).catch(() => {});
}

function paintCurrent() {
  // Android перезапускает оборвавшийся тоннель сам, но только при Auto
  if (current && !!prefs.serverAuto !== autoSelected()) savePrefs({ serverAuto: autoSelected() });
  el("h-name").textContent = current ? cleanName(current) : "—";
  paintFlag(el("h-flag"), current);
  const d = (info[current] || {}).desc;
  const auto = (info[current] || {}).type === "urltest";
  el("h-desc").textContent = d
    || (auto ? "автовыбор по задержке" : current ? "сервер выбран" : "сервер не выбран");
  const s = byName(current);
  const ms = el("h-ms");
  const [label, tone] = s ? delayLabel(s) : ["", ""];
  ms.textContent = label;
  ms.className = "ms" + (tone ? " " + tone : "");
  if (state === "on") resolveExit();   // сменили сервер на ходу — заголовок за ним
  syncTray();
}

function sortedServers() {
  const q = (el("srv-search").value || "").trim().toLowerCase();
  let list = servers.filter((s) => !q || s.name.toLowerCase().includes(q));
  const mode = prefs.srvSort || "panel";
  if (mode === "ping") {
    list = list.slice().sort((a, b) => (a.delay > 0 ? a.delay : 1e6) - (b.delay > 0 ? b.delay : 1e6));
  } else if (mode === "name") {
    list = list.slice().sort((a, b) => cleanName(a.name).localeCompare(cleanName(b.name), "ru"));
  }
  // Favourites first, then the OpenFlux channel — it is the whole point of this
  // client and the panel buries it at the end of the subscription.
  const fav = prefs.favorites || [];
  const weight = (s) => (fav.includes(s.name) ? 2 : isOfx(s.name) ? 1 : 0);
  return list.slice().sort((a, b) => weight(b) - weight(a));
}

// Строки списка живут между перерисовками: renderList правит их на месте и
// переставляет, а не строит заново. Раньше каждый ответ пинга пересоздавал весь
// список — анимация появления проигрывалась снова, и экран моргал.
const srvRows = new Map();   // имя сервера → {b, star, fl, nm, ds, badge, ms}
let srvOrder = [];           // порядок, показанный последним

function srvRow(name, animate, i) {
  const b = document.createElement("button");
  b.className = "srv" + (animate ? " enter" : "");
  if (animate) {
    b.style.setProperty("--i", Math.min(i, 14));
    b.addEventListener("animationend", () => b.classList.remove("enter"), { once: true });
  }
  const star = document.createElement("button");
  star.className = "star";
  star.title = "В избранное";
  star.addEventListener("click", (e) => { e.stopPropagation(); toggleFav(name); });
  const fl = document.createElement("span");
  fl.className = "flag";
  paintFlag(fl, name);
  const tx = document.createElement("span");
  tx.className = "tx";
  const nm = document.createElement("span");
  nm.className = "nm";
  const ds = document.createElement("span");
  ds.className = "ds";
  tx.append(nm, ds);
  const badge = document.createElement("span");
  const ms = document.createElement("span");
  b.append(star, fl, tx, badge, ms);
  b.addEventListener("click", () => choose(name));
  return { b, star, fl, nm, ds, badge, ms };
}

const setText = (node, t) => { if (node.textContent !== t) node.textContent = t; };
const setClass = (node, c) => { if (node.className !== c) node.className = c; };

function renderList() {
  const box = el("srv-list");
  let list = sortedServers();
  if (!list.length) {
    srvRows.clear(); srvOrder = [];
    box.textContent = "";
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = servers.length ? "Ничего не найдено"
      : subError ? "Не удалось загрузить подписку: " + subError
      : "Список пуст — проверьте подписку в настройках";
    box.append(d);
    return;
  }
  box.querySelectorAll(".empty").forEach((n) => n.remove());
  // сортировка по пингу во время замера держит прежний порядок: строки иначе
  // прыгали бы на каждый пришедший ответ; пересортируем, когда замер кончится
  if ((prefs.srvSort || "panel") === "ping" && servers.some((s) => s.pinging) && srvOrder.length) {
    const at = new Map(srvOrder.map((n, i) => [n, i]));
    list = list.slice().sort((a, b) => (at.get(a.name) ?? 1e6) - (at.get(b.name) ?? 1e6));
  }
  const first = srvRows.size === 0;
  const fav = prefs.favorites || [];
  const keep = new Set(list.map((s) => s.name));
  for (const [name, r] of srvRows) if (!keep.has(name)) { r.b.remove(); srvRows.delete(name); }

  list.forEach((s, i) => {
    let r = srvRows.get(s.name);
    if (!r) { r = srvRow(s.name, first, i); srvRows.set(s.name, r); }
    const isFav = fav.includes(s.name);
    setClass(r.b, "srv" + (s.name === current ? " sel" : "") + (r.b.classList.contains("enter") ? " enter" : ""));
    setClass(r.star, "star" + (isFav ? " on" : ""));
    setText(r.star, isFav ? "★" : "☆");
    setText(r.nm, cleanName(s.name));
    setText(r.ds, (info[s.name] || {}).desc || "");
    const type = (info[s.name] || {}).type;
    setClass(r.badge, "badge" + (isOfx(s.name) ? " ofx" : ""));
    setText(r.badge, isOfx(s.name) ? "мобильный" : type === "urltest" ? "авто"
      : (info[s.name] || {}).proto || type || "");
    const [label, tone] = delayLabel(s);
    setClass(r.ms, "ms" + (tone ? " " + tone : ""));
    setText(r.ms, label);
    if (box.children[i] !== r.b) box.insertBefore(r.b, box.children[i] || null);
  });
  srvOrder = list.map((s) => s.name);
  syncTray();
}

function toggleFav(name) {
  const fav = (prefs.favorites || []).slice();
  const i = fav.indexOf(name);
  if (i < 0) fav.push(name); else fav.splice(i, 1);
  savePrefs({ favorites: fav });
  renderList();
}

async function choose(name) {
  const before = current;
  current = name;
  savePrefs({ server: name });
  paintCurrent();
  renderList();
  // Канал «Мобильные операторы» движок открывает, только когда он выбран при
  // подключении (документ — одно устройство), поэтому на него и с него —
  // переподключение, а не переключение на ходу.
  if (state === "on" && isOfx(name) !== isOfx(before)) {
    say(isOfx(name) ? "переключаю на «Мобильные операторы» — переподключаюсь…" : "переподключаюсь на " + cleanName(name) + "…");
    await toggleConnection();
    await toggleConnection();
    return;
  }
  if (state === "connecting") { say("сервер выбран: " + cleanName(name) + " — применится после подключения"); return; }
  if (selectorName) {
    try {
      await clash("/proxies/" + encodeURIComponent(selectorName), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      say("сервер переключён: " + cleanName(name));
      invoke("set_tray_state", { on: true, server: name }).catch(() => {});
      // iPhone поднимает тоннель заново (смена сети) со своей копией выбора
      if (T.platform === "ios") invoke("remember_server", { server: name }).catch(() => {});
      showEgress();
    } catch (e) { say(errText(e), true); }
  } else {
    say("сервер выбран: " + cleanName(name));
  }
  tick();
}

async function loadInfo() {
  const r = await invoke("list_servers");
  info = (r && r.info) || {};
  if (r && r.routing) { baseline = r.routing; paintBaseline(); }
  return r;
}

// почему список серверов пуст (заглушка панели, нет сети): тогда «в подписке
// нет мобильного канала» — неправда, показываем настоящую причину
let subError = "";

async function loadServers() {
  if (state === "on") {
    try {
      const data = await clash("/proxies");
      const all = Object.values(data.proxies || {});
      const sel = all.find((p) => p.type === "Selector");
      if (sel) {
        selectorName = sel.name;
        liveType = {};
        const prev = new Map(servers.map((s) => [s.name, s]));
        servers = sel.all.map((n) => {
          const p = data.proxies[n];
          if (p) liveType[n] = p.type;
          const h = p && p.history && p.history.length ? p.history[p.history.length - 1] : null;
          return h && h.delay ? { name: n, delay: h.delay } : keepDelay(prev, n);
        });
        current = sel.now;
        paintCurrent(); renderList(); paintOfx();
        if (!Object.keys(info).length) loadInfo().then(() => { renderList(); paintCurrent(); }).catch(() => {});
        return;
      }
    } catch (_) { /* engine not up yet — fall back to the offline list */ }
  }
  selectorName = null;
  try {
    const r = await loadInfo();                 // {selector, default, servers, info}
    const names = (r && r.servers) || [];
    if (!names.length) throw new Error("подписка не отдала серверов");
    const prev = new Map(servers.map((s) => [s.name, s]));
    servers = names.map((n) => keepDelay(prev, n));
    if (!current || !names.includes(current)) current = prefs.server && names.includes(prefs.server)
      ? prefs.server : (r.default || names[0] || null);
    subError = "";
    listCachedAt = r.cachedAt || 0;
    rememberList(names, r.default);
  } catch (e) {
    subError = /нет профиля/.test(String(e)) ? "" : errText(e);
    // Подписка не загрузилась (нет сети, белые списки, панель недоступна) —
    // это не повод терять серверы: показываем последний удачный список.
    const c = prefs.srvCache;
    if (subError && !DEVICE_LIMIT.test(subError) && c && profile && c.sub === profile.sub && (c.servers || []).length) {
      servers = c.servers.map((n) => ({ name: n, delay: 0 }));
      if (!Object.keys(info).length) info = c.info || {};
      if (!current || !c.servers.includes(current)) current = prefs.server && c.servers.includes(prefs.server)
        ? prefs.server : (c.default || c.servers[0] || null);
      listCachedAt = c.at || 1;
      if (!loadServers.warned) { loadServers.warned = true; say("нет связи с сервером подписок — показываю сохранённый список"); }
    } else {
      if (!servers.length || !profile || !profile.sub) servers = [];
      if (subError && !handleDeviceLimit(subError, false)) say(subError, true);
    }
  }
  paintCurrent(); renderList(); paintOfx();
}

// перечитали список — уже измеренный пинг не теряем (иначе цифры пропадали
// и появлялись заново при каждом обновлении)
function keepDelay(prev, name) {
  const p = prev.get(name);
  return p && !p.pinging ? { name, delay: p.delay, pinged: p.pinged } : { name, delay: 0 };
}

// последний удачный список серверов — живёт до следующей удачной загрузки подписки
let listCachedAt = 0;
function rememberList(names, def) {
  if (!profile || !profile.sub) return;
  const c = prefs.srvCache || {};
  if (c.sub === profile.sub && JSON.stringify(c.servers) === JSON.stringify(names)
      && JSON.stringify(c.info) === JSON.stringify(info) && c.default === def) return;
  loadServers.warned = false;
  savePrefs({ srvCache: { sub: profile.sub, servers: names, info, default: def || null, at: Date.now() } });
}

// Connected: a real request through each server (Clash API delay test), the
// same check Happ runs. Disconnected: a TCP connect to each server, or a QUIC
// probe for the UDP ones (Hysteria2) — that also shows whether this network
// lets UDP out at all.
async function pingAll() {
  if (!servers.length) return;
  const btn = el("ping");
  btn.disabled = true;
  servers.forEach((s) => { s.pinging = true; });
  renderList();
  try {
    if (state === "on") {
      // канал открыт, только когда выбран: остальным он ответил бы «нет ответа»
      const queue = servers.filter((s) => (info[s.name] || {}).type !== "urltest" && (!isOfx(s.name) || isOfx(current)));
      servers.filter((s) => !queue.includes(s)).forEach((s) => { s.pinging = false; });
      const worker = async () => {
        for (let s; (s = queue.shift()); ) {
          const timeout = isOfx(s.name) ? 10000 : 5000;
          try {
            const r = await clash("/proxies/" + encodeURIComponent(s.name) +
              "/delay?timeout=" + timeout + "&url=" + encodeURIComponent("https://www.gstatic.com/generate_204"));
            s.delay = r && r.delay > 0 ? r.delay : 0;
          } catch (_) { s.delay = 0; }
          s.pinged = true; s.pinging = false;
          renderList();
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
    } else {
      const r = await invoke("ping_servers");
      const got = (r && r.ping) || {};
      for (const s of servers) {
        s.delay = got[s.name] ?? 0;
        s.pinged = true; s.pinging = false;
      }
    }
  } catch (e) {
    servers.forEach((s) => { s.pinging = false; });
    say(errText(e), true);
  }
  btn.disabled = false;
  renderList();
  paintCurrent();
}

on(el("ping"), "click", pingAll);
on(el("refresh"), "click", async () => { await loadServers(); say("список обновлён"); });
on(el("srv-search"), "input", renderList);
document.querySelectorAll("#srv-sort button").forEach((b) => on(b, "click", () => {
  document.querySelectorAll("#srv-sort button").forEach((x) => x.classList.toggle("on", x === b));
  savePrefs({ srvSort: b.dataset.sort });
  renderList();
}));
on(el("home-server"), "click", () => show("servers"));
on(el("home-channel"), "click", () => show("channel"));

/* ── OpenFlux channel ────────────────────────────────────────────────────── */

function paintOfx() {
  const hasChannel = servers.some((s) => isOfx(s.name));
  const dot = el("ofx-dot"), title = el("ofx-title"), note = el("ofx-note");
  const hDot = el("h-ofx-dot"), hTx = el("h-ofx");
  if (profile && profile.hasDoc && hasChannel) {
    dot.className = "dot big live"; hDot.className = "dot live";
    title.textContent = "Канал готов";
    note.textContent = "документ и сервер на месте";
    hTx.textContent = "готов к работе";
  } else if (profile && profile.hasDoc && !servers.length) {
    dot.className = "dot big warn"; hDot.className = "dot warn";
    title.textContent = "Подписка не загрузилась";
    note.textContent = subError || "нет связи с сервером подписок — проверьте интернет";
    hTx.textContent = DEVICE_LIMIT.test(subError) ? "места для устройств заняты" : "подписка не загрузилась";
  } else if (profile && profile.hasDoc) {
    dot.className = "dot big warn"; hDot.className = "dot warn";
    title.textContent = "Документ есть, сервера нет";
    note.textContent = "в подписке нет мобильного канала — напишите в поддержку @vpnushka_manager";
    hTx.textContent = "нет сервера в подписке";
  } else {
    dot.className = "dot big"; hDot.className = "dot";
    title.textContent = "Канал не настроен";
    note.textContent = "нужен ваш документ на Яндекс.Диске";
    hTx.textContent = hasChannel ? "нужен документ Яндекса" : "не настроен";
  }
  if (profile && profile.doc) el("doc-input").value = profile.doc;
  el("nav-ofx").textContent = hTx.textContent;
  el("nav-ofx-dot").className = hDot.className;
  // канал готов — он просто строка в списке серверов; карточка нужна, пока
  // его надо настроить (документ) или с ним что-то не так
  el("home-channel").style.display = profile && profile.hasDoc && hasChannel ? "none" : "";
}

function docMsg(text, kind) {
  const m = el("doc-msg");
  m.textContent = text || "";
  m.className = "msg" + (kind ? " " + kind : "");
}

on(el("open-disk"), "click", () => invoke("open_url", { url: "https://disk.yandex.ru/client/disk" })
  .catch((e) => say(errText(e), true)));

on(el("doc-save"), "click", async () => {
  const url = el("doc-input").value.trim();
  if (!url) { docMsg("вставьте ссылку на документ", "err"); return; }
  const btn = el("doc-save");
  btn.disabled = true;
  docMsg("проверяю документ…", "busy");
  try {
    profile = await invoke("save_doc", { url });
    docMsg("готово: канал включён. «Мобильные операторы» появятся в списке серверов.", "ok");
    say("мобильные операторы включены");
    await loadServers();
  } catch (e) {
    docMsg(errText(e), "err");
  }
  btn.disabled = false;
  paintOfx();
});

on(el("doc-clear"), "click", async () => {
  try {
    profile = await invoke("clear_doc");
    docMsg("канал отключён", "");
    el("doc-input").value = "";
    await loadServers();
  } catch (e) { say(errText(e), true); }
});

on(el("login-yandex"), "click", () => provision("provision_yandex"));
on(el("save-yatoken"), "click", () => provision("provision_manual", { oauth: el("yatoken-input").value.trim() }));

async function provision(cmd, args) {
  const btn = el("login-yandex");
  btn.disabled = true;
  docMsg("открываю Яндекс…", "busy");
  try {
    profile = await invoke(cmd, args);
    docMsg("готово: документ создан и канал включён", "ok");
    say("мобильные операторы включены");
    await loadServers();
  } catch (e) { docMsg(errText(e), "err"); }
  btn.disabled = false;
  paintOfx();
}

on(el("save-token"), "click", async () => {
  try {
    profile = await invoke("save_token", { token: el("token-input").value.trim() });
    say("токен сохранён");
    await loadServers();
    paintOfx();
    refreshProfileFields();
  } catch (e) { say(errText(e), true); }
});

/* ── routing rules ───────────────────────────────────────────────────────── */

const routing = () => (tweaks.routing = tweaks.routing || { apps: {}, domains: {}, ips: {} });
function bucket(kind, verdict) {
  const r = routing();
  r[kind] = r[kind] || {};
  r[kind][verdict] = r[kind][verdict] || [];
  return r[kind][verdict];
}

// Готовые наборы: один тап вместо десятка правил. Каждая строка потом видна и
// удаляется по отдельности — это просто быстрый способ заполнить исключения.
const PRESETS = [
  {
    label: "Банки и госуслуги мимо VPN", kind: "domains", verdict: "direct",
    items: ["gosuslugi.ru", "nalog.gov.ru", "mos.ru", "sberbank.ru", "sber.ru", "tbank.ru",
            "tinkoff.ru", "alfabank.ru", "vtb.ru", "raiffeisen.ru", "gazprombank.ru",
            "psbank.ru", "mail.ru", "yandex.ru"],
  },
  {
    label: "Все российские сайты мимо VPN", kind: "domains", verdict: "direct",
    items: [".ru", ".рф", ".su"],
  },
  {
    label: "Игры мимо VPN", kind: "apps", verdict: "direct",
    items: ["steam.exe", "steamwebhelper.exe", "EpicGamesLauncher.exe", "Battle.net.exe",
            "RiotClientServices.exe", "cs2.exe", "dota2.exe", "FortniteClient-Win64-Shipping.exe"],
  },
  {
    label: "YouTube и соцсети через VPN", kind: "domains", verdict: "proxy",
    items: ["youtube.com", "googlevideo.com", "ytimg.com", "instagram.com", "facebook.com",
            "x.com", "twitter.com", "discord.com", "discordapp.com"],
  },
  {
    label: "Браузер через VPN", kind: "apps", verdict: "proxy",
    items: ["chrome.exe", "msedge.exe", "firefox.exe", "opera.exe", "browser.exe"],
  },
];

function renderPresets() {
  const box = el("presets");
  box.textContent = "";
  // программы на телефоне — это пакеты, наборы из .exe там ни к чему
  for (const p of PRESETS.filter((x) => !(IS_ANDROID && x.kind === "apps"))) {
    const b = document.createElement("button");
    b.textContent = p.label;
    b.title = p.items.join(", ");
    b.addEventListener("click", () => applyPreset(p));
    box.append(b);
  }
}

async function applyPreset(p) {
  let added = 0;
  for (const item of p.items) {
    for (const v of ["proxy", "direct", "block"]) {
      const list = bucket(p.kind, v);
      const i = list.indexOf(item);
      if (i >= 0) list.splice(i, 1);          // одна запись — один вердикт
    }
    bucket(p.kind, p.verdict).push(item);
    added++;
  }
  ruleKind = p.kind;
  document.querySelectorAll("#rule-kind button").forEach((x) => x.classList.toggle("on", x.dataset.kind === p.kind));
  await saveRouting();
  say("добавлено правил: " + added + " (" + VERDICTS[p.verdict].toLowerCase() + ")");
}

function renderRules() {
  const box = el("rule-list");
  box.textContent = "";
  let n = 0;
  for (const verdict of ["proxy", "direct", "block"]) {
    for (const item of bucket(ruleKind, verdict)) {
      n++;
      const row = document.createElement("div");
      row.className = "rule";
      const what = document.createElement("span");
      what.className = "what";
      what.textContent = item;
      const vd = document.createElement("span");
      vd.className = "vd " + verdict;
      vd.textContent = VERDICTS[verdict];
      const del = document.createElement("button");
      del.className = "del";
      del.textContent = "×";
      del.title = "Удалить правило";
      del.addEventListener("click", () => {
        const list = bucket(ruleKind, verdict);
        list.splice(list.indexOf(item), 1);
        saveRouting();
      });
      row.append(what, vd, del);
      box.append(row);
    }
  }
  if (!n) {
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = ruleKind === "apps"
      ? "Правил нет — все программы идут по общим настройкам"
      : "Правил нет";
    box.append(d);
  }
  el("rule-input").placeholder =
    ruleKind === "apps" ? (IS_ANDROID ? "выберите приложение справа" : "chrome.exe")
      : ruleKind === "domains" ? "youtube.com" : "192.168.1.0/24";
  el("rule-pick").style.display = ruleKind === "apps" ? "" : "none";
  // На Android приложение можно только вывести из VPN (список VpnService):
  // ядро не видит, от какой программы пришло соединение.
  el("rule-verdict").style.display = IS_ANDROID && ruleKind === "apps" ? "none" : "";
}

function normalizeRule(kind, raw) {
  let v = (raw || "").trim();
  if (!v) return "";
  if (kind === "domains") {
    v = v.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/^www\./i, "").toLowerCase();
  } else if (kind === "apps") {
    v = v.split(/[\\/]/).pop();
  } else {
    v = v.replace(/\s+/g, "");
  }
  return v;
}

async function saveRouting() {
  try {
    tweaks = await invoke("set_tweaks", { patch: { routing: routing() } });
    renderRules();
    if (state === "on") say("правила применятся при следующем подключении");
  } catch (e) { say(errText(e), true); }
}

on(el("rule-add"), "click", () => {
  const v = normalizeRule(ruleKind, el("rule-input").value);
  if (!v) { say("что добавляем?", true); return; }
  for (const verdict of ["proxy", "direct", "block"]) {
    const list = bucket(ruleKind, verdict);
    const i = list.indexOf(v);
    if (i >= 0) list.splice(i, 1);          // one verdict per entry
  }
  bucket(ruleKind, IS_ANDROID && ruleKind === "apps" ? "direct" : ruleVerdict).push(v);
  el("rule-input").value = "";
  saveRouting();
});
on(el("rule-clear"), "click", async () => {
  tweaks.routing = { apps: { direct: [], proxy: [], block: [] },
                     domains: { direct: [], proxy: [], block: [] },
                     ips: { direct: [], proxy: [], block: [] } };
  await saveRouting();
  say("правила очищены — остался режим и фирменный пресет");
});
on(el("rule-input"), "keydown", (e) => { if (e.key === "Enter") el("rule-add").click(); });

document.querySelectorAll("#rule-kind button").forEach((b) => on(b, "click", () => {
  document.querySelectorAll("#rule-kind button").forEach((x) => x.classList.toggle("on", x === b));
  ruleKind = b.dataset.kind;
  renderRules();
}));
document.querySelectorAll("#rule-verdict button").forEach((b) => on(b, "click", () => {
  document.querySelectorAll("#rule-verdict button").forEach((x) => x.classList.toggle("on", x === b));
  ruleVerdict = b.dataset.verdict;
}));

/* process picker */
const sheet = (id, open) => el(id).classList.toggle("open", open);
document.querySelectorAll("[data-close]").forEach((b) =>
  on(b, "click", (e) => e.target.closest(".sheet").classList.remove("open")));

on(el("rule-pick"), "click", async () => {
  sheet("sheet-procs", true);
  const box = el("proc-list");
  box.textContent = "загружаю…";
  try {
    const list = await invoke("list_processes");
    const draw = () => {
      const q = (el("proc-search").value || "").trim().toLowerCase();
      box.textContent = "";
      for (const p of list.filter((x) => !q || x.toLowerCase().includes(q)).slice(0, 300)) {
        const b = document.createElement("button");
        b.className = "srv";
        const tx = document.createElement("span");
        tx.className = "tx";
        const nm = document.createElement("span");
        nm.className = "nm";
        nm.textContent = p;
        tx.append(nm);
        b.append(tx);
        b.addEventListener("click", () => {
          el("rule-input").value = p;
          sheet("sheet-procs", false);
        });
        box.append(b);
      }
      if (!box.children.length) box.textContent = "ничего не найдено";
    };
    el("proc-search").oninput = draw;
    draw();
  } catch (e) { box.textContent = errText(e); }
});

/* route mode (live, through the Clash API) */
// One switch decides everything about routing: the Clash mode for the running
// session and the full-tunnel flag for the next connect. There is no second
// "весь трафик через сервер" toggle any more — having two was what made it look
// as if every app needed its own rule.
async function applyRouteMode(mode, quiet) {
  savePrefs({ routeMode: mode });
  // the engine starts the next session in this mode (clash_api.default_mode)
  invoke("set_tweaks", { patch: { routeMode: mode } }).then((t) => { tweaks = t; }).catch(() => {});
  document.querySelectorAll("#route-mode button").forEach((b) => b.classList.toggle("on", b.dataset.rmode === mode.toLowerCase()));
  el("rule-hint").textContent = RULE_HINTS[mode] || "";
  el("nav-route").textContent = ROUTE_MODES[mode] || "";
  paintBaseline();
  paintHomeControls();
  paintQuick();
  if (state === "on") {
    try {
      await clash("/configs", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      if (!quiet) say("режим маршрутизации: " + ROUTE_MODES[mode]);
    } catch (e) { if (!quiet) say(errText(e), true); }
  } else if (!quiet) {
    say("режим сохранён: " + ROUTE_MODES[mode]);
  }
}
document.querySelectorAll("#route-mode button").forEach((b) => on(b, "click", () => {
  const map = { rule: "Rule", global: "Global", direct: "Direct" };
  applyRouteMode(map[b.dataset.rmode]);
}));

function paintHomeControls() {
  const mode = prefs.mode === "proxy" ? "proxy" : "tun";
  document.querySelectorAll("[data-pick-mode]").forEach((b) => b.classList.toggle("on", b.dataset.pickMode === mode));
  const rm = String(prefs.routeMode || "Global").toLowerCase();
  document.querySelectorAll("[data-pick-route]").forEach((b) => b.classList.toggle("on", b.dataset.pickRoute === rm));
}
document.querySelectorAll("[data-pick-mode]").forEach((b) => on(b, "click", () => {
  const t = document.querySelector('#mode [data-mode="' + b.dataset.pickMode + '"]');
  if (t) t.click();
}));
document.querySelectorAll("[data-pick-route]").forEach((b) => on(b, "click", () => {
  const t = document.querySelector('#route-mode [data-rmode="' + b.dataset.pickRoute + '"]');
  if (t) t.click();
}));

function paintBaseline() {
  const box = el("route-base");
  if (!baseline) { box.textContent = ""; return; }
  const via = setNames(baseline.viaServer);
  const direct = setNames(baseline.direct);
  if (!via && !direct) { box.textContent = ""; return; }
  const mode = prefs.routeMode || "Global";
  box.textContent = mode === "Rule"
    ? "Фирменный пресет: через VPN — " + (via || "—") + "; напрямую — " + (direct || "—") + "."
    : "В фирменном пресете через VPN шли бы: " + (via || "—") + ".";
}

/* ── preferences & advanced settings ─────────────────────────────────────── */

async function savePrefs(patch) {
  Object.assign(prefs, patch);
  try { prefs = await invoke("set_prefs", { patch }); } catch (e) { say(errText(e), true); }
  return prefs;
}
async function saveTweaks(patch) {
  try { tweaks = await invoke("set_tweaks", { patch }); } catch (e) { say(errText(e), true); }
  paintQuick();
  return tweaks;
}

function paintMode() {
  const cur = prefs.mode === "proxy" ? "proxy" : "tun";
  if (typeof paintHomeControls === "function") paintHomeControls();
  document.querySelectorAll("#mode button")
    .forEach((b) => b.classList.toggle("on", b.dataset.mode === cur));
  const phoneUi = /\b(android|ios)\b/.test(document.documentElement.className);
  el("hm-ico").innerHTML = cur === "proxy" ? GLYPH.compass : GLYPH.shield;
  el("hm-title").textContent = cur === "proxy" ? "Прокси" : phoneUi ? "Весь телефон" : "Весь трафик";
  el("hm-sub").textContent = cur === "proxy" ? "сменить на TUN" : "режим TUN";
  el("mode").className = "seg";
  const phone = /\b(android|ios)\b/.test(document.documentElement.className);
  el("home-mode").title = el("mode-hint").textContent = phone ? (cur === "proxy"
    ? "Без VPN: на телефоне поднимается прокси " + PROXY_ADDR + " (HTTP и SOCKS5). Впишите его в "
      + "Telegram (Настройки → Данные и память → Прокси) или другое приложение с настройкой прокси."
      + (document.documentElement.classList.contains("ios") ? " Safari подхватит его сам." : "")
    : "VPN: в тоннеле весь телефон, все приложения.")
    : prefs.mode === "proxy"
    ? "Системный прокси на " + PROXY_ADDR + " (HTTP и SOCKS5): браузеры и программы, которые его "
      + "уважают. Игры, звонки и Telegram чаще всего его игнорируют и идут мимо — для них нужен TUN."
    : "Виртуальный адаптер: в тоннеле всё без исключения, включая UDP — игры, звонки, QUIC.";
}

function paintQuick() {
  paintMode();
  el("q-mode").querySelector("b").textContent = prefs.mode === "proxy" ? "Прокси" : "TUN";
  if (state === "on") showProxyChip(); else el("chip-proxy").className = "chip tap";
  el("q-route").querySelector("b").textContent = ROUTE_MODES[prefs.routeMode || "Global"];
  const f = (tweaks.fragment || {}).mode || "off";
  el("q-frag").querySelector("b").textContent = f === "tls" ? "пакеты" : f === "record" ? "записи" : "выкл";
}

// Режим задаётся составом конфига (TUN-интерфейс против mixed-инбаунда), живьём
// его не переключить. Раньше кнопка при поднятом соединении просто отвечала
// «отключитесь, чтобы сменить режим» — со стороны это выглядело как поломка.
// Теперь переподключаемся сами.
async function setConnMode(next) {
  if (next === prefs.mode) return;
  if (state === "connecting") { say("дождитесь окончания подключения", true); return; }
  await savePrefs({ mode: next });
  paintQuick();
  if (state === "off") { say(next === "proxy" ? "режим: системный прокси" : "режим: TUN"); return; }
  say("меняю режим — переподключаюсь…");
  await toggleConnection();   // гасим
  await toggleConnection();   // и поднимаем уже в новом режиме
}

on(el("q-mode"), "click", () => setConnMode(prefs.mode === "proxy" ? "tun" : "proxy"));
on(el("q-route"), "click", () => {
  const order = ["Rule", "Global", "Direct"];
  applyRouteMode(order[(order.indexOf(prefs.routeMode || "Global") + 1) % 3]);
});
on(el("q-frag"), "click", () => {
  const order = ["off", "tls", "record"];
  const cur = (tweaks.fragment || {}).mode || "off";
  const next = order[(order.indexOf(cur) + 1) % 3];
  saveTweaks({ fragment: { mode: next } }).then(paintTech);
});

document.querySelectorAll("#mode button").forEach((b) => on(b, "click", () => setConnMode(b.dataset.mode)));
on(el("home-mode"), "click", () => setConnMode(prefs.mode === "proxy" ? "tun" : "proxy"));

function bindSwitch(id, key) {
  const node = el(id);
  on(node, "change", () => savePrefs({ [key]: node.checked }));
}
bindSwitch("auto-connect", "autoConnect");

// Версия нативной части: интерфейс обновляется без переустановки и может
// оказаться новее движка — тогда то, чего движок не умеет, не показываем.
let nativeVer = "";
const verNum = (v) => String(v || "0").split(".").map((x) => parseInt(x, 10) || 0);
function nativeAtLeast(v) {
  const a = verNum(nativeVer), b = verNum(v);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return true;
}

// Блокировка рекламы — список доменов в движке (rules/adblock.srs, с 1.4.0).
// Конфиг собирается при подключении, поэтому на ходу — переподключение.
function paintAdblock() {
  el("adblock-row").style.display = nativeAtLeast("1.4.0") ? "" : "none";
  el("adblock").checked = !!tweaks.adblock;
}
on(el("adblock"), "change", async (e) => {
  const v = e.target.checked;
  await saveTweaks({ adblock: v });
  if (state === "on") {
    say(v ? "включаю блокировку рекламы — переподключаюсь…" : "выключаю блокировку рекламы — переподключаюсь…");
    await toggleConnection();
    await toggleConnection();
  } else {
    say(v ? "реклама будет блокироваться после подключения" : "блокировка рекламы выключена");
  }
});
bindSwitch("tray-on-close", "trayOnClose");
bindSwitch("start-min", "startMinimized");
bindSwitch("keep-alive", "keepAlive");
on(el("autostart"), "change", async () => {
  await savePrefs({ autostart: el("autostart").checked });
  say(el("autostart").checked ? "приложение будет запускаться с системой" : "автозапуск выключен");
});

/* technical settings — every control writes straight into tweaks.json, which is
   the file the engine reads when building the sing-box config. */
function paintTech() {
  const t = tweaks;
  paintAdblock();
  const frag = (t.fragment || {}).mode || "off";
  document.querySelectorAll("#frag-mode button").forEach((b) => b.classList.toggle("on", b.dataset.frag === frag));
  el("frag-delay").value = (t.fragment || {}).delay || "500ms";
  el("frag-delay-row").style.display = frag === "tls" ? "" : "none";

  const m = t.mux || {};
  el("mux-on").checked = !!m.enabled;
  el("mux-proto").value = m.protocol || "smux";
  el("mux-conn").value = m.maxConnections ?? 4;
  el("mux-min").value = m.minStreams ?? 4;
  el("mux-max").value = m.maxStreams ?? 0;
  el("mux-pad").checked = !!m.padding;
  el("mux-brutal").checked = !!m.brutal;
  el("mux-up").value = m.upMbps ?? 50;
  el("mux-down").value = m.downMbps ?? 100;

  el("tls-fp").value = (t.tls || {}).fingerprint || "";
  el("packet-enc").value = t.packetEncoding || "";

  const tun = t.tun || {};
  el("tun-mtu").value = tun.mtu || "";
  el("tun-stack").value = tun.stack || "mixed";
  el("tun-strict").checked = tun.strictRoute !== false;

  const dns = t.dns || {};
  el("dns-remote").value = dns.remote || "";
  el("dns-local").value = dns.local || "";
  el("dns-strategy").value = dns.strategy || "";
  paintQuick();
}

document.querySelectorAll("#frag-mode button").forEach((b) => on(b, "click", async () => {
  await saveTweaks({ fragment: { mode: b.dataset.frag, delay: el("frag-delay").value.trim() || "500ms" } });
  paintTech();
}));
on(el("frag-delay"), "change", () => saveTweaks({ fragment: { delay: el("frag-delay").value.trim() || "500ms" } }));

const muxPatch = () => ({
  mux: {
    enabled: el("mux-on").checked,
    protocol: el("mux-proto").value,
    maxConnections: +el("mux-conn").value || 0,
    minStreams: +el("mux-min").value || 0,
    maxStreams: +el("mux-max").value || 0,
    padding: el("mux-pad").checked,
    brutal: el("mux-brutal").checked,
    upMbps: +el("mux-up").value || 0,
    downMbps: +el("mux-down").value || 0,
  },
});
["mux-on", "mux-proto", "mux-conn", "mux-min", "mux-max", "mux-pad", "mux-brutal", "mux-up", "mux-down"]
  .forEach((id) => on(el(id), "change", () => saveTweaks(muxPatch())));

on(el("tls-fp"), "change", () => saveTweaks({ tls: { fingerprint: el("tls-fp").value } }));
on(el("packet-enc"), "change", () => saveTweaks({ packetEncoding: el("packet-enc").value }));
["tun-mtu", "tun-stack", "tun-strict"].forEach((id) => on(el(id), "change", () => saveTweaks({
  tun: { mtu: +el("tun-mtu").value || 0, stack: el("tun-stack").value, strictRoute: el("tun-strict").checked },
})));
["dns-remote", "dns-local", "dns-strategy"].forEach((id) => on(el(id), "change", () => saveTweaks({
  dns: { remote: el("dns-remote").value, local: el("dns-local").value, strategy: el("dns-strategy").value },
})));
on(el("tech-reset"), "click", async () => {
  try {
    tweaks = await invoke("reset_tweaks");
    paintTech();
    renderRules();
    say("технические настройки сброшены");
  } catch (e) { say(errText(e), true); }
});

/* ── subscription ────────────────────────────────────────────────────────── */

on(el("save-sub"), "click", async () => {
  try {
    profile = await invoke("save_sub", { url: el("sub-input").value.trim() });
    say("подписка сохранена");
    await loadServers();
    loadSubInfo();
  } catch (e) { say(errText(e), true); }
});
on(el("sub-refresh"), "click", async () => { await subAutoUpdate(true); say("обновлено"); });

/* ── автообновление подписки (2.0.0): по умолчанию раз в час ───────────────
   Выключен VPN — новый список сразу на экране. Включён — соединение не рвём:
   новые серверы применятся при следующем подключении (и скажем об этом). */
const subAutoMin = () => (prefs.subAuto == null ? 60 : +prefs.subAuto);
let subAutoBusy = false;

function paintSubAuto() {
  const s = el("sub-auto");
  if (s) s.value = String(subAutoMin());
  const at = el("sub-auto-at");
  if (at) at.textContent = prefs.subUpdatedAt
    ? "обновлено " + new Date(prefs.subUpdatedAt).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
    : "список серверов, трафик и срок подписки";
}

async function subAutoUpdate(manual) {
  if (subAutoBusy || state === "connecting" || !profile || !profile.sub) return;
  subAutoBusy = true;
  try {
    if (state === "on") {
      const live = servers.map((x) => x.name);
      const r = await loadInfo();
      const names = (r && r.servers) || [];
      if (names.length) {
        rememberList(names, r.default);
        const changed = names.length !== live.length || names.some((n) => !live.includes(n));
        if (changed) say("подписка обновилась — новые серверы появятся после переподключения");
      }
    } else {
      await loadServers();
    }
    await savePrefs({ subUpdatedAt: Date.now() });
    if (manual || view === "more") loadSubInfo().catch(() => {});
  } catch (_) { /* нет сети — попробуем в следующий раз */ }
  finally { subAutoBusy = false; paintSubAuto(); }
}

on(el("sub-auto"), "change", async () => {
  await savePrefs({ subAuto: +el("sub-auto").value });
  paintSubAuto();
  say(+el("sub-auto").value ? "подписка будет обновляться " + el("sub-auto").selectedOptions[0].textContent : "автообновление подписки выключено");
});

setInterval(() => {
  const m = subAutoMin();
  if (!m || !prefs || !profile || !profile.sub) return;
  if (Date.now() - (prefs.subUpdatedAt || 0) >= m * 60000) subAutoUpdate(false);
}, 60000);
on(el("sub-open"), "click", () => {
  if (!profile || !profile.sub) { say("подписка не задана", true); return; }
  invoke("open_url", { url: profile.sub }).catch((e) => say(errText(e), true));
});

async function loadSubInfo() {
  const box = el("sub-card");
  if (!profile || !profile.sub) { box.textContent = ""; return; }
  try {
    const s = await invoke("sub_status");
    box.textContent = "";
    const mk = (label, value) => {
      const kv = document.createElement("div");
      kv.className = "kv";
      const a = document.createElement("span");
      a.textContent = label;
      const b = document.createElement("b");
      b.textContent = value;
      kv.append(a, b);
      return kv;
    };
    if (s.title) box.append(mk("Тариф", s.title));
    if (s.total) {
      box.append(mk("Трафик", bytes(s.used) + " из " + bytes(s.total)));
      const bar = document.createElement("div");
      bar.className = "bar";
      const i = document.createElement("i");
      i.style.width = Math.min(100, (s.used / s.total) * 100).toFixed(1) + "%";
      bar.append(i);
      box.append(bar);
    } else if (s.used) {
      box.append(mk("Трафик", bytes(s.used) + " · без лимита"));
    }
    if (s.expire) {
      const days = Math.ceil((s.expire * 1000 - Date.now()) / 86400000);
      box.append(mk("Действует", days > 0 ? "ещё " + days + " дн." : "истекла"));
    }
    remindExpiry(s);
    if (s.announce) {
      const a = document.createElement("div");
      a.className = "hint";
      a.textContent = s.announce;
      box.append(a);
    }
  } catch (e) {
    box.textContent = "";
    const d = document.createElement("div");
    d.className = "hint";
    d.textContent = errText(e);
    box.append(d);
  }
}

/* ── log & about ─────────────────────────────────────────────────────────── */

async function loadLog() {
  try {
    const lines = await invoke("engine_log");
    el("logbox").textContent = lines.length ? lines.slice(-160).join("\n") : "пока пусто";
    el("logbox").scrollTop = el("logbox").scrollHeight;
  } catch (_) {}
}
on(el("log-refresh"), "click", loadLog);
on(el("log-clear"), "click", async () => { await invoke("clear_log").catch(() => {}); loadLog(); });
on(el("log-folder"), "click", () => invoke("open_data_dir").catch((e) => say(errText(e), true)));
on(el("support"), "click", () => show("support"));
on(el("support-about"), "click", () => show("support"));
on(el("quit"), "click", () => invoke("quit_app").catch(() => {}));



/* ── картины ─────────────────────────────────────────────────────────────── */
//
// Та же фишка, что на сайте: русская живопись как фон зала. Полотна вшиты в
// клиент (art/*.jpg + art.json), поэтому они на месте и без интернета, и до
// того, как поднялся тоннель. Сменяются сами, два слоя — чтобы переход был
// плавным; когда тоннель поднят, полотно показывается ярче (см. .canvas.on).

let art = [];
let artIndex = 0;
let artDeck = [];           // перемешанная колода: все полотна по разу, потом заново
let artLayer = 0;              // какой из двух <img> сейчас показан
let artTimer = 0;
const ART_EVERY = 20000;       // само листается раз в 20 секунд

async function loadArt() {
  try {
    const r = await fetch("art.json");
    art = await r.json();
  } catch (_) { art = []; }
  if (!art.length) {
    el("art-cap").style.display = "none";
    return;
  }
  // при каждом запуске — другое полотно, не то же, что в прошлый раз
  artIndex = nextArt(Number(prefs.art ?? -1));
  paintArt(true);
  scheduleArt();
}

function scheduleArt() {
  clearTimeout(artTimer);
  if (art.length > 1) artTimer = setTimeout(() => stepArt(1), ART_EVERY);
}

// Случайный порядок без повторов: колода перемешивается (Фишер–Йетс), когда
// кончается — заново, и следующая не начинается с только что показанного.
function nextArt(prev) {
  if (art.length < 2) return 0;
  if (!artDeck.length) {
    artDeck = art.map((_, i) => i);
    for (let i = artDeck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [artDeck[i], artDeck[j]] = [artDeck[j], artDeck[i]];
    }
    if (artDeck[artDeck.length - 1] === prev) artDeck.unshift(artDeck.pop());
  }
  return artDeck.pop();
}

on(el("canvas"), "click", () => { if (art.length > 1) { stepArt(); } });

function stepArt() {
  if (art.length < 2) return;
  artIndex = nextArt(artIndex);
  paintArt();
  scheduleArt();
}

function paintArt(first) {
  const a = art[artIndex];
  if (!a) return;
  const layers = [el("art-a"), el("art-b")];
  const next = layers[first ? 0 : 1 - artLayer];
  const cur = layers[first ? 1 : artLayer];
  const img = new Image();
  img.onload = () => {
    next.classList.remove("leaving");
    next.src = img.src;
    next.classList.add("show");
    if (!first) {
      cur.classList.replace("show", "leaving");
      clearTimeout(cur._leave);
      cur._leave = setTimeout(() => cur.classList.remove("leaving"), 1500);
    }
    artLayer = layers.indexOf(next);
  };
  img.src = a.file;
  el("art-author").textContent = a.author;
  el("art-title").textContent = a.title;
  el("art-year").textContent = a.year || "";
  savePrefs({ art: artIndex });
}

/* ── updates ─────────────────────────────────────────────────────────────── */
//
// The endpoints live on the VPN nodes (tauri.conf.json), so a check works
// before the tunnel is up and never touches the panel. Everything is signed;
// the backend refuses a package whose signature does not match our key.

let pendingUpdate = null;   // {version, notes} once something newer is found

function showUpdateBar(u) {
  pendingUpdate = u;
  el("upd-title").textContent = "Доступна версия " + u.version;
  el("upd-sub").textContent = (u.notes || "").split("\n")[0].slice(0, 90)
    || (u.manual_url ? "скачайте и установите новый .ipa" : "нажмите «Обновить» — займёт меньше минуты");
  el("upd-go").textContent = u.manual_url ? "Скачать" : "Обновить";
  el("update-bar").classList.add("show");
}

// Телефон докачал новый интерфейс сам (как Telegram) — осталось перезапустить окно.
let webReadyShown = null;
function showWebReady(ver) {
  if (webReadyShown === ver) return;
  webReadyShown = ver;
  pendingUpdate = { version: ver, web: true };
  el("upd-title").textContent = "Обновление " + ver + " загружено";
  el("upd-sub").textContent = "применится при следующем запуске — или перезапустите сейчас";
  el("upd-go").textContent = "Перезапустить";
  el("update-bar").classList.add("show");
}

async function checkUpdate(manual) {
  const btn = el("check-update");
  if (manual) { btn.disabled = true; el("upd-status").textContent = "проверяю…"; }
  try {
    const u = await invoke("check_update");
    if (u.available) {
      showUpdateBar(u);
      el("upd-status").textContent = "есть версия " + u.version + " (у вас " + u.current + ")";
      // Android 12+ ставит повторное обновление сам, без окна — тогда можно как на ПК
      const quiet = !IS_ANDROID || u.silent === true;
      // Ставим сами только когда соединение выключено: установщик заменяет тот
      // самый файл, который держит движок.
      // На Android установку подтверждает сам человек в системном окне —
      // выскакивать оно должно по нажатию, а не само через 5 секунд после старта.
      if (prefs.autoUpdate !== false && state === "off" && quiet && !u.manual_url) runUpdate(true);
    } else if (u.web_ready) {
      showWebReady(u.web_ready);
      el("upd-status").textContent = "загружено обновление " + u.web_ready + " — применится при перезапуске";
    } else if (manual) {
      el("upd-status").textContent = "у вас последняя версия (" + u.current + ")";
      say("обновлений нет — версия " + u.current);
    }
  } catch (e) {
    if (manual) { el("upd-status").textContent = errText(e); say(errText(e), true); }
  }
  if (manual) btn.disabled = false;
}

async function runUpdate(auto) {
  const go = el("upd-go");
  if (pendingUpdate && pendingUpdate.web) {          // интерфейс уже на диске
    invoke("apply_web_update").catch((e) => say(errText(e), true));
    return;
  }
  if (pendingUpdate && pendingUpdate.manual_url) {   // iPhone: новый .ipa ставится руками
    invoke("open_url", { url: pendingUpdate.manual_url }).catch(() => {});
    return;
  }
  go.disabled = true;
  go.textContent = "0 %";
  if (auto) say("ставлю обновление " + (pendingUpdate ? pendingUpdate.version : ""));
  try {
    await invoke("install_update");   // приложение перезапустится само
  } catch (e) {
    go.disabled = false;
    go.textContent = "Обновить";
    el("upd-status").textContent = errText(e);
    say(errText(e), true);
  }
}

on(el("upd-go"), "click", () => runUpdate(false));
on(el("upd-later"), "click", () => el("update-bar").classList.remove("show"));
on(el("check-update"), "click", () => checkUpdate(true));
on(el("auto-update"), "change", () => savePrefs({ autoUpdate: el("auto-update").checked }));

if (listen) {
  listen("ofx-update-progress", (e) => {
    const p = e.payload || {};
    el("upd-go").textContent = p.pct != null ? p.pct + " %" : "качаю…";
    el("upd-title").textContent = "Обновление " + (pendingUpdate ? pendingUpdate.version : "");
    el("upd-sub").textContent = p.total
      ? bytes(p.done) + " из " + bytes(p.total)
      : bytes(p.done) + " загружено";
  });
}

/* ── startup ─────────────────────────────────────────────────────────────── */

function refreshProfileFields() {
  if (profile && profile.sub) el("sub-input").value = profile.sub;
  if (profile && profile.doc) el("doc-input").value = profile.doc;
}

async function refreshProfile() {
  try { profile = await invoke("load_token"); } catch (_) { profile = null; }
  refreshProfileFields();
  paintOfx();
  tick();
  return profile;
}

// The engine can outlive the window (or die on its own), so the truth is what
// get_status sees: a live child process or an answering Clash API.
async function syncStatus() {
  if (state === "connecting") return;
  let s = "off";
  try { s = await invoke("get_status"); } catch (_) {}
  if (s === "on" && state !== "on") {
    // движок подняли не кнопкой (автозапуск, плитка, iOS On Demand) — тоже
    // сначала убеждаемся, что выход отвечает, и только потом «подключено»
    setState("connecting");
    await loadServers();
    probeMsg = "проверяю сервер…"; tick();
    const ok = await waitForExit(isOfx(current) ? 60000 : 40000);
    if ((await invoke("get_status").catch(() => "off")) === "off") { setState("off"); return; }
    setState("on");
    if (!ok) setLinkBad(true);
    showEgress();
  }
  if (s === "off" && state === "on") {
    setState("off");
    await loadServers();
    // Android перезапускает сам (VpnSvc), а на iPhone тоннель гасит и сам
    // человек из «Настроек» — там молча поднимать его обратно нельзя.
    if (T.platform !== "android" && T.platform !== "ios") autoReconnect("соединение оборвалось");
  }
}

if (listen) {
  listen("ofx-log", (e) => {
    const line = String(e.payload);
    if (state === "connecting" || /ошиб|не удалось|!|exit-нода/i.test(line)) say(line);
    if (el("view-more").classList.contains("on")) loadLog();
  });
  listen("tray-connect", () => {
    if (state === "off" && prefs.policyAccepted === POLICY_VERSION) toggleConnection();
  });
  listen("tray-disconnect", () => { if (state === "on") toggleConnection(); });
  listen("tray-server", (e) => { const n = trayList[e.payload]; if (n && n !== current) choose(n); });
}

(async () => {
  try { prefs = await invoke("get_prefs"); } catch (_) { prefs = {}; }
  try { tweaks = await invoke("get_tweaks"); } catch (_) { tweaks = {}; }
  setTheme(prefs.theme || "dark");
  paintSubAuto();
  wireConsent();
  await policyGate();             // consent.js: без согласия с документами дальше не идём
  show("home");
  // до 1.0 режим и «весь трафик» были двумя разными настройками
  if (!prefs.routeMode) await savePrefs({ routeMode: prefs.fullTunnel === false ? "Rule" : "Global" });
  el("auto-connect").checked = !!prefs.autoConnect;
  el("autostart").checked = !!prefs.autostart;
  el("tray-on-close").checked = prefs.trayOnClose !== false;
  el("start-min").checked = !!prefs.startMinimized;
  el("auto-update").checked = prefs.autoUpdate !== false;
  el("keep-alive").checked = !!prefs.keepAlive;
  // раздел, где платформа спрятала все пункты (на iPhone нет трея и автозапуска), — не показываем пустым
  document.querySelectorAll("details.fold, .autohide").forEach((f) => {
    const items = [...f.querySelectorAll(".stack > *")];
    if (items.length && items.every((n) => getComputedStyle(n).display === "none")) {
      f.style.display = "none";
      const cap = f.previousElementSibling;
      if (cap && cap.classList.contains("autohide-label")) cap.style.display = "none";
    }
  });
  document.querySelectorAll("#srv-sort button").forEach((b) =>
    b.classList.toggle("on", b.dataset.sort === (prefs.srvSort || "panel")));
  current = prefs.server || null;
  loadArt();
  paintTech();
  renderPresets();
  renderRules();
  applyRouteMode(prefs.routeMode || "Global", true);
  setState("off");

  try {
    const a = await invoke("app_info");
    nativeVer = a.version || "";
    paintAdblock();
    el("about-ver").textContent = a.web ? a.version + " · интерфейс " + a.web : a.version;
    el("about-os").textContent = a.os === "windows" ? "Windows" : a.os === "macos" ? "macOS"
      : a.os === "android" ? "Android" : a.os === "ios" ? "iOS" : "Linux";
    el("about-dir").textContent = a.dataDir;
  } catch (_) {}

  const p = await refreshProfile();
  if (p && p.sub) {
    await loadServers();
    loadSubInfo();
  } else {
    // сразу главный экран: карточка «Подключите Telegram» на нём висит сама,
    // пока человек не войдёт (guest.js)
    say("войдите через Telegram, чтобы начать");
  }
  const link = await invoke("take_deep_link").catch(() => null);
  if (link) await importLink(link);
  await syncStatus();
  setInterval(syncStatus, 3000);
  // дата окончания подписки меняется (продлили) — и по ней напоминания
  setInterval(() => { if (profile && profile.sub) loadSubInfo(); }, 3 * 3600 * 1000);
  // окно поднялось — докачанный интерфейс рабочий (иначе телефон через три
  // запуска сам вернётся к встроенному)
  if (IS_ANDROID) invoke("web_ready").catch(() => {});
  setTimeout(() => checkUpdate(false), 5000);          // не мешаем первому экрану
  setInterval(() => checkUpdate(false), 6 * 3600 * 1000);
  if (prefs.autoConnect && state === "off" && profile && profile.sub) toggleConnection();
})();

/* ── импорт по ссылке vpnushka://import/<подписка> ───────────────────────── */
// Кнопка «Добавить в VPNUSHKA» в кабинете бота открывает такую ссылку
// (как happ://add/…): подписка ставится без копирования.

function linkToSub(link) {
  let s = String(link || "").trim().replace(/^vpnushka:\/*/i, "");
  s = s.replace(/^(import|add)\/?/i, "").replace(/^\?url=/i, "");
  if (!/^https?:/i.test(s)) { try { s = decodeURIComponent(s); } catch (_) {} }
  s = s.replace(/^(https?):\/*/i, "$1://");   // браузеры иногда съедают косую
  return /^https?:\/\/[^/]+\/./i.test(s) ? s : "";
}

async function importLink(link) {
  const url = linkToSub(link);
  if (!url) { say("ссылка не похожа на подписку", true); return; }
  // Открыть vpnushka:// может любой сайт — молча менять подписку разрешаем
  // только на нашу; чужую ссылку человек вставит сам в настройках.
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch (_) {}
  if (host !== "vpnushka.lol" && !host.endsWith(".vpnushka.lol")) {
    say("ссылка не от VPNUSHKA — если доверяете ей, вставьте её в Настройках → Подписка", true);
    return;
  }
  show("home");
  if (profile && profile.sub === url) { say("эта подписка уже добавлена"); return; }
  try {
    const guest = guestActive();
    const wasOn = state !== "off";
    if (guest) await endGuest(null, true);
    else if (wasOn) { setState("off"); await invoke("disconnect").catch(() => {}); }
    profile = await invoke("save_sub", { url });
    refreshProfileFields();
    say(wasOn ? "подписка добавлена — переподключаюсь" : "подписка добавлена — нажмите на картину, чтобы подключиться");
    await loadServers();
    loadSubInfo();
    tick();
    paintGuest();
    if (wasOn) await toggleConnection();
  } catch (e) { say(errText(e), true); }
}

if (listen) {
  listen("ofx-deep-link", () => invoke("take_deep_link").then((u) => u && importLink(u)).catch(() => {}));
}

/* ── напоминания об окончании подписки ───────────────────────────────────── */
// За 3 дня, за сутки и в день окончания. Телефоны ставят системные напоминания
// заранее (сработают и при закрытом приложении), ПК показывает уведомление, пока
// приложение запущено (оно обычно живёт в трее).

const DAY = 86400000;

function remindExpiry(s) {
  const card = el("exp-card");
  const end = s && s.expire ? s.expire * 1000 : 0;
  if (!end || guestActive()) {
    card.style.display = "none";
    if (IS_ANDROID) invoke("schedule_reminders", { items: [] }).catch(() => {});
    return;
  }
  const left = end - Date.now();
  const days = Math.ceil(left / DAY);
  const pct = s.total ? s.used / s.total * 100 : 0;
  card.style.display = left <= 3 * DAY || pct >= 80 ? "" : "none";
  el("exp-title").textContent = left <= 0 ? "Подписка закончилась"
    : days <= 1 ? "Подписка закончится в течение суток"
    : left <= 3 * DAY ? "Подписка закончится через " + days + " дн."
    : pct >= 100 ? "Трафик закончился"
    : "Израсходовано " + Math.floor(pct) + "% трафика";
  remindTraffic(s, pct);
  const items = [
    { id: 1, at: end - 3 * DAY, body: "Подписка закончится через 3 дня. Продлить — в приложении, раздел «Кабинет»." },
    { id: 2, at: end - DAY, body: "Подписка закончится завтра — продлите, чтобы VPN не отключился." },
    { id: 3, at: end, body: "Подписка закончилась. Продлить можно в приложении, раздел «Кабинет»." },
  ];
  if (IS_ANDROID) {
    const future = items.filter((i) => i.at > Date.now()).map((i) => ({ ...i, title: "VPNUSHKA" }));
    invoke("schedule_reminders", { items: future }).catch(() => {});
    return;
  }
  const due = items.filter((i) => i.at <= Date.now() && Date.now() - i.at < 2 * DAY).pop();
  if (!due) return;
  const key = s.expire + ":" + due.id;
  if (prefs.remindedExpiry === key) return;
  savePrefs({ remindedExpiry: key });
  invoke("notify", { title: "VPNUSHKA", body: due.body }).catch(() => {});
}

// Трафик — по факту, а не по расписанию: уведомление один раз на порог (80/95/100%)
// в пределах подписки; после продления (новый expire) счёт начинается заново.
function remindTraffic(s, pct) {
  const step = [100, 95, 80].find((p) => pct >= p);
  if (!step) return;
  const key = s.expire + ":t" + step;
  if (prefs.remindedTraffic === key) return;
  savePrefs({ remindedTraffic: key });
  invoke("notify", { title: "VPNUSHKA", body: step >= 100
    ? "Трафик по подписке закончился. Продлить или докупить — в приложении, раздел «Кабинет»."
    : "Израсходовано " + step + "% трафика (" + bytes(s.used) + " из " + bytes(s.total) + ")." }).catch(() => {});
}

on(el("exp-card"), "click", () => show("account"));

/* ── Auto: перевыбор сервера и переподключение ───────────────────────────── */
// Только при автовыборе (urltest): там клиент волен сменить сервер сам. Если
// человек выбрал конкретный сервер, молча уводить его на другой нельзя.

const PROBE = "&url=" + encodeURIComponent("https://www.gstatic.com/generate_204");

function autoSelected() {
  return !!current && !guestActive()
    && (liveType[current] === "URLTest" || (info[current] || {}).type === "urltest");
}

function autoReconnect(why) {
  if (!autoSelected() || autoTimer) return;
  if (autoRetry >= 3) { say("не удалось восстановить соединение — подключитесь вручную", true); return; }
  const wait = [3, 10, 30][autoRetry++];
  say(why + " — Auto переподключится через " + wait + " с");
  autoTimer = setTimeout(async () => {
    autoTimer = null;
    if (state !== "off" || !autoSelected()) return;
    await toggleConnection();
    if (state !== "on") autoReconnect("не подключилось");
  }, wait * 1000);
}

// Пока подключены: живой ли сервер, который Auto сейчас держит. Не отвечает —
// просим urltest перемерить всех (он сам уйдёт на живой); не помогло трижды
// подряд — переподключаемся целиком (сменилась сеть, упал движок).
async function autoWatch() {
  if (state !== "on" || !autoSelected() || navigator.onLine === false) return;
  const g = encodeURIComponent(current);
  try {
    const r = await clash("/proxies/" + g + "/delay?timeout=6000" + PROBE);
    if (r && r.delay > 0) { watchFails = 0; autoRetry = 0; return; }
  } catch (_) { /* no answer through it */ }
  watchFails++;
  // На «Мобильные операторы» сами не уводим: сервер выбирает человек — Auto
  // только перемеряет свои серверы и при необходимости переподключается.
  if (watchFails === 1) {
    say("сервер не отвечает — Auto ищет другой");
    clash("/group/" + g + "/delay?timeout=6000" + PROBE).then(loadServers).catch(() => {});
  } else if (watchFails === 2 && servers.some((s) => isOfx(s.name))) {
    say("обычные серверы не отвечают — если вы в мобильной сети с ограничениями, выберите «Мобильные операторы» в списке серверов", true);
  } else if (watchFails >= 3) {
    watchFails = 0;
    setState("off");
    await invoke("disconnect").catch(() => {});
    await loadServers();
    autoReconnect("связь через сервер пропала");
  }
}
setInterval(autoWatch, 20000);

// Сменилась сеть (Wi-Fi ↔ мобильная, проснулся ноутбук): сразу перемеряем
window.addEventListener("online", () => {
  if (state === "on" && autoSelected()) {
    clash("/group/" + encodeURIComponent(current) + "/delay?timeout=6000" + PROBE).then(loadServers).catch(() => {});
  } else if (state === "off" && autoTimer === null && autoRetry > 0) {
    autoReconnect("сеть вернулась");
  }
});
