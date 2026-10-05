// Акция «неделя подписки в подарок за установку приложения» — до 2 ноября 2026.
//
// Подарок — промокод бота на +7 дней (один раз на аккаунт, срок задан и в боте).
// Активируется через API кабинета, как ввод промокода в кабинете: бот сам
// продлевает подписку и отдаёт её в панель. Поэтому нужен вход через Telegram;
// без входа карточка зовёт войти.
//
// Грузится после account.js и пользуется его помощниками (acc, accData, apiOk,
// loginTelegram, refreshAccount, paintHomeAccount).

const GIFT = {
  code: "APPGIFT-FC4D65AE",
  until: Date.parse("2026-11-02T23:59:59+03:00"),
};

const giftLive = () => Date.now() < GIFT.until;

function paintGift() {
  const card = el("gift-card");
  if (!card) return;
  // забрал (или кабинет сказал, что уже забирал) — карточка больше не нужна
  if (!giftLive() || prefs.gift === "taken") { card.style.display = "none"; return; }
  card.style.display = "";
  const go = el("gift-go"), sub = el("gift-sub");
  if (!acc) {
    sub.textContent = "за установку приложения — войдите через Telegram, и неделя добавится · до 2 ноября";
    go.textContent = "Войти";
  } else if (accData.me && !accData.sub) {
    sub.textContent = "добавится к подписке — сначала оформите её или включите пробную · до 2 ноября";
    go.textContent = "Забрать";
  } else {
    sub.textContent = "за установку приложения ВПНушка — +7 дней к подписке · до 2 ноября";
    go.textContent = "Забрать";
  }
}

async function takeGift() {
  const go = el("gift-go"), msg = el("gift-msg");
  msg.textContent = ""; msg.className = "msg";
  if (!acc) { loginTelegram(); return; }
  go.disabled = true;
  try {
    await apiOk("POST", "/promocode/activate", { code: GIFT.code });
    await savePrefs({ gift: "taken" });
    say("🎁 +7 дней — подписка продлена. Спасибо, что с нами!");
    invoke("notify", { title: "ВПНушка", body: "🎁 Неделя подписки добавлена — спасибо, что установили приложение!" }).catch(() => {});
    refreshAccount();
  } catch (e) {
    const code = e.body && e.body.detail && e.body.detail.code;
    if (code === "already_used_by_user") {
      await savePrefs({ gift: "taken" });
      say("подарок уже получен на этот аккаунт");
    } else {
      msg.className = "msg err";
      msg.textContent =
        code === "no_subscription_for_days" ? "сначала оформите подписку или включите пробную — неделя добавится к ней"
        : code === "expired" || code === "inactive" ? "акция закончилась"
        : code === "daily_limit" ? "слишком много промокодов за сутки — попробуйте завтра"
        : errText(e);
    }
  }
  go.disabled = false;
  paintGift();
}

on(el("gift-go"), "click", takeGift);

// кабинет перерисовался (вход, выход, обновление подписки) — и карточка вместе с ним
{
  const base = paintHomeAccount;
  paintHomeAccount = function () { base(); paintGift(); };
}

// один раз за акцию — системное уведомление, чтобы о подарке узнали
setTimeout(() => {
  paintGift();
  if (giftLive() && prefs.gift !== "taken" && !prefs.giftNotified) {
    savePrefs({ giftNotified: true });
    invoke("notify", {
      title: "🎁 Подарок от ВПНушки",
      body: "Неделя подписки за установку приложения — заберите на главной до 2 ноября",
    }).catch(() => {});
  }
}, 4000);
