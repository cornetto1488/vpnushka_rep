// Runs inside the Yandex webview window. Injected at document start AND
// re-evaluated by the Rust side every ~0.5 s, so it must be idempotent: all
// state lives on window.__ofx and every step guards itself.
//
// Split of work — both halves proven separately:
//   * Rust (reqwest + the OAuth token grabbed from this window) does the REST
//     part: upload a blank .docx, publish it, read back resource_id (uid:hash)
//     + public_url. Validated in ofx_provision.py.
//   * This script does the ONE session-gated step, same-origin on disk.yandex.ru,
//     with the page's real `sk`: mpfs/office-set-access-state accessState="all",
//     which turns the public link into an edit-by-link (what OpenFlux rides).
//     A wrong/expired sk answers 403 with the correct ckey — we retry with it.
//
// Handshake with Rust (no IPC: this is a remote origin):
//   step 1 out: https://oauth.yandex.ru/ofx-token?t=<access_token> | ?err=<msg>
//   step 3 in : https://disk.yandex.ru/client/disk#ofx-req=<b64url({rid,url})>
//   step 3 out: https://disk.yandex.ru/ofx-done?doc=<url> | ?err=<msg>
// Rust polls the window URL, so a real navigation is the signal.
(function () {
  "use strict";

  var S = (window.__ofx = window.__ofx || { sentToken: false, running: false, done: false });

  // ---- step 1: OAuth implicit flow -----------------------------------------
  // Яндекс возвращает токен во ФРАГМЕНТЕ (verification_code#access_token=…).
  // WebView2 считает это same-document и фрагмент в url() не отдаёт, поэтому
  // перекладываем токен в путь+query и делаем НАСТОЯЩУЮ навигацию: её видно.
  // Если фрагмент уже стёрли — снимаем токен прямо со страницы: она его
  // печатает, чтобы можно было скопировать руками.
  var TOKEN_RE = /\b(y0_[A-Za-z0-9_.\-]{20,}|AQAA[A-Za-z0-9_.\-]{20,})/;

  function scrapeToken() {
    try {
      var els = document.querySelectorAll("input,textarea");
      for (var i = 0; i < els.length; i++) {
        var m = TOKEN_RE.exec(els[i].value || "");
        if (m) return m[1];
      }
      var text = document.body ? document.body.innerText || "" : "";
      var t = TOKEN_RE.exec(text);
      if (t) return t[1];
    } catch (e) {}
    return null;
  }

  // The report is a navigation to /ofx-token, which Rust sees when it polls the
  // window URL. Яндекс может увести нас с этого адреса раньше, чем Rust успеет
  // опросить (404 -> редирект), поэтому токен лежит в sessionStorage и мы
  // возвращаемся на /ofx-token при каждом прогоне, пока Rust не заберёт его и
  // не уведёт окно на Диск сам.
  var TOK_STORE = "__ofx_tok";

  function report(kind, value) {
    try { sessionStorage.setItem(TOK_STORE, kind + "|" + value); } catch (e) {}
    location.replace("https://oauth.yandex.ru/ofx-token?" + kind + "=" + encodeURIComponent(value));
  }

  function oauthStep() {
    if (location.pathname.indexOf("/ofx-token") === 0) return;   // Rust уже видит адрес
    var saved = null;
    try { saved = sessionStorage.getItem(TOK_STORE); } catch (e) {}
    if (saved) {                       // нас увели с /ofx-token — возвращаемся
      var i = saved.indexOf("|");
      report(saved.slice(0, i), saved.slice(i + 1));
      return;
    }
    var hay = (location.hash || "") + "&" + (location.search || "");
    var m = /[#&?]access_token=([^&]+)/.exec(hay);
    var tok = m ? decodeURIComponent(m[1]) : scrapeToken();
    if (tok) { report("t", tok); return; }
    var e = /[#&?]error=([^&]+)/.exec(hay);
    if (e) report("err", decodeURIComponent(e[1]));
  }

  if (location.hostname === "oauth.yandex.ru") { oauthStep(); return; }
  if (location.hostname !== "disk.yandex.ru") return;        // passport, captcha…
  if (location.pathname.indexOf("/ofx-done") === 0) return;  // our own result page

  // ---- step 3: flip the published doc to edit-by-link ------------------------
  var STORE = "__ofx_req";
  var SK_WAIT_MS = 25000;   // the SPA fills the page config in asynchronously
  var POLL_MS = 400;

  function b64urlDecode(s) {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    var bin = atob(s), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  }

  // The request survives the SPA rewriting location.hash on boot, and a login
  // redirect in the middle (sessionStorage is per-origin, disk.yandex.ru).
  function readRequest() {
    var m = /[#&]ofx-req=([A-Za-z0-9\-_]+)/.exec(location.hash || "");
    if (m) {
      try {
        var req = JSON.parse(b64urlDecode(m[1]));
        if (req && req.rid && req.url) {
          try { sessionStorage.setItem(STORE, JSON.stringify(req)); } catch (e) {}
          return req;
        }
      } catch (e) {}
    }
    try {
      var s = sessionStorage.getItem(STORE);
      return s ? JSON.parse(s) : null;
    } catch (e) { return null; }
  }

  // Same trick as step 1: the answer is a navigation, and it is repeated from
  // sessionStorage if the SPA takes us somewhere else before Rust looks.
  var DONE_STORE = "__ofx_done";

  function finish(kind, value) {
    S.done = true;
    try {
      sessionStorage.removeItem(STORE);
      sessionStorage.setItem(DONE_STORE, kind + "|" + String(value));
    } catch (e) {}
    location.replace("https://disk.yandex.ru/ofx-done?" + kind + "=" + encodeURIComponent(String(value)));
  }

  // The web session's sk, exactly as the Disk UI uses it for /edit/api calls.
  // It shows up in different places depending on the build, so try them all and
  // fall back to scraping the inline page config.
  function getSk() {
    try {
      var g = window;
      var cands = [
        g.__CONFIG__ && g.__CONFIG__.sk,
        g.__STORE__ && g.__STORE__.environment && g.__STORE__.environment.sk,
        g.Ya && g.Ya.sk,
        g.SK, g.sk,
      ];
      for (var i = 0; i < cands.length; i++) {
        if (typeof cands[i] === "string" && cands[i].length > 8) return cands[i];
      }
      var m = /["']sk["']\s*:\s*["']([0-9a-f]{16,}:\d+)["']/i.exec(document.documentElement.innerHTML);
      if (m) return m[1];
    } catch (e) {}
    return null;
  }

  function waitForSk(deadline) {
    return new Promise(function (resolve) {
      (function tick() {
        var sk = getSk();
        if (sk) return resolve(sk);
        if (Date.now() > deadline) return resolve(null);
        setTimeout(tick, POLL_MS);
      })();
    });
  }

  function setAccess(resourceId, sk) {
    return fetch("/edit/api?m=mpfs/office-set-access-state", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
      body: JSON.stringify({
        sk: sk || "x",
        apiMethod: "mpfs/office-set-access-state",
        requestParams: { resourceId: resourceId, accessState: "all" },
      }),
    }).then(function (r) {
      return r.text().then(function (t) {
        var j = {};
        try { j = JSON.parse(t); } catch (e) {}
        return { status: r.status, body: j, text: t };
      });
    });
  }

  function ckeyOf(res) {
    return res && res.body && res.body.error && res.body.error.ckey ? res.body.error.ckey : null;
  }

  function run(req) {
    if (S.running || S.done) return;
    S.running = true;
    // Only the Disk app (/client/…) ever carries an sk; on a bare page such as
    // robots.txt (Android) go straight to the ckey round-trip.
    var inApp = location.pathname.indexOf("/client/") === 0;
    waitForSk(Date.now() + (inApp ? SK_WAIT_MS : 0))
      .then(function (sk) {
        return setAccess(req.rid, sk).then(function (res) {
          // A real session converges on the ckey handed back by the 403; retry
          // a couple of times because each answer carries a fresh one.
          var attempts = 0;
          function retry(r) {
            var ck = ckeyOf(r);
            if (r.status === 200 || !ck || attempts >= 2) return r;
            attempts++;
            return setAccess(req.rid, ck).then(retry);
          }
          return retry(res);
        });
      })
      .then(function (res) {
        if (res.status === 200) finish("doc", req.url);
        else finish("err", "office-set-access-state -> " + res.status + " " + (res.text || "").slice(0, 200));
      })
      .catch(function (e) { S.running = false; finish("err", (e && e.message) || e); });
  }

  var done = null;
  try { done = sessionStorage.getItem(DONE_STORE); } catch (e) {}
  if (done) {                             // ответ уже есть — держим адрес
    var j = done.indexOf("|");
    finish(done.slice(0, j), done.slice(j + 1));
    return;
  }

  var req = readRequest();
  if (!req) return;                       // ordinary Disk page, nothing to do
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { run(req); });
  } else {
    run(req);
  }

  // Kept for manual debugging from devtools.
  window.__ofxSetAccess = function (rid, url) { S.running = false; S.done = false; run({ rid: rid, url: url }); };
})();
