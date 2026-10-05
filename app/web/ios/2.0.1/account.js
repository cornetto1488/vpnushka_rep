// Кабинет VPNUSHKA внутри клиента: вход через Telegram, баланс, пополнение,
// продление и покупка подписки. Всё это — API веб-кабинета бота Bedolaga
// (cabinet.vpnushka.lol/api/cabinet), тот же, которым пользуется сайт кабинета,
// поэтому платёжки, цены и скидки ровно те, что в боте, и настраиваются там же.
//
// Запросы идут через бэкенд (cabinet_http в lib.rs / Commands.java): CORS
// кабинета пускает только его сайт. Токены лежат в настройках (prefs.account).
//
// Грузится после app.js и пользуется его общими помощниками (invoke, el, on,
// say, errText, show, profile, prefs, savePrefs, loadServers, loadSubInfo).

let acc = null;              // {access, refresh, user}
let accData = {};            // последнее, что отдал кабинет
let accPeriod = null;        // выбранный срок продления/покупки
let loginGen = 0;            // чтобы второй клик «Войти» отменял первый опрос
let payWatch = 0;            // таймер ожидания оплаты
let topupMethod = null;
let topupOption = null;

const BOT_URL = "https://t.me/vpnushka_bot";

/* ── запросы к кабинету ──────────────────────────────────────────────────── */

// Английские ответы кабинета, которые может увидеть покупатель.
const API_TEXT = [
  [/Token expired or not found|Invalid token state|already consumed/i, "ссылка для входа устарела — нажмите «Войти» ещё раз"],
  [/Account is deactivated/i, "аккаунт отключён — напишите в поддержку"],
  [/Too many requests/i, "слишком много попыток — подождите минуту"],
  [/Invalid email or password|Incorrect email or password/i, "неверная почта или пароль"],
  [/Email not verified|verify your email/i, "почта не подтверждена — откройте письмо и нажмите ссылку"],
  [/already registered/i, "эта почта уже зарегистрирована — войдите или восстановите пароль"],
  [/Disposable email/i, "временные почтовые ящики не принимаются"],
  [/cannot be used for registration/i, "эту почту нельзя использовать для регистрации"],
  [/Password login not configured/i, "у этого аккаунта нет пароля — войдите через Telegram или нажмите «Забыли пароль?»"],
  [/Email auth.*disabled|Email authentication is disabled/i, "вход по почте сейчас выключен"],
  [/Email service is not configured/i, "письма сейчас не отправляются — попробуйте позже или войдите через Telegram"],
  [/value is not a valid email|valid email address/i, "проверьте адрес почты"],
  [/at least 8 characters/i, "пароль — от 8 символов"],
  [/Invalid or unavailable payment method/i, "этот способ оплаты сейчас недоступен"],
  [/Minimum amount is ([\d.]+)/i, (m) => "минимальная сумма — " + Math.round(+m[1]) + " ₽"],
  [/Maximum amount is ([\d.,]+)/i, (m) => "максимальная сумма — " + m[1].replace(/\.00$/, "") + " ₽"],
  [/Selected renewal period is not available/i, "этот срок сейчас недоступен"],
  [/No subscription found/i, "подписки пока нет"],
  [/restricted for this account/i, "для этого аккаунта операция запрещена — напишите в поддержку"],
  [/Stars payments are only available through the bot/i, "Stars — только через бота"],
  [/Failed to create .* payment|Failed to process/i, "платёжная система не ответила — попробуйте другой способ"],
];

function apiText(r) {
  const b = r && r.body;
  let d = b && typeof b === "object" ? b.detail ?? b.message : b;
  if (d && typeof d === "object" && !Array.isArray(d)) d = d.message || d.code;
  if (Array.isArray(d)) d = d.map((x) => x.msg || x).join("; ");
  d = String(d || "").trim();
  for (const [re, ru] of API_TEXT) {
    const m = d.match(re);
    if (m) return typeof ru === "function" ? ru(m) : ru;
  }
  if (/[а-яё]/i.test(d)) return d;
  return d ? "кабинет: " + d : "кабинет ответил ошибкой " + (r ? r.status : "");
}

// form: {fields, filename, text} — multipart с текстовым файлом (нативная часть с 2.0.0)
async function rawApi(method, path, body, bearer, form) {
  return invoke("cabinet_http", { method, path, body: body ?? null, bearer: bearer || null, form: form || null });
}

// Access-токен живёт недолго: на 401 один раз обновляем его refresh-токеном.
async function api(method, path, body, form) {
  if (!acc) throw new Error("войдите в кабинет");
  let r = await rawApi(method, path, body, acc.access, form);
  if (r.status === 401 && acc.refresh) {
    const rr = await rawApi("POST", "/auth/refresh", { refresh_token: acc.refresh });
    if (rr.status === 200 && rr.body && rr.body.access_token) {
      await saveAccount({ ...acc, access: rr.body.access_token, refresh: rr.body.refresh_token || acc.refresh });
      r = await rawApi(method, path, body, rr.body.access_token, form);   // новым токеном, не старым
    } else if (rr.status === 401 || rr.status === 403) {
      await saveAccount(null);
      paintAccount();
      throw new Error("вход в кабинет истёк — войдите ещё раз");
    }
  }
  return r;
}

async function apiOk(method, path, body, form) {
  const r = await api(method, path, body, form);
  if (r.status < 200 || r.status >= 300) {
    const e = new Error(apiText(r));
    e.status = r.status;
    e.body = r.body;
    throw e;
  }
  return r.body;
}

