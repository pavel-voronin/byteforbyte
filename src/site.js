"use strict";
const { projects, technologyGroups, locales, repository, themes } = JSON.parse(document.querySelector("#site-data").textContent);
const byId = (id) => document.getElementById(id);
const ui = {
  locale: byId("language"), theme: byId("theme"), query: byId("query"),
  platform: byId("platform"), kind: byId("kind"),
  filters: byId("filters"), filterPanel: byId("filter-panel"), filterToggle: byId("filter-toggle"),
  filterActions: byId("filter-actions"), reset: byId("reset"), share: byId("share"), shareStatus: byId("share-status")
};

function recall(key) {
  try { return localStorage.getItem("byte-for-byte:" + key); } catch { return null; }
}
function remember(key, value) {
  try { localStorage.setItem("byte-for-byte:" + key, value); } catch { /* Storage can be disabled. */ }
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
function enableWheelSelection(select) {
  let distance = 0;
  let lastWheel = -Infinity;
  select.addEventListener("wheel", (event) => {
    const { deltaX, deltaY, deltaMode, timeStamp } = event;
    if (event.ctrlKey || !deltaY || Math.abs(deltaX) > Math.abs(deltaY)) return;
    event.preventDefault();

    const direction = Math.sign(deltaY);
    if (timeStamp - lastWheel > 200 || Math.sign(distance) !== direction) distance = 0;
    lastWheel = timeStamp;
    const step = 32;
    distance += deltaMode === WheelEvent.DOM_DELTA_PIXEL ? deltaY : direction * step;
    if (Math.abs(distance) < step) return;
    distance = 0;

    const next = select.selectedIndex + direction;
    if (next < 0 || next >= select.options.length) return;
    select.selectedIndex = next;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, { passive: false });
}
function applyTheme(id) {
  const theme = themes.find((theme) => theme.id === id);
  document.documentElement.dataset.theme = theme.id;
  byId("favicon").setAttribute("href", theme.icon);
}
const savedTheme = recall("color-theme");
const themeId = themes.some((theme) => theme.id === savedTheme) ? savedTheme : document.documentElement.dataset.theme;
for (const theme of themes) addOption(ui.theme, theme.id, theme.name, "en");
ui.theme.value = themeId;
applyTheme(themeId);
ui.theme.addEventListener("change", () => {
  applyTheme(ui.theme.value);
  remember("color-theme", ui.theme.value);
});
for (const [code, locale] of Object.entries(locales)) addOption(ui.locale, code, locale.name, code);
const platformControls = new Map();
const kindControls = new Map([...ui.kind.querySelectorAll("input")].map(input => [input.value, input]));
for (const platform of [...new Set(projects.map((project) => project.platform))].sort()) {
  const label = element("label");
  const checkbox = element("input");
  checkbox.type = "checkbox";
  checkbox.value = platform;
  platformControls.set(platform, checkbox);
  checkbox.setAttribute("aria-controls", "projects");
  label.append(checkbox, element("bdi", platform));
  ui.platform.append(label);
}
const ungroupedTechnologies = new Set(projects.flatMap((project) => project.technologies ?? []));
const technologyControls = new Map();
const technologyLabels = new Map([
  ["x86 Assembly", "x86 ASM"],
  ["MIPS Assembly", "MIPS ASM"]
]);
const technologyLabel = (name) => technologyLabels.get(name) ?? name;
const technologyIcons = {
  techLanguages: "code-xml",
  techBuildTools: "wrench",
  techEngines: "cog",
  techRuntimes: "square-terminal",
  techOther: "shapes"
};
for (const legend of ui.filters.querySelectorAll("legend[data-icon]")) {
  legend.prepend(catalogIcon(legend.dataset.icon));
}
const technologyFilterGroups = [];
const groups = Object.entries(technologyGroups).map(([id, names]) => [id, names.filter((name) => ungroupedTechnologies.delete(name))]);
groups.push(["techOther", [...ungroupedTechnologies]]);
for (const [id, names] of groups) {
  if (!names.length) continue;
  const group = element("fieldset");
  const legend = element("legend");
  const title = element("span");
  const options = element("div", null, "filter-options");
  title.dataset.t = id;
  legend.append(technologyIcon(id), title);
  group.append(legend, options);
  for (const technology of names.sort((a, b) => a.localeCompare(b, "en"))) {
    const option = element("label");
    const checkbox = element("input");
    checkbox.type = "checkbox";
    checkbox.value = technology;
    technologyControls.set(technology, { checkbox, group: id });
    option.append(checkbox, element("bdi", technologyLabel(technology)));
    options.append(option);
  }
  ui.filterPanel.append(group);
  technologyFilterGroups.push(group);
}
const filterGroups = [
  { param: "platform", group: ui.platform, matches: (project, value) => project.platform === value },
  { param: "kind", group: ui.kind, matches: (project, value) => project.kind === value },
  ...technologyFilterGroups.map((group) => ({
    param: "tech", group, matches: (project, value) => project.technologies?.includes(value)
  }))
];
const repositoryUrl = repository.replace(/\/$/, "");
const addProject = byId("add-project");
const githubMark = addProject.querySelector("svg");
const feedback = byId("feedback-link");
addProject.href = repositoryUrl + "/issues/new?template=add-project.yml";
feedback.href = repositoryUrl + "/issues";
feedback.append(githubMark.cloneNode(true));

const t = (key) => locales[language].strings[key];
const filterOptionLimit = 5;
for (const filter of filterGroups) {
  const { group } = filter;
  const options = group.matches(".filter-options") ? group : group.querySelector(".filter-options");
  filter.options = options;
  filter.labels = Array.from(options.children);
  if (filter.labels.length <= filterOptionLimit) continue;

  const more = element("button", null, "filter-more");
  more.type = "button";
  more.dir = "ltr";
  options.append(more);
  filter.more = more;
  more.addEventListener("click", () => {
    const firstEnabled = options.querySelector("label[hidden] input:enabled");
    filter.expanded = true;
    for (const option of filter.labels) option.hidden = false;
    more.hidden = true;
    (firstEnabled ?? filter.group.closest("fieldset").querySelector("input:enabled"))?.focus({ preventScroll: true });
  });
}
const expandedStacks = new Set();
const stackObserver = new ResizeObserver((entries) => {
  for (const { target: stack, contentRect } of entries) {
    const more = stack.lastElementChild;
    const tags = [...stack.querySelectorAll(".is-featured")];
    const tagCount = stack.querySelectorAll(".is-overflow-tag").length;
    for (const tag of tags) tag.hidden = false;
    const gap = Number.parseFloat(getComputedStyle(stack).columnGap);
    const widths = tags.map((tag) => tag.getBoundingClientRect().width);
    const total = widths.reduce((sum, width) => sum + width, gap * Math.max(0, tags.length - 1));
    more.hidden = tagCount === tags.length && total <= contentRect.width;
    if (more.hidden) continue;

    let visible = tags.length;
    let visibleWidth = total;
    while (visible > 0) {
      more.textContent = "+" + (tagCount - visible);
      if (visibleWidth + gap + more.getBoundingClientRect().width <= contentRect.width) break;
      visible -= 1;
      visibleWidth -= widths[visible] + gap;
    }
    setHiddenTagCount(more, tagCount - visible);
    for (const [index, tag] of tags.entries()) {
      if (index >= visible && tag === document.activeElement) more.focus({ preventScroll: true });
      tag.hidden = index >= visible;
    }
  }
});
function setHiddenTagCount(button, count) {
  button.textContent = "+" + count;
  button.setAttribute("aria-label", t("showTags") + " (+" + count + ")");
}
function localize() {
  document.documentElement.lang = language;
  document.documentElement.dir = locales[language].dir ?? "ltr";
  document.title = "Byte for Byte · " + t("catalog");
  ui.locale.value = language;
  document.querySelectorAll("[data-t]").forEach((el) => { el.textContent = t(el.dataset.t); });
  document.querySelectorAll("[data-a]").forEach((el) => { el.setAttribute("aria-label", t(el.dataset.a)); });
  document.querySelectorAll("[data-p]").forEach((el) => { el.placeholder = t(el.dataset.p); });
  const number = new Intl.NumberFormat(language);
  for (const { more, labels } of filterGroups) {
    if (!more) continue;
    const count = number.format(labels.length - filterOptionLimit);
    more.textContent = "+" + count;
    more.setAttribute("aria-label", t("moreOptions").replace("{count}", count));
  }
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
function catalogIcon(name) {
  const namespace = "http://www.w3.org/2000/svg";
  const icon = document.createElementNS(namespace, "svg");
  icon.setAttribute("class", "technology-icon");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  const source = document.createElementNS(namespace, "use");
  source.setAttribute("href", "#lucide-" + name);
  icon.append(source);
  return icon;
}
function technologyIcon(group) {
  return catalogIcon(technologyIcons[group] ?? technologyIcons.techOther);
}
function filterTag(id, label, icon, checkbox, description) {
  const tag = element("button", null, "entry-tag");
  tag.type = "button";
  tag.dir = "auto";
  tag.id = id;
  tag.append(icon, label);
  tag.setAttribute("aria-description", description);
  tag.setAttribute("aria-pressed", String(checkbox.checked));
  tag.addEventListener("click", () => {
    const hadFocus = document.activeElement === tag;
    checkbox.click();
    if (hadFocus) {
      const replacement = byId(tag.id) ?? (checkbox.getClientRects().length ? checkbox : ui.filterToggle);
      replacement.focus({ preventScroll: true });
    }
  });
  return tag;
}
function projectTags(project, showAllTags) {
  const stack = element("div", null, "entry-stack");
  stack.setAttribute("role", "group");
  stack.setAttribute("aria-label", t("filters"));
  const tagPrefix = "tag-" + project.id + "-";
  const platform = filterTag(tagPrefix + "platform", project.platform, catalogIcon("monitor"),
    platformControls.get(project.platform), t("platform"));
  const kind = filterTag(tagPrefix + "kind", t(project.kind), catalogIcon("shapes"),
    kindControls.get(project.kind), t("kind"));
  const expanded = showAllTags || expandedStacks.has(project.id);
  kind.hidden = !expanded;
  kind.classList.add("is-overflow-tag");
  const technologies = project.technologies ?? [];
  const featuredGroup = technologies.some(technology => technologyControls.get(technology).group === "techEngines")
    ? "techEngines" : "techLanguages";
  const featured = [];
  const additional = [];
  for (const [index, technology] of technologies.entries()) {
    const { checkbox, group } = technologyControls.get(technology);
    const tag = filterTag(tagPrefix + index, technologyLabel(technology), technologyIcon(group), checkbox, t(group));
    const isFeatured = group === featuredGroup;
    tag.classList.add("is-overflow-tag");
    tag.classList.toggle("is-featured", isFeatured);
    tag.hidden = !expanded && !isFeatured;
    (isFeatured ? featured : additional).push(tag);
  }
  stack.append(platform, ...featured, kind, ...additional);
  if (expanded) {
    stack.classList.add("is-expanded");
  } else {
    const more = element("button");
    more.type = "button";
    more.dir = "ltr";
    const hiddenCount = additional.length + 1;
    more.hidden = hiddenCount === 0;
    setHiddenTagCount(more, hiddenCount);
    more.addEventListener("click", () => {
      expandedStacks.add(project.id);
      stackObserver.unobserve(stack);
      stack.classList.add("is-expanded");
      more.remove();
      for (const tag of stack.children) tag.hidden = false;
      stack.tabIndex = -1;
      stack.focus({ preventScroll: true });
    });
    stack.append(more);
    stackObserver.observe(stack);
  }
  return stack;
}
function playablePreview(image, project) {
  if (!project.playUrl) return image;
  const play = link(project.playUrl);
  play.className = "entry-play";
  play.classList.toggle("entry-play-placeholder", image === null);
  play.setAttribute("aria-label", t("playProject").replace("{title}", () => project.title));
  const indicator = element("span", null, "entry-play-indicator");
  indicator.append(catalogIcon("play"));
  if (image) play.append(image);
  play.append(indicator);
  return play;
}
function projectRow(project, showAllTags) {
  const card = element("tbody");
  const row = element("tr");
  card.append(row);
  const preview = project.screenshot;
  const hasPreview = Boolean(preview || project.playUrl);
  const name = element("th", null, "entry-name");
  name.scope = "row";
  name.id = "project-" + project.id;
  const title = link(project.repository, project.title);
  title.dir = "auto";
  if (hasPreview) {
    card.classList.add("has-preview");
    const screenshotCell = element("td", null, "entry-screenshot-cell");
    screenshotCell.rowSpan = 2;
    const screenshot = preview ? element("img", null, "entry-screenshot") : null;
    if (screenshot) {
      card.style.setProperty("--entry-screenshot-ratio", preview.width / preview.height);
      screenshot.width = preview.width;
      screenshot.height = preview.height;
      screenshot.alt = "";
      screenshot.decoding = "async";
      screenshot.src = preview.src;
    }
    screenshotCell.append(playablePreview(screenshot, project));
    row.append(screenshotCell);
    const inlineScreenshot = playablePreview(screenshot ? screenshot.cloneNode(true) : null, project);
    inlineScreenshot.classList.add("entry-screenshot-inline");
    if (project.playUrl) name.append(inlineScreenshot);
    else title.prepend(inlineScreenshot);
  } else {
    name.colSpan = 2;
  }
  const description = element("bdi", project.description ?? project.target, "entry-target");
  name.append(title);
  if (project.releaseYear !== undefined) {
    name.append(" ", element("bdi", "(" + project.releaseYear + ")", "entry-year"));
  }
  const credit = element("bdi", null, "entry-credit");
  const author = project.creditUrl ? link(project.creditUrl, project.credit) : element("bdi", project.credit);
  author.dir = "auto";
  if (project.creditUrl && ["github.com", "www.github.com"].includes(new URL(project.creditUrl).hostname)) {
    author.prepend(githubMark.cloneNode(true));
  }
  credit.append("by ", author);
  name.append(" ", credit);
  row.append(name);

  const detailsRow = element("tr");
  const detailsCell = element("td", null, "entry-details");
  detailsCell.colSpan = hasPreview ? 1 : 2;
  detailsCell.setAttribute("headers", name.id);
  detailsCell.append(description, projectTags(project, showAllTags));
  detailsRow.append(detailsCell);
  card.append(detailsRow);
  return card;
}
function normalize(value) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}
function checkedValues(group) {
  return Array.from(group.querySelectorAll(":checked"), (option) => option.value);
}
function consumeSharedFilters() {
  const url = new URL(window.location.href);
  const params = new URLSearchParams(url.hash.slice(1));
  if (!params.has("q") && !filterGroups.some(({ param }) => params.has(param))) return false;

  ui.query.value = params.get("q") ?? "";
  for (const { group, param } of filterGroups) {
    const values = new Set(params.getAll(param));
    for (const input of group.querySelectorAll("input")) input.checked = values.has(input.value);
  }
  url.hash = "";
  window.history.replaceState(window.history.state, "", url);
  return true;
}
function sharedFiltersUrl() {
  const url = new URL(window.location.href);
  url.search = "";
  const params = new URLSearchParams();
  const query = ui.query.value.trim();
  if (query) params.set("q", query);
  for (const { group, param } of filterGroups) {
    for (const value of checkedValues(group)) params.append(param, value);
  }
  url.hash = params.toString();
  return url.href;
}
function updateFilterOptions(filter, candidates) {
  const { options, labels, more } = filter;
  const focused = options.contains(document.activeElement) && document.activeElement.matches("input")
    ? document.activeElement : null;
  for (const label of labels) {
    const input = label.firstElementChild;
    input.disabled = !input.checked && !candidates.some((project) => filter.matches(project, input.value));
  }
  const ordered = [...labels].sort((a, b) => Number(a.firstElementChild.disabled) - Number(b.firstElementChild.disabled));
  if (more && ordered.slice(filterOptionLimit).some((label) => label.firstElementChild.checked)) {
    filter.expanded = true;
  }
  for (const [index, label] of ordered.entries()) {
    label.hidden = !filter.expanded && index >= filterOptionLimit;
    const current = options.children[index];
    if (label !== current) options.insertBefore(label, current);
  }
  if (more) more.hidden = !!filter.expanded;
  if (focused && (focused.disabled || focused.parentElement.hidden || document.activeElement !== focused)) {
    const replacement = !focused.disabled && !focused.parentElement.hidden ? focused
      : options.querySelector("label:not([hidden]) input:enabled") ?? (more && !more.hidden ? more : ui.reset);
    replacement.focus({ preventScroll: true });
  }
}
function render() {
  const terms = normalize(ui.query.value.trim()).split(/\s+/).filter(Boolean);
  const filters = filterGroups.map((filter) => ({ filter, selected: checkedValues(filter.group) }));
  const hasFilters = terms.length > 0 || filters.some((filter) => filter.selected.length > 0);
  ui.filterActions.hidden = !hasFilters;
  clearShareStatus();
  const searchResults = projects.filter((project) => {
    const stack = project.technologies ?? [];
    const searchable = normalize([
      project.title, project.platform, project.description, project.target, project.credit, t(project.kind), ...stack, ...stack.map(technologyLabel)
    ].join(" "));
    return terms.every((term) => searchable.includes(term));
  });
  const matchesFilters = (project, except) => filters.every((filter) =>
    filter === except || !filter.selected.length || filter.selected.some((value) => filter.filter.matches(project, value))
  );
  for (const filter of filters) {
    const candidates = searchResults.filter((project) => matchesFilters(project, filter));
    updateFilterOptions(filter.filter, candidates);
  }
  const result = searchResults.filter((project) => matchesFilters(project));
  const collator = new Intl.Collator(language);
  const byName = (a, b) => collator.compare(a.title, b.title);
  result.sort(hasFilters ? byName : (a, b) => b.added.localeCompare(a.added) || byName(a, b));
  const number = new Intl.NumberFormat(language);
  stackObserver.disconnect();
  const table = byId("projects");
  table.replaceChildren(table.querySelector("colgroup"), table.tHead, ...result.map((project) =>
    projectRow(project, hasFilters)
  ));
  byId("count").textContent = t("count").replace("{shown}", number.format(result.length)).replace("{total}", number.format(projects.length));
  byId("empty").hidden = result.length !== 0;
}

function moveTo(id) {
  const target = byId(id);
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: "start" });
}
const desktopLayout = window.matchMedia("(width > 570px)");
const pageScroll = byId("page-scroll");
const header = document.querySelector("header.site");
const catalogSidebar = byId("catalog-sidebar");
const catalogResults = byId("catalog-results");
const catalogFooter = byId("catalog-footer");
function placeCatalogFooter() {
  const parent = desktopLayout.matches ? catalogSidebar : catalogResults;
  if (catalogFooter.parentElement !== parent) parent.append(catalogFooter);
}
desktopLayout.addEventListener("change", placeCatalogFooter);
placeCatalogFooter();
const layoutObserver = new ResizeObserver((entries) => {
  for (const { target, borderBoxSize } of entries) {
    const height = borderBoxSize[0].blockSize + "px";
    if (target === header) document.documentElement.style.setProperty("--site-header-height", height);
    else target.style.setProperty("--catalog-column-height", height);
  }
});
for (const region of [header, catalogSidebar, catalogResults]) layoutObserver.observe(region, { box: "border-box" });

