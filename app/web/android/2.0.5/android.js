// VPNUSHKA для Android: тот же интерфейс, что на ПК (app/src), в WebView.
//
// Загружается ДО app.js. Строит window.__TAURI__ поверх Java-моста
// (window.OfxNative, см. MainActivity.Bridge): invoke → промис, который
// разрешает Java, listen → события движка. Ещё здесь то, что на телефоне
// устроено иначе, чем в окне на ПК: fetch к Clash API и к проверке IP идёт
// через Java, кнопка «назад», цвет системных панелей, лишние для телефона
// настройки (трей, автозапуск).
(function () {
  "use strict";
  var N = window.OfxNative;
  var pending = new Map();
  var listeners = {};
  var seq = 0;

  window.__ofxResolve = function (id, ok, value) {
    var p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (ok) p.res(value); else p.rej(value);
  };
  window.__ofxEmit = function (event, payload) {
    (listeners[event] || []).slice().forEach(function (f) {
      try { f({ event: event, payload: payload }); } catch (e) {}
    });
  };

  function invoke(cmd, args) {
    return new Promise(function (res, rej) {
      if (!N) { rej("нет связи с приложением"); return; }
      var id = ++seq;
      pending.set(id, { res: res, rej: rej });
      N.invoke(id, cmd, JSON.stringify(args || {}));
    });
  }

  window.__TAURI__ = {
    platform: "android",
    core: { invoke: invoke },
    event: {
      listen: function (event, f) {
        (listeners[event] = listeners[event] || []).push(f);
        return Promise.resolve(function () {
          listeners[event] = (listeners[event] || []).filter(function (x) { return x !== f; });
        });
      },
    },
    window: { getCurrentWindow: function () { return { minimize: function () { return invoke("minimize_window"); } }; } },
  };

  // Clash API живёт на http://127.0.0.1 — со страницы https это смешанный
  // контент и доступ к локальной сети, WebView такое режет. А проверку IP
  // WebView сделал бы мимо VPN: само приложение из VPN исключено. Оба случая
  // выполняет Java, остальное — обычный fetch.
  var nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    init = init || {};
    var url = typeof input === "string" ? input : input.url;
    if (/^http:\/\/(127\.0\.0\.1|localhost):/.test(url) || url.indexOf("https://api.ipify.org") === 0) {
      var headers = init.headers || {};
      if (typeof Headers !== "undefined" && headers instanceof Headers) {
        var h = {};
        headers.forEach(function (v, k) { h[k] = v; });
        headers = h;
      }
      return invoke("__http", {
        method: init.method || "GET", url: url, headers: headers,
        body: init.body == null ? null : String(init.body),
      }).then(function (r) {
        var empty = r.status === 204 || r.status === 304;
        return new Response(empty ? null : r.body, { status: r.status, headers: { "content-type": r.type || "text/plain" } });
      }, function (e) { throw new TypeError(String(e)); });
    }
    return nativeFetch(input, init);
  };

  document.documentElement.classList.add("android");

  // цвет строки состояния и навигации — как у темы страницы
  var lastDark = null;
  function syncBars() {
    var dark = document.documentElement.dataset.theme === "dark";
    if (dark === lastDark) return;
    lastDark = dark;
    invoke("__theme", { dark: dark }).catch(function () {});
  }
  new MutationObserver(syncBars).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  // «Назад»: закрыть шторку → раздел выше → свернуть приложение
  window.__ofxBack = function () {
    var open = document.querySelector(".sheet.open");
    if (open) { open.classList.remove("open"); return true; }
    // раздел → его родитель (правила/канал → настройки) → главная
    return window.__ofxViewBack ? window.__ofxViewBack() : false;
  };

  function hideRow(id) {
    var n = document.getElementById(id);
    var row = n && (n.closest("label") || n);
    if (row) row.style.display = "none";
  }
  function text(id, t) { var n = document.getElementById(id); if (n) n.textContent = t; }

  // На телефоне нет окна, трея и автозапуска. Режим «Прокси» — без VPN,
  // локальный HTTP/SOCKS5 для приложений с настройкой прокси (Telegram).
  ["autostart", "tray-on-close", "start-min"].forEach(hideRow);
  ["win-min", "win-close", "about-dir"].forEach(function (id) {
    var n = document.getElementById(id);
    if (!n) return;
    (id === "about-dir" ? n.closest(".kv") : n).style.display = "none";
  });
  // TUN-адаптер на телефоне — системный VpnService, его MTU/стек не настраиваются
  var tunBtn = document.querySelector('#mode [data-mode="tun"]');
  if (tunBtn) tunBtn.textContent = "VPN (весь телефон)";
  var tunBox = document.getElementById("tun-mtu");
  tunBox = tunBox && tunBox.closest(".grid2") && tunBox.closest(".grid2").parentElement;
  if (tunBox) {
    tunBox.style.display = "none";
    var hr = tunBox.previousElementSibling;
    if (hr && hr.classList.contains("hr")) hr.style.display = "none";
  }
  text("log-folder", "Отправить журнал");
  text("quit", "Отключиться и выйти");
  var pick = document.getElementById("rule-pick");
  if (pick) pick.title = "Выбрать из установленных приложений";
  var ph = document.querySelector("#sheet-procs h2");
  if (ph && ph.firstChild) ph.firstChild.textContent = "Приложения";
  var tun = document.querySelector('#rule-kind button[data-kind="apps"]');
  if (tun) tun.textContent = "Приложения";
  document.querySelectorAll("#view-rules .hint").forEach(function (h) {
    if (h.textContent.indexOf("«Программы»") >= 0) {
      h.textContent = "Исключения сильнее режима и фирменного пресета. Применяются при следующем "
        + "подключении. Выбранные приложения ходят в интернет напрямую, мимо VPN — например, банк.";
    }
  });
})();
