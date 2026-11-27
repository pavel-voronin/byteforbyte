import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const catalogPath = "data/catalog.json";
const screenshotDirectory = "assets/screenshots";
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

async function prepareBatch(baseSha, approvals, pending, screenshots) {
  if (!approvals.size) return { numbers: [] };
  const temporary = await mkdtemp(join(tmpdir(), "catalog-accept-"));
  const checkout = join(temporary, "checkout");
  let checkedOut = false;
  try {
    git(["worktree", "add", "--detach", checkout, baseSha]);
    checkedOut = true;
    const path = join(checkout, catalogPath);
    const catalog = JSON.parse(await readFile(path, "utf8"));
    const groups = JSON.parse(await readFile(join(checkout, "data/technologies.json"), "utf8"));
    const { validateCatalog } = await import(pathToFileURL(join(checkout, "scripts/validate-catalog.mjs")));
    const checkScreenshot = ({ screenshot }) => access(join(checkout, screenshotDirectory, screenshot.file));
    await validateCatalog(catalog, groups, checkScreenshot);
    const numbers = [];
    const files = [catalogPath];
    for (const issue of approvals.values()) {
      try {
        const { screenshotUrl, ...project } = projectFromIssue(issue, catalog);
        assertUnique(project, catalog);
        assertUnique(project, pending);
        let screenshot;
        if (screenshotUrl) {
          const key = project.id + "\n" + screenshotUrl;
          screenshot = screenshots.get(key);
          if (screenshot) {
            await mkdir(join(checkout, screenshotDirectory), { recursive: true });
            await writeFile(join(checkout, screenshot.path), screenshot.data);
          } else {
            const result = await prepareScreenshot(project, screenshotUrl, checkout);
            screenshot = { ...result, descriptor: project.screenshot };
            screenshots.set(key, screenshot);
          }
          project.screenshot = screenshot.descriptor;
        }
        await validateCatalog([...catalog, project], groups, checkScreenshot);
        catalog.push(project);
        numbers.push(issue.number);
        if (screenshot) files.push(screenshot.path);
      } catch (error) {
        console.warn("Skipping issue #" + issue.number + ". " + error.message);
      }
    }
    if (!numbers.length) return { numbers };
    await writeFile(path, JSON.stringify(catalog, null, 2) + "\n");
    git(["add", "--", ...files], { cwd: checkout });
    return { numbers, tree: git(["write-tree"], { cwd: checkout }) };
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
  const canAccept = (login, id) => login?.toLowerCase() === owner.toLowerCase() || id === paulArgentId;
  requireValue(event.action === "labeled" && event.label?.name === "accepted" &&
    canAccept(event.sender?.login, event.sender?.id), "Only the repository owner and PaulArgent can accept a project.");
  const token = process.env.GITHUB_TOKEN;
  requireValue(token, "Missing Actions token.");
  const base = event.repository.default_branch;
  const runId = process.env.GITHUB_RUN_ID;
  requireValue(/^[1-9][0-9]*$/.test(runId ?? ""), "Invalid Actions run ID.");
  const branch = "catalog/batch-" + runId;
  const endpoint = process.env.GITHUB_API_URL + "/repos/" + owner + "/" + repo;

  async function request(url, method = "GET", data, allowMissing = false) {
    const response = await fetch(url, {
      method,
      headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json",
        "Content-Type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data)
    });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw Object.assign(new Error(method + " " + url + " failed (" + response.status + "). " + (error?.message ?? "")),
        { status: response.status });
    }
    return response.status === 204 ? null : response.json();
  }
  const api = (path, ...options) => request(endpoint + path, ...options);
  const basePath = "/git/ref/heads/" + base;
  const batchPath = "/git/ref/heads/" + branch;
  const sameRepo = pull => pull.head.repo?.full_name === owner + "/" + repo;
  const previous = await api("/pulls?" + new URLSearchParams({ state: "all", head: owner + ":" + branch, base }));
  let pr = previous.find(pull => sameRepo(pull) && pull.head.ref === branch && pull.user?.login === "github-actions[bot]");
  requireValue(pr || previous.length === 0, "The batch branch is already used by another pull request.");

  async function publish() {
    const run = await api("/actions/workflows/catalog.yml/dispatches", "POST", { ref: base });
    console.log("Started catalog publication for " + base + (run?.html_url ? ": " + run.html_url : "."));
  }
  if (pr?.state === "closed") {
    if (pr.merged_at && pr.merge_commit_sha === (await api(basePath)).object.sha) {
      const runs = await api("/actions/workflows/catalog.yml/runs?" +
        new URLSearchParams({ head_sha: pr.merge_commit_sha, branch: base }));
      if (!runs.workflow_runs.some(run => run.status !== "completed" || run.conclusion === "success")) await publish();
    }
    return;
  }

  async function listAccepted() {
    const numbers = [];
    for (let page = 1; ; page++) {
      const issues = await api("/issues?" + new URLSearchParams({ state: "open", labels: "accepted", per_page: "100", page }));
      numbers.push(...issues.filter(issue => !issue.pull_request).map(issue => issue.number));
      if (issues.length < 100) return [...new Set(numbers)].sort((a, b) => a - b);
    }
  }

  async function collectBatch() {
    // New label events can share a single pending job. The open issues are the queue.
    const { object } = await api(basePath);
    const file = await api("/contents/" + catalogPath + "?ref=" + object.sha);
    const existing = new Set(JSON.parse(Buffer.from(file.content, "base64").toString("utf8")).map(item => item.id));
    const outstanding = async () => (await listAccepted()).filter(number => !existing.has("proposal-" + number));
    let numbers = await outstanding();
    let stableFor = 0;
    for (let elapsed = 0; numbers.length && stableFor < 60 && elapsed < 180; elapsed += 15) {
      await delay(15_000);
      const latest = await outstanding();
      stableFor = latest.join(",") === numbers.join(",") ? stableFor + 15 : 0;
      numbers = latest;
    }
    return numbers;
  }

  async function readTimeline(entries) {
    const selections = entries.map(({ number, cursor }) => {
      requireValue(Number.isSafeInteger(number) && number > 0, "Invalid issue number.");
      return `i${number}: issue(number: ${number}) {
        number body state lastEditedAt
        timelineItems(last: 50, itemTypes: [LABELED_EVENT, UNLABELED_EVENT]${cursor ? ", before: " + JSON.stringify(cursor) : ""}) {
          pageInfo { hasPreviousPage startCursor }
          nodes {
            __typename
            ... on LabeledEvent { label { name } createdAt actor { login ... on User { databaseId } } }
            ... on UnlabeledEvent { label { name } }
          }
        }
      }`;
    });
    const result = await request(process.env.GITHUB_GRAPHQL_URL, "POST", {
      query: `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { ${selections.join("\n")} } }`,
      variables: { owner, repo }
    });
    requireValue(!result.errors?.length && result.data?.repository,
      "GitHub could not read approval history. " + (result.errors?.[0]?.message ?? ""));
    return Object.values(result.data.repository).filter(Boolean);
  }

  async function readApprovals(numbers) {
    const approvals = new Map();
    for (let offset = 0; offset < numbers.length; offset += 15) {
      let entries = numbers.slice(offset, offset + 15).map(number => ({ number }));
      while (entries.length) {
        const issues = await readTimeline(entries);
        entries = [];
        for (const { number, body, state, lastEditedAt, timelineItems } of issues) {
          if (state !== "OPEN") continue;
          const { nodes, pageInfo } = timelineItems;
          const label = nodes.findLast(node => node?.label?.name === "accepted");
          if (!label && pageInfo.hasPreviousPage) {
            entries.push({ number, cursor: pageInfo.startCursor });
            continue;
          }
          if (label?.__typename !== "LabeledEvent" || !canAccept(label.actor?.login, label.actor?.databaseId)) continue;
          if (lastEditedAt && Date.parse(lastEditedAt) >= Date.parse(label.createdAt)) {
            console.warn("Issue #" + number + " was edited at or after acceptance. Review and reapply accepted.");
            continue;
          }
          approvals.set(number, { number, body, updated_at: label.createdAt });
        }
      }
    }
    return approvals;
  }

  async function pendingProjects() {
    const projects = [];
    for (let page = 1; ; page++) {
      const pulls = await api("/pulls?" + new URLSearchParams({ state: "open", base, per_page: "100", page }));
      for (const pull of pulls) {
        if (!sameRepo(pull) || pull.head.ref === branch || pull.user?.login !== "github-actions[bot]") continue;
        const legacy = /^catalog\/issue-([1-9]\d*)$/.exec(pull.head.ref);
        const numbers = legacy ? [legacy[1]] : /^catalog\/batch-[1-9]\d*$/.test(pull.head.ref)
          ? [...(pull.body ?? "").matchAll(/^Catalog submission: #([1-9]\d*)$/gm)].map(match => match[1]) : [];
        if (!numbers.length) continue;
        const ids = new Set(numbers.map(number => "proposal-" + number));
        const file = await api("/contents/" + catalogPath + "?ref=" + encodeURIComponent(pull.head.sha));
        projects.push(...JSON.parse(Buffer.from(file.content, "base64").toString("utf8")).filter(item => ids.has(item.id)));
      }
      if (pulls.length < 100) return projects;
    }
  }

  const numbers = await collectBatch();
  if (!numbers.length) return;
  const pending = await pendingProjects();
  const commitEnv = { ...process.env,
    GIT_AUTHOR_NAME: "github-actions[bot]", GIT_COMMITTER_NAME: "github-actions[bot]",
    GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
    GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com"
  };
  const pushEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http." + process.env.GITHUB_SERVER_URL + "/.extraheader",
    GIT_CONFIG_VALUE_0: "AUTHORIZATION: basic " + Buffer.from("x-access-token:" + token).toString("base64")
  };

  let validatedHead;
  const screenshots = new Map();
  for (let attempt = 1; attempt <= 5; attempt++) {
    git(["fetch", "--no-tags", "origin", "refs/heads/" + base]);
    const baseSha = git(["rev-parse", "FETCH_HEAD"]);
    const currentCatalog = JSON.parse(git(["show", baseSha + ":" + catalogPath]));
    const existing = new Set(currentCatalog.map(item => item.id));
    const remaining = numbers.filter(number => !existing.has("proposal-" + number));
    const approvals = await readApprovals(remaining);
    const batch = await prepareBatch(baseSha, approvals, pending, screenshots);
    if (!batch.numbers.length) {
      if (pr) await api("/pulls/" + pr.number, "PATCH", { state: "closed" });
      console.log("No new accepted submissions to publish.");
      return;
    }

    const oldHead = (await api(batchPath, "GET", undefined, true))?.object.sha;
    requireValue(!pr || oldHead, "The batch pull request has no proposal branch.");
    if (oldHead) {
      git(["fetch", "--no-tags", "origin", "refs/heads/" + branch]);
      requireValue(git(["rev-parse", "FETCH_HEAD"]) === oldHead, "The batch branch changed during validation.");
      requireValue(oldHead === validatedHead || git(["rev-parse", oldHead + "^{tree}"]) === batch.tree,
        "The batch branch contains changes outside the validated submissions.");
    }
    requireValue(!validatedHead || oldHead === validatedHead, "The validated batch branch was modified.");
    let headSha = oldHead;
    if (!oldHead || git(["rev-parse", oldHead + "^{tree}"]) !== batch.tree ||
        git(["rev-parse", oldHead + "^1"]) !== baseSha) {
      const parents = oldHead ? ["-p", baseSha, "-p", oldHead] : ["-p", baseSha];
      headSha = git(["commit-tree", batch.tree, ...parents, "-m", "Add accepted catalog submissions"], { env: commitEnv });
      // Keep the previous proposal head as a parent for fast-forward updates.
      git(["push", "origin", headSha + ":refs/heads/" + branch], { env: pushEnv });
    }
    validatedHead = headSha;
    const body = "Adds the accepted projects to the catalog.\n\n" +
      batch.numbers.map(number => "Catalog submission: #" + number).join("\n");
    if (!pr) {
      pr = await api("/pulls", "POST", { title: "Add accepted catalog submissions", head: branch, base, body });
    } else if (pr.body !== body) {
      pr = await api("/pulls/" + pr.number, "PATCH", { body });
    }

    const reviewed = await readApprovals(batch.numbers);
    const stillApproved = batch.numbers.every(number => {
      const current = reviewed.get(number);
      const original = approvals.get(number);
      return current?.body === original.body && current?.updated_at === original.updated_at;
    });
    if (stillApproved && (await api(basePath)).object.sha === baseSha) {
      try {
        const merged = await api("/pulls/" + pr.number + "/merge", "PUT", { sha: headSha, merge_method: "squash" });
        requireValue(merged.merged, "GitHub did not merge " + pr.html_url + ". " + (merged.message ?? ""));
      } catch (error) {
        const baseChanged = [405, 409].includes(error.status) && (await api(basePath)).object.sha !== baseSha;
        if (!baseChanged && !/base branch (?:was modified|changed)/i.test(error.message)) throw error;
        if (attempt === 5) throw error;
        console.log("The base branch changed. Retrying " + pr.html_url);
        await delay(1_000 * 2 ** (attempt - 1));
        continue;
      }
      console.log("Merged " + pr.html_url + " with " + batch.numbers.length + " submissions.");
      await publish();
      return;
    }
    requireValue(attempt < 5, "The approvals or base branch kept changing. Review " + pr.html_url);
    console.log("The approvals or base branch changed. Retrying " + pr.html_url);
    await delay(1_000 * 2 ** (attempt - 1));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
