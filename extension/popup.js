const $ = id => document.getElementById(id);
const send = msg => chrome.runtime.sendMessage(msg);

const KEY_HINTS = {
  typesafe:     ["console.typesafe.ai → Keys", "https://console.typesafe.ai/keys"],
  openrouter:   ["openrouter.ai → Settings → Keys", "https://openrouter.ai/settings/keys"],
  nanogpt:      ["nano-gpt.com → API", "https://nano-gpt.com/api"],
  digitalocean: ["DigitalOcean → Serverless Inference → Model access keys", "https://cloud.digitalocean.com/"],
  custom:       null
};
function detectProvider(key) {
  if (/^sk-or-/i.test(key)) return "openrouter";
  if (/^ts[-_]/i.test(key)) return "typesafe";
  if (/^sk-do-|^dop_v1_/i.test(key)) return "digitalocean";
  return null;
}

let windowId = null;

(async () => {
  const win = await chrome.windows.getCurrent();
  windowId = win.id;

  const s = await send({ type: "settings" });
  const providers = await send({ type: "providers" });

  $("auto").checked = !!s.auto;
  $("auto").onchange = () => chrome.storage.sync.set({ auto: $("auto").checked });
  $("options").onclick = () => chrome.runtime.openOptionsPage();

  setupKey(s, providers);

  $("sort").onclick = sortNow;
  $("ungroup").onclick = async () => {
    await send({ type: "ungroup", windowId });
    $("status").textContent = "Группы категорий сняты";
    renderCats();
  };

  $("closeSel").onclick = async () => {
    const ids = checkedLeftovers();
    if (!ids.length) return;
    await send({ type: "closeTabs", ids });
    $("status").textContent = `Закрыто вкладок: ${ids.length}`;
    renderLeftovers(); renderCats();
  };
  $("keep").onclick = async () => {
    const ids = [...document.querySelectorAll("#leftList input")].map(i => Number(i.value));
    await send({ type: "keepTabs", ids });
    renderLeftovers();
  };

  renderCats();
  renderLeftovers();
  renderUsage();
  $("resetUsage").onclick = async () => { await send({ type: "resetUsage" }); renderUsage(); };
  chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch.usage) renderUsage(); });
})();

// ---------- разложить ----------
async function sortNow() {
  const btn = $("sort");
  btn.disabled = true;
  btn.textContent = "Раскладываю…";
  $("status").textContent = "Jev смотрит на заголовки и адреса вкладок";
  const r = await send({ type: "sort", windowId });
  btn.disabled = false;
  btn.textContent = "Разложить вкладки";

  if (r && r.error === "no_key") { $("status").textContent = ""; return warn("Сначала вставь ключ Jev."); }
  if (r && r.error === "bad_key") { $("status").textContent = ""; return warn("Ключ не подошёл (401/403). Нажми «Изменить» и вставь новый."); }
  if (!r || r.total === undefined) { $("status").textContent = "Ошибка: " + ((r && r.error) || "нет ответа"); return; }

  if (!r.total) $("status").textContent = "Свободных вкладок нет — все уже в группах или закреплены";
  else {
    const parts = [`Разложено: ${r.grouped} из ${r.total}`];
    if (r.leftovers) parts.push(`не подошли: ${r.leftovers}`);
    if (r.failed) parts.push(`ошибок: ${r.failed}`);
    $("status").textContent = parts.join(" · ");
    if (r.error) warn("Ошибка Jev: " + r.error);
  }
  renderCats();
  renderLeftovers();
}

