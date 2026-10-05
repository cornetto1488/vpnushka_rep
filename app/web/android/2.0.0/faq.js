// Частые вопросы и тарифы в разделе «Поддержка» (2.0.0).
//
// Тексты — свои, статичные (innerHTML здесь безопасен: ничего от пользователя
// или сервера сюда не попадает). Картинки лежат в faq/ рядом — работают и без
// интернета. Цены считаются по той же формуле, что у бота (classic): цена
// периода + 30 ₽ за каждое следующее устройство в месяц (за 14 дней — как за
// месяц). Поменялись цены в боте — поменять PERIODS / DEVICE_MONTH здесь.
//
// Грузится после app.js, account.js и support.js (el, on, show, invoke, say, supTab).

const PERIODS = [
  { days: 14, name: "14 дней", short: "14 дн", price: 40 },
  { days: 30, name: "1 месяц", short: "1 мес", price: 75 },
  { days: 60, name: "2 месяца", short: "2 мес", price: 140 },
  { days: 90, name: "3 месяца", short: "3 мес", price: 200 },
  { days: 180, name: "полгода", short: "6 мес", price: 380 },
  { days: 360, name: "год", short: "год", price: 750 },
];
const DEVICE_MONTH = 30;

const faqRub = (n) => n.toLocaleString("ru-RU").replace(/ /g, " ") + " ₽";
const faqMonths = (d) => Math.max(1, Math.round(d / 30));
const priceFor = (p, dev) => p.price + DEVICE_MONTH * (dev - 1) * faqMonths(p.days);

