// Места для устройств заняты — частый случай при переходе с Happ/INCY на
// VPNUSHKA: старое приложение на этом же телефоне держит место, и панель
// отдаёт новому устройству заглушку. Раньше человек видел «нет мобильного
// канала» или hwid и шёл в кабинет/поддержку. Теперь клиент сам показывает
// устройства подписки и меняет старое на это одним нажатием (sub_devices →
// sub.vpnushka.lol/guest/devices, по ссылке подписки — вход в кабинет не нужен).
// Тот же телефон/ПК узнаётся по модели («iPhone 14», «SM-S948B», «host_x86_64») —
// её с 1.2.1 шлют все клиенты, как Happ.

// фраза движка (stubReason в connect/main.go)
const DEVICE_LIMIT = /места для устройств/i;
let devAutoShown = false;   // сам открываем один раз за запуск; по «Подключить» — всегда
let devRetryConnect = false;

const APP_ON = { iPhone: "этом iPhone", Android: "этом телефоне", Windows: "этом компьютере",
                 Linux: "этом компьютере", Mac: "этом Mac" };

function devWhen(iso) {
  const t = Date.parse(iso || "");
  if (!t) return "";
  const d = Math.floor((Date.now() - t) / 86400000);
  if (d <= 0) return "в сети сегодня";
  if (d === 1) return "в сети вчера";
  if (d < 30) return "в сети " + d + " дн. назад";
  return "давно не в сети";
}

const devLabel = (x) => [x.name, x.app].filter(Boolean).join(" · ");

// true — это была нехватка мест, и человеку уже показан экран замены
function handleDeviceLimit(msg, fromConnect) {
  if (!DEVICE_LIMIT.test(String(msg || ""))) return false;
  if (fromConnect || !devAutoShown) {
    devAutoShown = true;
    devRetryConnect = !!fromConnect;
    openDevicesFull();
  }
  return true;
}

async function openDevicesFull() {
  const box = el("devfull-list"), lead = el("devfull-lead"), match = el("devfull-match");
  box.textContent = "";
  match.style.display = "none";
  lead.textContent = "Загружаю список устройств…";
  sheet("sheet-devices", true);
  let d;
  try {
    d = await invoke("sub_devices", { action: "list" });
  } catch (e) {
    lead.textContent = "Все места для устройств в подписке заняты, а список сейчас не загрузился: "
      + errText(e) + ". Освободить место можно в кабинете или через поддержку @vpnushka_manager.";
    return;
  }
  paintDevicesFull(d);
}

function paintDevicesFull(d) {
  const box = el("devfull-list"), lead = el("devfull-lead"), match = el("devfull-match");
  box.textContent = "";
  const list = (d.devices || []).filter((x) => !x.me);
  if (d.registered || !d.full) {
    lead.textContent = "Место для этого устройства уже есть — можно подключаться.";
    match.style.display = "none";
    return;
  }
  lead.textContent = "В подписке заняты все " + (d.limit || list.length) + " мест для устройств. "
    + "Чтобы VPNUSHKA заработала здесь, замените одно из них — отвязанное устройство перестанет "
    + "подключаться, его всегда можно вернуть так же.";
  const same = list.find((x) => x.same === "model") || list.find((x) => x.same === "legacy");
  if (same) {
    const where = APP_ON[same.platform] || "этом устройстве";
    el("devfull-match-tx").textContent = same.same === "model"
      ? "Похоже, на " + where + " раньше был " + (same.app || "другой VPN") + " (" + same.name + ")."
      : "Похоже, это прошлая установка VPNUSHKA на " + where + ".";
    const go = el("devfull-match-go");
    go.textContent = "Заменить его на это устройство";
    go.onclick = () => replaceDevice(same, go, true);
    match.style.display = "";
  } else {
    match.style.display = "none";
  }
  for (const x of list) {
    if (x === same) continue;
    const row = document.createElement("div");
    row.className = "devrow";
    const tx = document.createElement("span");
    tx.className = "tx";
    const b = document.createElement("b");
    b.textContent = devLabel(x) || "Устройство";
    const sub = document.createElement("span");
    sub.textContent = devWhen(x.lastSeen);
    tx.append(b, sub);
    const btn = document.createElement("button");
    btn.className = "btn sm";
    btn.textContent = "Заменить";
    btn.onclick = () => replaceDevice(x, btn, false);
    row.append(tx, btn);
    box.append(row);
  }
}

async function replaceDevice(x, btn, sure) {
  // подтверждение вторым нажатием (confirm() в Android WebView не работает)
  if (!sure && btn.dataset.armed !== "1") {
    btn.dataset.armed = "1";
    btn.textContent = "Точно?";
    setTimeout(() => { btn.dataset.armed = ""; btn.textContent = "Заменить"; }, 3500);
    return;
  }
  btn.disabled = true;
  try {
    const d = await invoke("sub_devices", { action: "replace", remove: x.id });
    sheet("sheet-devices", false);
    say("готово: " + (devLabel(x) || "старое устройство") + " отвязано, место за этим устройством");
    if (d && d.full && !d.registered) { paintDevicesFull(d); sheet("sheet-devices", true); return; }
    if (devRetryConnect && state === "off") {
      devRetryConnect = false;
      await toggleConnection();
    } else {
      await loadServers();
    }
  } catch (e) {
    say(errText(e), true);
  } finally {
    btn.disabled = false;
  }
}