async function saveAccount(a) {
  acc = a;
  await savePrefs({ account: a });
}

/* ── форматирование ──────────────────────────────────────────────────────── */

const rub = (kop) => {
  const v = (kop || 0) / 100;
  return v.toLocaleString("ru-RU", { maximumFractionDigits: v % 1 ? 2 : 0 }) + " ₽";
};
const ddmmyyyy = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? "—" : d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
};
function periodName(days) {
  const m = { 30: "1 месяц", 31: "1 месяц", 60: "2 месяца", 90: "3 месяца", 180: "6 месяцев",
              360: "1 год", 365: "1 год", 7: "Неделя", 14: "2 недели" };
  if (m[days]) return m[days];
  return days + " дн.";
}
const STATUS = {
  active: "активна", trial: "пробная", expired: "истекла", disabled: "отключена",
  limited: "трафик исчерпан", pending: "ожидает оплаты",
};
function accMsg(id, text, kind) {
  const m = el(id);
  m.textContent = text || "";
  m.className = "msg" + (kind ? " " + kind : "");
}
function kvRow(label, value) {
  const kv = document.createElement("div");
  kv.className = "kv";
  const a = document.createElement("span");
  a.textContent = label;
  const b = document.createElement("b");
  b.textContent = value;
  kv.append(a, b);
  return kv;
}

/* ── вход ────────────────────────────────────────────────────────────────── */

let loginLink = "";

async function loginTelegram() {
  const gen = ++loginGen;
  const btn = el("acc-login-tg");
  btn.disabled = true;
  accMsg("acc-login-msg", "готовлю вход…", "busy");
  try {
    const r = await rawApi("POST", "/auth/deeplink/request", {});
    if (r.status !== 200) throw new Error(apiText(r));
    const { token, bot_username, expires_in } = r.body;
    loginLink = "https://t.me/" + bot_username + "?start=webauth_" + token;
    await invoke("open_url", { url: loginLink });
    el("acc-login-reopen").style.display = "";
    accMsg("acc-login-msg", "Откроется Telegram: в боте @" + bot_username
      + " нажмите «Запустить», затем «Подтвердить вход». Приложение подхватит вход само.", "busy");
    const until = Date.now() + (expires_in || 300) * 1000;
    while (gen === loginGen && Date.now() < until) {
      await new Promise((res) => setTimeout(res, 2500));
      if (gen !== loginGen) return;
      const p = await rawApi("POST", "/auth/deeplink/poll", { token }).catch(() => null);
      if (!p || p.status === 202) continue;
      if (p.status === 200 && p.body && p.body.access_token) {
        await loggedIn(p.body);
        return;
      }
      if (p.status === 429) continue;
      throw new Error(apiText(p));
    }
    if (gen === loginGen) throw new Error("время на подтверждение вышло — нажмите «Войти» ещё раз");
  } catch (e) {
    if (gen === loginGen) accMsg("acc-login-msg", errText(e), "err");
  } finally {
    if (gen === loginGen) btn.disabled = false;
  }
}

// Почта: вход, регистрация (письмо со ссылкой — потом вход паролем),
// повторная отправка письма и сброс пароля. Ссылки из писем открываются
// в браузере (кабинет), приложению после этого достаточно войти паролем.
let mailMode = "login";

function setMailMode(m) {
  mailMode = m;
  document.querySelectorAll("#mail-mode [data-mail]").forEach((b) => b.classList.toggle("on", b.dataset.mail === m));
  el("mail-reg-extra").hidden = m !== "register";
  el("acc-login-email").textContent = m === "register" ? "Зарегистрироваться" : "Войти";
  el("acc-pass").autocomplete = m === "register" ? "new-password" : "current-password";
  el("mail-forgot").style.display = m === "login" ? "" : "none";
  accMsg("mail-msg", "");
}

const mailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

async function loginEmail() {
  const email = el("acc-email").value.trim();
  const password = el("acc-pass").value;
  if (!mailOk(email)) { accMsg("mail-msg", "проверьте адрес почты", "err"); return; }
  if (!password) { accMsg("mail-msg", "введите пароль", "err"); return; }
  if (mailMode === "register") return registerEmail(email, password);
  const btn = el("acc-login-email");
  btn.disabled = true;
  try {
    const r = await rawApi("POST", "/auth/email/login", { email, password });
    if (r.status !== 200) {
      if (r.status === 403 && /verify/i.test(JSON.stringify(r.body || ""))) el("mail-resend").style.display = "";
      throw new Error(apiText(r));
    }
    el("acc-pass").value = "";
    accMsg("mail-msg", "");
    await loggedIn(r.body);
  } catch (e) { accMsg("mail-msg", errText(e), "err"); }
  btn.disabled = false;
}

async function registerEmail(email, password) {
  if (password.length < 8) { accMsg("mail-msg", "пароль — от 8 символов", "err"); return; }
  if (password !== el("acc-pass2").value) { accMsg("mail-msg", "пароли не совпадают", "err"); return; }
  const btn = el("acc-login-email");
  btn.disabled = true;
  try {
    const body = { email, password, language: "ru" };
    const name = el("acc-regname").value.trim();
    if (name) body.first_name = name.slice(0, 64);
    const r = await rawApi("POST", "/auth/email/register/standalone", body);
    if (r.status !== 200 && r.status !== 201) throw new Error(apiText(r));
    el("acc-pass2").value = "";
    setMailMode("login");
    el("mail-resend").style.display = "";
    if (r.body && r.body.requires_verification === false) {
      accMsg("mail-msg", "Готово — теперь войдите с этим паролем.", "ok");
    } else {
      accMsg("mail-msg", "Письмо отправлено на " + email + ". Откройте его и нажмите ссылку — затем вернитесь "
        + "сюда и нажмите «Войти». Письма нет — проверьте «Спам».", "ok");
    }
  } catch (e) { accMsg("mail-msg", errText(e), "err"); }
  btn.disabled = false;
}

