import { readFile, writeFile, mkdir } from "node:fs/promises";

const file = (path) => new URL(path, import.meta.url);
const read = (path) => readFile(file(path), "utf8");
const [template, css, js, catalogJson, technologiesJson, localesJson, themesJson, brandSvg, lucideSvg, controllerSvg] = await Promise.all([
  read("src/index.html"), read("src/site.css"), read("src/site.js"),
  read("data/catalog.json"), read("data/technologies.json"), read("data/locales.json"), read("data/themes.json"),
  read("src/brand.svg"), read("src/lucide-icons.svg"), read("dendy-junior-controller.svg")
]);
const projects = JSON.parse(catalogJson);
const technologyGroups = JSON.parse(technologiesJson);
const locales = JSON.parse(localesJson);
const themes = JSON.parse(themesJson);
const revision = process.env.CATALOG_REVISION || "";
const repository = process.env.CATALOG_REPOSITORY || "https://github.com/pavel-voronin/byteforbyte";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function https(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}
function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}\.\d{3}Z)?$/.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(+date) && date.toISOString().slice(0, value.length) === value;
}

assert(!revision || /^[a-f0-9]{40}$/.test(revision), "Invalid CATALOG_REVISION");
assert(https(repository), "Invalid CATALOG_REPOSITORY URL");
assert(Array.isArray(projects), "Catalog must be an array");
const seen = new Set();
const targets = new Set();
const technologyNames = new Map();
const validTechnologyName = (name) => typeof name === "string" && name && name === name.trim() && !name.includes(",");
const technologyKey = (name) => name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
assert(technologyGroups && typeof technologyGroups === "object" && !Array.isArray(technologyGroups),
  "Expected a map of technology groups");
for (const [group, names] of Object.entries(technologyGroups)) {
  assert(group !== "techOther" && Array.isArray(names) && names.every(validTechnologyName), "Invalid technology group: " + group);
  for (const name of names) {
    const key = technologyKey(name);
    assert(!technologyNames.has(key), "Technology assigned more than once: " + name);
    technologyNames.set(key, name);
  }
}
for (const [index, project] of projects.entries()) {
  const record = "Catalog row " + (index + 1);
  assert(project && typeof project === "object", record + " must be an object");
  for (const field of ["id", "title", "platform", "credit", "target"]) {
    assert(typeof project[field] === "string" && project[field].trim(), record + " requires " + field);
  }
  assert(project.description === undefined || (typeof project.description === "string" && project.description.trim()),
    record + " requires a nonempty description when provided");
  const stack = project.technologies === undefined ? [] : project.technologies;
  assert(Array.isArray(stack) && stack.every(validTechnologyName),
    record + " requires technologies to be an array of names");
  const stackKeys = stack.map(technologyKey);
  assert(new Set(stackKeys).size === stack.length, record + " has duplicate technologies");
  for (const [position, key] of stackKeys.entries()) {
    assert(!technologyNames.has(key) || technologyNames.get(key) === stack[position],
      record + " must spell the technology as " + technologyNames.get(key));
    technologyNames.set(key, stack[position]);
  }
  assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project.id) && !seen.has(project.id), record + " has invalid or duplicate id");
  seen.add(project.id);
  assert(["game", "software"].includes(project.kind), record + " has invalid kind");
  assert(project.match === "byte", record + " has invalid match");
  assert(project.releaseYear === undefined ||
    (Number.isInteger(project.releaseYear) && project.releaseYear >= 1000 && project.releaseYear <= 9999),
    record + " requires a four-digit release year");
  assert(validDate(project.added), record + " requires a real date (YYYY-MM-DD or UTC ISO timestamp)");
  assert(https(project.repository) && https(project.evidence), record + " requires HTTPS links");
  assert(project.creditUrl === undefined || https(project.creditUrl), record + " has an invalid restoration team URL");
  assert(project.playUrl === undefined || https(project.playUrl), record + " has an invalid playable version URL");
  if (project.screenshot !== undefined) {
    const screenshot = project.screenshot;
    assert(screenshot && typeof screenshot.file === "string" && /^[a-z0-9-]+\.webp$/.test(screenshot.file)
      && [screenshot.width, screenshot.height].every(value => Number.isInteger(value) && value > 0),
    record + " requires a WebP screenshot filename and positive dimensions");
    const image = await readFile(file("assets/screenshots/" + screenshot.file));
    project.screenshot = {
      width: screenshot.width,
      height: screenshot.height,
      src: "data:image/webp;base64," + image.toString("base64")
    };
  }
  const target = [project.repository.replace(/\/$/, "").toLowerCase(), project.target.trim().toLowerCase()].join(" ");
  assert(!targets.has(target), record + " duplicates a project target");
  targets.add(target);
}

