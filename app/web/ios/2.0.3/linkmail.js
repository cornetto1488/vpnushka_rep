// Способы входа (2.0.2): к аккаунту, в который вошли через Telegram,
// привязывается почта с паролем — дальше это ОДИН аккаунт с двумя входами.
//
// Кабинет Bedolaga: POST /auth/email/register (с токеном вошедшего) пишет почту
// и пароль в этот же аккаунт и шлёт письмо подтверждения. Почта уже у другого
// живого аккаунта → merge_required: на неё уходит 6-значный код →
// /auth/email/merge/verify {code} → merge_token → GET /auth/merge/{token}
// (что объединяем) → POST /auth/merge/{token} {keep_subscription_from} →
// новые токены объединённого аккаунта.
//
// Грузится после app.js и account.js (el, on, acc, accData, apiOk, saveAccount,
// refreshAccount, errText, accMsg, ddmmyyyy).

let lgMergeToken = "";
let lgKeep = 0;

function lgPane(id) {
  for (const p of ["lg-form", "lg-wait", "lg-merge", "lg-merge-pick"]) el(p).hidden = p !== id;
}

function paintLogins() {
  const card = el("logins");
  if (!card) return;
  const me = (typeof accData !== "undefined" && accData.me) || (acc && acc.user) || null;
  card.style.display = acc && me ? "" : "none";
  if (!acc || !me) return;
  const tg = !!me.telegram_id;
  el("lg-tg-sub").textContent = tg ? (me.username ? "@" + me.username : "привязан") : "не привязан";
  el("lg-tg-st").className = "lg-st" + (tg ? " on" : "");
  el("lg-tg-st").textContent = tg ? "✓" : "";
  const mail = me.email || "";
  el("lg-mail-st").className = "lg-st" + (mail && me.email_verified ? " on" : mail ? " wait" : "");
  el("lg-mail-st").textContent = mail && me.email_verified ? "✓" : mail ? "…" : "";
  if (lgMergeToken || !el("lg-merge").hidden) return;      // идёт объединение — не сбиваем
  if (mail && me.email_verified) {
    el("lg-mail-sub").textContent = mail + " · можно входить по почте";
    lgPane(null);
  } else if (mail) {
    el("lg-mail-sub").textContent = mail + " · ждём подтверждения";
    el("lg-wait-mail").textContent = mail;
    lgPane("lg-wait");
  } else {
    el("lg-mail-sub").textContent = "не привязана";
    lgPane("lg-form");
  }
}

const lgMailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

async function lgLink() {
  const email = el("lg-email").value.trim();
  const password = el("lg-pass").value;
  if (!lgMailOk(email)) return accMsg("lg-msg", "проверьте адрес почты", "err");
  if (password.length < 8) return accMsg("lg-msg", "пароль — от 8 символов", "err");
  if (password !== el("lg-pass2").value) return accMsg("lg-msg", "пароли не совпадают", "err");
  const btn = el("lg-link");
  btn.disabled = true;
  accMsg("lg-msg", "привязываю…", "busy");
  try {
    const r = await apiOk("POST", "/auth/email/register", { email, password });
    el("lg-pass").value = ""; el("lg-pass2").value = "";
    if (r && r.merge_required) {
      el("lg-code").value = "";
      lgPane("lg-merge");
      accMsg("lg-msg", "код отправлен на " + email, "ok");
      setTimeout(() => el("lg-code").focus(), 100);
    } else {
      accMsg("lg-msg", "Письмо отправлено на " + email + " — подтвердите почту, и вход по ней заработает.", "ok");
      await refreshAccount(false);
      paintLogins();
    }
  } catch (e) {
    accMsg("lg-msg", errText(e), "err");
  }
  btn.disabled = false;
}

async function lgResend() {
  try {
    await apiOk("POST", "/auth/email/resend", {});
    accMsg("lg-msg", "Письмо отправлено ещё раз — проверьте и «Спам».", "ok");
  } catch (e) { accMsg("lg-msg", errText(e), "err"); }
}

