// Согласие с документами (Пользовательское соглашение, Политика
// конфиденциальности, Правила) — при первом запуске и при каждой новой
// редакции (POLICY_VERSION в policies.js). Пока не принято, приложение закрыто
// этим экраном и не подключается. «Принимаю» включается, только когда текст
// пролистан до самого конца.
//
// Грузится ДО app.js (policyGate должна существовать к первому await в его
// запуске), поэтому el/on/invoke из app.js трогаем только внутри функций.

let consentDone = null;
let consentWired = false;

function paintConsent(readOnly) {
  wireConsent();
  const body = el("c-body");
  body.textContent = "";
  for (const d of POLICIES) {
    const h = document.createElement("h3");
    h.textContent = d.title;
    const box = document.createElement("div");
    box.innerHTML = d.html;               // наш собственный текст из policies.js
    body.append(h, box);
  }
  body.scrollTop = 0;
  el("c-bar").style.width = "0";
  el("c-accept").disabled = true;
  el("c-sub").textContent = readOnly ? "Редакция от 24 сентября 2026 года"
    : "Прочитайте документы до конца — кнопка «Принимаю» станет активной";
  el("c-note").style.display = readOnly ? "none" : "";
  el("c-accept").parentElement.style.display = readOnly ? "none" : "";
  el("c-close").style.display = readOnly ? "" : "none";
  el("consent").style.display = "";
  checkRead();
}

// Дочитал — значит, увидел низ последнего документа (с запасом в пару пикселей).
function checkRead() {
  const b = el("c-body");
  const max = b.scrollHeight - b.clientHeight;
  const frac = max <= 0 ? 1 : Math.min(1, b.scrollTop / max);
  el("c-bar").style.width = (frac * 100).toFixed(1) + "%";
  if (max <= 0 || b.scrollTop >= max - 4) el("c-accept").disabled = false;
}
function wireConsent() {
  if (consentWired) return;
  consentWired = true;
  on(el("c-body"), "scroll", checkRead);

  // ссылки из документов — во внешнем браузере, окно приложения не уходит со страницы
  on(el("c-body"), "click", (e) => {
    const a = e.target.closest("a");
    if (!a) return;
    e.preventDefault();
    invoke("open_url", { url: a.href }).catch(() => {});
  });

  on(el("c-accept"), "click", async () => {
    if (el("c-accept").disabled) return;
    await savePrefs({ policyAccepted: POLICY_VERSION, policyAcceptedAt: Date.now() });
    el("consent").style.display = "none";
    if (consentDone) { consentDone(); consentDone = null; }
  });

  on(el("c-decline"), "click", async () => {
    if (T.platform === "ios") { say("без согласия с документами приложение не работает", true); return; }
    await invoke("quit_app").catch(() => {});
  });

  on(el("c-close"), "click", () => { el("consent").style.display = "none"; });
  on(el("docs"), "click", () => paintConsent(true));
}

// Вызывается из app.js сразу после загрузки настроек: пока документ не
// принят, дальше (подключение, импорт ссылки, автоподключение) не идём.
function policyGate() {
  if (prefs.policyAccepted === POLICY_VERSION) return Promise.resolve();
  return new Promise((resolve) => { consentDone = resolve; paintConsent(false); });
}
