export function assert(condition, message) {
  if (!condition) throw new Error(message);
}
export function https(value) {
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

export async function validateCatalog(projects, technologyGroups, checkScreenshot) {
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
      await checkScreenshot(project);
    }
    const target = [project.repository.replace(/\/$/, "").toLowerCase(), project.target.trim().toLowerCase()].join(" ");
    assert(!targets.has(target), record + " duplicates a project target");
    targets.add(target);
  }
}