async function lgCheck() {
  await refreshAccount(false);
  paintLogins();
  const me = accData.me || {};
  accMsg("lg-msg", me.email_verified ? "Почта подтверждена — теперь можно входить и по почте." : "Пока не подтверждена — нажмите ссылку в письме.",
    me.email_verified ? "ok" : "err");
}

async function lgCode() {
  const code = el("lg-code").value.replace(/\D/g, "");
  if (code.length !== 6) return accMsg("lg-msg", "код — 6 цифр из письма", "err");
  const btn = el("lg-code-go");
  btn.disabled = true;
  try {
    const r = await apiOk("POST", "/auth/email/merge/verify", { code });
    lgMergeToken = r.merge_token || "";
    if (!lgMergeToken) throw new Error("кабинет не прислал токен объединения — начните заново");
    const p = await apiOk("GET", "/auth/merge/" + encodeURIComponent(lgMergeToken));
    lgPaintMerge(p);
    lgPane("lg-merge-pick");
    accMsg("lg-msg", "");
  } catch (e) {
    accMsg("lg-msg", errText(e), "err");
  }
  btn.disabled = false;
}

function lgSubLine(u) {
  const s = u.subscription;
  const bal = (u.balance_kopeks || 0) / 100;
  const sub = !s ? "подписки нет"
    : (s.is_trial ? "пробная" : "подписка") + (s.end_date ? " до " + ddmmyyyy(s.end_date) : "")
      + (s.device_limit ? " · устройств " + s.device_limit : "");
  return sub + " · баланс " + bal.toLocaleString("ru-RU") + " ₽";
}

function lgPaintMerge(p) {
  const box = el("lg-merge-opts");
  box.innerHTML = "";
  const end = (u) => (u.subscription && u.subscription.end_date ? Date.parse(u.subscription.end_date) : 0);
  lgKeep = end(p.secondary) > end(p.primary) ? p.secondary.id : p.primary.id;   // по умолчанию — что дольше
  for (const [u, who] of [[p.primary, "Этот аккаунт (Telegram)"], [p.secondary, "Аккаунт с почтой " + (p.secondary.email || "")]]) {
    const b = document.createElement("button");
    b.className = "lg-opt" + (u.id === lgKeep ? " on" : "");
    const t = document.createElement("b"); t.textContent = who;
    const s = document.createElement("span"); s.textContent = lgSubLine(u);
    b.append(t, s);
    on(b, "click", () => {
      lgKeep = u.id;
      box.querySelectorAll(".lg-opt").forEach((x) => x.classList.toggle("on", x === b));
    });
    box.append(b);
  }
  el("lg-merge-go").disabled = false;
}

async function lgMerge() {
  if (!lgMergeToken || !lgKeep) return;
  const btn = el("lg-merge-go");
  btn.disabled = true;
  accMsg("lg-msg", "объединяю…", "busy");
  try {
    const r = await apiOk("POST", "/auth/merge/" + encodeURIComponent(lgMergeToken), { keep_subscription_from: lgKeep });
    lgMergeToken = "";
    if (r && r.access_token) {
      await saveAccount({ access: r.access_token, refresh: r.refresh_token || acc.refresh, user: r.user || acc.user });
    }
    accMsg("lg-msg", "Готово — это теперь один аккаунт: входите и через Telegram, и по почте.", "ok");
    lgPane(null);
    await refreshAccount(true);
    paintLogins();
  } catch (e) {
    accMsg("lg-msg", errText(e), "err");
    btn.disabled = false;
  }
}

on(el("lg-link"), "click", lgLink);
on(el("lg-pass2"), "keydown", (e) => { if (e.key === "Enter") lgLink(); });
on(el("lg-resend"), "click", lgResend);
on(el("lg-check"), "click", lgCheck);
on(el("lg-code-go"), "click", lgCode);
on(el("lg-code"), "keydown", (e) => { if (e.key === "Enter") lgCode(); });
on(el("lg-merge-go"), "click", lgMerge);
