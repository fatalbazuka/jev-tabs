// Умные группы вкладок — service worker.
// Jev выбирает категорию вкладки по заголовку и адресу; расширение кладёт вкладку в группу Chrome
// с названием и цветом категории. «Прочее» не группируется — такие вкладки попап предлагает закрыть.

// ---------- категории ----------
// Цвета — только те 9, что умеют группы Chrome.
const COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

const DEFAULT_CATEGORIES = [
  { id: "work",     title: "Работа",      color: "blue",
    desc: "Рабочие инструменты и сервисы: почта, мессенджеры для работы, таск-трекеры, Confluence, Jira, GitHub, облака, админки, документы, таблицы, корпоративные системы" },
  { id: "study",    title: "Учёба",       color: "purple",
    desc: "Изучение нового: курсы, лекции, туториалы, документация и статьи, которые читаешь чтобы разобраться в теме, Википедия, научные статьи" },
  { id: "shopping", title: "Покупки",     color: "yellow",
    desc: "Магазины и маркетплейсы, карточки товаров, корзина, сравнение цен, доставка, бронирование, билеты" },
  { id: "fun",      title: "Развлечения", color: "pink",
    desc: "Видео, сериалы, фильмы, музыка, игры, стримы, соцсети и ленты, мемы" },
  { id: "news",     title: "Новости",     color: "orange",
    desc: "Новостные сайты и ленты, свежие события, обзоры происходящего" }
];
const OTHER = {
  id: "other",
  desc: "Не подходит ни под одну категорию выше или непонятно, что это: пустые и служебные страницы, страницы входа, результаты поиска, разовые ссылки"
};

const DEFAULTS = {
  apiKey: "",
  provider: "typesafe",
  endpoint: "",
  model: "",
  auto: true,                       // раскладывать новые вкладки автоматически
  categories: DEFAULT_CATEGORIES
};

async function getSettings() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...s };
}

// ---------- провайдеры Jev ----------
const PROVIDERS = {
  typesafe:     { name: "TypeSafe",     endpoint: "https://api.typesafe.ai/v1/systemone",      model: "jev-latest" },
  openrouter:   { name: "OpenRouter",   endpoint: "https://openrouter.ai/api/alpha/decisions", model: "~typesafe/jev-latest" },
  nanogpt:      { name: "NanoGPT",      endpoint: "https://nano-gpt.com/api/v1/decisions",     model: "typesafe/jev-latest" },
  digitalocean: { name: "DigitalOcean", endpoint: "https://inference.do-ai.run/v1/systemone",  model: "typesafe-jev-1.13.0" },
  custom:       { name: "Свой адрес",   endpoint: "", model: "jev-latest" }
};
const PRICE_PER_TOKEN = 0.042 / 1e6;   // TypeSafe, вход; выход бесплатный

function resolve(s) {
  const p = PROVIDERS[s.provider] || PROVIDERS.typesafe;
  if (s.provider === "custom") return { endpoint: s.endpoint, model: s.model || p.model };
  return { endpoint: p.endpoint, model: p.model };
}

// ---------- счётчик расхода ----------
const today = () => new Date().toLocaleDateString("sv");
const emptyUsage = () => ({ tokens: 0, cost: 0, requests: 0, estimated: false });

// записи идут строго по очереди: параллельные запросы иначе перезатирают друг друга
let usageLock = Promise.resolve();
function addUsage(u) {
  usageLock = usageLock.then(() => writeUsage(u), () => writeUsage(u));
  return usageLock;
}
async function writeUsage(u) {
  const { usage = {} } = await chrome.storage.local.get("usage");
  const day = today();
  if (!usage.day || usage.day.date !== day) usage.day = { date: day, ...emptyUsage() };
  usage.total = usage.total || { since: day, ...emptyUsage() };
  for (const b of [usage.day, usage.total]) {
    b.tokens += u.tokens; b.cost += u.cost; b.requests += 1;
    if (u.estimated) b.estimated = true;
  }
  await chrome.storage.local.set({ usage });
}
function usageFrom(body) {
  const u = body.usage || {};
  const tokens = u.input_tokens ?? u.prompt_tokens ?? u.total_tokens ?? 0;
  if (typeof u.cost === "number") return { tokens, cost: u.cost, estimated: false };
  return { tokens, cost: tokens * PRICE_PER_TOKEN, estimated: true };
}