const FAQ = [
  {
    q: "Как подключиться?", ico: "power", open: true,
    a: `<ol class="faq-steps">
          <li><b>Войдите</b> в Кабинете — через Telegram или по почте.</li>
          <li><b>Нажмите большую кнопку</b> на главной. Подписка подтянется сама.</li>
          <li>Готово — сверху загорится <b>«VPN включён»</b> и сервер, через который идёт трафик.</li>
        </ol>
        <p>Видео со звуком — на сайте, раздел «Как подключить».</p>`,
    img: "faq/connect.webp", tall: true,
    act: [{ label: "Войти в Кабинет", go: "account" }, { label: "Видео на сайте", url: "https://vpnushka.lol/#howto" }],
  },
  {
    q: "Сколько стоит?", ico: "ruble",
    a: `<p><b>75 ₽ в месяц</b> за одно устройство, каждое следующее — <b>+30 ₽ в месяц</b>.
        За 3 месяца, полгода и год выходит дешевле — до <b>−17%</b>. Трафик 2 ТБ в месяц.</p>`,
    act: [{ label: "Все тарифы", tab: "prices" }],
  },
  {
    q: "Как оплатить или продлить?", ico: "card",
    a: `<p>В <b>Кабинете</b> нажмите «Пополнить баланс» — картой или криптовалютой. Затем выберите период:
        подписка продлится сразу, переподключаться не нужно.</p>
        <p>Оплатить можно и в боте <b>@vpnushka_bot</b> — баланс общий.</p>`,
    act: [{ label: "Открыть Кабинет", go: "account" }],
  },
  {
    q: "Сколько устройств можно подключить?", ico: "devices",
    a: `<p>В подписку входит <b>одно устройство</b>, каждое следующее — +30 ₽ в месяц. Добавить места можно в Кабинете.</p>
        <p>Если пишет <b>«лимит устройств заполнен»</b> — в Кабинете → «Устройства» отвяжите то, чем больше не пользуетесь.</p>`,
    img: "faq/devices.webp",
    act: [{ label: "Мои устройства", go: "account" }],
  },
  {
    q: "Можно войти без Telegram?", ico: "mail",
    a: `<p>Да. В Кабинете выберите <b>«Почта»</b> → «Регистрация»: укажите почту и пароль, подтвердите адрес по ссылке
        из письма — и войдите. Подписка и баланс привязываются к этому аккаунту.</p>
        <p>Забыли пароль — там же «Забыли пароль?», ссылка для сброса придёт на почту.</p>`,
    act: [{ label: "Войти по почте", go: "account" }],
  },
  {
    q: "Какой сервер выбрать?", ico: "globe",
    a: `<p>Серверы в <b>Германии, Франции, Турции, США и Гонконге</b>. Проще всего оставить <b>Auto</b> — приложение
        само выберет самый быстрый. Нужна конкретная страна — выберите её в «Серверах»; кнопка с пульсом замерит пинг.</p>`,
    img: "faq/servers.webp",
    act: [{ label: "Серверы", go: "servers" }],
  },
  {
    q: "На мобильном интернете ничего не открывается", ico: "signal",
    a: `<p>Бывает, что оператор пускает только на некоторые сайты. Для этого есть режим <b>«Мобильные операторы»</b>:
        Настройки → «Мобильные операторы» → войдите в Яндекс, остальное приложение сделает само.</p>
        <p>У каждого устройства — <b>свой документ</b>: телефон и компьютер можно подключить с одного аккаунта Яндекса,
        друг другу они не мешают. Скорость в этом режиме ниже обычной — хватит для мессенджеров и сайтов.</p>`,
    img: "faq/channel.webp",
    act: [{ label: "Мобильные операторы", go: "channel" }],
  },
  {
    q: "Подключено, но сайты не грузятся", ico: "alert",
    a: `<ol class="faq-steps">
          <li>Выберите <b>другой сервер</b> или Auto.</li>
          <li>В Кабинете нажмите <b>«Обновить подписку»</b>.</li>
          <li>На мобильном интернете — включите <b>«Мобильные операторы»</b>.</li>
          <li>Не помогло — напишите нам во вкладке «Чат» и оставьте <b>«Приложить журнал»</b>: по нему видно, где рвётся.</li>
        </ol>`,
    act: [{ label: "Написать в чат", tab: "chat" }],
  },
  {
    q: "Сколько трафика?", ico: "chart",
    a: `<p><b>2 ТБ в месяц</b> — с запасом даже для фильмов. Приложение предупредит на 80%, 95% и 100%,
        остаток видно в Кабинете.</p>`,
  },
  {
    q: "Блокировка рекламы", ico: "shield",
    a: `<p>Настройки → <b>«Блокировать рекламу и трекеры»</b>. Рекламные сети, баннеры и счётчики режутся прямо в туннеле —
        во всех приложениях и браузерах сразу.</p>`,
    img: "faq/settings.webp",
    act: [{ label: "Настройки", go: "more" }],
  },
  {
    q: "VPN или Прокси? И что такое маршрутизация?", ico: "route",
    a: `<p><b>VPN</b> — через туннель идёт всё устройство. <b>Прокси</b> — только программы, которые настроены на прокси.</p>
        <p><b>Маршрутизация</b>: «Всё» — весь трафик через VPN (рекомендуем); «Пресет» — через VPN только зарубежные
        сервисы и мессенджеры по нашим спискам, остальное напрямую на полной скорости; «Напрямую» — через VPN идёт
        только то, что вы сами добавите в исключения.</p>`,
    act: [{ label: "Маршрутизация", go: "rules" }],
  },
  {
    q: "Пригласи друга — как это работает?", ico: "gift",
    a: `<p>Отправьте свою ссылку. Друг получит <b>+7 дней</b>, вы — <b>+30 дней</b>, когда он оплатит подписку.
        Чем больше друзей, тем больше за каждого: до 60 дней.</p>`,
    img: "faq/invite.webp",
    act: [{ label: "Моя ссылка", go: "invite" }],
  },
  {
    q: "Нужно ли переустанавливать при обновлении?", ico: "refresh",
    a: `<p>Нет. Обновления приходят сами: на компьютере ставятся, когда VPN выключен, на телефоне интерфейс
        обновляется на лету. Версия — в Настройках, внизу.</p>`,
  },
  {
    q: "Что вы знаете обо мне?", ico: "lock",
    a: `<p>Только то, что нужно для работы сервиса: аккаунт Telegram или почту, подписку и технические журналы подключения.
        Подробно — в политике конфиденциальности.</p>`,
    act: [{ label: "Политика конфиденциальности", url: "https://vpnushka.lol/?privacy=1#privacy-policy" }],
  },
];

