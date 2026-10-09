/* ── Свои правила: обмен набором и «куда пойдёт сайт» (2.0.6) ─────────────── */

/* Обмен: набор правил — одна строка «vpnushka-rules:…» (JSON в base64url).
   Её можно переслать другу или прислать из поддержки; импорт добавляет
   правила к своим (у совпадающих записей побеждает присланный вердикт). */

const RULES_PREFIX = "vpnushka-rules:";
const RULE_KINDS = ["apps", "domains", "ips"];
const RULE_VERDICTS = ["proxy", "direct", "block"];

function b64urlEncode(text) {
  const bin = Array.from(new TextEncoder().encode(text), (b) => String.fromCharCode(b)).join("");
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function exportRules() {
  const r = routing();
  const out = { v: 1, base: customBase(), off: tweaks.customOff || [], routing: {} };
  for (const k of RULE_KINDS) {
    for (const v of RULE_VERDICTS) {
      const list = ((r[k] || {})[v] || []).filter(Boolean);
      if (list.length) (out.routing[k] = out.routing[k] || {})[v] = list;
    }
  }
  return RULES_PREFIX + b64urlEncode(JSON.stringify(out));
}

function parseRules(text) {
  let s = String(text || "").trim();
  const i = s.indexOf(RULES_PREFIX);
  if (i < 0) throw new Error("это не набор правил — строка должна начинаться с «" + RULES_PREFIX + "»");
  s = s.slice(i + RULES_PREFIX.length).split(/\s/)[0];
  let d;
  try { d = JSON.parse(b64urlDecode(s)); } catch (_) { throw new Error("строка повреждена — скопируйте её целиком"); }
  if (!d || typeof d.routing !== "object") throw new Error("в строке нет правил");
  const clean = {};
  let n = 0;
  for (const k of RULE_KINDS) {
    for (const v of RULE_VERDICTS) {
      const list = ((d.routing[k] || {})[v] || []);
      if (!Array.isArray(list)) continue;
      for (const raw of list.slice(0, 2000)) {
        if (typeof raw !== "string") continue;
        const item = normalizeRule(k, raw);
        if (!item || item.length > 200) continue;
        ((clean[k] = clean[k] || {})[v] = clean[k][v] || []).push(item);
        n++;
      }
    }
  }
  if (!n && !d.base) throw new Error("в наборе нет ни одного правила");
  const off = Array.isArray(d.off) ? d.off.filter((k) => typeof k === "string" && k.length < 40).slice(0, 40) : null;
  return { routing: clean, base: CUSTOM_BASES[d.base] ? d.base : null, off, count: n };
}

async function importRules(text) {
  const p = parseRules(text);
  for (const k of RULE_KINDS) {
    for (const v of RULE_VERDICTS) {
      for (const item of ((p.routing[k] || {})[v] || [])) {
        // на Android приложение можно только вывести из VPN или пустить «только его»
        for (const other of RULE_VERDICTS) {
          const l = bucket(k, other);
          const j = l.indexOf(item);
          if (j >= 0) l.splice(j, 1);
        }
        bucket(k, v).push(item);
      }
    }
  }
  if (p.base && p.base !== tweaks.customBase) await saveTweaks({ customBase: p.base });
  if (p.off) await saveTweaks({ customOff: p.off });
  await saveRouting(true);
  paintRouteMode();
  return p.count;
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (_) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (_) {}
    ta.remove();
    return ok;
  }
}

on(el("rules-share"), "click", () => {
  el("rules-io-out").value = exportRules();
  el("rules-io-in").value = "";
  el("rules-io-msg").textContent = "";
  sheet("sheet-rules-io", true);
});
on(el("rules-io-copy"), "click", async () => {
  const ok = await copyText(el("rules-io-out").value);
  el("rules-io-msg").className = "msg" + (ok ? " ok" : " err");
  el("rules-io-msg").textContent = ok ? "Скопировано — отправьте строку тому, кому нужны правила"
    : "Не скопировалось — выделите строку вручную";
});
on(el("rules-io-out"), "focus", (e) => e.target.select());
on(el("rules-io-import"), "click", async () => {
  const m = el("rules-io-msg");
  try {
    const n = await importRules(el("rules-io-in").value);
    m.className = "msg ok";
    m.textContent = "Добавлено правил: " + n + ". Включён режим «Свои правила».";
    el("rules-io-in").value = "";
    el("rules-io-out").value = exportRules();
  } catch (e) {
    m.className = "msg err";
    m.textContent = errText(e);
  }
});