// ---------- группы ----------
async function renderCats() {
  const sm = await send({ type: "summary", windowId });
  const box = $("cats");
  box.textContent = "";
  for (const c of sm.cats) {
    const b = document.createElement("button");
    b.className = "cat";
    b.disabled = !c.groupId;
    b.title = c.groupId ? "Свернуть / развернуть группу" : "Группы пока нет";
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = (GROUP_COLORS[c.color] || GROUP_COLORS.grey).hex;
    const t = document.createElement("span");
    t.textContent = c.title;
    const st = document.createElement("span");
    st.className = "state";
    st.textContent = c.groupId ? (c.collapsed ? "свёрнута" : "") : "";
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = c.count || "—";
    b.append(sw, t, n, st);
    if (c.groupId) b.onclick = async () => { await send({ type: "toggleGroup", groupId: c.groupId }); renderCats(); };
    box.appendChild(b);
  }
  if (sm.loose) {
    const p = document.createElement("div");
    p.className = "empty";
    p.style.margin = "6px 10px 0";
    p.textContent = `Вне групп: ${sm.loose}`;
    box.appendChild(p);
  }
}

// ---------- лишние вкладки ----------
async function renderLeftovers() {
  const list = await send({ type: "leftovers", windowId });
  $("leftBlock").hidden = !list.length;
  $("leftCount").textContent = list.length ? String(list.length) : "";
  const box = $("leftList");
  box.textContent = "";
  for (const x of list) {
    const row = document.createElement("label");
    row.className = "left-item";
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = true; cb.value = String(x.id);
    let fav;
    if (x.favIconUrl && /^https:/.test(x.favIconUrl)) {
      fav = document.createElement("img"); fav.src = x.favIconUrl; fav.alt = "";
    } else { fav = document.createElement("span"); fav.className = "fav"; }
    const text = document.createElement("span");
    text.className = "left-text";
    const title = document.createElement("span");
    title.className = "left-title"; title.textContent = x.title;
    const dom = document.createElement("span");
    dom.className = "left-domain";
    try { dom.textContent = new URL(x.url).hostname; } catch { dom.textContent = ""; }
    text.append(title, dom);
    row.append(cb, fav, text);
    box.appendChild(row);
  }
}
const checkedLeftovers = () => [...document.querySelectorAll("#leftList input:checked")].map(i => Number(i.value));

// ---------- счётчик ----------
const fmtTokens = n => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);
function fmtCost(c, est) {
  const sign = est ? "≈$" : "$";
  if (c === 0) return sign + "0";
  if (c < 0.0001) return sign + "<0.0001";
  return sign + (c < 0.01 ? c.toFixed(4) : c.toFixed(2));
}
async function renderUsage() {
  const u = await send({ type: "getUsage" });
  const d = (u && u.day) || { tokens: 0, cost: 0, requests: 0 };
  $("usageDay").textContent = d.requests
    ? `Сегодня: ${d.requests} запр. · ${fmtTokens(d.tokens)} ток. · ${fmtCost(d.cost, d.estimated)}`
    : "Сегодня: 0 запросов";
  $("usageDay").title = d.estimated ? "≈ — по цене TypeSafe $0.042 за 1M входных токенов" : "Стоимость вернул провайдер";
  const t = u && u.total;
  $("usageTotal").textContent = t && t.requests ? `Всего: ${fmtCost(t.cost, t.estimated)}` : "";
  const bal = await send({ type: "getBalance" });
  $("usageBalance").textContent = bal && typeof bal.remaining === "number" ? `Остаток OR: $${bal.remaining.toFixed(2)}` : "";
}

// ---------- ключ ----------
const mask = k => (k.length > 8 ? "••••" + k.slice(-4) : "••••");

