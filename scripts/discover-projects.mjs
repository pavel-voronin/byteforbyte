import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const windowDays = 60;
const now = new Date();
const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
const githubQueries = [
  '"byte-for-byte" "reconstructed source" in:readme',
  '"byte-identical" "matching decompilation" in:readme',
  '"byte-for-byte" "retail executable" in:readme',
  '"byte-for-byte" reconstruction in:name,description',
  '"bit-identical" rebuild dos in:readme',
  '"byte-perfect" reconstruction dos in:readme',
  '"matching decompilation" dos in:description',
  "topic:matching-decompilation"
];
const exactTerms = /\b(?:byte[- ](?:for[- ]byte|identical|exact|matching)|bit[- ]identical|exact rebuild)\b/i;
const forumTerms = /\b(?:decompil\w*|reconstruc\w*|reverse.engineer\w*|source code)\b/i;
const targetTerms = /\b(?:decompil\w*|DOS|game|ROM|retail executable)\b/i;

async function request(endpoint, params, headers = {}) {
  const url = new URL(endpoint);
  if (params) url.search = new URLSearchParams(params);
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
      if (response.ok) return response;
      if (attempt || (response.status < 500 && response.status !== 429)) {
        throw new Error(`HTTP ${response.status}`);
      }
      await response.body.cancel();
    } catch (error) {
      if (attempt || error.message.startsWith("HTTP ")) throw error;
    }
    await delay(2000);
  }
}

async function github(term) {
  const token = process.env.GITHUB_TOKEN;
  const headers = { Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = "Bearer " + token;
  const q = `${term} pushed:>=${since.slice(0, 10)} is:public archived:false fork:false`;
  const results = [];
  for (let page = 1; page <= 10; page++) {
    const data = await (await request("https://api.github.com/search/repositories",
      { q, sort: "updated", per_page: 100, page }, headers)).json();
    if (data.incomplete_results || data.total_count > 1000 || !Array.isArray(data.items)) {
      throw new Error("Search incomplete. Narrow this query or retry.");
    }
    results.push(...data.items.map((item) => ({
      url: item.html_url, title: item.full_name, description: item.description, date: item.pushed_at,
      evidence: item.html_url + "#readme", source: "GitHub", signal: term
    })));
    if (page * 100 >= data.total_count) return results;
  }
  return results;
}

async function gitlab(term) {
  const results = [];
  for (let page = 1; ; page++) {
    const response = await request("https://gitlab.com/api/v4/projects", {
      search: term, last_activity_after: since.replace(/\.\d+Z$/, "Z"),
      visibility: "public", archived: "false", per_page: 100, page
    });
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error("Unexpected project list");
    results.push(...data.map((item) => ({
      url: item.web_url, title: item.path_with_namespace, description: item.description, date: item.last_activity_at,
      evidence: item.readme_url, source: "GitLab", signal: term
    })));
    if (!response.headers.get("x-next-page") && data.length < 100) return results;
  }
}

async function byteMatch() {
  const results = [];
  for (let page = 1; ; page++) {
    const response = await request("https://bytematch.dev/api/v1/projects", { per_page: 500, page });
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error("Unexpected project list");
    for (const item of data) {
      const percent = item.measures?.matched_code_percent;
      if (typeof percent !== "number" || percent < 95) continue;
      results.push({
        url: `https://github.com/${item.owner}/${item.repo}`, title: item.name, date: item.timestamp,
        evidence: item.url, source: "ByteMatch", signal: `${percent}% matched code (${item.version})`
      });
    }
    if (page >= Number(response.headers.get("x-total-pages") || 1)) return results;
  }
}

async function goldBox() {
  const response = await request("https://forums.goldbox.games/index.php?action=.xml;board=28;type=rss2;limit=20");
  const feed = await response.text();
  if (!/<rss\b/.test(feed)) throw new Error("Unexpected RSS response");
  return Array.from(feed.matchAll(/<item>([\s\S]*?)<\/item>/g), ([, item]) => ({
    url: item.match(/<link>([^<]+)<\/link>/)?.[1].replaceAll("&amp;", "&"),
    title: item.match(/<title>([^<]+)<\/title>/)?.[1], date: item.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1],
    source: "Gold Box forums", signal: "Forum post"
  })).filter((item) => item.url && forumTerms.test(item.title ?? ""));
}

