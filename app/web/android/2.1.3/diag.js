/* ── «Проверить связь»: самодиагностика одной кнопкой (2.0.6) ───────────────
   Проходит по цепочке, на которой обычно ломается: подписка → тоннель →
   выход через сервер → DNS → нужные сайты через сервер → остальные серверы.
   Итог — одна строка «что не так и что делать», подробности — списком, и
   кнопка «Отправить в поддержку» (чат поддержки с готовым отчётом).

   Сайты проверяются замером через выход сервера (Clash API /proxies/X/delay),
   а не fetch из окна: на Android само приложение выведено из тоннеля, и fetch
   показал бы связь без VPN. */

let diagBusy = false;
let diagReport = "";

// что проверяем «через сервер»: заблокированное в РФ и то, о чём спрашивают чаще
const DIAG_SITES = [
  ["YouTube", "https://www.youtube.com/generate_204"],
  ["Telegram", "https://telegram.org/"],
  ["Instagram", "https://www.instagram.com/"],
];
// Турция сама режет часть сайтов — частый вопрос «почему не открывается»
const DIAG_TR_NOTE = "Турция сама блокирует часть сайтов (взрослые, Wattpad и др.) — для них выберите Францию или США.";

function diagRow(box, title) {
  const r = document.createElement("div");
  r.className = "diag-row wait";
  const i = document.createElement("span"); i.className = "diag-ico";
  const t = document.createElement("span"); t.className = "diag-tx";
  const b = document.createElement("b"); b.textContent = title;
  const s = document.createElement("span"); s.className = "sub"; s.textContent = "проверяю…";
  t.append(b, s);
  r.append(i, t);
  box.append(r);
  return (tone, text) => { r.className = "diag-row " + tone; s.textContent = text; };
}

// задержка через конкретный выход до url; 0 — не ответил
async function diagDelay(name, url, ms) {
  try {
    const r = await clash("/proxies/" + encodeURIComponent(name) + "/delay?timeout=" + (ms || 6000)
      + "&url=" + encodeURIComponent(url));
    return r && r.delay > 0 ? r.delay : 0;
  } catch (_) { return 0; }
}

// конкретный сервер, через который сейчас идёт трафик (группу раскрываем)
async function diagExitName() {
  let name = current;
  for (let i = 0; i < 4 && name; i++) {
    const p = await clash("/proxies/" + encodeURIComponent(name)).catch(() => null);
    if (!p || !p.now || !/selector|urltest|fallback/i.test(p.type || "")) break;
    name = p.now;
  }
  return name;
}

