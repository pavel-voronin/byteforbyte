import { readFile, writeFile, mkdir } from "node:fs/promises";

const file = (path) => new URL(path, import.meta.url);
const read = (path) => readFile(file(path), "utf8");
const [template, css, js, catalogJson, localesJson, themesJson] = await Promise.all([
  read("src/index.html"), read("src/site.css"), read("src/site.js"),
  read("data/catalog.json"), read("data/locales.json"), read("data/themes.json")
]);
const projects = JSON.parse(catalogJson);
const locales = JSON.parse(localesJson);
const themes = JSON.parse(themesJson);
const revision = process.env.CATALOG_REVISION || "";
const repository = process.env.CATALOG_REPOSITORY || "https://github.com/pavel-voronin/bytetobyte";

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
for (const [index, project] of projects.entries()) {
  const record = "Catalog row " + (index + 1);
  assert(project && typeof project === "object", record + " must be an object");
  for (const field of ["id", "title", "platform", "credit", "target"]) {
    assert(typeof project[field] === "string" && project[field].trim(), record + " requires " + field);
  }
  assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project.id) && !seen.has(project.id), record + " has invalid or duplicate id");
  seen.add(project.id);
  assert(["game", "software"].includes(project.kind), record + " has invalid kind");
  assert(project.match === "byte", record + " has invalid match");
  assert(validDate(project.added), record + " requires a real date (YYYY-MM-DD or UTC ISO timestamp)");
  assert(https(project.repository) && https(project.evidence), record + " requires HTTPS links");
  const target = [project.repository.replace(/\/$/, "").toLowerCase(), project.target.trim().toLowerCase()].join(" ");
  assert(!targets.has(target), record + " duplicates a project target");
  targets.add(target);
}

assert(locales.en?.strings, "Missing English translation");
const translationKeys = new Set([
  ...Array.from(template.matchAll(/data-[tap]="([a-z0-9-]+)"/g), match => match[1]),
  "added", "count"
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

const colorKeys = ["bg", "paper", "input", "hover", "ink", "muted", "accent", "action", "actionInk", "focus", "rule", "inputEdge", "comment", "command", "success"];
const themeIds = new Set();
const themeCss = themes.map(({ id, name, scheme, colors }) => {
  assert(/^[a-z0-9-]+$/.test(id) && !themeIds.has(id), "Invalid or duplicate theme: " + id);
  assert(typeof name === "string" && name.trim() && ["dark","light"].includes(scheme), "Invalid theme metadata: " + id);
  themeIds.add(id);
  const vars = colorKeys.map(key => {
    assert(/^#[0-9a-f]{6}$/i.test(colors?.[key]), "Invalid " + key + " color in " + id);
    return "--" + key + ":" + colors[key];
  });
  return ':root[data-theme="' + id + '"]{color-scheme:' + scheme + ";" + vars.join(";") + "}";
}).join("\n");
assert(themeIds.has("dracula"), "Missing default theme");
const themeOptions = themes.map(({ id, name }) => ({ id, name }));
const data = JSON.stringify({ projects, locales, repository, themes: themeOptions }).replaceAll("<", "\\u003c");
const assets = { CSS: css, JS: js, DATA: data, THEMES: themeCss,
  REVISION: revision ? '<meta name="catalog-revision" content="' + revision + '">' : "" };
const html = template.replace(/%%(CSS|JS|DATA|THEMES|REVISION)%%/g, (_, key) => assets[key]);
await mkdir(file("dist/"), { recursive: true });
await writeFile(file("dist/index.html"), html);
console.log("Built dist/index.html with " + projects.length + " projects and " + Object.keys(locales).length + " locales.");
