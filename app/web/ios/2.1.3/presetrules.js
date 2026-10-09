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
  if (p.games) return p.games.length + " " + plural(p.games.length, "игра", "игры", "игр");
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
    const r = rows.get(name) || { what: name, verdict: "proxy", domains: [], ips: [], off: [] };
    r.off.push(t);
    const s = PRESET_DATA.sets[t] || {};
    r.domains.push(...(s.domains || []));
    r.ips.push(...(s.ips || []));
    rows.set(name, r);
  }
  return [...rows.values()];
}

// off — ключи tweaks.customOff (connect/modes.go customRules): выключенное
// в «Своих правилах» идёт как «всё остальное» основы
function presetRuleRows(mode) {
  const D = PRESET_DATA, rows = [];
  const custom = mode === "Custom";
  const base = custom ? customBase() : null;
  const like = custom ? { proxy: "Global", games: "Games", rule: "Rule", direct: "Direct" }[base] : mode;
  if (tweaks.adblock) rows.push({ what: "Реклама и трекеры", verdict: "block", note: "включено в настройках" });
  const rest = (verdict) => rows.push({ what: "Всё остальное", verdict, last: true });
  if (like === "Global") rest("proxy");
  else if (like === "Direct") rest("direct");
  else if (like === "Games") {
    const bundle = D.sets["ru-bundle"] || {};
    rows.push({ what: "Заблокированное в России", verdict: "proxy", domains: bundle.domains, off: ["ru-bundle"],
                note: "даже если это игра — иначе она не откроется" });
    const g = D.sets.games || {};
    if (T.platform === "android") rows.push({ what: "Игровые приложения", verdict: "direct", apps: D.gameApps,
                                              games: D.mobileGames, off: ["gameApps"] });
    else if (!IS_ANDROID) rows.push({ what: "Игры и лаунчеры", verdict: "direct", apps: D.gameProcesses,
                                      games: D.pcGames, off: ["gameProcesses"] });
    rows.push({ what: "Сайты и серверы игр", verdict: "direct", domains: g.domains, ips: g.ips, off: ["games"] });
    rest("proxy");
  } else {
    rows.push({ what: "Заблокированные игры", verdict: "proxy", domains: D.presetExtra, off: ["presetExtra"] });
    rows.push({ what: "Сайты проверки IP", verdict: "proxy", domains: D.ipCheck, off: ["ipCheck"],
                note: "чтобы было видно, что VPN работает" });
    rows.push(...presetSetRows());
    rest("direct");
  }
  if (custom) {
    const off = new Set(tweaks.customOff || []);
    for (const r of rows) if (r.off) r.disabled = r.off.every((k) => off.has(k));
  }
  return rows;
}

const PIN_CAPS = {
  Global: "Правила режима «Всё через VPN»", Games: "Правила режима «Игровой»",
  Rule: "Правила фирменного пресета", Direct: "Правила режима «Всё напрямую»",
  Custom: "Свои правила",
};
const LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" '
  + 'stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';

// иконки игр: до шести штук в строку, остальное — «+N»
function gameStrip(games) {
  const box = document.createElement("span");
  box.className = "gstrip";
  const withIco = (games || []).filter((g) => g.icon);
  for (const g of withIco.slice(0, 6)) {
    const i = document.createElement("img");
    i.src = g.icon; i.alt = ""; i.title = g.name; i.loading = "lazy";
    box.append(i);
  }
  if ((games || []).length > 6) {
    const m = document.createElement("em");
    m.textContent = "+" + (games.length - 6);
    box.append(m);
  }
  return box;
}

function renderPresetRules() {
  const card = el("preset-list");
  if (!card || typeof PRESET_DATA === "undefined") return;
  const mode = prefs.routeMode || "Global";
  const custom = mode === "Custom";
  el("preset-cap").textContent = PIN_CAPS[mode] || "";
  el("base-cap").textContent = "Из основы «" + ({ proxy: "Всё через VPN", games: "Игровой", rule: "Пресет",
                                                  direct: "Напрямую" }[customBase()]) + "»";
  el("preset-hint").textContent = custom
    ? "Ваши правила срабатывают первыми. Выключите в основе то, что не нужно, — оно пойдёт как «всё остальное»."
    : "Встроены в режим и не меняются. Хотите убрать или добавить что-то — «Настроить под себя».";
  const box = el("preset-list");
  box.textContent = "";
  for (const r of presetRuleRows(mode)) {
    const list = !!((r.domains || []).length || (r.ips || []).length || (r.apps || []).length);
    const row = document.createElement("div");
    row.className = "rule pin" + (list ? " tap" : "") + (r.last ? " last" : "") + (r.disabled ? " off" : "");
    let lead;
    if (custom && r.off) {
      lead = document.createElement("label");
      lead.className = "sw mini";
      lead.title = r.disabled ? "Включить" : "Выключить";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !r.disabled;
      cb.addEventListener("change", () => toggleBasePart(r.off, !cb.checked));
      lead.append(cb, document.createElement("i"));
      lead.addEventListener("click", (e) => e.stopPropagation());
    } else {
      lead = document.createElement("span");
      lead.className = "lock";
      lead.innerHTML = LOCK;
    }
    const what = document.createElement("span");
    what.className = "what";
    const b = document.createElement("b");
    b.textContent = r.what;
    what.append(b);
    const sub = r.disabled ? "выключено — идёт как всё остальное" : list ? countText(r) : r.note || "";
    if (r.games && !r.disabled) what.append(gameStrip(r.games));
    else if (sub) {
      const s = document.createElement("small");
      s.textContent = sub;
      what.append(s);
    }
    const vd = document.createElement("span");
    vd.className = "vd " + r.verdict;
    vd.textContent = VERDICTS[r.verdict];
    row.append(lead, what, vd);
    if (list) {
      const ch = document.createElement("span");
      ch.className = "chev";
      row.append(ch);
      row.addEventListener("click", () => openPinList(r));
    }
    box.append(row);
  }
}