function setupKey(s, providers) {
  const card = $("keyCard"), line = $("keyLine"), input = $("keyInput"), status = $("keyStatus");
  let saved = { apiKey: s.apiKey, provider: s.provider || "typesafe", endpoint: s.endpoint, model: s.model };
  let chosen = saved.provider;

  const chips = $("chips");
  for (const [id, p] of Object.entries(providers)) {
    const c = document.createElement("button");
    c.className = "chip"; c.type = "button"; c.setAttribute("role", "radio");
    c.dataset.id = id; c.textContent = p.name;
    c.onclick = () => choose(id);
    chips.appendChild(c);
  }
  function choose(id) {
    chosen = id;
    chips.querySelectorAll(".chip").forEach(c => c.setAttribute("aria-checked", String(c.dataset.id === id)));
    const hint = KEY_HINTS[id];
    $("keyHint").textContent = "";
    if (hint) {
      $("keyHint").append("Ключ: ");
      const a = document.createElement("a");
      a.href = hint[1]; a.target = "_blank"; a.rel = "noopener"; a.textContent = hint[0];
      $("keyHint").append(a);
    } else $("keyHint").textContent = "Любой сервис или прокси с API Jev (LiteLLM, Kong и т. п.)";
    $("customFields").hidden = id !== "custom";
    if (id === "custom") { $("customEndpoint").value = saved.endpoint || ""; $("customModel").value = saved.model || ""; }
  }
  const showCard = editing => {
    card.hidden = false; line.hidden = true;
    $("cancelKey").hidden = !editing;
    input.value = ""; setStatus("", ""); choose(chosen);
    setTimeout(() => input.focus(), 50);
  };
  const showLine = () => {
    card.hidden = true; line.hidden = false;
    $("keyProvider").textContent = (providers[saved.provider] || providers.typesafe).name;
    $("keyMask").textContent = mask(saved.apiKey);
  };
  saved.apiKey ? showLine() : showCard(false);

  $("editKey").onclick = () => { chosen = saved.provider; showCard(true); };
  $("cancelKey").onclick = showLine;
  $("eye").onclick = () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    $("eye").setAttribute("aria-label", show ? "Скрыть ключ" : "Показать ключ");
  };
  const autodetect = () => {
    const p = detectProvider(input.value.trim());
    if (p && p !== chosen) { choose(p); setStatus("Похоже на ключ " + providers[p].name, ""); }
  };
  $("paste").onclick = async () => {
    try {
      const t = (await navigator.clipboard.readText()).trim();
      if (!t) return setStatus("Буфер пуст", "err");
      input.value = t; autodetect();
      if (!detectProvider(t)) setStatus("Вставлено — выбери провайдера и нажми «Проверить и сохранить»", "");
    } catch { setStatus("Нет доступа к буферу — вставь вручную (Ctrl+V)", "err"); input.focus(); }
  };
  input.addEventListener("paste", () => setTimeout(() => { input.value = input.value.trim(); autodetect(); }, 0));
  input.addEventListener("keydown", e => { if (e.key === "Enter") $("saveKey").click(); });

  $("saveKey").onclick = async () => {
    const key = input.value.replace(/\s+/g, "");
    if (!key) return setStatus("Сначала вставь ключ", "err");
    const next = { apiKey: key, provider: chosen, endpoint: "", model: "" };
    if (chosen === "custom") {
      next.endpoint = $("customEndpoint").value.trim();
      next.model = $("customModel").value.trim();
      if (!/^https:\/\//.test(next.endpoint)) return setStatus("Укажи адрес API, начиная с https://", "err");
      // свой адрес — просим доступ к этому хосту (нужен жест пользователя, он есть: клик)
      const origin = new URL(next.endpoint).origin + "/*";
      const granted = await chrome.permissions.request({ origins: [origin] }).catch(() => false);
      if (!granted) return setStatus("Без доступа к " + new URL(next.endpoint).host + " запросы не уйдут", "err");
    }
    const btn = $("saveKey");
    btn.disabled = true; btn.textContent = "Проверяю…";
    setStatus("Отправляю тестовый запрос в " + providers[chosen].name, "");
    const r = await send({ type: "testKey", ...next });
    btn.disabled = false; btn.textContent = "Проверить и сохранить";
    if (r && r.error === "bad_key") return setStatus(providers[chosen].name + " не принял ключ. Проверь провайдера и что ключ скопирован целиком.", "err");
    await chrome.storage.sync.set(next);
    saved = next;
    $("warn").style.display = "none";
    renderUsage();
    if (r && r.ok) showLine();
    else { setStatus("Не удалось проверить (" + ((r && r.error) || "нет ответа") + "). Ключ сохранён как есть.", "err"); setTimeout(showLine, 2200); }
  };
  function setStatus(t, cls) { status.textContent = t; status.className = "key-status" + (cls ? " " + cls : ""); }
}

function warn(t) { $("warn").textContent = t; $("warn").style.display = "block"; }
