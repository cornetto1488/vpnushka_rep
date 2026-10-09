// VPNUSHKA для iPhone: тот же интерфейс, что на ПК и Android (app/src), в WKWebView.
//
// Загружается ДО app.js. Строит window.__TAURI__ поверх моста WKScriptMessageHandler
// (Bridge.m): invoke → промис, который разрешает Objective-C через __ofxResolve.
// fetch к Clash API (127.0.0.1:9090 — его держит VPN-расширение) и к проверке IP
// идёт через натив: со страницы vpnushka:// это другой origin.
(function () {
  "use strict";
  var H = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ofx;
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
      if (!H) { rej("нет связи с приложением"); return; }
      var id = ++seq;
      pending.set(id, { res: res, rej: rej });
      H.postMessage({ id: id, cmd: cmd, args: args || {} });
    });
  }

  window.__TAURI__ = {
    platform: "ios",
    core: { invoke: invoke },
    event: {
      listen: function (event, f) {
        (listeners[event] = listeners[event] || []).push(f);
        return Promise.resolve(function () {
          listeners[event] = (listeners[event] || []).filter(function (x) { return x !== f; });
        });
      },
    },
    window: { getCurrentWindow: function () { return { minimize: function () { return Promise.resolve(); } }; } },
  };

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

  document.documentElement.classList.add("android", "ios");

  function hide(id) {
    var n = document.getElementById(id);
    if (!n) return;
    var row = n.closest("label") || n;
    row.style.display = "none";
  }
  function text(id, t) { var n = document.getElementById(id); if (n) n.textContent = t; }

  // На iPhone нет окна, трея и автозапуска, а правила по приложениям iOS не
  // позволяет. Канал «Мобильные операторы» (OpenFlux) есть — он собран в
  // VPN-расширение. «Прокси» — тоннель без маршрутов с системным прокси
  // 127.0.0.1:10808 (PacketTunnelProvider).
  ["autostart", "tray-on-close", "start-min", "auto-update", "win-min", "win-close", "rule-pick"].forEach(hide);
  var about = document.getElementById("about-dir");
  if (about && about.closest(".kv")) about.closest(".kv").style.display = "none";
  var appsKind = document.querySelector('#rule-kind button[data-kind="apps"]');
  if (appsKind) appsKind.style.display = "none";
  var tunBtn = document.querySelector('#mode [data-mode="tun"]');
  if (tunBtn) tunBtn.textContent = "VPN (весь телефон)";
  var tunBox = document.getElementById("tun-mtu");
  tunBox = tunBox && tunBox.closest(".grid2") && tunBox.closest(".grid2").parentElement;
  if (tunBox) {
    tunBox.style.display = "none";
    var hr = tunBox.previousElementSibling;
    if (hr && hr.classList.contains("hr")) hr.style.display = "none";
  }
  // «Программы» скрыты — по умолчанию открываем «Сайты»
  var dom = document.querySelector('#rule-kind button[data-kind="domains"]');
  if (dom) setTimeout(function () { dom.click(); }, 0);
  document.querySelectorAll("#view-rules .hint").forEach(function (h) {
    if (h.textContent.indexOf("«Программы»") >= 0) {
      h.textContent = "Исключения сильнее режима и фирменного пресета. Применяются при следующем подключении.";
    }
  });
  text("quit", "Отключиться");
  text("log-folder", "Отправить журнал");

  // «Назад» свайпом нет — шторки закрываются тапом по фону (как на ПК)

  // статус-бар и фон под страницей — как у темы страницы
  var lastDark = null;
  function syncBars() {
    var dark = document.documentElement.dataset.theme !== "light";
    if (dark === lastDark) return;
    lastDark = dark;
    invoke("__theme", { dark: dark }).catch(function () {});
  }
  new MutationObserver(syncBars).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  syncBars();
})();
