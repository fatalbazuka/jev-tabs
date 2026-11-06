const $ = id => document.getElementById(id);
const send = msg => chrome.runtime.sendMessage(msg);
const MAX_CATS = 10;

let cats = [];
let defaults = [];
let dirty = false;

(async () => {
  const s = await send({ type: "settings" });
  const d = await send({ type: "defaults" });
  defaults = d.categories;
  cats = structuredClone(s.categories);
  render();

  $("add").onclick = () => {
    if (cats.length >= MAX_CATS) return flash(`Не больше ${MAX_CATS} категорий — Jev лучше выбирает из короткого списка`, "err");
    const used = new Set(cats.map(c => c.color));
    const color = Object.keys(GROUP_COLORS).find(c => !used.has(c)) || "grey";
    cats.push({ id: "c" + Date.now().toString(36), title: "", color, desc: "" });
    markDirty(); render();
    const inputs = document.querySelectorAll(".title-input");
    inputs[inputs.length - 1].focus();
  };
  $("reset").onclick = () => { cats = structuredClone(defaults); markDirty(); render(); };
  $("save").onclick = save;
  $("clear").onclick = async () => { await send({ type: "clearCache" }); flash("Память сброшена", "ok"); };

  window.addEventListener("beforeunload", e => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });
})();

function markDirty() { dirty = true; flash("Есть несохранённые изменения", ""); }

function render() {
  const box = $("cats");
  box.textContent = "";
  cats.forEach((c, i) => box.appendChild(card(c, i)));
  $("add").disabled = cats.length >= MAX_CATS;
}

function card(c, i) {
  const el = document.createElement("div");
  el.className = "cat";
  el.style.borderLeftColor = GROUP_COLORS[c.color].hex;

  // название + порядок + удалить
  const row = document.createElement("div");
  row.className = "row";
  const title = document.createElement("input");
  title.className = "title-input";
  title.value = c.title;
  title.placeholder = "Название группы";
  title.maxLength = 24;
  title.setAttribute("aria-label", "Название категории");
  title.oninput = () => { c.title = title.value; markDirty(); };

  const up = iconBtn("Выше", '<path d="M12 19V5"/><path d="M5 12l7-7 7 7"/>', i === 0, () => { swap(i, i - 1); });
  const down = iconBtn("Ниже", '<path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/>', i === cats.length - 1, () => { swap(i, i + 1); });
  const del = iconBtn("Удалить категорию", '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/>', cats.length <= 1, () => {
    cats.splice(i, 1); markDirty(); render();
  });
  row.append(title, up, down, del);

  // цвет
  const colors = document.createElement("fieldset");
  colors.className = "colors";
  const lg = document.createElement("legend");
  lg.textContent = "Цвет группы";
  colors.appendChild(lg);
  for (const [key, info] of Object.entries(GROUP_COLORS)) {
    const lab = document.createElement("label");
    lab.className = "sw";
    lab.title = info.name;
    const r = document.createElement("input");
    r.type = "radio"; r.name = "color-" + c.id; r.value = key; r.checked = c.color === key;
    r.setAttribute("aria-label", info.name);
    r.onchange = () => { c.color = key; el.style.borderLeftColor = info.hex; markDirty(); };
    const sp = document.createElement("span");
    sp.style.background = info.hex;
    lab.append(r, sp);
    colors.appendChild(lab);
  }

  // описание
  const dl = document.createElement("label");
  dl.className = "label";
  dl.textContent = "Что сюда относится — словами";
  const desc = document.createElement("textarea");
  desc.value = c.desc;
  desc.placeholder = "Например: сайты про мой Telegram-бот — BotFather, документация aiogram, мой сервер, GitHub-репозиторий бота";
  desc.oninput = () => { c.desc = desc.value; markDirty(); };
  dl.appendChild(desc);
  desc.style.marginTop = "4px";

  el.append(row, colors, dl);
  return el;
}

function iconBtn(label, path, disabled, onClick) {
  const b = document.createElement("button");
  b.className = "icon-btn";
  b.type = "button";
  b.disabled = disabled;
  b.setAttribute("aria-label", label);
  b.title = label;
  b.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1b1f24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  b.onclick = onClick;
  return b;
}

function swap(a, b) {
  [cats[a], cats[b]] = [cats[b], cats[a]];
  markDirty(); render();
}

async function save() {
  const clean = cats.map(c => ({ ...c, title: c.title.trim(), desc: c.desc.trim() }));
  if (clean.some(c => !c.title)) return flash("У каждой категории должно быть название", "err");
  if (clean.some(c => !c.desc)) return flash("Опиши словами, что относится к каждой категории — по описанию решает Jev", "err");
  const titles = clean.map(c => c.title.toLowerCase());
  if (new Set(titles).size !== titles.length) return flash("Названия категорий не должны повторяться", "err");
  if (titles.includes("прочее")) return flash("«Прочее» уже есть всегда — выбери другое название", "err");

  $("save").disabled = true;
  const r = await send({ type: "saveCategories", categories: clean });
  $("save").disabled = false;
  if (r && r.ok) { cats = clean; dirty = false; render(); flash("Сохранено. Открытые группы обновлены.", "ok"); }
  else flash("Не удалось сохранить: " + ((r && r.error) || "нет ответа"), "err");
}

function flash(t, cls) { $("msg").textContent = t; $("msg").className = cls || ""; }
