// Временный доступ: 20 минут бесплатно, только Telegram и кабинет.
//
// Зачем: в РФ Telegram заблокирован, а войти в кабинет (и получить подписку)
// можно только через него. Кнопка берёт у панели одноразовую подписку
// (guest_issue → sub.vpnushka.lol/guest/issue → сквад Guest, инбаунд
// France-Guest на FR), подключает её в режиме «фирменный пресет» —
// Telegram идёт в тоннель, остальное напрямую, так что оплата и обычные сайты
// не ломаются — и ждёт входа. Сервер сам не пускает ничего, кроме Telegram,
// кабинета и DNS. После входа adoptSubscription (account.js) гасит гостевой
// тоннель, ставит настоящую подписку и поднимает её.
//
// Одна выдача на устройство (hwid движка) и на IP в сутки; повторное нажатие,
// пока доступ идёт, возвращает ту же подписку.
//
// Грузится после app.js и account.js и пользуется их помощниками.

function guestExpired() {
  return !!(prefs.guest && Date.now() >= Date.parse(prefs.guest.expiresAt));
}
function guestActive() {
  return !!(prefs.guest && profile && profile.sub && subKey(profile.sub) === subKey(prefs.guest.sub));
}

function guestMsg(text, kind) {
  const m = el("guest-msg");
  m.textContent = text || "";
  m.className = "msg" + (kind ? " " + kind : "");
}

// Карточка на главной висит, пока человек не вошёл через Telegram (на всех
// платформах): без входа нет ни баланса, ни продления, ни напоминаний. Кнопка
// «Временный доступ» в ней — только когда подписки ещё нет (Telegram в РФ
// заблокирован, а подписку без входа не получить).
function paintGuest() {
  const card = el("guest-card");
  const active = guestActive() && !guestExpired();
  const noSub = !profile || !profile.sub;
  const showCard = active || !acc;
  card.style.display = showCard ? "" : "none";
  // сервер у гостя один и выбирать нечего — место отдаём карточке
  el("home-server").style.display = active ? "none" : "";
  el("acc-guest").style.display = !acc && !active ? "" : "none";
  if (!showCard) return;
  const connected = state === "on";
  if (active) {
    const left = Math.max(0, Math.floor((Date.parse(prefs.guest.expiresAt) - Date.now()) / 1000));
    el("guest-left").textContent = Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0");
    el("guest-title").textContent = connected ? "Временный доступ включён" : "Временный доступ";
    el("guest-sub").textContent = connected
      ? (acc ? "вы вошли — оформите подписку в кабинете"
             : "работает только Telegram. Войдите — ваша подписка подключится сама")
      : state === "connecting" ? "подключаюсь…" : "нажмите на картину, чтобы подключиться";
  } else {
    el("guest-left").textContent = "";
    el("guest-title").textContent = "Подключите Telegram";
    el("guest-sub").textContent = noSub
      ? "войдите — подписка подключится сама. Telegram не открывается? Есть 20 минут бесплатно"
      : "войдите — баланс, продление и напоминания будут здесь";
  }
  el("guest-go").style.display = !active && noSub ? "" : "none";
  el("guest-login").style.display = !acc && (!active || connected) ? "" : "none";
  el("guest-stop").style.display = active ? "" : "none";
}

async function startGuest() {
  if (state === "connecting") return;
  show("home");
  const btn = el("guest-go");
  btn.disabled = true;
  guestMsg("получаю временный доступ…", "busy");
  try {
    const r = await invoke("guest_issue");
    // запоминаем «свою» подписку, чтобы вернуть её, когда гостевая кончится
    const prevSub = guestActive() ? prefs.guest.prevSub || null : (profile && profile.sub) || null;
    if (state === "on") { setState("off"); await invoke("disconnect").catch(() => {}); }
    await savePrefs({ guest: { sub: r.subUrl, expiresAt: r.expiresAt, prevSub } });
    profile = await invoke("save_sub", { url: r.subUrl });
    refreshProfileFields();
    await loadServers();
    guestMsg("");
    paintGuest();
    await toggleConnection();
  } catch (e) {
    guestMsg(errText(e), "err");
  }
  btn.disabled = false;
  paintGuest();
}

// Конец гостевого доступа: гасим тоннель и возвращаем прежнюю подписку (или
// забываем гостевую — мёртвая ссылка не должна выглядеть рабочей). keepSub —
// подписку сейчас заменят настоящей, трогать её не нужно.
let guestEnding = false;

async function endGuest(msg, keepSub) {
  const g = prefs.guest;
  if (!g || guestEnding) return;
  guestEnding = true;
  try {
    const wasActive = guestActive();
    if (wasActive && state !== "off") {
      setState("off");
      await invoke("disconnect").catch(() => {});
    }
    await savePrefs({ guest: null });
    if (wasActive && !keepSub) {
      try {
        profile = g.prevSub ? await invoke("save_sub", { url: g.prevSub }) : await invoke("clear_sub");
      } catch (_) {}
      el("sub-input").value = (profile && profile.sub) || "";
      await loadServers();
      tick();
    }
  } finally {
    guestEnding = false;
  }
  guestMsg("");
  if (msg) say(msg, true);
  paintGuest();
}

on(el("guest-go"), "click", startGuest);
on(el("acc-guest"), "click", startGuest);
on(el("guest-login"), "click", () => { show("account"); loginTelegram(); });
on(el("guest-stop"), "click", () => endGuest("временный доступ завершён"));

setInterval(() => {
  if (!prefs.guest) return;
  if (guestExpired()) {
    endGuest(acc ? "временный доступ закончился"
                 : "20 минут временного доступа истекли — войдите в кабинет или оформите подписку");
    return;
  }
  if (el("guest-card").style.display !== "none") paintGuest();
}, 1000);
