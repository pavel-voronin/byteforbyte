import { readFile, writeFile, mkdir } from "node:fs/promises";
import { assert, https, validateCatalog } from "./scripts/validate-catalog.mjs";

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

assert(!revision || /^[a-f0-9]{40}$/.test(revision), "Invalid CATALOG_REVISION");
assert(https(repository), "Invalid CATALOG_REPOSITORY URL");
await validateCatalog(projects, technologyGroups, async (project) => {
  const { file: filename, width, height } = project.screenshot;
  const image = await readFile(file("assets/screenshots/" + filename));
  project.screenshot = { width, height, src: "data:image/webp;base64," + image.toString("base64") };
});

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