// ---------- вопрос к Jev ----------
function buildQuestions(categories) {
  const criteria = {};
  for (const c of categories) criteria[c.id] = `${c.title}: ${c.desc}`;
  criteria[OTHER.id] = OTHER.desc;
  return {
    group: {
      type: "choice",
      instructions:
        "Это одна открытая вкладка браузера: заголовок страницы, домен и путь. " +
        "Выбери категорию, к которой она относится по смыслу для пользователя. " +
        "Если вкладка подходит под несколько — выбери главную. Если не уверен — other.",
      criteria
    }
  };
}

async function postJev(state, questions, s) {
  const { endpoint, model } = resolve(s);
  if (!endpoint) throw new Error("Не задан адрес для «Свой адрес»");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Authorization": "Bearer " + s.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ model, state, questions })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (body.error && body.error.message) || body.detail || body.error || res.statusText;
      const err = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
      err.status = res.status;
      throw err;
    }
    await addUsage(usageFrom(body));
    return body.answers || {};
  } finally {
    clearTimeout(timer);
  }
}

// ---------- кэш решений ----------
// Ключ зависит от набора категорий: поменял описания — старые решения не используются.
function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
const catsSignature = cats => hash(cats.map(c => c.id + ":" + c.desc).join("|"));

function describeTab(tab) {
  let domain = "", path = "";
  try { const u = new URL(tab.url); domain = u.hostname; path = (u.pathname + u.search).slice(0, 120); } catch {}
  return { title: (tab.title || "").slice(0, 200), domain, path };
}

const CACHE_LIMIT = 3000;
async function classify(tab, s) {
  const state = describeTab(tab);
  const key = "t:" + catsSignature(s.categories) + ":" + hash(state.domain + "|" + state.title);
  const got = await chrome.storage.local.get(key);
  if (got[key]) return got[key].cat;

  const a = await postJev(state, buildQuestions(s.categories), s);
  const g = a.group;
  if (!g || !g.choice) throw new Error("Неожиданный ответ Jev");
  // неуверенный выбор — считаем «прочим», чтобы не засорять группы
  const cat = (typeof g.confidence === "number" && g.confidence < 0.45) ? OTHER.id : g.choice;
  await chrome.storage.local.set({ [key]: { cat, t: Date.now() } });
  trimCacheSoon();
  return cat;
}
let trimTimer = null;
function trimCacheSoon() {
  if (trimTimer) return;
  trimTimer = setTimeout(async () => {
    trimTimer = null;
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter(k => k.startsWith("t:"));
    if (keys.length <= CACHE_LIMIT) return;
    keys.sort((a, b) => (all[a].t || 0) - (all[b].t || 0));
    await chrome.storage.local.remove(keys.slice(0, keys.length - CACHE_LIMIT));
  }, 5000);
}

// ---------- группы Chrome ----------
// Все изменения групп идут по очереди, чтобы параллельные вкладки не создали две «Работы».
let lock = Promise.resolve();
const serial = fn => (lock = lock.then(fn, fn));

async function findGroup(windowId, title) {
  const gs = await chrome.tabGroups.query({ windowId });
  return gs.find(g => g.title === title) || null;
}

async function putIntoGroup(tabIds, windowId, cat) {
  if (!tabIds.length) return;
  const g = await findGroup(windowId, cat.title);
  if (g) {
    await chrome.tabs.group({ tabIds, groupId: g.id });
    if (g.color !== cat.color) await chrome.tabGroups.update(g.id, { color: cat.color });
  } else {
    const gid = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
    await chrome.tabGroups.update(gid, { title: cat.title, color: cat.color, collapsed: false });
  }
}

const groupable = t => !t.pinned && /^https?:/.test(t.url || "") && t.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE;

