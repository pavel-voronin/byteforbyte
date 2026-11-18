import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const catalogPath = "data/catalog.json";
const branchPrefix = "catalog/issue-";
const fields = new Map([
  ["Project name", ["title", 150]],
  ["Original platform", ["platform", 40]],
  ["Type", ["kind", 12]],
  ["Restoration team", ["credit", 120]],
  ["Exact original release and verified files", ["target", 240]],
  ["Project repository URL", ["repository", 500]],
  ["Byte-for-byte evidence URL", ["evidence", 500]]
]);

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function httpsUrl(value, field) {
  let url;
  try { url = new URL(value); } catch { throw new Error(field + " must be an HTTPS URL."); }
  requireValue(url.protocol === "https:" && !url.username && !url.password && !/\s/.test(value),
    field + " must be an HTTPS URL without credentials.");
  return url;
}

function normalize(value) {
  return value.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
}

function repositoryKey(value) {
  const url = new URL(value);
  const cleanPath = url.pathname.replace(/\/+$/, "").replace(/\.git$/i, "");
  return url.host + (url.hostname === "github.com" ? cleanPath.toLowerCase() : cleanPath);
}

export function projectFromIssue(issue, catalog) {
  requireValue(Number.isSafeInteger(issue.number) && issue.number > 0, "Invalid issue number.");
  requireValue(typeof issue.body === "string" && issue.body.length <= 6000, "Invalid issue body.");
  const paragraphs = issue.body.replace(/\r\n/g, "\n").trim().split(/^### /m);
  requireValue(paragraphs.shift() === "" && paragraphs.length === fields.size, "Use the Add a project issue form.");
  const values = {};
  for (const paragraph of paragraphs) {
    const end = paragraph.indexOf("\n");
    const field = paragraph.slice(0, end);
    const mapping = fields.get(field);
    requireValue(mapping && !Object.hasOwn(values, mapping[0]), "Unknown or duplicate form field.");
    const [key, max] = mapping;
    const value = paragraph.slice(end + 1).trim();
    requireValue(value && value !== "_No response_" && value.length <= max && !/[\p{Cc}\u2028\u2029]/u.test(value),
      "Missing, too long, or multiline field: " + field);
    values[key] = value.normalize("NFC");
  }
  requireValue(values.kind === "Game" || values.kind === "Software", "Select Game or Software.");
  const repo = httpsUrl(values.repository, "Project repository");
  requireValue(repo.pathname !== "/" && !repo.search && !repo.hash, "Use the project repository URL without a query or fragment.");
  httpsUrl(values.evidence, "Byte-for-byte evidence");
  const added = new Date(issue.updated_at);
  requireValue(Number.isFinite(+added), "Invalid acceptance date.");
  const knownPlatform = catalog.find((item) => normalize(item.platform) === normalize(values.platform));
  return {
    id: "proposal-" + issue.number,
    ...values,
    platform: knownPlatform?.platform ?? values.platform,
    kind: values.kind.toLowerCase(),
    match: "byte",
    added: added.toISOString().slice(0, 10)
  };
}

export function assertUnique(project, catalog) {
  const ownRepository = repositoryKey(project.repository);
  const ownTarget = normalize(project.target);
  requireValue(!catalog.some((item) => item.id === project.id ||
    (repositoryKey(item.repository) === ownRepository && normalize(item.target) === ownTarget)),
    "Duplicate project: this repository and target already appear in the catalog or a pending proposal.");
}

async function main() {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
  requireValue(event.action === "labeled" && event.label?.name === "accepted" && event.sender?.login === owner,
    "Only the repository owner can accept a project.");
  const token = process.env.GITHUB_TOKEN;
  requireValue(token, "Missing Actions token.");
  const base = event.repository.default_branch;
  const endpoint = process.env.GITHUB_API_URL + "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo);
  async function api(path, method = "GET", data, allowMissing = false) {
    const response = await fetch(endpoint + path, {
      method,
      headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json",
        "Content-Type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data)
    });
    if (allowMissing && response.status === 404) return null;
    requireValue(response.ok, method + " " + path + " failed (" + response.status + "). " +
      ((await response.clone().json().catch(() => null))?.message ?? ""));
    return response.json();
  }
  const number = event.issue.number;
  requireValue(Number.isSafeInteger(number) && number > 0, "Invalid issue number.");
  const current = await api("/issues/" + number);
  if (current.state !== "open" || current.pull_request || !current.labels.some(({ name }) => name === "accepted")) {
    console.log("Issue is no longer an accepted, open proposal.");
    return;
  }
  requireValue(current.body === event.issue.body, "The issue changed after acceptance. Review it and apply accepted again.");
  const branch = branchPrefix + number;
  const previous = await api("/pulls?" + new URLSearchParams({ state: "all", head: owner + ":" + branch }));
  if (previous.length) {
    console.log("A pull request already exists: " + previous[0].html_url);
    return;
  }

  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  const project = projectFromIssue(event.issue, catalog);
  assertUnique(project, catalog);

  for (let page = 1; ; page++) {
    const pulls = await api("/pulls?" + new URLSearchParams({ state: "open", base, per_page: "100", page }));
    for (const pull of pulls) {
      if (pull.head.repo?.full_name !== owner + "/" + repo || !pull.head.ref.startsWith(branchPrefix)) continue;
      const incomingId = "proposal-" + pull.head.ref.slice(branchPrefix.length);
      const file = await api("/contents/" + catalogPath + "?ref=" + encodeURIComponent(pull.head.sha));
      const inside = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
      assertUnique(project, inside.filter((item) => item.id === incomingId));
    }
    if (pulls.length < 100) break;
  }

  const next = Buffer.from(JSON.stringify([...catalog, project], null, 2) + "\n");
  await writeFile(catalogPath, next);
  execFileSync(process.execPath, ["build.mjs"], { stdio: "inherit" });

  const branchPath = "/git/ref/heads/" + branch;
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const remoteBranch = await api(branchPath, "GET", undefined, true);
  if (!remoteBranch) await api("/git/refs", "POST", { ref: "refs/heads/" + branch, sha: baseSha });

  const prior = await api("/contents/" + catalogPath + "?ref=" + encodeURIComponent(branch));
  if (!Buffer.from(prior.content, "base64").equals(next)) {
    // A retry can complete a branch that was created before the script reached the commit.
    requireValue(!remoteBranch || remoteBranch.object.sha === baseSha, "The proposal branch already has different changes.");
    await api("/contents/" + catalogPath, "PUT", {
      message: "Add catalog project from issue #" + number,
      content: next.toString("base64"),
      sha: prior.sha,
      branch
    });
  }
  const pr = await api("/pulls", "POST", {
    title: "Add catalog project from issue #" + number,
    head: branch,
    base,
    body: "Adds the accepted project to the catalog.\n\nCloses #" + number
  });
  console.log("Created " + pr.html_url);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