byId("home").addEventListener("click", (event) => {
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  (desktopLayout.matches ? pageScroll : window).scrollTo({ top: 0 });
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
ui.filterToggle.addEventListener("click", () => {
  const open = ui.filterPanel.classList.toggle("is-open");
  ui.filterToggle.setAttribute("aria-expanded", String(open));
  ui.filterToggle.dataset.t = open ? "hideFilters" : "showFilters";
  ui.filterToggle.textContent = t(ui.filterToggle.dataset.t);
});
for (const { group } of filterGroups) group.addEventListener("change", render);
for (const select of [ui.theme, ui.locale]) enableWheelSelection(select);
ui.reset.addEventListener("click", () => {
  const restoreFocus = ui.reset.matches(":focus-visible");
  ui.query.value = "";
  for (const option of ui.filters.querySelectorAll(":checked")) option.checked = false;
  render();
  if (restoreFocus) ui.platform.querySelector("input")?.focus({ preventScroll: true });
});
let shareStatusTimer;
function clearShareStatus() {
  ui.share.classList.remove("is-copied");
  ui.shareStatus.textContent = "";
}
ui.share.addEventListener("click", async () => {
  const url = sharedFiltersUrl();
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    window.prompt(t("copyShareLink"), url);
    return;
  }
  if (ui.filterActions.hidden) return;
  ui.share.classList.add("is-copied");
  ui.shareStatus.textContent = t("shareCopied");
  window.clearTimeout(shareStatusTimer);
  shareStatusTimer = window.setTimeout(clearShareStatus, 2500);
});
window.addEventListener("hashchange", () => {
  if (consumeSharedFilters()) render();
});
consumeSharedFilters();
localize();
