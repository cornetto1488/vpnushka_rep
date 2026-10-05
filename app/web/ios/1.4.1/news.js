// Новости ВПНушки. Пишутся в админке кабинета бота (Новости), экспорт на панели
// (/root/vpn-443/news/news_export.py) раз в 2 минуты кладёт один и тот же
// news.json на ноды обновлений и на сайт vpnushka.lol — приложение и сайт
// показывают одно и то же, и выпускать версию ради новости не нужно.
//
// Источники по очереди: сайт, затем ноды (запасные копии). Картинки в JSON относительные (img/…), разрешаем от адреса источника.
// Последний удачный ответ хранится в prefs.news — без сети лента не пустеет.
//
// Грузится после app.js (el, on, show, prefs, savePrefs, invoke, say).

const NEWS_SOURCES = [
  { url: "https://vpnushka.lol/api/news", base: "https://vpnushka.lol/news/" },
  { url: "https://store.vpnushka.lol/app/news/news.json", base: "https://store.vpnushka.lol/app/news/" },
  { url: "https://cloud.vpnushka.lol/app/news/news.json", base: "https://cloud.vpnushka.lol/app/news/" },
  { url: "https://shop.vpnushka.lol/app/news/news.json", base: "https://shop.vpnushka.lol/app/news/" },
];

let news = { items: [], base: "" };
let newsOpen = null;   // открытая статья

async function fetchNews() {
  for (const src of NEWS_SOURCES) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(src.url, { cache: "no-store", signal: ctl.signal });
      if (!r.ok) continue;
      const d = await r.json();
      if (d && Array.isArray(d.items)) return { items: d.items, base: src.base };
    } catch (_) { /* следующий источник */ } finally { clearTimeout(t); }
  }
  return null;
}

const newsUrl = (src) => {
  if (!src) return "";
  if (/^https:\/\//i.test(src)) return src;
  return /^img\//.test(src) ? news.base + src : "";
};
const newsDay = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
};
const newestId = () => news.items.reduce((m, n) => Math.max(m, n.id || 0), 0);

// Текст статьи очищен экспортом; здесь — вторая линия: только белый список
// тегов, из атрибутов — ссылка и картинка с нашего источника.
const NEWS_TAGS = new Set(["P", "BR", "B", "STRONG", "I", "EM", "U", "S", "A", "UL", "OL", "LI",
  "H2", "H3", "H4", "BLOCKQUOTE", "CODE", "PRE", "IMG", "HR"]);
function newsNodes(src, out) {
  for (const n of Array.from(src.childNodes)) {
    if (n.nodeType === 3) { out.append(document.createTextNode(n.textContent)); continue; }
    if (n.nodeType !== 1 || /^(SCRIPT|STYLE|IFRAME|OBJECT|TEMPLATE)$/.test(n.tagName)) continue;
    if (!NEWS_TAGS.has(n.tagName)) { newsNodes(n, out); continue; }
    const c = document.createElement(n.tagName);
    if (n.tagName === "A") {
      const href = n.getAttribute("href") || "";
      if (/^(https?:|tg:)/i.test(href)) {
        c.dataset.href = href;
        c.href = "#";
      }
    } else if (n.tagName === "IMG") {
      const u = newsUrl(n.getAttribute("src"));
      if (!u) continue;
      c.src = u;
      c.loading = "lazy";
      c.alt = "";
      c.addEventListener("error", () => c.remove());
    }
    newsNodes(n, c);
    out.append(c);
  }
}

function paintNewsCard() {
  const card = el("news-card");
  if (!news.items.length) { card.style.display = "none"; return; }
  card.style.display = "";
  const top = news.items[0];
  const unread = newestId() > (prefs.newsSeen || 0);
  el("news-card-title").textContent = unread ? "Новости · есть новое" : "Новости";
  el("news-card-sub").textContent = top.title;
  el("news-dot").style.display = unread ? "" : "none";
}

function newsMeta(n) {
  return [n.category, newsDay(n.date)].filter(Boolean).join(" · ");
}