const FAQ_ICO = {
  power: '<path d="M12 3v8"/><path d="M6.3 7.3a8 8 0 1 0 11.4 0"/>',
  ruble: '<path d="M8 20V4h6a4 4 0 0 1 0 8H6"/><path d="M6 16h8"/>',
  card: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M3 10h18M7 15h3"/>',
  devices: '<rect x="2.5" y="4" width="13" height="10" rx="1.8"/><path d="M6 18h6"/><rect x="16" y="8" width="5.5" height="11" rx="1.4"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m4 7 8 6 8-6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  signal: '<path d="M5 19v-3M10 19v-6M15 19V9M20 19V5"/>',
  alert: '<path d="M12 3 2.5 20h19z"/><path d="M12 10v4M12 17h.01"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  shield: '<path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  route: '<circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 18h6.5a3.5 3.5 0 0 0 0-7h-5a3.5 3.5 0 0 1 0-7H16"/>',
  gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M5 12v8h14v-8M12 8v12M12 8S10.5 3.5 8 4.5 9 8 12 8zm0 0s1.5-4.5 4-3.5S15 8 12 8z"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
};

function faqAction(a) {
  if (a.tab) return supTab(a.tab);
  if (a.go) return show(a.go);
  if (a.url) invoke("open_url", { url: a.url }).catch((e) => say(errText(e), true));
}

function renderFaq() {
  const box = el("faq-list");
  if (!box || box.childElementCount) return;
  FAQ.forEach((f, i) => {
    const d = document.createElement("details");
    d.className = "card faq-item";
    if (f.open) d.open = true;
    d.innerHTML = `<summary><span class="faq-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${FAQ_ICO[f.ico] || ""}</svg></span>
        <span class="faq-q">${f.q}</span></summary>
      <div class="faq-a${f.img ? " has-img" : ""}${f.tall ? " tall" : ""}">
        <div class="faq-text">${f.a}<div class="faq-act"></div></div>
        ${f.img ? `<img class="faq-img" alt="" loading="lazy" data-src="${f.img}">` : ""}
      </div>`;
    // картинки (особенно анимация) грузим, только когда вопрос открыли
    const load = () => d.querySelectorAll("img[data-src]").forEach((im) => { im.src = im.dataset.src; im.removeAttribute("data-src"); });
    if (d.open) load();
    on(d, "toggle", () => d.open && load());
    const act = d.querySelector(".faq-act");
    (f.act || []).forEach((a, k) => {
      const b = document.createElement("button");
      b.className = "btn small" + (k === 0 ? " primary" : "");
      b.textContent = a.label;
      on(b, "click", () => faqAction(a));
      act.append(b);
    });
    box.append(d);
  });
}

let priceDev = 1;
function renderPrices() {
  const seg = el("price-dev"), grid = el("price-grid");
  if (!seg || !grid) return;
  if (!seg.childElementCount) {
    for (let n = 1; n <= 5; n++) {
      const b = document.createElement("button");
      b.dataset.dev = n;
      b.textContent = n;
      b.title = n + (n === 1 ? " устройство" : n < 5 ? " устройства" : " устройств");
      on(b, "click", () => { priceDev = n; renderPrices(); });
      seg.append(b);
    }
  }
  seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", +b.dataset.dev === priceDev));
  const base = priceFor(PERIODS[1], priceDev);   // месяц — точка отсчёта выгоды
  grid.innerHTML = "";
  for (const p of PERIODS) {
    const total = priceFor(p, priceDev), m = faqMonths(p.days);
    const perMonth = Math.round(total / m);
    const save = p.days >= 60 ? Math.round((1 - total / (base * m)) * 100) : 0;
    const c = document.createElement("div");
    c.className = "price-card" + (p.days === 360 ? " hot" : "");
    c.innerHTML = `<span class="pc-name">${p.name}</span>
      <b class="pc-total">${faqRub(total)}</b>
      <span class="pc-sub">${p.days >= 60 ? faqRub(perMonth) + " в месяц" : p.days === 14 ? "попробовать" : "помесячно"}</span>
      ${save > 0 ? `<span class="pc-save">−${save}%</span>` : ""}
      ${p.days === 360 ? `<span class="pc-badge">выгоднее всего</span>` : ""}`;
    grid.append(c);
  }
}

renderFaq();
renderPrices();
