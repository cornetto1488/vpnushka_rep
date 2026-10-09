/* ── Закреплённые правила режимов ─────────────────────────────────────────────
   Готовые режимы — это тоже правила, просто встроенные. Показываем их тем же
   списком, что и свои, но с замком: посмотреть можно (вплоть до каждого сайта
   в списке), убрать — нельзя. Порядок — как в движке (connect/modes.go):
   сверху вниз, решает первое подходящее. Данные — presetdata.js. */

const PIN_SET_ORDER = ["ru-bundle", "geosite-telegram", "geoip-telegram", "geosite-whatsapp",
                       "geosite-tiktok", "discord-voice-ip-list", "viber_aws_ip"];
const PIN_SET_TITLES = { "ru-bundle": "Заблокированное в России" };

// plural — из invite.js
function countText(p) {
  const parts = [];
  const d = (p.domains || []).length, i = (p.ips || []).length, a = (p.apps || []).length;
  if (d) parts.push(d + " " + plural(d, "сайт", "сайта", "сайтов"));
  if (i) parts.push(i + " " + plural(i, "сеть", "сети", "сетей"));
  if (a) parts.push(a + " " + plural(a, "программа", "программы", "программ"));
  return parts.join(" · ");
}

// списки подписки: в клиенте все они идут через VPN (см. inject в connect/main.go)
function presetSetRows() {
  const used = baseline ? [...(baseline.viaServer || []), ...(baseline.direct || [])] : PIN_SET_ORDER;
  const known = new Set(PIN_SET_ORDER);
  const tags = [...PIN_SET_ORDER.filter((t) => used.includes(t)), ...used.filter((t) => !known.has(t))];
  const rows = new Map();     // Telegram: сайты и сети — одной строкой
  for (const t of tags) {
    const name = PIN_SET_TITLES[t] || SET_NAMES[t] || t;
    const r = rows.get(name) || { what: name, verdict: "proxy", domains: [], ips: [] };
    const s = PRESET_DATA.sets[t] || {};
    r.domains.push(...(s.domains || []));
    r.ips.push(...(s.ips || []));
    rows.set(name, r);
  }
  return [...rows.values()];
}

function presetRuleRows(mode) {
  const D = PRESET_DATA, rows = [];
  if (tweaks.adblock) rows.push({ what: "Реклама и трекеры", verdict: "block", note: "включено в «Блокировке рекламы»" });
  const rest = (verdict) => rows.push({ what: "Всё остальное", verdict, last: true });
  const rule = () => {
    rows.push({ what: "Заблокированные игры", verdict: "proxy", domains: D.presetExtra });
    rows.push({ what: "Сайты проверки IP", verdict: "proxy", domains: D.ipCheck,
                note: "чтобы было видно, что VPN работает" });
    rows.push(...presetSetRows());
    rest("direct");
  };
  if (mode === "Global") rest("proxy");
  else if (mode === "Direct") rest("direct");
  else if (mode === "Games") {
    const bundle = D.sets["ru-bundle"] || {};
    rows.push({ what: "Заблокированное в России", verdict: "proxy", domains: bundle.domains,
                note: "даже если это игра — иначе она не откроется" });
    const g = D.sets.games || {};
    rows.push({ what: "Игры: сайты и серверы", verdict: "direct", domains: g.domains, ips: g.ips });
    if (T.platform === "android") rows.push({ what: "Игровые приложения", verdict: "direct", apps: D.gameApps });
    else if (!IS_ANDROID) rows.push({ what: "Игры и лаунчеры", verdict: "direct", apps: D.gameProcesses });
    rest("proxy");
  } else if (mode === "Rule") rule();
  else {            // Custom: после правил человека — «остальное»
    const base = customBase();
    if (base === "rule") rule();
    else rest(base);
  }
  return rows;
}