function renderNewsList() {
  const box = el("news-list");
  box.textContent = "";
  if (!news.items.length) {
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = "Новостей пока нет";
    box.append(d);
    return;
  }
  for (const n of news.items) {
    const b = document.createElement("button");
    b.className = "card news-item" + (n.featured ? " featured" : "");
    if (n.image) {
      const img = document.createElement("img");
      img.src = newsUrl(n.image);
      img.alt = "";
      img.loading = "lazy";
      img.addEventListener("error", () => img.remove());
      b.append(img);
    }
    const meta = document.createElement("span");
    meta.className = "news-meta";
    meta.textContent = newsMeta(n);
    const t = document.createElement("b");
    t.textContent = n.title;
    const ex = document.createElement("span");
    ex.className = "news-ex";
    ex.textContent = n.excerpt || "";
    b.append(meta, t, ex);
    b.addEventListener("click", () => openArticle(n));
    box.append(b);
  }
}

function openArticle(n) {
  newsOpen = n;
  el("news-list").hidden = true;
  el("news-art").hidden = false;
  const img = el("news-art-img");
  img.hidden = !n.image;
  if (n.image) img.src = newsUrl(n.image);
  el("news-art-meta").textContent = newsMeta(n) + (n.minutes ? " · " + n.minutes + " мин" : "");
  el("news-art-title").textContent = n.title;
  const body = el("news-art-html");
  body.textContent = "";
  newsNodes(new DOMParser().parseFromString(n.html || "", "text/html").body, body);
  el("view-news").scrollTop = 0;
}

function closeArticle() {
  if (!newsOpen) return false;
  newsOpen = null;
  el("news-art").hidden = true;
  el("news-list").hidden = false;
  return true;
}

// вызывает show("news") из app.js
function openNewsView() {
  closeArticle();
  renderNewsList();
  if (newestId() > (prefs.newsSeen || 0)) savePrefs({ newsSeen: newestId() });
  paintNewsCard();
  refreshNews(false);
}

async function refreshNews(notify) {
  const got = await fetchNews();
  if (!got) return;
  const changed = JSON.stringify(got.items) !== JSON.stringify(news.items);
  news = got;
  if (changed) {
    savePrefs({ news: { items: got.items, base: got.base, at: Date.now() } });
    if (view === "news" && !newsOpen) renderNewsList();
  }
  // о новой статье — системным уведомлением, один раз. При первом запуске
  // старые новости «прочитанными» не считаем, но и не звоним о них.
  const top = newestId();
  if (prefs.newsNotified == null) {
    savePrefs({ newsNotified: top });
  } else if (notify && top > prefs.newsNotified) {
    const fresh = news.items.find((n) => n.id === top);
    savePrefs({ newsNotified: top });
    if (fresh) invoke("notify", { title: "ВПНушка · новости", body: fresh.title }).catch(() => {});
  }
  paintNewsCard();
}

// ссылки в статье — во внешнем браузере
on(el("news-art-html"), "click", (e) => {
  const a = e.target.closest("a[data-href]");
  if (!a) return;
  e.preventDefault();
  invoke("open_url", { url: a.dataset.href }).catch((err) => say(errText(err), true));
});

// «Назад» из статьи — к списку, а не на главную: кнопка в шапке раздела,
// системная «Назад» Android и Esc
document.querySelectorAll("#view-news [data-back], #tb-back").forEach((b) =>
  b.addEventListener("click", (e) => {
    if (view === "news" && closeArticle()) { e.stopImmediatePropagation(); e.preventDefault(); }
  }, true));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && view === "news" && closeArticle()) e.stopImmediatePropagation();
}, true);
{
  const base = window.__ofxViewBack;
  window.__ofxViewBack = () => (view === "news" && closeArticle()) || base();
}

(async () => {
  for (let i = 0; i < 50 && !(prefs && Object.keys(prefs).length); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (prefs.news && Array.isArray(prefs.news.items)) news = { items: prefs.news.items, base: prefs.news.base || "" };
  paintNewsCard();
  setTimeout(() => refreshNews(true), 3000);
  setInterval(() => refreshNews(true), 30 * 60 * 1000);
})();
