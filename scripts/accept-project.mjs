import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const catalogPath = "data/catalog.json";
const screenshotDirectory = "assets/screenshots";
const branchPrefix = "catalog/issue-";
const paulArgentId = 98917699;
const technologyField = "Technology stack";
const releaseYearField = "Original release year";
const screenshotField = "Screenshot";
const attachmentHosts = new Set(["user-images.githubusercontent.com", "private-user-images.githubusercontent.com"]);
const attachmentRedirectHosts = new Set([
  ...attachmentHosts,
  "objects.githubusercontent.com",
  "github-production-user-asset-6210df.s3.amazonaws.com",
  "github-production-repository-file-5c1aeb.s3.amazonaws.com"
]);
const fieldAliases = new Map([
  ["Restoration team", "Restorer"],
  ["Restoration team URL", "Restorer URL"],
  ["Exact original release and verified files", "What matches the original?"]
]);
const optionalUrlFields = new Map([
  ["Restorer URL", "creditUrl"],
  ["Playable version URL", "playUrl"]
]);
const fields = new Map([
  ["Project name", ["title", 150]],
  ["Original platform", ["platform", 40]],
  ["Type", ["kind", 12]],
  ["Restorer", ["credit", 120]],
  ["What matches the original?", ["target", 240]],
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

function githubAttachment(url) {
  return attachmentHosts.has(url.hostname) || (url.hostname === "github.com" &&
    /^\/(?:user-attachments\/(?:assets|files)|[^/]+\/[^/]+\/(?:assets|files))\//.test(url.pathname));
}

async function downloadScreenshot(value) {
  let url = httpsUrl(value, screenshotField);
  const signal = AbortSignal.timeout(30_000);
  const limit = 10 * 1024 * 1024;
  for (let redirects = 0; redirects <= 4; redirects++) {
    requireValue(!url.port && (githubAttachment(url) || (redirects > 0 && attachmentRedirectHosts.has(url.hostname))),
      "Use an image uploaded through the Screenshot field.");
    const response = await fetch(url, { redirect: "manual", signal });
    const redirect = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && redirect) {
      await response.body?.cancel();
      url = httpsUrl(new URL(redirect, url).href, screenshotField);
      continue;
    }
    requireValue(response.ok && response.body, "Screenshot download failed (" + response.status + ").");
    requireValue(Number(response.headers.get("content-length")) <= limit, "Screenshot exceeds GitHub’s 10 MiB image limit.");
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      requireValue(bytes <= limit, "Screenshot exceeds GitHub’s 10 MiB image limit.");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, bytes);
  }
  throw new Error("Too many redirects while downloading the screenshot.");
}

async function prepareScreenshot(project, url, checkout) {
  const input = await downloadScreenshot(url);
  const file = project.id + ".webp";
  const path = screenshotDirectory + "/" + file;
  await mkdir(join(checkout, screenshotDirectory), { recursive: true });
  const python = process.platform === "win32" ? "py" : "/usr/bin/python3";
  const encoderEnv = { ...process.env };
  delete encoderEnv.GITHUB_TOKEN;
  const output = execFileSync(python, ["scripts/prepare-screenshot.py", path], {
    cwd: checkout, input, encoding: "utf8", timeout: 30_000, env: encoderEnv
  });
  project.screenshot = { file, ...JSON.parse(output) };
  return { path, data: await readFile(join(checkout, path)) };
}

function git(args, options = {}) {
  return execFileSync("git", args, { encoding: "utf8", ...options }).trim();
}

async function validateProject(baseSha, issue, checkPending) {
  const temporary = await mkdtemp(join(tmpdir(), "catalog-accept-"));
  const checkout = join(temporary, "checkout");
  let checkedOut = false;
  try {
    git(["worktree", "add", "--detach", checkout, baseSha]);
    checkedOut = true;
    const path = join(checkout, catalogPath);
    const catalog = JSON.parse(await readFile(path, "utf8"));
    const { screenshotUrl, ...project } = projectFromIssue(issue, catalog);
    assertUnique(project, catalog);
    await checkPending(project);
    const screenshot = screenshotUrl ? await prepareScreenshot(project, screenshotUrl, checkout) : null;
    const content = JSON.stringify([...catalog, project], null, 2) + "\n";
    await writeFile(path, content);
    execFileSync(process.execPath, ["build.mjs"], { cwd: checkout, stdio: "inherit" });
    return { content, project, screenshot };
  } finally {
    if (checkedOut) git(["worktree", "remove", "--force", checkout]);
    await rmdir(temporary);
  }
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
  requireValue(paragraphs.shift() === "", "Use the Add a project issue form.");
  const values = {};
  const optionalUrls = {};
  let technologies;
  let releaseYear;
  let screenshotUrl;
  for (const paragraph of paragraphs) {
    const end = paragraph.indexOf("\n");
    const label = paragraph.slice(0, end);
    const field = fieldAliases.get(label) ?? label;
    const value = paragraph.slice(end + 1).trim();
    if (field === screenshotField) {
      requireValue(screenshotUrl === undefined, "Include the screenshot field only once.");
      if (!value || value === "_No response_") {
        screenshotUrl = null;
      } else {
        const urls = value.match(/https:\/\/[^\s<>"')\]]+/gi) ?? [];
        requireValue(urls.length === 1, "Attach one screenshot.");
        screenshotUrl = httpsUrl(urls[0], screenshotField).href;
      }
      continue;
    }
    const optionalUrl = optionalUrlFields.get(field);
    if (optionalUrl) {
      requireValue(!Object.hasOwn(optionalUrls, optionalUrl) && value.length <= 500, "Duplicate or too long field: " + field);
      optionalUrls[optionalUrl] = !value || value === "_No response_" ? null : httpsUrl(value, field).href;
      continue;
    }
    if (field === releaseYearField) {
      const blank = !value || value === "_No response_";
      requireValue(releaseYear === undefined && (blank || /^[1-9][0-9]{3}$/.test(value)),
        "Enter the original release year once as four digits.");
      releaseYear = blank ? null : Number(value);
      continue;
    }
    if (field === technologyField) {
      requireValue(technologies === undefined && value.length <= 240 && !/[\p{Cc}\u2028\u2029]/u.test(value),
        "Duplicate, too long, or multiline field: " + technologyField);
      technologies = value && value !== "_No response_" ? value.normalize("NFC").split(",").map((name) => name.trim()) : [];
      requireValue(technologies.every(Boolean), "List technology names separated by commas.");
      continue;
    }
    const mapping = fields.get(field);
    requireValue(mapping && !Object.hasOwn(values, mapping[0]), "Unknown or duplicate form field.");
    const [key, max] = mapping;
    requireValue(value && value !== "_No response_" && value.length <= max && !/[\p{Cc}\u2028\u2029]/u.test(value),
      "Missing, too long, or multiline field: " + field);
    values[key] = value.normalize("NFC");
  }
  requireValue(Object.keys(values).length === fields.size, "Use the Add a project issue form.");
  requireValue(values.kind === "Game" || values.kind === "Software", "Select Game or Software.");
  const repo = httpsUrl(values.repository, "Project repository");
  requireValue(repo.pathname !== "/" && !repo.search && !repo.hash, "Use the project repository URL without a query or fragment.");
  httpsUrl(values.evidence, "Byte-for-byte evidence");
  const added = new Date(issue.updated_at);
  requireValue(Number.isFinite(+added), "Invalid acceptance date.");
  const knownPlatform = catalog.find((item) => normalize(item.platform) === normalize(values.platform));
  const names = new Map(catalog.flatMap((item) => item.technologies ?? []).map((name) => [normalize(name), name]));
  const stack = new Set();
  for (const name of technologies ?? []) {
    const key = normalize(name);
    if (!names.has(key)) names.set(key, name);
    stack.add(names.get(key));
  }
  return {
    id: "proposal-" + issue.number,
    ...values,
    ...Object.fromEntries(Object.entries(optionalUrls).filter(([, value]) => value !== null)),
    ...(screenshotUrl ? { screenshotUrl } : {}),
    platform: knownPlatform?.platform ?? values.platform,
    kind: values.kind.toLowerCase(),
    ...(stack.size ? { technologies: [...stack] } : {}),
    ...(releaseYear ? { releaseYear } : {}),
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
  const canAccept = event.sender?.login === owner || event.sender?.id === paulArgentId;
  requireValue(event.action === "labeled" && event.label?.name === "accepted" && canAccept,
    "Only the repository owner and PaulArgent can accept a project.");
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
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw Object.assign(new Error(method + " " + path + " failed (" + response.status + "). " + (error?.message ?? "")),
        { status: response.status });
    }
    return response.status === 204 ? null : response.json();
  }
  async function publish() {
    const run = await api("/actions/workflows/catalog.yml/dispatches", "POST", { ref: base });
    console.log("Started catalog publication for " + base + (run?.html_url ? ": " + run.html_url : "."));
  }

  const number = event.issue.number;
  requireValue(Number.isSafeInteger(number) && number > 0, "Invalid issue number.");
  const branch = branchPrefix + number;
  const previous = await api("/pulls?" + new URLSearchParams({ state: "all", head: owner + ":" + branch, base }));
  let pr = previous.find((pull) => pull.user?.login === "github-actions[bot]" &&
    pull.head.ref === branch && pull.head.repo?.full_name === owner + "/" + repo);
  requireValue(pr || previous.length === 0, "The proposal branch is already used by another pull request.");

  async function readCatalog(sha) {
    const file = await api("/contents/" + catalogPath + "?ref=" + encodeURIComponent(sha));
    return JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
  }
  async function checkPending(project) {
    for (let page = 1; ; page++) {
      const pulls = await api("/pulls?" + new URLSearchParams({ state: "open", base, per_page: "100", page }));
      for (const pull of pulls) {
        if (pull.head.repo?.full_name !== owner + "/" + repo || !pull.head.ref.startsWith(branchPrefix) ||
            pull.head.ref === branch) continue;
        const incomingId = "proposal-" + pull.head.ref.slice(branchPrefix.length);
        const inside = await readCatalog(pull.head.sha);
        assertUnique(project, inside.filter((item) => item.id === incomingId));
      }
      if (pulls.length < 100) break;
    }
  }

  const basePath = "/git/ref/heads/" + base;
  const branchPath = "/git/ref/heads/" + branch;
  const attempts = 5;
  let validatedHead;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (pr) {
      pr = await api("/pulls/" + pr.number);
      if (pr.state === "closed") {
        if (pr.merged) await publish();
        else console.log("The catalog pull request was closed: " + pr.html_url);
        return;
      }
      requireValue(pr.base.ref === base && pr.head.ref === branch &&
        pr.head.repo?.full_name === owner + "/" + repo, "The proposal pull request targets a different branch.");
    }
    const current = await api("/issues/" + number);
    if (current.state !== "open" || current.pull_request || !current.labels.some(({ name }) => name === "accepted")) {
      console.log("Issue is no longer an accepted, open proposal.");
      return;
    }
    requireValue(current.body === event.issue.body, "The issue changed after acceptance. Review it and apply accepted again.");

    git(["fetch", "--no-tags", "origin", "refs/heads/" + base]);
    const baseSha = git(["rev-parse", "FETCH_HEAD"]);
    const baseTree = git(["rev-parse", baseSha + "^{tree}"]);
    const { content, project, screenshot } = await validateProject(baseSha, event.issue, checkPending);
    const files = [];
    if (screenshot) {
      const blob = await api("/git/blobs", "POST", { content: screenshot.data.toString("base64"), encoding: "base64" });
      files.push({ path: screenshot.path, mode: "100644", type: "blob", sha: blob.sha });
    }
    const createTree = (tree, catalog) => api("/git/trees", "POST", {
      base_tree: tree,
      tree: [{ path: catalogPath, mode: "100644", type: "blob", content: catalog }, ...files]
    });
    const updated = await createTree(baseTree, content);
    const remoteBranch = await api(branchPath, "GET", undefined, true);
    const oldHead = remoteBranch?.object.sha;
    let prior;
    if (oldHead && oldHead !== baseSha) {
      prior = await api("/git/commits/" + oldHead);
      if (oldHead !== validatedHead && prior.tree.sha !== updated.sha) {
        const oldBase = prior.parents[0]?.sha;
        requireValue(oldBase, "The proposal branch has no base commit.");
        const oldCatalog = await readCatalog(oldBase);
        const { screenshotUrl, ...oldProject } = projectFromIssue(event.issue, oldCatalog);
        if (screenshot) oldProject.screenshot = project.screenshot;
        const parent = await api("/git/commits/" + oldBase);
        const expected = await createTree(parent.tree.sha, JSON.stringify([...oldCatalog, oldProject], null, 2) + "\n");
        requireValue(prior.tree.sha === expected.sha, "The proposal branch contains changes outside the validated submission.");
      }
    }
    if (pr) requireValue(oldHead, "The approved pull request has no proposal branch.");
    let headSha = oldHead;
    if (!prior || prior.parents[0]?.sha !== baseSha || prior.tree.sha !== updated.sha) {
      // Keep the previous proposal head as a parent so ref updates remain fast-forward.
      const parents = prior ? [baseSha, oldHead] : [baseSha];
      const commit = await api("/git/commits", "POST", {
        message: "Add catalog project from issue #" + number, tree: updated.sha, parents
      });
      headSha = commit.sha;
      if (remoteBranch) {
        await api("/git/refs/heads/" + branch, "PATCH", { sha: headSha, force: false });
      } else {
        await api("/git/refs", "POST", { ref: "refs/heads/" + branch, sha: headSha });
      }
    }
    validatedHead = headSha;
    pr ??= await api("/pulls", "POST", {
      title: "Add catalog project from issue #" + number,
      head: branch,
      base,
      body: "Adds the accepted project to the catalog.\n\n"
        + (screenshot ? "Includes the optimized WebP screenshot for the catalog card.\n\n" : "")
        + "Catalog submission: #" + number
    });

    if ((await api(basePath)).object.sha === baseSha) {
      try {
        const merged = await api("/pulls/" + pr.number + "/merge", "PUT", { sha: headSha, merge_method: "squash" });
        requireValue(merged.merged, "GitHub did not merge " + pr.html_url + ". " + (merged.message ?? ""));
      } catch (error) {
        const baseChanged = error.status === 405 || error.status === 409
          ? (await api(basePath)).object.sha !== baseSha
          : false;
        if (!baseChanged && !/base branch (?:was modified|changed)/i.test(error.message)) throw error;
        if (attempt === attempts) throw error;
        console.log("GitHub reported a changed base. Retrying " + pr.html_url);
        await delay(1_000 * 2 ** (attempt - 1));
        continue;
      }
      console.log("Merged " + pr.html_url);
      await publish();
      return;
    }
    requireValue(attempt < attempts, "The base branch kept changing during validation. Review " + pr.html_url);
    console.log("The base branch changed during validation. Retrying " + pr.html_url);
    await delay(1_000 * 2 ** (attempt - 1));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
