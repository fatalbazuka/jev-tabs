// Снимает скриншоты настоящего Chromium с загруженным расширением для README.
// Запросы к Jev не делаются: решения заранее кладутся в кэш расширения,
// страницы сайтов подменяются заглушками через Playwright.
//
// Нужны: Node, Playwright, Xvfb и ImageMagick (`import`).
//   Xvfb :99 -screen 0 3200x1640x24 &
//   DISPLAY=:99 node docs/screenshots.js "$PWD/extension" /путь/для/снимков
//   convert снимок.png -crop 3200x88+0+0 +repage docs/images/tabs-after.png   # полоска вкладок
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const fs = require('fs'), path = require('path');
const EXT = process.argv[2], OUT = process.argv[3];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = name => execSync(`import -window root -crop 3200x1640+0+0 ${path.join(OUT, name)}`);

// вкладки: url, заголовок, буква и цвет фавиконки, категория
const TABS = [
  ['https://github.com/acme/billing/pulls', 'Pull requests · acme/billing', 'G', '#24292f', 'work'],
  ['https://jira.acme.dev/browse/BILL-412', '[BILL-412] Ошибка округления в счёте — Jira', 'J', '#2684ff', 'work'],
  ['https://mail.google.com/mail/u/0/#inbox', 'Входящие (12) — почта', 'M', '#ea4335', 'news-skip'],
  ['https://ru.wikipedia.org/wiki/Теория_графов', 'Теория графов — Википедия', 'W', '#636466', 'study'],
  ['https://www.youtube.com/watch?v=lofi', 'lofi hip hop radio — beats to relax/study to', '▶', '#ff0000', 'fun'],
  ['https://www.ozon.ru/product/naushniki-123', 'Беспроводные наушники — купить на OZON', 'O', '#005bff', 'shopping'],
  ['https://lenta.ru/news/2026/11/06/', 'Главные новости дня — Лента.ру', 'Л', '#292929', 'news'],
  ['https://accounts.example.com/login', 'Вход в аккаунт', '?', '#9aa0a6', 'other'],
  ['https://www.kinopoisk.ru/series/123/', 'Сериал «Тьма» — Кинопоиск', 'К', '#ff6600', 'fun'],
  ['https://confluence.acme.dev/display/BILL/Release', 'Релиз 2.4 — Confluence', 'C', '#1868db', 'work'],
  ['https://www.wildberries.ru/catalog/555/detail.aspx', 'Рюкзак городской — Wildberries', 'W', '#cb11ab', 'shopping'],
  ['https://www.google.com/search?q=как+сварить+глинтвейн', 'как сварить глинтвейн — Поиск', 'G', '#4285f4', 'other'],
  ['https://habr.com/ru/news/870000/', 'Вышел Chrome 140: что нового — Хабр', 'Х', '#65a3be', 'news'],
  ['https://stepik.org/lesson/1234/step/1', 'Урок 3. Рекурсия — Stepik', 'S', '#66cc66', 'study'],
];
TABS[2][4] = 'work';

const page = (title, letter, color) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${title}</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='${color}'/><text x='16' y='23' font-size='19' font-family='Arial' font-weight='700' fill='white' text-anchor='middle'>${letter}</text></svg>`)}">
<style>body{margin:0;font:15px/1.5 system-ui,sans-serif;background:#f6f7f9;color:#1b1f24}
header{height:56px;background:${color};display:flex;align-items:center;padding:0 28px;color:#fff;font-weight:700}
main{max-width:860px;margin:32px auto;padding:0 24px}.b{background:#fff;border-radius:12px;height:120px;margin:16px 0;box-shadow:0 1px 2px rgba(0,0,0,.06)}
.l{height:14px;background:#e4e6ea;border-radius:7px;margin:10px 0}</style></head>
<body><header>${title}</header><main><h1 style="font-size:26px">${title}</h1><div class="l" style="width:80%"></div><div class="l" style="width:65%"></div><div class="l" style="width:72%"></div><div class="b"></div><div class="b"></div></main></body></html>`;

(async () => {
  const ud = fs.mkdtempSync(path.join(OUT, 'ud-'));
  const ctx = await chromium.launchPersistentContext(ud, {
    headless: false, viewport: null, locale: 'ru-RU',
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--window-position=0,0', '--window-size=1600,820', '--force-device-scale-factor=2', '--disable-features=Translate,TranslateUI', '--lang=ru', '--hide-crash-restore-bubble', '--no-first-run', '--disable-infobars', '--test-type'],
  });
  await ctx.route(/^https:\/\/(?!api\.typesafe)/, route => {
    const t = TABS.find(x => decodeURI(route.request().url()) === decodeURI(x[0].split('#')[0]));
    if (!t) return route.fulfill({ status: 404, body: '' });
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: page(t[1], t[2], t[3]) });
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');

  // настройки и кэш решений вместо реальных запросов к Jev
  await sw.evaluate(async tabs => {
    await chrome.storage.sync.set({ apiKey: 'ts-demo-key-9f3a', provider: 'typesafe', auto: false });
    const s = await getSettings();
    const sig = catsSignature(s.categories);
    const items = {};
    for (const [url, title, , , cat] of tabs) {
      const st = describeTab({ url, title });
      items['t:' + sig + ':' + hash(st.domain + '|' + st.title)] = { cat, t: Date.now() };
    }
    await chrome.storage.local.set(items);
    await chrome.storage.local.set({ usage: {
      day: { date: new Date().toLocaleDateString('sv'), tokens: 4120, cost: 0.00017, requests: 15, estimated: true },
      total: { since: '2026-10-01', tokens: 98000, cost: 0.0041, requests: 342, estimated: true } } });
  }, TABS);

  const pages = ctx.pages();
  for (let i = 0; i < TABS.length; i++) {
    const p = i === 0 && pages[0] ? pages[0] : await ctx.newPage();
    await p.goto(TABS[i][0]);
  }
  const first = ctx.pages()[0];
  await first.bringToFront();
  await sleep(1500);
  shot('browser-before.png');

  const r = await sw.evaluate(async () => {
    const [w] = await chrome.windows.getAll();
    return sortWindow(w.id);
  });
  console.log('sort:', JSON.stringify(r));
  await sleep(800);
  // свернём «Покупки» для наглядности
  await sw.evaluate(async () => {
    const gs = await chrome.tabGroups.query({});
    const g = gs.find(x => x.title === 'Покупки'); if (g) await chrome.tabGroups.update(g.id, { collapsed: true });
  });
  await sleep(1000);
  shot('browser-after.png');

  await sw.evaluate(() => chrome.storage.sync.set({ auto: true }));
  try {
    await sw.evaluate(() => chrome.action.openPopup());
    await sleep(2000);
    shot('browser-popup.png');
  } catch (e) { console.log('popup failed:', e.message); }
  await ctx.close();
})();