// ---------- «прочее»: кандидаты на закрытие ----------
async function getLeftovers() {
  const { leftovers = [] } = await chrome.storage.session.get("leftovers");
  return leftovers;
}
async function setLeftovers(list) {
  await chrome.storage.session.set({ leftovers: list });
  const n = list.length;
  chrome.action.setBadgeBackgroundColor({ color: "#5b6069" });
  chrome.action.setBadgeText({ text: n ? String(n) : "" });
}
async function addLeftovers(tabs) {
  const list = await getLeftovers();
  const ids = new Set(list.map(x => x.id));
  for (const t of tabs) {
    if (ids.has(t.id)) continue;
    list.push({ id: t.id, windowId: t.windowId, title: t.title || t.url, url: t.url, favIconUrl: t.favIconUrl || "" });
  }
  await setLeftovers(list);
}
async function dropLeftovers(ids) {
  const set = new Set(ids);
  await setLeftovers((await getLeftovers()).filter(x => !set.has(x.id)));
}

// ---------- разложить все вкладки окна ----------
let sorting = false;
async function sortWindow(windowId) {
  if (sorting) return { error: "Уже раскладываю" };
  const s = await getSettings();
  if (!s.apiKey) return { error: "no_key" };
  sorting = true;
  try {
    const tabs = (await chrome.tabs.query({ windowId })).filter(groupable);
    const byCat = {};
    const leftovers = [];
    let failed = 0, lastError = null;

    // по 4 запроса одновременно
    for (let i = 0; i < tabs.length; i += 4) {
      const chunk = tabs.slice(i, i + 4);
      const res = await Promise.all(chunk.map(t => classify(t, s).catch(e => ({ e }))));
      res.forEach((r, j) => {
        if (r && r.e) { failed++; lastError = r.e; return; }
        if (r === OTHER.id || !s.categories.some(c => c.id === r)) leftovers.push(chunk[j]);
        else (byCat[r] = byCat[r] || []).push(chunk[j].id);
      });
      if (lastError && (lastError.status === 401 || lastError.status === 403)) break;
    }

    await serial(async () => {
      for (const c of s.categories) {
        const ids = byCat[c.id] || [];
        // вкладка могла закрыться, пока ждали Jev
        const alive = (await Promise.all(ids.map(id => chrome.tabs.get(id).catch(() => null)))).filter(Boolean).map(t => t.id);
        await putIntoGroup(alive, windowId, c);
      }
    });
    await addLeftovers(leftovers);

    const grouped = Object.values(byCat).reduce((n, a) => n + a.length, 0);
    const out = { grouped, leftovers: leftovers.length, failed, total: tabs.length };
    if (lastError) out.error = lastError.status === 401 || lastError.status === 403 ? "bad_key" : String(lastError.message || lastError);
    return out;
  } finally {
    sorting = false;
  }
}

// ---------- авто: новые вкладки ----------
// Запоминаем вкладку при создании и раскладываем, когда она догрузилась и у неё появился заголовок.
chrome.tabs.onCreated.addListener(async tab => {
  const { pending = [] } = await chrome.storage.session.get("pending");
  pending.push(tab.id);
  await chrome.storage.session.set({ pending: pending.slice(-200) });
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== "complete") return;
  const { pending = [] } = await chrome.storage.session.get("pending");
  if (!pending.includes(tabId)) return;
  await chrome.storage.session.set({ pending: pending.filter(id => id !== tabId) });

  const s = await getSettings();
  if (!s.auto || !s.apiKey || !groupable(tab)) return;
  try {
    const cat = await classify(tab, s);
    const c = s.categories.find(x => x.id === cat);
    if (!c) return addLeftovers([tab]);
    await serial(async () => {
      const fresh = await chrome.tabs.get(tabId).catch(() => null);
      if (fresh && groupable(fresh)) await putIntoGroup([tabId], fresh.windowId, c);
    });
  } catch { /* тихо: авто не должно мешать */ }
});

chrome.tabs.onRemoved.addListener(id => dropLeftovers([id]));

// ---------- изменение категорий: обновить уже открытые группы ----------
async function syncGroups(oldCats, newCats) {
  const newById = Object.fromEntries(newCats.map(c => [c.id, c]));
  const gs = await chrome.tabGroups.query({});
  for (const g of gs) {
    const old = oldCats.find(c => c.title === g.title);
    if (!old) continue;
    const now = newById[old.id];
    if (!now) continue; // категорию удалили — группу не трогаем, это уже просто группа пользователя
    if (now.title !== g.title || now.color !== g.color) {
      await chrome.tabGroups.update(g.id, { title: now.title, color: now.color });
    }
  }
}