async function runDiag() {
  if (diagBusy) return;
  diagBusy = true;
  const box = el("diag-list");
  box.textContent = "";
  el("diag-verdict").textContent = "Проверяю…";
  el("diag-verdict").className = "diag-verdict";
  el("diag-send").disabled = true;
  el("diag-run").disabled = true;
  const lines = [];                        // для отчёта в поддержку
  const problems = [];                     // [важность, совет, действие: [надпись, fn] | "switch"]
  let bestAlt = null;                      // самый быстрый живой сервер, кроме текущего
  const put = (row, tone, text, title) => { row(tone, text); lines.push((tone === "ok" ? "✓ " : tone === "warn" ? "! " : "✗ ") + title + ": " + text); };

  try {
    // 1. подписка
    const rSub = diagRow(box, "Подписка");
    if (!profile || !profile.sub) {
      put(rSub, "bad", "не добавлена — войдите в кабинет или вставьте ссылку", "Подписка");
      problems.push([0, "Нет подписки: войдите в кабинет или вставьте ссылку в Настройки → Подписка.", ["Войти в кабинет", () => show("account")]]);
    } else {
      try {
        const s = await invoke("sub_status");
        const left = s.expire ? s.expire * 1000 - Date.now() : Infinity;
        const pct = s.total ? s.used / s.total * 100 : 0;
        if (left <= 0) {
          put(rSub, "bad", "закончилась", "Подписка");
          problems.push([0, "Подписка закончилась — продлите её, и VPN заработает.", ["Продлить подписку", () => goRenew()]]);
        } else if (pct >= 100) {
          put(rSub, "bad", "трафик израсходован (" + bytes(s.used) + ")", "Подписка");
          problems.push([0, "Трафик по подписке закончился — продлите или докупите его.", ["Продлить подписку", () => goRenew()]]);
        } else {
          put(rSub, left < 3 * 86400000 ? "warn" : "ok", s.expire
            ? "активна, осталось " + Math.max(1, Math.ceil(left / 86400000)) + " дн." + (s.total ? " · трафик " + Math.floor(pct) + "%" : "")
            : "активна", "Подписка");
        }
      } catch (e) {
        const msg = errText(e);
        put(rSub, "warn", "сервер подписок не ответил (" + msg + ")", "Подписка");
        if (typeof DEVICE_LIMIT !== "undefined" && DEVICE_LIMIT.test(msg)) {
          problems.push([0, "Заняты все места для устройств — освободите место в кабинете.", ["Открыть кабинет", () => show("account")]]);
        }
      }
    }

    // 2. тоннель
    const rTun = diagRow(box, "VPN");
    if (state !== "on") {
      put(rTun, "warn", state === "connecting" ? "подключается…" : "выключен — дальше проверю, когда подключитесь", "VPN");
      if (!problems.length) problems.push([1, "VPN выключен — подключитесь, и проверка пройдёт до конца.", ["Подключить", async () => {
        await toggleConnection(); if (state === "on") runDiag(); }]]);
      return finish();
    }
    put(rTun, "ok", "включён · режим «" + (ROUTE_MODES[prefs.routeMode || "Global"] || "—") + "»"
      + (prefs.mode === "proxy" ? " · прокси" : ""), "VPN");

    // 3. выход через сервер
    const rExit = diagRow(box, "Сервер");
    const exit = await diagExitName();
    const exitMs = exit ? await diagDelay(exit, PROBE_URL, 6000) : 0;
    const exitName = cleanName(exit || "—");
    if (exitMs) put(rExit, exitMs > 800 ? "warn" : "ok", exitName + " · " + exitMs + " мс", "Сервер");
    else {
      put(rExit, "bad", exitName + " не отвечает", "Сервер");
      problems.push([0, "Сервер «" + exitName + "» не отвечает — переключитесь на другой.", "switch"]);
    }

    // 4. DNS через тоннель
    const rDns = diagRow(box, "DNS");
    try {
      const d = await clash("/dns/query?name=www.google.com&type=A");
      const ok = d && Array.isArray(d.Answer) && d.Answer.length;
      put(rDns, ok ? "ok" : "bad", ok ? "имена определяются" : "имена не определяются", "DNS");
      if (!ok) problems.push([0, "Не работает DNS — переподключитесь; не поможет — выберите другой сервер.", ["Переподключиться", async () => {
        await toggleConnection(); await toggleConnection(); }]]);
    } catch (_) {
      put(rDns, "warn", "ядро не дало проверить", "DNS");
    }

    // 5. сайты через выход
    if (exit && exitMs) {
      for (const [title, url] of DIAG_SITES) {
        const r = diagRow(box, title);
        const ms = await diagDelay(exit, url, 8000);
        put(r, ms ? "ok" : "bad", ms ? "открывается через «" + exitName + "» · " + ms + " мс" : "не открывается через «" + exitName + "»", title);
        if (!ms) problems.push([1, title + " не открывается через «" + exitName + "» — попробуйте другой сервер.", "switch"]);
      }
    }

    // 6. остальные серверы — есть ли куда переключиться
    const rAll = diagRow(box, "Другие серверы");
    const names = servers.map((s) => s.name).filter((n) => !isOfx(n) && liveType[n] && !/selector|urltest|fallback/i.test(liveType[n]));
    const res = await Promise.all(names.map(async (n) => [n, await diagDelay(n, PROBE_URL, 5000)]));
    const alive = res.filter((x) => x[1]).sort((a, b) => a[1] - b[1]);
    if (!names.length) put(rAll, "warn", "список недоступен", "Другие серверы");
    else put(rAll, alive.length ? "ok" : "bad", "отвечают " + alive.length + " из " + names.length
      + (alive.length ? " · быстрее всех " + cleanName(alive[0][0]) + " (" + alive[0][1] + " мс)" : ""), "Другие серверы");
    if (names.length && !alive.length) problems.push([0, "Не отвечает ни один сервер — скорее всего, сеть режет VPN. Поможет канал «Мобильные операторы» или фрагментация (Настройки → Технические).", ["Мобильные операторы", () => show("channel")]]);
    bestAlt = (alive.find((x) => x[0] !== exit) || [])[0] || null;

    if (/турц|turk/i.test(exit || "")) { lines.push("i " + DIAG_TR_NOTE); diagRow(box, "Турция")("warn", DIAG_TR_NOTE); }
  } finally {
    finish();
  }

  function finish() {
    if (!diagBusy) return;
    diagBusy = false;
    problems.sort((a, b) => a[0] - b[0]);
    const v = el("diag-verdict");
    const top = problems[0];
    const tone = top ? (top[0] ? "warn" : "bad") : "ok";
    v.className = "diag-verdict big " + tone;
    v.textContent = "";
    const ico = document.createElement("span");
    ico.className = "dv-ico";
    ico.textContent = tone === "ok" ? "✓" : "!";
    const h = document.createElement("b");
    h.textContent = tone === "ok" ? "Всё работает" : tone === "bad" ? "Нашли проблему" : "Есть замечание";
    const t = document.createElement("span");
    t.className = "dv-text";
    t.textContent = top ? top[1] : "VPN подключён, сайты открываются, серверы отвечают.";
    v.append(ico, h, t);
    let act = top && top[2];
    if (act === "switch") act = bestAlt ? ["Перейти на сервер «" + cleanName(bestAlt) + "»", () => { choose(bestAlt); setTimeout(runDiag, 2500); }] : null;
    if (act) {
      const b = document.createElement("button");
      b.className = "btn primary wide";
      b.textContent = act[0];
      b.addEventListener("click", () => { if (act[0] !== "Подключить") sheet("sheet-diag", false); act[1](); });
      v.append(b);
    }
    diagReport = "Проверка связи из приложения\n" + t.textContent + "\n\n" + lines.join("\n");
    el("diag-send").disabled = false;
    el("diag-run").disabled = false;
  }
}

function openDiag() {
  sheet("sheet-diag", true);
  runDiag();
}

on(el("diag-open"), "click", openDiag);
on(el("diag-open-sup"), "click", openDiag);
on(el("diag-run"), "click", runDiag);
on(el("diag-send"), "click", () => {
  sheet("sheet-diag", false);
  // новое обращение с готовым отчётом (или дописать в уже открытое — support.js)
  supNew(diagReport + "\n\nЧто не работает: ");
  if (el("sup-diag")) el("sup-diag").checked = true;   // и журнал подключения — поддержке он нужен
  say("отчёт вставлен — допишите, что не работает, и отправьте");
});