async function toggleBasePart(keys, off) {
  const set = new Set(tweaks.customOff || []);
  for (const k of keys) off ? set.add(k) : set.delete(k);
  await saveTweaks({ customOff: [...set] });
  renderPresetRules();
  say((off ? "выключено" : "включено") + (state === "on" ? " — применится при следующем подключении" : ""));
}

/* содержимое списка — с поиском («есть ли тут мой сайт?») и исключениями:
   «исключить» добавляет своё правило с обратным вердиктом, а свои правила
   срабатывают раньше основы. Не в «Своих правилах» — переходим в них с
   основой от текущего режима (enterCustom), так что больше ничего не меняется. */
let pinItems = [], pinRow = null;
function openPinList(r) {
  pinRow = r;
  el("pin-title").textContent = r.what;
  el("pin-sub").textContent = countText(r) + " · " + VERDICTS[r.verdict].replace(/^./, (c) => c.toLowerCase())
    + (r.games ? "." : ". Сайт подходит вместе с поддоменами.");
  const own = new Set();
  pinItems = [];
  if (r.games) {           // игры — по одной строке с иконкой, файлы/пакеты мелко
    for (const g of r.games) {
      const vals = g.procs || g.pkgs || [];
      vals.forEach((v) => own.add(v));
      pinItems.push({ label: g.name, sub: vals.join(", "), icon: g.icon, kind: "apps", vals });
    }
  }
  for (const v of r.apps || []) if (!own.has(v)) pinItems.push({ label: v, kind: "apps", vals: [v] });
  for (const v of r.domains || []) pinItems.push({ label: showDomain(v), kind: "domains", vals: [v] });
  for (const v of r.ips || []) pinItems.push({ label: v, tag: "IP", kind: "ips", vals: [v] });
  el("pin-q").value = "";
  el("pin-q").placeholder = r.games ? "найти игру, например Dota 2" : "найти сайт, например youtube.com";
  paintPinList();
  sheet("sheet-pin", true);
}

const opposite = (v) => v === "proxy" ? "direct" : "proxy";
// исключать можно сайты и сети, а на ПК — и программы; приложения телефона —
// нет: «через VPN» там значит «только эти через VPN» (см. VpnSvc)
const canExclude = (it) => pinRow && pinRow.verdict !== "block" && !pinRow.last
  && (it.kind !== "apps" || !IS_ANDROID) && it.vals.every((v) => !/[\\^$*()[\]]/.test(v));
const isOwn = (it) => it.vals.every((v) => ["proxy", "direct", "block"].some((vd) => bucket(it.kind, vd).includes(v)));

async function excludeItem(it) {
  for (const v of it.vals) {
    for (const vd of ["proxy", "direct", "block"]) {
      const l = bucket(it.kind, vd), i = l.indexOf(v);
      if (i >= 0) l.splice(i, 1);
    }
    bucket(it.kind, opposite(pinRow.verdict)).push(v);
  }
  await saveRouting(true);
  say(it.label + " — теперь " + VERDICTS[opposite(pinRow.verdict)].toLowerCase().replace("vpn", "VPN")
      + (state === "on" ? ", после переподключения" : ""));
  paintPinList();
}

function paintPinList() {
  const q = el("pin-q").value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  const box = el("pin-items");
  box.textContent = "";
  // youtube.com найдётся и по «m.youtube.com» — так же, как сработало бы правило
  const hit = (it) => !q || it.label.toLowerCase().includes(q) || (it.sub || "").toLowerCase().includes(q)
    || it.vals.some((v) => q.endsWith("." + v.toLowerCase().replace(/^\./, "")));
  const found = pinItems.filter(hit);
  const frag = document.createDocumentFragment();
  for (const it of found.slice(0, 3000)) {
    const d = document.createElement("div");
    d.className = "pin-item" + (it.icon || it.sub ? " game" : "");
    if (it.icon) { const i = document.createElement("img"); i.src = it.icon; i.alt = ""; i.loading = "lazy"; d.append(i); }
    const tx = document.createElement("span");
    tx.className = "tx";
    const b = document.createElement("b");
    b.textContent = it.label;
    tx.append(b);
    if (it.sub && it.sub !== it.label) { const s = document.createElement("small"); s.textContent = it.sub; tx.append(s); }
    d.append(tx);
    if (it.tag) { const t = document.createElement("i"); t.textContent = it.tag; d.append(t); }
    if (isOwn(it)) {
      const t = document.createElement("i");
      t.className = "own";
      t.textContent = "в ваших правилах";
      d.append(t);
    } else if (canExclude(it)) {
      const x = document.createElement("button");
      x.className = "excl";
      x.textContent = "исключить";
      x.title = "Пустить " + (pinRow.verdict === "proxy" ? "мимо VPN" : "через VPN") + " своим правилом";
      x.addEventListener("click", () => excludeItem(it));
      d.append(x);
    }
    frag.append(d);
  }
  box.append(frag);
  el("pin-none").style.display = found.length ? "none" : "";
  el("pin-none").textContent = q ? "«" + q + "» в этом списке нет" : "Список пуст";
}
on(el("pin-q"), "input", paintPinList);

on(el("route-check-open"), "click", () => {
  sheet("sheet-route-check", true);
  setTimeout(() => el("route-check-in").focus(), 250);
});

renderPresetRules();
