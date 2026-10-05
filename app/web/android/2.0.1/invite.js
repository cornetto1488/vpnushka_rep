// «Пригласи друга» — реферальная программа бота Bedolaga через API кабинета.
//
// Награды настраиваются в боте (таблица referral_reward_levels, схема levels,
// режим tiers): за каждого друга, впервые пополнившего баланс от 75 ₽, — дни
// подписки пригласившему и бонус другу; чем больше оплативших друзей, тем выше
// ступень и больше дней за следующего. Цифры на экране берутся из /referral/terms,
// поэтому, если в боте поменять бонусы, приложение покажет новые сами.
//
// Грузится после account.js (acc, apiOk, rawApi, loginTelegram, rub, ddmmyyyy).

let inv = { terms: null, info: null, friends: null };

const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100, b = a % 10;
  return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
};
const daysWord = (n) => n + " " + plural(n, "день", "дня", "дней");
const friendsWord = (n) => n + " " + plural(n, "друг", "друга", "друзей");
// «30 дн. подписки» → 30
const daysOf = (s) => { const m = String(s || "").match(/(\d+)\s*дн/); return m ? +m[1] : 0; };

// ступени из terms: [{need, you, friend, current}]
function invLevels() {
  const t = inv.terms;
  if (!t || !Array.isArray(t.levels)) return [];
  return t.levels.map((l) => ({
    need: l.required_referrals || 0,
    you: daysOf((l.rewards || []).join(" ")),
    friend: daysOf(l.referee_reward),
    current: !!l.is_current,
  })).sort((a, b) => a.need - b.need);
}

function currentLevel(levels) {
  const paid = inv.terms && inv.terms.tier_referrals_active || 0;
  return levels.filter((l) => l.need <= paid).pop() || levels[0];
}

function paintInviteCards() {
  const t = inv.terms;
  const live = !t || t.is_enabled !== false;
  const levels = invLevels();
  const cur = levels.length ? currentLevel(levels) : null;
  el("invite-card").style.display = live ? "" : "none";
  document.querySelectorAll(".invite-card").forEach((c) => { c.style.display = live ? "" : "none"; });
  if (!cur) return;
  el("invite-card-title").textContent = cur.you >= 28 && cur.you <= 31
    ? "Позови друга — месяц бесплатно" : "Позови друга — +" + daysWord(cur.you);
  el("invite-card-sub").textContent = "вам +" + daysWord(cur.you) + ", другу +" + daysWord(cur.friend) + " — за каждого, кто оплатит";
  el("acc-invite-sub").textContent = "+" + daysWord(cur.you) + " за каждого друга";
}

function paintInvite() {
  const t = inv.terms;
  const levels = invLevels();
  const cur = levels.length ? currentLevel(levels) : null;
  if (cur) {
    el("inv-you").textContent = "+" + cur.you;
    el("inv-friend").textContent = "+" + cur.friend;
  }
  if (t) el("inv-min").textContent = rub(t.minimum_topup_kopeks);

  el("inv-out").style.display = acc ? "none" : "";
  el("inv-in").style.display = acc ? "" : "none";
  if (!acc) return;

  const i = inv.info;
  el("inv-link").textContent = i ? i.bot_referral_link || i.referral_link : "загружаю…";
  el("inv-share").style.display = navigator.share ? "" : "none";
  el("inv-n").textContent = i ? i.total_referrals : "—";
  el("inv-paid").textContent = i ? i.active_referrals : "—";
  el("inv-days").textContent = i ? i.total_earnings_days || 0 : "—";

  // ступени: текущая подсвечена, у следующей — сколько осталось
  const box = el("inv-levels");
  box.textContent = "";
  const paid = t && t.tier_referrals_active || 0;
  for (const l of levels) {
    const row = document.createElement("div");
    row.className = "inv-level" + (cur && l.need === cur.need ? " on" : "") + (l.need > paid ? " locked" : "");
    const a = document.createElement("span");
    a.textContent = l.need ? "от " + l.need + " " + plural(l.need, "друга", "друзей", "друзей") : "с первого друга";
    const b = document.createElement("b");
    b.textContent = "+" + daysWord(l.you);
    const c = document.createElement("span");
    c.className = "sub";
    c.textContent = "другу +" + daysWord(l.friend);
    row.append(a, b, c);
    box.append(row);
  }
  const next = levels.find((l) => l.need > paid);
  el("inv-next").textContent = next
    ? "Ещё " + friendsWord(next.need - paid) + " с оплатой — и за каждого следующего будет +" + daysWord(next.you)
    : levels.length ? "У вас максимальная ступень — спасибо, что рекомендуете ВПНушку!" : "";

  const fl = el("inv-friends");
  fl.textContent = "";
  const items = (inv.friends && inv.friends.items) || [];
  el("inv-friends-fold").style.display = items.length ? "" : "none";
  for (const f of items) {
    const row = document.createElement("div");
    row.className = "kv";
    const a = document.createElement("span");
    a.textContent = f.first_name || (f.username ? "@" + f.username : "друг #" + f.id);
    const b = document.createElement("b");
    b.textContent = (f.has_paid ? "оплата ✓" : "без оплаты") + " · " + ddmmyyyy(f.created_at);
    row.append(a, b);
    fl.append(row);
  }
}