function key(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return "";
    if (url.hostname === "forums.goldbox.games") return url.origin + url.pathname + url.search;
    return url.host + url.pathname.replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
  } catch {
    return "";
  }
}

const markdown = (value) => String(value ?? "").replace(/[\r\n]+/g, " ")
  .replace(/[\\`*_{}\[\]<>|]/g, "\\$&");
const safeLink = (value) => key(value) ? encodeURI(value).replaceAll("(", "%28").replaceAll(")", "%29") : null;
const catalog = JSON.parse(await readFile(new URL("../data/catalog.json", import.meta.url), "utf8"));
const known = new Set(catalog.map(({ repository }) => key(repository)));
const searches = [
  ...githubQueries.map((query) => [`GitHub · ${query}`, () => github(query)]),
  ...["matching decompilation", "byte-for-byte", "byte-identical"].map((query) =>
    [`GitLab · ${query}`, () => gitlab(query)]),
  ["ByteMatch", byteMatch],
  ["Gold Box forums", goldBox]
];
const results = await Promise.allSettled(searches.map(([, search]) => search()));
const candidates = new Map();
const sources = results.map((result, index) => {
  const name = searches[index][0];
  if (result.status === "rejected") return { name, error: result.reason.message };
  for (const item of result.value) {
    const id = key(item.url);
    if (!id || known.has(id)) continue;
    const candidate = candidates.get(id) ?? { ...item, signals: [] };
    const signal = { source: item.source, match: item.signal, evidence: item.evidence };
    candidate.signals.push(signal);
    if (item.description) candidate.description = item.description;
    candidates.set(id, candidate);
  }
  return { name, count: result.value.length };
});
const rank = (item) => Number(exactTerms.test(item.description ?? "") && targetTerms.test(item.description ?? "")) * 2
  + Number(item.signals.some(({ source }) => source === "ByteMatch"))
  + new Set(item.signals.map(({ source }) => source)).size;
const ordered = [...candidates.values()].sort((a, b) =>
  rank(b) - rank(a) || (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0) || a.url.localeCompare(b.url));

const failures = sources.filter(({ error }) => error);
const summary = [
  "# Catalog discovery",
  "",
  `${ordered.length} candidates outside the catalog. GitHub and GitLab search window: ${since.slice(0, 10)} onwards.`,
  "A search hit or a code-match percentage does not establish that the full binary matches.",
  "",
  ...ordered.slice(0, 25).map((item) => {
    const links = [...new Map(item.signals.filter(({ evidence }) => safeLink(evidence))
      .map(({ source, evidence }) => [source, `[${source}](${safeLink(evidence)})`])).values()];
    const progress = item.signals.find(({ source }) => source === "ByteMatch");
    return `- [${markdown(item.title ?? item.url)}](${safeLink(item.url)})` +
      (item.description ? ` — ${markdown(item.description)}` : "") +
      (progress ? ` — ${markdown(progress.match)}` : "") +
      (links.length ? ` (${links.join(", ")})` : "");
  }),
  "",
  ...sources.map(({ name, count, error }) => `- ${markdown(name)} — ${error ? `FAILED (${markdown(error)})` : `${count} found`}`),
  ""
].join("\n");

const output = process.argv[2] ?? "discovery";
await mkdir(output, { recursive: true });
await writeFile(join(output, "candidates.json"), JSON.stringify({ checkedAt: now, since, sources, candidates: ordered }, null, 2) + "\n");
await writeFile(join(output, "report.md"), summary);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(summary);
if (failures.length) process.exitCode = 1;