const PIN_CAPS = {
  Global: "Правила режима «Всё через VPN»", Games: "Правила режима «Игровой»",
  Rule: "Правила фирменного пресета", Direct: "Правила режима «Всё напрямую»",
  Custom: "После ваших правил",
};
const LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" '
  + 'stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';

function renderPresetRules() {
  const card = el("preset-card");
  if (!card || typeof PRESET_DATA === "undefined") return;
  const mode = prefs.routeMode || "Global";
  // в «Своих правилах» закреплённое срабатывает после правил человека — и стоит под ними
  const rules = el("rules-card");
  if (mode === "Custom") { if (rules.nextElementSibling !== card) rules.after(card); }
  else if (card.nextElementSibling !== rules) rules.before(card);
  el("preset-cap").textContent = PIN_CAPS[mode] || "";
  el("preset-hint").textContent = mode === "Custom"
    ? "Ваши правила проверяются первыми, затем — эти. Их меняет переключатель «Всё, что не в правилах»."
    : "Встроены в режим — их нельзя убрать. Проверяются сверху вниз. Нажмите на список, чтобы увидеть, что в нём.";
  const box = el("preset-list");
  box.textContent = "";
  for (const r of presetRuleRows(mode)) {
    const list = !!((r.domains || []).length || (r.ips || []).length || (r.apps || []).length);
    const row = document.createElement(list ? "button" : "div");
    row.className = "rule pin" + (list ? " tap" : "") + (r.last ? " last" : "");
    const lock = document.createElement("span");
    lock.className = "lock";
    lock.innerHTML = LOCK;
    const what = document.createElement("span");
    what.className = "what";
    const b = document.createElement("b");
    b.textContent = r.what;
    what.append(b);
    const sub = list ? countText(r) : r.note || "";
    if (sub) {
      const s = document.createElement("small");
      s.textContent = sub + (list && r.note ? " — " + r.note : "");
      what.append(s);
    }
    const vd = document.createElement("span");
    vd.className = "vd " + r.verdict;
    vd.textContent = VERDICTS[r.verdict];
    row.append(lock, what, vd);
    if (list) {
      const ch = document.createElement("span");
      ch.className = "chev";
      row.append(ch);
      row.addEventListener("click", () => openPinList(r));
    }
    box.append(row);
  }
}

/* содержимое списка — с поиском: «есть ли тут мой сайт?» */
let pinItems = [];
function openPinList(r) {
  el("pin-title").textContent = r.what;
  el("pin-sub").textContent = countText(r) + " · " + VERDICTS[r.verdict].replace(/^./, (c) => c.toLowerCase())
    + ". Сайт из списка подходит вместе с поддоменами.";
  pinItems = [...(r.domains || []).map((v) => [showDomain(v), ""]),
              ...(r.ips || []).map((v) => [v, "IP"]),
              ...(r.apps || []).map((v) => [v, ""])];
  el("pin-q").value = "";
  paintPinList();
  sheet("sheet-pin", true);
}
function paintPinList() {
  const q = el("pin-q").value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  const box = el("pin-items");
  box.textContent = "";
  // youtube.com найдётся и по «m.youtube.com» — так же, как сработало бы правило
  const hit = (v) => !q || v.toLowerCase().includes(q) || (q.endsWith("." + v.toLowerCase().replace(/^\./, "")));
  const found = pinItems.filter(([v]) => hit(v));
  const frag = document.createDocumentFragment();
  for (const [v, tag] of found.slice(0, 3000)) {
    const d = document.createElement("div");
    d.className = "pin-item";
    d.textContent = v;
    if (tag) { const t = document.createElement("i"); t.textContent = tag; d.append(t); }
    frag.append(d);
  }
  box.append(frag);
  el("pin-none").style.display = found.length ? "none" : "";
  el("pin-none").textContent = q ? "«" + q + "» в этом списке нет" : "Список пуст";
}
on(el("pin-q"), "input", paintPinList);

renderPresetRules();