async function loadInvite() {
  if (inv.loading) return;
  inv.loading = true;
  try {
    // условия публичные: без входа — стартовая ступень, со входом — своя
    const r = await rawApi("GET", "/referral/terms", null, acc ? acc.access : null);
    if (r.status === 200 && r.body) inv.terms = r.body;
  } catch (_) {}
  if (acc) {
    try {
      const [info, friends] = await Promise.all([
        apiOk("GET", "/referral"),
        apiOk("GET", "/referral/list?per_page=50").catch(() => null),
      ]);
      inv.info = info;
      inv.friends = friends;
    } catch (e) {
      el("inv-msg").className = "msg err";
      el("inv-msg").textContent = errText(e);
    }
  }
  inv.loading = false;
  paintInviteCards();
  if (view === "invite") paintInvite();
}

// вызывает show("invite") из app.js
function openInvite() {
  el("inv-msg").textContent = "";
  paintInvite();
  loadInvite();
}

const invLink = () => inv.info && (inv.info.bot_referral_link || inv.info.referral_link);
const invText = () => {
  const lv = invLevels();
  const cur = lv.length ? currentLevel(lv) : null;
  return "Пользуюсь ВПНушкой — быстро и без заморочек. По моей ссылке +"
    + daysWord(cur ? cur.friend : 7) + " к подписке при первой оплате:";
};

async function copyInvite() {
  const link = invLink();
  if (!link) return;
  const text = invText() + " " + link;
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch (_) {
    // WebView без доступа к буферу — старый способ
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    try { ok = document.execCommand("copy"); } catch (_) {}
    ta.remove();
  }
  el("inv-msg").className = "msg" + (ok ? " ok" : " err");
  el("inv-msg").textContent = ok ? "Скопировано — отправьте другу" : "Не получилось скопировать — выделите ссылку вручную";
}

on(el("inv-copy"), "click", copyInvite);
on(el("inv-link"), "click", copyInvite);
on(el("inv-tg"), "click", () => {
  const link = invLink();
  if (!link) return;
  const url = "https://t.me/share/url?url=" + encodeURIComponent(link) + "&text=" + encodeURIComponent(invText());
  invoke("open_url", { url }).catch((e) => say(errText(e), true));
});
on(el("inv-share"), "click", () => {
  const link = invLink();
  if (link && navigator.share) navigator.share({ title: "ВПНушка", text: invText(), url: link }).catch(() => {});
});
on(el("inv-login"), "click", () => openAuth());

// вошли/вышли из кабинета — карточки и экран вслед
{
  const base = paintHomeAccount;
  paintHomeAccount = function () {
    base();
    if (acc && !inv.info) loadInvite();
    if (!acc) inv.info = inv.friends = null;
    if (view === "invite") paintInvite();
  };
}

setTimeout(loadInvite, 2500);
