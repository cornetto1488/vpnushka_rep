// Вход (2.0.0): один блок #acc-out — почта и Telegram на равных, плюс
// временный доступ на 20 минут. Живёт в Кабинете; после соглашения, пока нет
// ни аккаунта, ни подписки, переносится на полноэкранный экран входа
// (#auth-gate) — и туда же ведёт кнопка подключения без подписки.
// После входа или подключённой подписки экран закрывается сам.
//
// Грузится после app.js, account.js, guest.js (el, on, show, prefs, savePrefs,
// acc, profile, guestActive, startGuest, loginTelegram).

let authHome = null;          // откуда взяли #acc-out: {parent, next}
let authLaterThisRun = false; // «Войду позже» — до следующего запуска не навязываем

// m = null — способ ещё не выбран: оба на равных, формы скрыты. Почту по
// умолчанию не открываем: у тех, кто пришёл из бота, почты в аккаунте нет, и
// регистрация по почте создала бы им второй, пустой аккаунт.
function setAuthMethod(m) {
  document.querySelectorAll("#auth-method [data-auth]").forEach((b) => b.classList.toggle("on", b.dataset.auth === m));
  el("auth-mail").hidden = m !== "mail";
  el("auth-tg").hidden = m !== "tg";
  el("auth-pick").hidden = !!m;
  if (m && prefs.authMethod !== m) savePrefs({ authMethod: m });
}

function authOpen() { return el("auth-gate").style.display !== "none"; }

function openAuth() {
  if (acc) return;
  const box = el("acc-out");
  if (!authHome) authHome = { parent: box.parentNode, next: box.nextSibling };
  el("auth-slot").append(box);
  // на ПК окно низкое — «20 минут» уходит в левую колонку, под приветствие
  if (document.documentElement.classList.contains("pc")) {
    const g = el("auth-guest");
    authHome.guestNext = g.nextSibling;
    el("ag-guest-slot").append(g);
  }
  box.style.display = "";
  el("auth-gate").style.display = "";
  document.documentElement.classList.add("auth-open");
  paintAuthGuest();
  el("auth-gate").querySelector(".ag-scroll").scrollTop = 0;
}

function closeAuth() {
  if (!authOpen()) return;
  el("auth-gate").style.display = "none";
  document.documentElement.classList.remove("auth-open");
  if (authHome) {
    if (authHome.guestNext) el("acc-out").insertBefore(el("auth-guest"), authHome.guestNext);
    authHome.parent.insertBefore(el("acc-out"), authHome.next); authHome = null;
  }
  if (typeof paintAccount === "function") paintAccount();
}

// Нужно ли встречать экраном входа: ни аккаунта, ни подписки (или только гостевая)
const needAuth = () => !acc && (!profile || !profile.sub || guestActive());

function maybeOpenAuth() {
  if (needAuth() && !authLaterThisRun) openAuth();
}

// Карточка временного доступа внутри блока входа
function paintAuthGuest() {
  const card = el("auth-guest");
  if (!card) return;
  const active = typeof guestActive === "function" && guestActive() && !guestExpired();
  const noSub = !profile || !profile.sub || active;
  card.style.display = !acc && noSub ? "" : "none";
  el("acc-guest").style.display = active ? "none" : "";
  card.classList.toggle("on", active);
  if (active) {
    const left = Math.max(0, Math.floor((Date.parse(prefs.guest.expiresAt) - Date.now()) / 1000));
    el("auth-guest-left").textContent = Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0");
    el("auth-guest-title").textContent = state === "on" ? "Временный доступ включён" : "Временный доступ";
    el("auth-guest-sub").textContent = state === "on"
      ? "Telegram работает — войдите через него, и подписка подключится сама"
      : state === "connecting" ? "подключаюсь…" : "подключите его кнопкой на главной";
  } else {
    el("auth-guest-left").textContent = "";
    el("auth-guest-title").textContent = "Telegram не открывается?";
    el("auth-guest-sub").textContent = "Включим 20 минут бесплатно — Telegram заработает, войдите через него, и подписка подключится сама.";
  }
}
setInterval(() => {
  if (authOpen() && !needAuth()) closeAuth();          // вошли или подписка появилась
  if (authOpen() || view === "account") paintAuthGuest();
}, 1000);

document.querySelectorAll("#auth-method [data-auth]").forEach((b) => on(b, "click", () => setAuthMethod(b.dataset.auth)));
on(el("auth-later"), "click", () => { authLaterThisRun = true; closeAuth(); show("home"); });
on(el("auth-have-sub"), "click", () => {
  closeAuth();
  show("more");
  const f = el("sub-fold");
  if (f) { f.open = true; setTimeout(() => { f.scrollIntoView({ block: "center" }); el("sub-input").focus(); }, 250); }
});

(async () => {
  for (let i = 0; i < 50 && !(prefs && Object.keys(prefs).length); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  setAuthMethod(prefs.authMethod === "tg" || prefs.authMethod === "mail" ? prefs.authMethod : null);
})();