/* «Куда пойдёт сайт?» Ядро не умеет отвечать на вопрос «по какому правилу
   пошёл бы X» — поэтому спрашиваем его делом: открываем соединение к сайту и
   смотрим его в Clash API /connections (там выход и сработавшее правило).
   На Android само окно выведено из тоннеля — соединение открывает натив через
   SOCKS ядра (probe_route), туда же, куда приходит весь трафик телефона. */

// порядок важен: правило «domain_suffix=… clash_mode=Custom» — это правило
// человека, а не «всё остальное» режима
const RULE_WHY = [
  [/vpnushka-games/, "по списку игр режима «Игровой»"],
  [/vpnushka-adblock/, "блокировка рекламы"],
  [/2ip\.ru|ipify|ifconfig/, "сайты проверки IP — всегда через VPN"],
  [/ru-bundle|geosite-|geoip-|discord|viber/, "по спискам фирменного пресета"],
  [/domain_suffix|domain=|domain_keyword|ip_cidr|process_name|package_name/, "правило"],
  [/clash_mode=Global/i, "режим «Всё через VPN»"],
  [/clash_mode=Direct/i, "режим «Всё напрямую»"],
  [/clash_mode=Games/i, "режим «Игровой»: не игра — через VPN"],
  [/clash_mode=Custom/i, "«Свои правила»: всё, что не в правилах"],
  [/clash_mode=Rule/i, "фирменный пресет"],
];

function routeWhy(rule) {
  const cond = String(rule || "").split("=>")[0].replace(/\s*clash_mode=\w+/g, "").trim();
  if (!rule) return "";
  if (!/=/.test(String(rule).split("=>")[0])) return "ни одно правило не подошло — по умолчанию";
  for (const [re, t] of RULE_WHY) if (re.test(rule)) {
    if (t !== "правило") return t;
    const mine = prefs.routeMode === "Custom" && /clash_mode=Custom/.test(rule);
    return (mine ? "ваше правило" : "встроенное правило") + " (" + cond.slice(0, 80) + ")";
  }
  return cond.slice(0, 80);
}

async function checkRoute() {
  const out = el("route-check-out");
  const host = normalizeRule("domains", el("route-check-in").value);
  if (!host || !/\./.test(host)) { out.className = "hint"; out.textContent = "Введите адрес сайта, например youtube.com"; return; }
  if (state !== "on") { out.className = "hint"; out.textContent = "Подключитесь — проверка смотрит, как ведёт сайт работающий VPN."; return; }
  const btn = el("route-check-btn");
  btn.disabled = true;
  out.className = "hint";
  out.textContent = "проверяю " + host + "…";
  const seen = new Set();
  try {
    const before = await clash("/connections").catch(() => ({}));
    for (const c of (before && before.connections) || []) seen.add(c.id);
    if (T.platform === "android") invoke("probe_route", { host }).catch(() => {});
    else fetch("https://" + host + "/", { mode: "no-cors", cache: "no-store" }).catch(() => {});
    let hit = null;
    for (let i = 0; i < 20 && !hit; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const d = await clash("/connections").catch(() => ({}));
      hit = ((d && d.connections) || []).find((c) => !seen.has(c.id) && c.metadata
        && (c.metadata.host === host || String(c.metadata.host || "").endsWith("." + host)));
    }
    if (!hit) {
      out.className = "hint warn";
      out.textContent = host + ": соединения не было — сайт заблокирован правилом «Блокировать» или рекламным фильтром, "
        + "либо не ответил. Проверьте свои правила.";
      return;
    }
    const chain = hit.chains || [];
    const exit = chain[0] || "";
    const direct = /^direct$/i.test(exit);
    const why = routeWhy(hit.rule);
    out.className = "hint " + (direct ? "" : "ok");
    out.textContent = host + " → " + (direct ? "напрямую, мимо VPN" : "через VPN, сервер " + cleanName(exit))
      + (why ? " · " + why : "") + ".";
  } finally {
    btn.disabled = false;
  }
}

on(el("route-check-btn"), "click", checkRoute);
on(el("route-check-in"), "keydown", (e) => { if (e.key === "Enter") checkRoute(); });