assert(locales.en?.strings, "Missing English translation");
const translationKeys = new Set([
  ...Array.from(template.matchAll(/data-[tap]="([a-z0-9-]+)"/gi), match => match[1]),
  "count", "showTags", "playProject", "moreOptions", "hideFilters", "techOther", ...Object.keys(technologyGroups)
]);
for (const [tag, locale] of Object.entries(locales)) {
  assert(Intl.getCanonicalLocales(tag)[0] === tag, "Use canonical locale tag " + tag);
  assert(locale.name?.trim() && [undefined, "ltr", "rtl"].includes(locale.dir), "Invalid locale metadata: " + tag);
  for (const key of translationKeys) {
    assert(typeof locale.strings?.[key] === "string" &&
      locale.strings[key].trim(), "Missing " + tag + " translation: " + key);
  }
  assert(["{shown}", "{total}"].every(key => locale.strings.count.includes(key)), "Missing count tokens: " + tag);
}

const colorKeys = [
  "bg", "paper", "paperInk", "rule", "paperRule", "ink", "accent", "activeAccent", "muted", "focus",
  "hover", "hoverInk", "input", "inputInk", "inputEdge", "placeholder", "dropdown", "dropdownInk", "dropdownEdge",
  "action", "actionInk", "actionEdge", "actionHover", "secondary", "secondaryInk", "secondaryEdge", "secondaryHover",
  "terminal", "terminalInk", "command", "success"
];
const logoAccents = {
  dracula: ["rule"],
  abyss: ["command"],
  "dark-high-contrast": ["rule"],
  "kimbie-dark": ["focus", "paperInk"],
  "monokai-dimmed": ["success"],
  monokai: ["success"],
  "quiet-light": ["action"],
  red: ["focus"],
  "solarized-dark": ["action"],
  "solarized-light": ["command", "terminalInk"],
  "tomorrow-night-blue": ["focus"]
};
function logoInk({ id, colors }) {
  const [accent, contrast] = logoAccents[id] ?? ["activeAccent"];
  const ink = colors[accent].slice(0, 7);
  if (!contrast) return ink;
  // Blend toward the theme's text color where the accent needs more contrast at 16px.
  const accentChannels = ink.slice(1).match(/../g);
  const contrastChannels = colors[contrast].slice(1, 7).match(/../g);
  return "#" + accentChannels.map((channel, index) => {
    const value = Math.round((3 * parseInt(channel, 16) + parseInt(contrastChannels[index], 16)) / 4);
    return value.toString(16).padStart(2, "0");
  }).join("");
}
const themeIds = new Set();
const themeCss = themes.map(({ id, name, scheme, colors }) => {
  assert(/^[a-z0-9-]+$/.test(id) && !themeIds.has(id), "Invalid or duplicate theme: " + id);
  assert(typeof name === "string" && name.trim() && ["dark","light"].includes(scheme), "Invalid theme metadata: " + id);
  themeIds.add(id);
  const vars = colorKeys.map(key => {
    assert(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(colors?.[key]), "Invalid " + key + " color in " + id);
    return "--" + key + ":" + colors[key];
  });
  vars.push("--logo-ink:" + logoInk({ id, colors }));
  return ':root[data-theme="' + id + '"]{color-scheme:' + scheme + ";" + vars.join(";") + "}";
}).join("\n");
const defaultTheme = "quiet-light";
assert(themeIds.has(defaultTheme), "Missing default theme");
const brandMark = (theme) => brandSvg.trim()
  .replace("%%LOGO_PAPER%%", theme.colors.paper)
  .replace("%%LOGO_INK%%", logoInk(theme));
const themeOptions = themes.map((theme) => ({
  id: theme.id, name: theme.name, icon: "data:image/svg+xml," + encodeURIComponent(brandMark(theme))
}));
const data = JSON.stringify({ projects, technologyGroups, locales, repository, themes: themeOptions }).replaceAll("<", "\\u003c");
const assets = { CSS: css, JS: js, DATA: data, THEMES: themeCss, DEFAULT_THEME: defaultTheme,
  LUCIDE: lucideSvg.trim(),
  CONTROLLER: "data:image/svg+xml;base64," + Buffer.from(controllerSvg.trim()).toString("base64"),
  ICON: themeOptions.find(({ id }) => id === defaultTheme).icon,
  MARK: brandMark(themes.find(({ id }) => id === defaultTheme))
    .replace("<svg ", '<svg class="logo" aria-hidden="true" '),
  REVISION: revision ? '<meta name="catalog-revision" content="' + revision + '">' : "" };
const html = template.replace(/%%(CSS|JS|DATA|THEMES|REVISION|ICON|MARK|DEFAULT_THEME|LUCIDE|CONTROLLER)%%/g, (_, key) => assets[key]);
await mkdir(file("dist/"), { recursive: true });
await writeFile(file("dist/index.html"), html);
console.log("Built dist/index.html with " + projects.length + " projects and " + Object.keys(locales).length + " locales.");