async function ungroupOurs(windowId) {
  const s = await getSettings();
  const titles = new Set(s.categories.map(c => c.title));
  const gs = await chrome.tabGroups.query({ windowId });
  for (const g of gs) {
    if (!titles.has(g.title)) continue;
    const tabs = await chrome.tabs.query({ groupId: g.id });
    if (tabs.length) await chrome.tabs.ungroup(tabs.map(t => t.id));
  }
  return { ok: true };
}

async function summary(windowId) {
  const s = await getSettings();
  const gs = await chrome.tabGroups.query({ windowId });
  const out = [];
  for (const c of s.categories) {
    const g = gs.find(x => x.title === c.title);
    const n = g ? (await chrome.tabs.query({ groupId: g.id })).length : 0;
    out.push({ id: c.id, title: c.title, color: c.color, count: n, groupId: g ? g.id : null, collapsed: g ? g.collapsed : false });
  }
  const loose = (await chrome.tabs.query({ windowId })).filter(groupable).length;
  return { cats: out, loose };
}

// ---------- сообщения ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "settings":   return getSettings();
      case "defaults":   return { categories: DEFAULT_CATEGORIES, colors: COLORS };
      case "providers":  return PROVIDERS;
      case "sort":       return sortWindow(msg.windowId);
      case "ungroup":    return ungroupOurs(msg.windowId);
      case "summary":    return summary(msg.windowId);
      case "toggleGroup": {
        const g = await chrome.tabGroups.get(msg.groupId).catch(() => null);
        if (g) await chrome.tabGroups.update(g.id, { collapsed: !g.collapsed });
        return { ok: true };
      }
      case "leftovers": {
        // отдаём только живые вкладки нужного окна
        const list = await getLeftovers();
        const alive = [];
        for (const x of list) {
          const t = await chrome.tabs.get(x.id).catch(() => null);
          if (t && t.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) alive.push({ ...x, title: t.title || x.title, windowId: t.windowId });
        }
        if (alive.length !== list.length) await setLeftovers(alive);
        return alive.filter(x => msg.windowId == null || x.windowId === msg.windowId);
      }
      case "closeTabs":
        await chrome.tabs.remove(msg.ids).catch(() => {});
        await dropLeftovers(msg.ids);
        return { ok: true };
      case "keepTabs":
        await dropLeftovers(msg.ids);
        return { ok: true };
      case "saveCategories": {
        const old = (await getSettings()).categories;
        await chrome.storage.sync.set({ categories: msg.categories });
        await syncGroups(old, msg.categories);
        return { ok: true };
      }
      case "testKey": {
        const s = await getSettings();
        try {
          await postJev(
            { title: "Проверка ключа", domain: "example.com", path: "/" },
            buildQuestions(s.categories),
            { ...s, apiKey: msg.apiKey, provider: msg.provider, endpoint: msg.endpoint || "", model: msg.model || "" }
          );
          return { ok: true };
        } catch (e) {
          return { error: e.status === 401 || e.status === 403 ? "bad_key" : String(e.message || e) };
        }
      }
      case "getUsage": {
        const { usage = {} } = await chrome.storage.local.get("usage");
        if (!usage.day || usage.day.date !== today()) usage.day = { date: today(), ...emptyUsage() };
        return usage;
      }
      case "resetUsage":
        await chrome.storage.local.remove("usage");
        return { ok: true };
      case "getBalance": {
        const s = await getSettings();
        if (s.provider !== "openrouter" || !s.apiKey) return null;
        try {
          const r = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: "Bearer " + s.apiKey } });
          if (!r.ok) return null;
          const d = (await r.json()).data || {};
          return { remaining: d.limit_remaining };
        } catch { return null; }
      }
      case "clearCache": {
        const all = await chrome.storage.local.get(null);
        await chrome.storage.local.remove(Object.keys(all).filter(k => k.startsWith("t:")));
        return { ok: true };
      }
      default: return null;
    }
  })().then(sendResponse, e => sendResponse({ error: String(e) }));
  return true;
});
