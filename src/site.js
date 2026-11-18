"use strict";
const { projects, locales, repository, themes } = JSON.parse(document.querySelector("#site-data").textContent);
const byId = (id) => document.getElementById(id);
const ui = {
  locale: byId("language"), theme: byId("theme"), query: byId("query"),
  platform: byId("platform"), kind: byId("kind"), sort: byId("sort"), reset: byId("reset")
};

function recall(key) {
  try { return localStorage.getItem("byte-to-byte:" + key); } catch { return null; }
}
function remember(key, value) {
  try { localStorage.setItem("byte-to-byte:" + key, value); } catch { /* Storage can be disabled. */ }
}
function preferredLocale() {
  const available = Object.keys(locales);
  for (const candidate of navigator.languages) {
    const lower = candidate.toLowerCase();
    const match = available.find((tag) => tag.toLowerCase() === lower) ??
      available.find((tag) => tag.split("-")[0] === lower.split("-")[0]);
    if (match) return match;
  }
  return "en";
}
const savedLocale = recall("locale");
let language = Object.hasOwn(locales, savedLocale) ? savedLocale : preferredLocale();

function addOption(select, value, name, lang) {
  const option = new Option(name, value);
  if (lang) option.lang = lang;
  select.add(option);
}
const savedTheme = recall("color-theme");
const themeId = themes.some((theme) => theme.id === savedTheme) ? savedTheme : "dracula";
for (const theme of themes) addOption(ui.theme, theme.id, theme.name, "en");
ui.theme.value = themeId;
document.documentElement.dataset.theme = themeId;
ui.theme.addEventListener("change", () => {
  document.documentElement.dataset.theme = ui.theme.value;
  remember("color-theme", ui.theme.value);
});
for (const [code, locale] of Object.entries(locales)) addOption(ui.locale, code, locale.name, code);
for (const platform of [...new Set(projects.map((project) => project.platform))].sort()) {
  addOption(ui.platform, platform, platform);
}
const repositoryUrl = repository.replace(/\/$/, "");
byId("header-repository").href = repositoryUrl;
byId("add-project").href = repositoryUrl + "/issues/new?template=add-project.yml";

const t = (key) => locales[language].strings[key];
function localize() {
  document.documentElement.lang = language;
  document.documentElement.dir = locales[language].dir ?? "ltr";
  document.title = "Byte to Byte · " + t("catalog");
  ui.locale.value = language;
  const total = projects.length;
  const category = new Intl.PluralRules(language).select(total);
  const forms = locales[language].total;
  const wording = forms["=" + total] ?? forms[category] ?? forms.other;
  byId("total-projects").textContent = wording.replace("{n}", new Intl.NumberFormat(language).format(total));
  document.querySelectorAll("[data-t]").forEach((el) => { el.textContent = t(el.dataset.t); });
  document.querySelectorAll("[data-a]").forEach((el) => { el.setAttribute("aria-label", t(el.dataset.a)); });
  document.querySelectorAll("[data-p]").forEach((el) => { el.placeholder = t(el.dataset.p); });
  render();
}
function element(tag, text, className) {
  const el = document.createElement(tag);
  if (text) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function link(url, title) {
  const el = element("a", title);
  el.href = url;
  return el;
}
function projectRow(project, dateFormat) {
  const row = element("tr");
  const name = element("th", null, "entry-name");
  name.scope = "row";
  const title = link(project.repository, project.title);
  title.dir = "auto";
  const original = element("bdi", project.target, "entry-target");
  name.append(title, original);

  const meta = element("td", null, "entry-meta");
  const platform = element("bdi", project.platform, "entry-platform");
  const info = element("span", t(project.kind), "entry-type");
  const added = element("time", dateFormat.format(new Date(project.added)));
  added.dateTime = project.added;
  added.setAttribute("aria-label", t("added") + " " + added.textContent);
  const classification = element("div", null, "entry-classification");
  classification.append(platform, info);
  meta.append(classification, added);

  row.append(name, meta);
  return row;
}
function normalize(value) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}
function render() {
  const terms = normalize(ui.query.value.trim()).split(/\s+/).filter(Boolean);
  const result = projects.filter((project) => {
    const searchable = normalize([project.title, project.platform, project.target, project.credit, t(project.kind)].join(" "));
    return (!ui.platform.value || project.platform === ui.platform.value) &&
      (!ui.kind.value || project.kind === ui.kind.value) && terms.every((term) => searchable.includes(term));
  });
  const collator = new Intl.Collator(language);
  const byName = (a, b) => collator.compare(a.title, b.title);
  result.sort(ui.sort.value === "name" ? byName : (a, b) => b.added.localeCompare(a.added) || byName(a, b));
  const dateFormat = new Intl.DateTimeFormat(language, { dateStyle: "medium", timeZone: "UTC" });
  const number = new Intl.NumberFormat(language);
  byId("projects").replaceChildren(...result.map((project) => projectRow(project, dateFormat)));
  byId("count").textContent = t("count").replace("{shown}", number.format(result.length)).replace("{total}", number.format(projects.length));
  byId("empty").hidden = result.length !== 0;
}

function moveTo(id) {
  const target = byId(id);
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: "start" });
}
byId("home").addEventListener("click", (event) => {
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  window.scrollTo({ top: 0 });
});
byId("skip").addEventListener("click", (event) => {
  event.preventDefault();
  moveTo("catalog");
});

ui.locale.addEventListener("change", () => {
  language = ui.locale.value;
  remember("locale", language);
  localize();
});
ui.query.addEventListener("input", render);
for (const control of [ui.platform, ui.kind, ui.sort]) control.addEventListener("change", render);
ui.reset.addEventListener("click", () => {
  ui.query.value = ui.platform.value = ui.kind.value = "";
  ui.query.focus();
  render();
});
localize();