async function resendMail() {
  const email = el("acc-email").value.trim();
  if (!mailOk(email)) { accMsg("mail-msg", "впишите почту, на которую регистрировались", "err"); return; }
  const r = await rawApi("POST", "/auth/email/register/resend", { email }).catch((e) => ({ status: 0, body: errText(e) }));
  accMsg("mail-msg", r.status === 200 ? "Если почта ждёт подтверждения, письмо придёт через минуту-две."
    : apiText(r), r.status === 200 ? "ok" : "err");
}

async function forgotPassword() {
  const email = el("acc-email").value.trim();
  if (!mailOk(email)) { accMsg("mail-msg", "впишите почту — пришлём ссылку для нового пароля", "err"); return; }
  const r = await rawApi("POST", "/auth/password/forgot", { email }).catch((e) => ({ status: 0, body: errText(e) }));
  accMsg("mail-msg", r.status === 200 ? "Если такой аккаунт есть, ссылка для нового пароля уже на почте. "
    + "Задайте пароль по ссылке и войдите здесь." : apiText(r), r.status === 200 ? "ok" : "err");
}

async function loggedIn(auth) {
  loginGen++;
  if (typeof closeAuth === "function") closeAuth();
  el("acc-login-tg").disabled = false;
  await saveAccount({ access: auth.access_token, refresh: auth.refresh_token, user: auth.user || null });
  accMsg("acc-login-msg", "");
  el("acc-login-reopen").style.display = "none";
  say("вы вошли в кабинет");
  paintAccount();
  await refreshAccount(true);
}

async function logout() {
  if (acc) rawApi("POST", "/auth/logout", { refresh_token: acc.refresh }, acc.access).catch(() => {});
  stopPayWatch();
  await saveAccount(null);
  accData = {};
  paintAccount();
  say("вы вышли из кабинета");
}

/* ── данные кабинета ─────────────────────────────────────────────────────── */

let refreshing = null;

// Всё, что показывает вкладка, одним заходом. autoSub — подключить подписку из
// кабинета, если в приложении её ещё нет (сразу после входа).
function refreshAccount(autoSub) {
  if (!acc) { paintAccount(); return Promise.resolve(); }
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const [me, bal, sub] = await Promise.all([
        apiOk("GET", "/auth/me"),
        apiOk("GET", "/balance"),
        apiOk("GET", "/subscription"),
      ]);
      accData = { me, balance: bal.balance_kopeks, sub: sub.has_subscription ? sub.subscription : null };
      acc.user = me;
      const s = accData.sub;
      // продлевать можно платную подписку (в т.ч. истёкшую); пробную и пустую — только купить
      if (s && !s.is_trial) {
        accData.periods = (await apiOk("GET", "/subscription/renewal-options").catch(() => []))
          .map((p) => ({ days: p.period_days, price: p.price_kopeks, orig: p.original_price_kopeks,
                         discount: p.discount_percent }));
        accData.mode = "renew";
      } else {
        const opts = await apiOk("GET", "/subscription/purchase-options").catch(() => null);
        accData.purchase = opts;
        accData.periods = ((opts && opts.periods) || []).filter((p) => p.is_available !== false)
          .map((p) => ({ days: p.period_days, price: p.price_kopeks, orig: p.original_price_kopeks,
                         discount: p.discount_percent, raw: p }));
        accData.mode = "buy";
        accData.trial = s ? null : await apiOk("GET", "/subscription/trial").catch(() => null);
      }
      if (!accData.periods.some((p) => accPeriod && p.days === accPeriod.days)) accPeriod = null;
      paintAccount();
      loadDevices();
      if (autoSub) await adoptSubscription(false);
      loadHistory();
    } catch (e) {
      if (acc) accMsg("acc-renew-msg", errText(e), "err");
      paintAccount();
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

// Ссылка на подписку из кабинета. Бывает скрыта настройкой бота — тогда берём
// её из /connection-link.
async function cabinetSubUrl() {
  const s = accData.sub;
  if (s && s.subscription_url) return s.subscription_url;
  const c = await apiOk("GET", "/subscription/connection-link").catch(() => null);
  return (c && c.subscription_url) || "";
}

// Короткий id подписки — последний кусок пути: одна и та же подписка бывает
// записана разными доменами.
const subKey = (u) => String(u || "").replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").pop();

async function adoptSubscription(force) {
  if (!accData.sub) return;
  const url = await cabinetSubUrl();
  if (!url) return;
  const same = profile && profile.sub && subKey(profile.sub) === subKey(url);
  if (same) { el("acc-use-sub").style.display = "none"; return; }
  // Гостевая подписка — не «своя ссылка»: её меняем на настоящую без вопросов.
  const guest = guestActive();
  if (!force && !guest && profile && profile.sub) {   // своя ссылка уже есть — не перетираем молча
    el("acc-use-sub").style.display = "";
    return;
  }
  try {
    // Через гостевой тоннель подписку не скачать (сервер пускает только Telegram),
    // поэтому сначала гасим его, потом переключаемся и поднимаем уже настоящую.
    const reconnect = guest && state !== "off";
    if (guest) await endGuest(null, true);
    profile = await invoke("save_sub", { url });
    refreshProfileFields();
    el("acc-use-sub").style.display = "none";
    say(guest ? "вход выполнен — подключаю вашу подписку" : "подписка из кабинета подключена");
    await loadServers();
    loadSubInfo();
    tick();
    paintGuest();
    if (reconnect) await toggleConnection();
  } catch (e) { say(errText(e), true); }
}

async function loadHistory() {
  if (!acc || !el("acc-history").open) return;
  const box = el("acc-tx");
  try {
    const r = await apiOk("GET", "/balance/transactions?per_page=15");
    box.textContent = "";
    for (const t of r.items || []) {
      const row = document.createElement("div");
      row.className = "txrow";
      const d = document.createElement("span");
      d.className = "d";
      d.textContent = t.description || t.type;
      d.title = d.textContent;
      const when = document.createElement("span");
      when.className = "t";
      when.textContent = ddmmyyyy(t.created_at);
      const b = document.createElement("b");
      const plus = /deposit|refund|bonus|referral|reward|gift/.test(t.type || "");
      b.className = plus ? "plus" : "";
      b.textContent = (plus ? "+" : "−") + rub(Math.abs(t.amount_kopeks)) + (t.is_completed ? "" : " …");
      row.append(d, when, b);
      box.append(row);
    }
    if (!box.children.length) box.innerHTML = '<div class="empty">операций пока нет</div>';
  } catch (e) { box.textContent = errText(e); }
}

/* ── отрисовка ───────────────────────────────────────────────────────────── */

function paintHomeAccount() {
  const t = el("h-acc-title"), sub = el("h-acc"), dot = el("h-acc-dot");
  // на ПК тот же статус точкой на кнопке кабинета в заголовке
  const wdot = () => { el("win-acc-dot").className = "wdot" + (/warn|err/.test(dot.className) ? " " + dot.className.split(" ")[1] : ""); };
  if (!acc) {
    t.textContent = "Кабинет";
    sub.textContent = "войдите в аккаунт — баланс и продление здесь";
    dot.className = "dot";
    wdot();
    if (typeof paintGuest === "function") paintGuest();
    return;
  }
  const s = accData.sub;
  const bal = accData.balance != null ? "баланс " + rub(accData.balance) : "";
  t.textContent = "Кабинет" + (bal ? " · " + bal : "");
  if (!s) {
    sub.textContent = accData.me ? "подписки нет — оформите здесь" : "загружаю…";
    dot.className = accData.me ? "dot warn" : "dot";
  } else if (s.is_active) {
    sub.textContent = "подписка до " + ddmmyyyy(s.end_date)
      + (s.days_left <= 3 ? " — пора продлить" : " · " + (s.time_left_display || s.days_left + " дн."));
    dot.className = s.days_left <= 3 ? "dot warn" : "dot live";
  } else {
    sub.textContent = "подписка " + (STATUS[s.status] || s.status) + " — продлите здесь";
    dot.className = "dot err";
  }
  wdot();
  if (typeof paintGuest === "function") paintGuest();
}

function paintAccount() {
  el("acc-out").style.display = acc ? "none" : "";
  el("acc-in").style.display = acc ? "" : "none";
  paintHomeAccount();
  if (!acc) return;

  const u = accData.me || acc.user || {};
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || u.email || "Аккаунт";
  el("acc-name").textContent = name;
  el("acc-ava").textContent = (name.trim()[0] || "V").toUpperCase();
  el("acc-sub").textContent = u.username ? "@" + u.username : u.email || (u.telegram_id ? "Telegram " + u.telegram_id : "");
  el("acc-balance").textContent = accData.balance != null ? rub(accData.balance) : "—";

  // подписка
  const box = el("acc-subinfo");
  box.textContent = "";
  const s = accData.sub;
  if (!accData.me) {
    box.append(kvRow("Статус", "загружаю…"));
  } else if (!s) {
    box.append(kvRow("Статус", "нет подписки"));
  } else {
    box.append(kvRow("Статус", (STATUS[s.status] || s.status) + (s.is_trial && s.status !== "trial" ? " (пробная)" : "")));
    if (s.tariff_name) box.append(kvRow("Тариф", s.tariff_name));
    box.append(kvRow(s.is_expired ? "Закончилась" : "Действует до", ddmmyyyy(s.end_date)
      + (s.is_active && s.time_left_display ? " · " + s.time_left_display : "")));
    const lim = s.traffic_limit_gb || 0;
    box.append(kvRow("Трафик", (s.traffic_used_gb || 0).toFixed(1) + " ГБ" + (lim ? " из " + lim + " ГБ" : " · без лимита")));
    if (lim) {
      const bar = document.createElement("div");
      bar.className = "bar";
      const i = document.createElement("i");
      i.style.width = Math.min(100, s.traffic_used_percent || 0).toFixed(1) + "%";
      bar.append(i);
      box.append(bar);
    }
    if (s.device_limit) box.append(kvRow("Устройств", String(s.device_limit)));
  }

  // продление / покупка
  const buy = accData.mode === "buy";
  el("acc-renew-cap").textContent = buy ? (s ? "Оформить подписку" : "Купить подписку") : "Продлить подписку";
  const list = el("acc-periods");
  list.textContent = "";
  for (const p of accData.periods || []) {
    const b = document.createElement("button");
    b.className = accPeriod && accPeriod.days === p.days ? "on" : "";
    const n = document.createElement("b");
    n.textContent = periodName(p.days);
    const pr = document.createElement("span");
    pr.textContent = (buy ? "от " : "") + rub(p.price);
    b.append(n, pr);
    if (p.orig && p.orig > p.price) {
      const o = document.createElement("s");
      o.textContent = rub(p.orig);
      b.append(o);
    }
    if (p.discount) {
      const d = document.createElement("i");
      d.textContent = "−" + p.discount + "%";
      b.append(d);
    }
    b.addEventListener("click", () => pickPeriod(p));
    list.append(b);
  }
  if (!(accData.periods || []).length && accData.me) {
    list.innerHTML = '<div class="empty">сроки не загрузились — обновите</div>';
  }
  el("acc-trial").style.display = accData.trial && accData.trial.is_available ? "" : "none";
  if (accData.trial && accData.trial.is_available) {
    el("acc-trial").textContent = "Попробовать бесплатно — " + accData.trial.duration_days + " дн."
      + (accData.trial.requires_payment ? " за " + rub(accData.trial.price_kopeks) : "");
  }
  paintRenewButton();
}

function paintRenewButton() {
  const btn = el("acc-renew");
  const note = el("acc-renew-note");
  const p = accPeriod;
  if (!p) {
    btn.disabled = true;
    btn.textContent = "Выберите срок";
    note.textContent = "";
    return;
  }
  const price = p.total ?? p.price;
  const short = Math.max(0, price - (accData.balance || 0));
  btn.disabled = false;
  const what = accData.mode === "buy" ? "Купить на " : "Продлить на ";
  btn.textContent = short > 0
    ? "Пополнить и " + (accData.mode === "buy" ? "купить" : "продлить") + " — " + rub(price)
    : what + periodName(p.days).toLowerCase() + " за " + rub(price);
  note.textContent = short > 0
    ? "На балансе не хватает " + rub(short) + ". После оплаты подписка " + (accData.mode === "buy" ? "оформится" : "продлится") + " сама."
    : "Спишется с баланса: " + rub(price) + ".";
}

async function pickPeriod(p) {
  accPeriod = p;
  accMsg("acc-renew-msg", "");
  paintAccount();
  // в покупке к цене срока добавляются трафик/серверы/устройства — точную
  // сумму считает кабинет
  if (accData.mode === "buy" && p.raw) {
    try {
      const pv = await apiOk("POST", "/subscription/purchase-preview", { selection: buySelection(p) });
      if (accPeriod === p) { p.total = pv.total_price_kopeks; paintRenewButton(); }
    } catch (e) { accMsg("acc-renew-msg", errText(e), "err"); }
  }
}

// Параметры покупки — те, что кабинет предлагает по умолчанию для этого срока.
function buySelection(p) {
  const d = (accData.purchase && accData.purchase.selection) || {};
  const r = p.raw || {};
  const pick = (x, ...keys) => { for (const k of keys) if (x && x[k] != null) return x[k]; return undefined; };
  return {
    period_id: r.id || d.period_id,
    period_days: p.days,
    traffic_value: pick(r.traffic, "current", "default") ?? d.traffic_value,
    servers: pick(r.servers, "selected", "default") ?? d.servers ?? [],
    devices: pick(r.devices, "current", "default") ?? d.devices,
  };
}

async function renewOrBuy() {
  const p = accPeriod;
  if (!p) return;
  const btn = el("acc-renew");
  btn.disabled = true;
  accMsg("acc-renew-msg", accData.mode === "buy" ? "оформляю…" : "продлеваю…", "busy");
  try {
    if (accData.mode === "buy") {
      await apiOk("POST", "/subscription/purchase", { selection: buySelection(p) });
    } else {
      await apiOk("POST", "/subscription/renew", { period_days: p.days });
    }
    accMsg("acc-renew-msg", accData.mode === "buy" ? "подписка оформлена" : "подписка продлена", "ok");
    say(accData.mode === "buy" ? "подписка оформлена" : "подписка продлена на " + periodName(p.days).toLowerCase());
    accPeriod = null;
    await refreshAccount(true);
    loadSubInfo();
  } catch (e) {
    if (e.status === 402) {
      // Кабинет уже сохранил «корзину»: после пополнения бот сам продлит/купит.
      const d = (e.body && e.body.detail) || {};
      const missing = d.missing_amount || Math.max(0, (p.total ?? p.price) - (accData.balance || 0));
      accMsg("acc-renew-msg", "");
      openTopup(missing, "Не хватает " + rub(missing) + ". После оплаты подписка "
        + (accData.mode === "buy" ? "оформится" : "продлится") + " автоматически.");
    } else {
      accMsg("acc-renew-msg", errText(e), "err");
    }
  }
  btn.disabled = false;
}

async function activateTrial() {
  const btn = el("acc-trial");
  btn.disabled = true;
  try {
    await apiOk("POST", "/subscription/trial", {});
    say("пробная подписка активирована");
    await refreshAccount(true);
  } catch (e) {
    if (e.status === 402) openTopup(accData.trial.price_kopeks, "Пробный период платный — пополните баланс.");
    else say(errText(e), true);
  }
  btn.disabled = false;
}

/* ── устройства ──────────────────────────────────────────────────────────── */

let devN = 1;
let devPrice = null;       // ответ /devices/price для devN
let myHwid = "";

async function loadDevices() {
  const card = el("acc-dev-card");
  const s = accData.sub;
  if (!acc || !s) { card.style.display = "none"; return; }
  card.style.display = "";
  if (!myHwid) myHwid = await invoke("device_hwid").catch(() => "");
  try {
    const d = await apiOk("GET", "/subscription/devices");
    accData.devices = d;
    paintDevices();
  } catch (e) {
    el("acc-dev-list").textContent = "";
    accMsg("acc-dev-msg", errText(e), "err");
  }
  loadDevicePrice();
}

const PLATFORM = { windows: "Windows", android: "Android", ios: "iPhone / iPad", macos: "macOS",
                   linux: "Linux", darwin: "macOS" };

function paintDevices() {
  const d = accData.devices || { devices: [], total: 0, device_limit: 0 };
  const list = d.devices || [];
  const limit = d.device_limit || (accData.sub && accData.sub.device_limit) || 0;
  el("acc-dev-count").textContent = list.length + (limit ? " из " + limit : "");
  el("acc-dev-warn").textContent = limit && list.length >= limit
    ? "Лимит устройств заполнен — новое устройство не подключится. Отвяжите лишнее или добавьте мест."
    : "";
  const box = el("acc-dev-list");
  box.textContent = "";
  for (const x of list) {
    const row = document.createElement("div");
    const mine = myHwid && x.hwid === myHwid;
    row.className = "devrow" + (mine ? " me" : "");
    const tx = document.createElement("span");
    tx.className = "tx";
    const b = document.createElement("b");
    const plat = PLATFORM[String(x.platform || "").toLowerCase()] || x.platform || "";
    const model = x.device_model && x.device_model !== "Unknown" ? x.device_model : "";
    b.textContent = x.local_name || [plat, model].filter(Boolean).join(" · ") || "Устройство";
    const sub = document.createElement("span");
    sub.textContent = (mine ? "это устройство · " : "") + (x.created_at ? "активно " + ddmmyyyy(x.created_at) : "");
    tx.append(b, sub);
    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "×";
    del.title = "Отвязать устройство";
    del.addEventListener("click", () => removeDevice(x, mine, del));
    row.append(tx, del);
    box.append(row);
  }
  if (!list.length) box.innerHTML = '<div class="empty">устройств пока нет</div>';
  el("acc-dev-clear").style.display = list.length > 1 ? "" : "none";
}

// Подтверждение вторым нажатием: confirm() в Android WebView без своего
// обработчика сразу отвечает «нет».
function armed(btn, label) {
  if (btn.dataset.armed === "1") return true;
  const was = btn.textContent;
  btn.dataset.armed = "1";
  btn.textContent = label;
  setTimeout(() => { btn.dataset.armed = ""; btn.textContent = was; }, 3500);
  return false;
}

async function removeDevice(x, mine, btn) {
  if (!armed(btn, "точно?")) {
    say(mine ? "это устройство — оно снова займёт место при следующем подключении; нажмите ещё раз"
             : "на нём VPN перестанет работать; нажмите ещё раз, чтобы отвязать");
    return;
  }
  try {
    await apiOk("DELETE", "/subscription/devices/" + encodeURIComponent(x.hwid));
    say("устройство отвязано");
    await loadDevices();
    await refreshSubscription(true);
  } catch (e) { say(errText(e), true); }
}

async function removeAllDevices() {
  if (!armed(el("acc-dev-clear"), "Точно отвязать все? Нажмите ещё раз")) return;
  try {
    await apiOk("DELETE", "/subscription/devices");
    say("все устройства отвязаны");
    await loadDevices();
    await refreshSubscription(true);
  } catch (e) { say(errText(e), true); }
}

async function loadDevicePrice() {
  const btn = el("acc-dev-buy");
  el("acc-dev-n").textContent = devN;
  btn.disabled = true;
  try {
    const n = devN;
    const p = await apiOk("GET", "/subscription/devices/price?devices=" + n);
    if (n !== devN) return;
    devPrice = p;
    if (!p.available) {
      el("acc-dev-price").textContent = "";
      btn.textContent = p.reason || "Добавить нельзя";
      return;
    }
    el("acc-dev-price").textContent = rub(p.total_price_kopeks) + (p.days_left ? " до конца подписки" : "");
    btn.textContent = "Добавить " + n + " " + (n === 1 ? "место" : n < 5 ? "места" : "мест") + " за " + rub(p.total_price_kopeks);
    btn.disabled = false;
  } catch (e) {
    el("acc-dev-price").textContent = "";
    btn.textContent = "Добавить";
    accMsg("acc-dev-msg", errText(e), "err");
  }
}

function stepDevices(delta) {
  const max = devPrice && devPrice.can_add ? devPrice.can_add : 20;
  devN = Math.max(1, Math.min(max, devN + delta));
  loadDevicePrice();
}

async function buyDevices() {
  const btn = el("acc-dev-buy");
  btn.disabled = true;
  accMsg("acc-dev-msg", "добавляю…", "busy");
  try {
    const r = await apiOk("POST", "/subscription/devices/purchase", { devices: devN });
    accMsg("acc-dev-msg", (r.message || "добавлено") + ". Теперь мест: " + r.new_device_limit + ".", "ok");
    say("места для устройств добавлены");
    devN = 1;
    await refreshAccount(false);
    await refreshSubscription(true);
  } catch (e) {
    if (e.status === 402) {
      // корзину сохраняем — бот добавит места сам, как только деньги придут
      const d = (e.body && e.body.detail) || {};
      const missing = d.missing_kopeks || d.missing_amount ||
        Math.max(0, ((devPrice && devPrice.total_price_kopeks) || 0) - (accData.balance || 0));
      await apiOk("POST", "/subscription/devices/save-cart", { devices: devN }).catch(() => {});
      accMsg("acc-dev-msg", "");
      openTopup(missing, "Не хватает " + rub(missing) + ". После оплаты места для устройств добавятся сами.");
    } else {
      accMsg("acc-dev-msg", errText(e), "err");
    }
  }
  btn.disabled = false;
}

// «Обновить подписку»: заново забрать её с панели. Новый лимит устройств,
// продление и новые серверы применяются к соединению только после
// переподключения — если VPN включён, переподключаемся сами.
async function refreshSubscription(quiet) {
  const btn = el("acc-sub-refresh");
  btn.disabled = true;
  try {
    if (accData.sub) await adoptSubscription(false);
    await loadServers();
    loadSubInfo();
    if (state === "on") {
      if (!quiet) say("обновляю подписку — переподключаюсь…");
      await toggleConnection();
      await toggleConnection();
    } else if (!quiet) {
      say("подписка обновлена");
    }
  } catch (e) { say(errText(e), true); }
  btn.disabled = false;
}

/* ── пополнение ──────────────────────────────────────────────────────────── */

let topupMethods = [];

async function openTopup(amountKop, why) {
  el("topup-why").textContent = why || "";
  el("topup-why").style.display = why ? "" : "none";
  accMsg("topup-msg", "");
  if (amountKop) el("topup-amount").value = Math.ceil(amountKop / 100);
  sheet("sheet-topup", true);
  const box = el("topup-methods");
  if (!topupMethods.length) box.innerHTML = '<div class="empty">загружаю способы оплаты…</div>';
  try {
    topupMethods = (await apiOk("GET", "/balance/payment-methods")).filter((m) => m.is_available !== false);
  } catch (e) {
    box.textContent = "";
    accMsg("topup-msg", errText(e), "err");
    return;
  }
  if (!topupMethods.some((m) => topupMethod && m.id === topupMethod.id)) topupMethod = topupMethods[0] || null;
  paintTopup();
}

const METHOD_HINT = {
  yookassa: "банковская карта РФ",
  cryptobot: "криптовалюта через @CryptoBot",
  telegram_stars: "звёзды Telegram — оплата в самом Telegram",
};

function paintTopup() {
  const box = el("topup-methods");
  box.textContent = "";
  if (!topupMethods.length) {
    box.innerHTML = '<div class="empty">способов оплаты сейчас нет — напишите в поддержку</div>';
    return;
  }
  for (const m of topupMethods) {
    const b = document.createElement("button");
    b.className = topupMethod && topupMethod.id === m.id ? "on" : "";
    const n = document.createElement("b");
    n.textContent = m.name;
    const d = document.createElement("span");
    d.textContent = m.description || METHOD_HINT[m.id] || "";
    b.append(n, d);
    b.addEventListener("click", () => { topupMethod = m; topupOption = null; paintTopup(); });
    box.append(b);
  }
  const m = topupMethod;
  // варианты внутри способа (карта / СБП) — если их больше одного
  const opts = el("topup-options");
  opts.textContent = "";
  const list = (m && m.options) || [];
  if (list.length > 1) {
    if (!list.some((o) => o.id === topupOption)) topupOption = list[0].id;
    for (const o of list) {
      const b = document.createElement("button");
      b.textContent = o.name;
      b.title = o.description || "";
      b.className = o.id === topupOption ? "on" : "";
      b.addEventListener("click", () => { topupOption = o.id; paintTopup(); });
      opts.append(b);
    }
    opts.style.display = "";
  } else {
    topupOption = list.length ? list[0].id : null;
    opts.style.display = "none";
  }
  const quick = el("topup-quick");
  quick.textContent = "";
  const amounts = m && m.quick_amounts && m.quick_amounts.length ? m.quick_amounts : [10000, 30000, 50000, 100000];
  for (const k of amounts) {
    const b = document.createElement("button");
    b.textContent = rub(k);
    b.addEventListener("click", () => { el("topup-amount").value = Math.round(k / 100); });
    quick.append(b);
  }
  el("topup-limits").textContent = m
    ? "От " + rub(m.min_amount_kopeks) + (m.max_amount_kopeks ? " до " + rub(m.max_amount_kopeks) : "") + "."
    : "";
}

async function topupGo() {
  const m = topupMethod;
  if (!m) { accMsg("topup-msg", "выберите способ оплаты", "err"); return; }
  const rubles = Math.round(+el("topup-amount").value || 0);
  const kop = rubles * 100;
  if (!rubles) { accMsg("topup-msg", "введите сумму", "err"); return; }
  if (kop < m.min_amount_kopeks) { accMsg("topup-msg", "минимум " + rub(m.min_amount_kopeks), "err"); return; }
  if (m.max_amount_kopeks && kop > m.max_amount_kopeks) { accMsg("topup-msg", "максимум " + rub(m.max_amount_kopeks), "err"); return; }
  const btn = el("topup-go");
  btn.disabled = true;
  accMsg("topup-msg", "создаю платёж…", "busy");
  try {
    const before = await lastTxId();
    let url;
    if (m.id === "telegram_stars") {
      const r = await apiOk("POST", "/balance/stars-invoice", { amount_kopeks: kop });
      url = r.invoice_url;
    } else {
      const body = { amount_kopeks: kop, payment_method: m.id };
      if (topupOption) body.payment_option = topupOption;
      const r = await apiOk("POST", "/balance/topup", body);
      url = r.payment_url;
    }
    if (!url) throw new Error("платёжная система не вернула ссылку");
    await invoke("open_url", { url });
    sheet("sheet-topup", false);
    startPayWatch(before, m.name);
  } catch (e) {
    accMsg("topup-msg", errText(e), "err");
  }
  btn.disabled = false;
}

async function lastTxId() {
  try {
    const r = await apiOk("GET", "/balance/transactions?per_page=5&type=deposit");
    return Math.max(0, ...(r.items || []).filter((t) => t.is_completed).map((t) => t.id));
  } catch (_) { return 0; }
}

// Оплата идёт в браузере; ждём, пока в истории появится зачисление. Бот сам
// сверяет платёж с платёжкой (вебхук/автопроверка) — мы только смотрим итог.
function startPayWatch(beforeId, methodName) {
  stopPayWatch();
  const until = Date.now() + 20 * 60 * 1000;
  accMsg("acc-pay-msg", "Оплатите в открывшемся окне (" + methodName + "). Баланс обновится сам.", "busy");
  const step = async () => {
    if (!acc) return;
    const r = await apiOk("GET", "/balance/transactions?per_page=5&type=deposit").catch(() => null);
    const got = r && (r.items || []).find((t) => t.is_completed && t.id > beforeId);
    if (got) {
      stopPayWatch();
      accMsg("acc-pay-msg", "Зачислено " + rub(got.amount_kopeks) + ".", "ok");
      say("баланс пополнен на " + rub(got.amount_kopeks));
      await refreshAccount(true);
      loadSubInfo();
      // сохранённую корзину (продление/покупку) бот проводит сразу после
      // зачисления — через несколько секунд перечитываем подписку ещё раз
      setTimeout(() => { refreshAccount(false).then(() => refreshSubscription(true)); }, 10000);
      return;
    }
    if (Date.now() > until) {
      stopPayWatch();
      accMsg("acc-pay-msg", "Оплата пока не пришла. Если вы оплатили — нажмите «обновить» чуть позже.", "");
      return;
    }
    payWatch = setTimeout(step, 5000);
  };
  payWatch = setTimeout(step, 5000);
}
function stopPayWatch() { clearTimeout(payWatch); payWatch = 0; }

/* ── события ─────────────────────────────────────────────────────────────── */

on(el("acc-login-tg"), "click", loginTelegram);
on(el("acc-login-reopen"), "click", () => loginLink && invoke("open_url", { url: loginLink }).catch(() => {}));
on(el("acc-login-email"), "click", loginEmail);
document.querySelectorAll("#mail-mode [data-mail]").forEach((b) => on(b, "click", () => setMailMode(b.dataset.mail)));
on(el("mail-resend"), "click", resendMail);
on(el("mail-forgot"), "click", forgotPassword);
on(el("acc-pass2"), "keydown", (e) => { if (e.key === "Enter") loginEmail(); });
on(el("mail-docs"), "click", (e) => { e.preventDefault(); if (typeof paintConsent === "function") paintConsent(true); });
on(el("acc-pass"), "keydown", (e) => { if (e.key === "Enter") loginEmail(); });
on(el("acc-logout"), "click", logout);
on(el("acc-reload"), "click", async () => { await refreshAccount(false); say("кабинет обновлён"); });
on(el("acc-topup"), "click", () => openTopup(0, ""));
on(el("acc-renew"), "click", renewOrBuy);
on(el("acc-trial"), "click", activateTrial);
on(el("acc-use-sub"), "click", () => adoptSubscription(true));
on(el("acc-sub-refresh"), "click", () => refreshSubscription(false));
on(el("acc-dev-clear"), "click", removeAllDevices);
on(el("acc-dev-minus"), "click", () => stepDevices(-1));
on(el("acc-dev-plus"), "click", () => stepDevices(1));
on(el("acc-dev-buy"), "click", buyDevices);
on(el("acc-open-bot"), "click", () => invoke("open_url", { url: BOT_URL }).catch((e) => say(errText(e), true)));
on(el("acc-history"), "toggle", loadHistory);
on(el("topup-go"), "click", topupGo);
on(el("topup-amount"), "keydown", (e) => { if (e.key === "Enter") topupGo(); });
on(el("home-account"), "click", () => show("account"));
on(document.querySelector('#tabs button[data-view="account"]'), "click", () => refreshAccount(false));
on(el("home-account"), "click", () => refreshAccount(false));

// Старт: prefs грузит app.js асинхронно — дожидаемся их.
(async () => {
  for (let i = 0; i < 50 && !(prefs && Object.keys(prefs).length); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  acc = prefs.account && prefs.account.access ? prefs.account : null;
  paintAccount();
  if (acc) {
    await refreshAccount(!(profile && profile.sub));
  }
  // раз в 10 минут — чтобы дата окончания и баланс на главной были свежими
  setInterval(() => { if (acc && !payWatch) refreshAccount(false); }, 10 * 60 * 1000);
})();
