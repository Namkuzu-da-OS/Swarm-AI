#!/usr/bin/env node
// Reconcile the hub: read every task and command from GitHub, fold them into state,
// then project that state back (labels, open/closed, the bot's state comment,
// acknowledgements) and write the public board.json.
//
//   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo node scripts/reconcile.mjs --out site/board.json [--dry-run]
//
// Idempotent: run it as often as you like; a missed run is caught by the next one.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fold, parseCommand, iso, DEFAULTS, PR_URL } from './lib/fold.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const OUT = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : null;
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;
if (!TOKEN || !REPO) { console.error('GITHUB_TOKEN and GITHUB_REPOSITORY are required'); process.exit(2); }
const [OWNER, NAME] = REPO.split('/');

let config = {};
try { config = JSON.parse(readFileSync(join(ROOT, 'swarm.config.json'), 'utf8')); } catch { /* defaults */ }
const cfg = { ...DEFAULTS, ...config };

const STATUS_LABELS = {
  proposed: ['swarm:proposed', 'c9d6df', 'Waiting for a maintainer to approve'],
  open: ['swarm:open', 'f4a261', 'Open: any agent can claim it'],
  claimed: ['swarm:claimed', 'e8b87d', 'An agent is working on it'],
  review: ['swarm:review', 'ef8354', 'Submitted; waiting for human review'],
  done: ['swarm:done', '2ea44f', 'Shipped'],
  blocked: ['swarm:blocked', '7a8a9a', 'Blocked'],
  closed: ['swarm:closed', '243352', 'Closed without shipping'],
};

async function gh(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(init.headers || {}) },
  });
  if (!res.ok && res.status !== 404 && res.status !== 422) throw new Error(`${init.method || 'GET'} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

async function gql(query, variables = {}) {
  const res = await gh('/graphql', { method: 'POST', body: JSON.stringify({ query, variables }) });
  if (res?.errors?.length && !res.data) throw new Error(JSON.stringify(res.errors));
  return res.data;
}

const COMMENT_FIELDS = `id databaseId body createdAt authorAssociation
  author { __typename login ... on User { createdAt } }
  reactionGroups { content viewerHasReacted }`;

async function loadTasks() {
  const tasks = [];
  let after = null;
  do {
    const d = await gql(`query($o:String!,$n:String!,$a:String){ repository(owner:$o,name:$n){ issues(first:50, after:$a, labels:["swarm:task"], orderBy:{field:CREATED_AT,direction:ASC}){
      pageInfo{ hasNextPage endCursor }
      nodes{ id number title body url state stateReason createdAt closedAt authorAssociation author{ login }
        labels(first:30){ nodes{ name } }
        timelineItems(itemTypes:[CLOSED_EVENT], last:1){ nodes{ ... on ClosedEvent { actor { __typename login } } } }
        comments(first:100){ pageInfo{ hasNextPage endCursor } nodes{ ${COMMENT_FIELDS} } } } } } }`, { o: OWNER, n: NAME, a: after });
    const page = d.repository.issues;
    for (const i of page.nodes) {
      const comments = [...i.comments.nodes];
      let cAfter = i.comments.pageInfo.hasNextPage ? i.comments.pageInfo.endCursor : null;
      while (cAfter) {
        const more = await gql(`query($id:ID!,$a:String){ node(id:$id){ ... on Issue { comments(first:100, after:$a){ pageInfo{ hasNextPage endCursor } nodes{ ${COMMENT_FIELDS} } } } } }`, { id: i.id, a: cAfter });
        comments.push(...more.node.comments.nodes);
        cAfter = more.node.comments.pageInfo.hasNextPage ? more.node.comments.pageInfo.endCursor : null;
      }
      const closer = i.timelineItems.nodes[0]?.actor;
      tasks.push({
        ...i,
        labels: i.labels.nodes.map((l) => l.name),
        closedByBot: closer?.__typename === 'Bot',
        closedBy: closer?.login || null,
        comments: comments.map((c) => ({
          id: String(c.databaseId), nodeId: c.id, body: c.body, createdAt: c.createdAt, authorAssociation: c.authorAssociation,
          author: { login: c.author?.login, type: c.author?.__typename === 'Bot' ? 'Bot' : 'User', createdAt: c.author?.createdAt },
          reacted: c.reactionGroups.some((g) => g.viewerHasReacted && (g.content === 'ROCKET' || g.content === 'CONFUSED')),
        })),
      });
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  // A command is handled once a bot ack names it (re=<id>), whichever token posted it.
  for (const t of tasks) {
    const acked = new Set(t.comments.filter((c) => c.author.type === 'Bot').flatMap((c) => [...c.body.matchAll(/\bre=(\d+)/g)].map((m) => m[1])));
    for (const c of t.comments) c.handled = c.reacted || acked.has(c.id);
  }
  return tasks;
}

// Look up every PR anyone has /submitted, so the fold can verify and track it.
async function loadPRs(tasks) {
  const urls = new Set();
  for (const t of tasks) for (const c of t.comments) {
    if (c.author.type === 'Bot') continue;
    const p = parseCommand(c.body);
    const m = p?.cmd === 'submit' && p.text.split(/\s+/)[0].match(PR_URL);
    if (m) urls.add(m[0].replace(/\/$/, ''));
  }
  const list = [...urls];
  const prs = {};
  for (let i = 0; i < list.length; i += 40) {
    const chunk = list.slice(i, i + 40);
    const q = chunk.map((u, k) => `p${k}: resource(url:${JSON.stringify(u)}){ ... on PullRequest { url author{login} merged mergedAt mergedBy{login} closed closedAt baseRepository{ nameWithOwner } headRefOid } }`).join('\n');
    // A failed lookup aborts the run: acking INVALID_PR on a transient error would be permanent.
    const d = await gql(`query{ ${q} }`);
    chunk.forEach((u, k) => {
      const r = d?.[`p${k}`];
      if (r?.url) prs[u] = { repo: r.baseRepository?.nameWithOwner, author: r.author?.login, merged: r.merged, mergedAt: r.mergedAt, mergedBy: r.mergedBy?.login, closed: r.closed, closedAt: r.closedAt, head: r.headRefOid };
    });
  }
  return prs;
}

function stateJSON(st) {
  return {
    status: st.status,
    claimant: st.claim?.login || null,
    agent: st.claim?.agent || null,
    machine: st.claim?.machine || null,
    heartbeat: st.claim ? iso(st.claim.heartbeat) : null,
    lapsesAt: st.status === 'claimed' && st.claim ? iso(Math.min(st.claim.heartbeat + cfg.ttlHours * 3600e3, st.claim.since + cfg.maxLeaseHours * 3600e3)) : null,
    pr: st.pr, credit: st.credit, approvedBy: st.approvedBy, doneAt: st.doneAt ? iso(st.doneAt) : null, note: st.note,
  };
}

function stateComment(st) {
  const j = stateJSON(st);
  const who = j.claimant ? ` · @${j.claimant}${j.agent ? ` (${j.agent}${j.machine ? ' on ' + j.machine : ''})` : ''} · lapses ${j.lapsesAt}` : '';
  const pr = j.pr ? ` · [PR](${j.pr})` : '';
  const credit = st.status === 'done' && j.credit ? ` · built by @${j.credit.login}${j.approvedBy ? `, approved by @${j.approvedBy}` : ''}` : '';
  const hist = st.log.slice(-15).map((l) => `- ${iso(l.t)} ${l.what.replace(/[<>]/g, '')}`).join('\n');
  return `<!-- swarm:state -->\n**Swarm** · status: \`${st.status}\`${who}${pr}${credit}\n\n<details><summary>History</summary>\n\n${hist || '- (nothing yet)'}\n\n</details>\n\n<!-- swarm:json ${JSON.stringify(j).replace(/--/g, '- -')} -->`;
}

const HELP = {
  CLAIM: 'Claimed. Post `/progress <note>` at least every %TTL%h (the claim ends after %MAX%h in total), then `/submit <PR url>`.',
  SUBMIT: 'Submitted. A maintainer reviews the PR; merging it ships the task.',
};

async function project(tasks, out) {
  const byNum = new Map(tasks.map((t) => [t.number, t]));
  for (const [name, color, description] of Object.values(STATUS_LABELS)) {
    await gh(`/repos/${REPO}/labels`, { method: 'POST', body: JSON.stringify({ name, color, description }) }); // 422 if it exists
  }
  for (const st of out.tasks) {
    const issue = byNum.get(st.number);
    const want = STATUS_LABELS[st.status][0];
    const stale = issue.labels.filter((l) => l.startsWith('swarm:') && l !== 'swarm:task' && l !== want);
    for (const l of stale) await gh(`/repos/${REPO}/issues/${st.number}/labels/${encodeURIComponent(l)}`, { method: 'DELETE' });
    if (!issue.labels.includes(want)) await gh(`/repos/${REPO}/issues/${st.number}/labels`, { method: 'POST', body: JSON.stringify({ labels: [want] }) });

    const shouldClose = st.status === 'done' || st.status === 'closed';
    if (shouldClose && issue.state === 'OPEN') {
      await gh(`/repos/${REPO}/issues/${st.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed', state_reason: st.status === 'done' ? 'completed' : 'not_planned' }) });
    } else if (!shouldClose && issue.state === 'CLOSED') {
      await gh(`/repos/${REPO}/issues/${st.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'open' }) });
    }

    const body = stateComment(st);
    const mine = issue.comments.find((c) => c.author.type === 'Bot' && c.body.startsWith('<!-- swarm:state -->'));
    if (!mine) await gh(`/repos/${REPO}/issues/${st.number}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
    else if (mine.body.trim() !== body.trim()) await gh(`/repos/${REPO}/issues/comments/${mine.id}`, { method: 'PATCH', body: JSON.stringify({ body }) });
  }

  // Acknowledge each command exactly once: a reaction marks it handled.
  const comments = new Map(tasks.flatMap((t) => t.comments.map((c) => [c.id, c])));
  for (const r of out.results) {
    const c = comments.get(r.id);
    if (!c || c.handled) continue;
    const quiet = r.ok && (r.cmd === 'progress');
    if (!quiet) {
      const tag = `${r.ok ? 'SWARM_OK' : 'SWARM_ERR'} ${r.code} task=${r.task} by=@${r.login} re=${r.id}`;
      const help = (HELP[r.code] || '').replace('%TTL%', cfg.ttlHours).replace('%MAX%', cfg.maxLeaseHours);
      const text = r.ok ? `${r.message[0].toUpperCase()}${r.message.slice(1)}.${help ? ' ' + help : ''}` : r.message;
      await gh(`/repos/${REPO}/issues/${r.task}/comments`, { method: 'POST', body: JSON.stringify({ body: `\`${tag}\`\n\n${text.replace(/@(\w)/g, '@​$1')}` }) });
    }
    await gh(`/repos/${REPO}/issues/comments/${r.id}/reactions`, { method: 'POST', body: JSON.stringify({ content: r.ok ? 'rocket' : 'confused' }) });
  }
}

function board(out) {
  const pick = (st) => ({
    number: st.number, title: st.title, url: st.url, project: st.project, priority: st.priority, size: st.size,
    status: st.status, depends: st.depends, createdAt: st.createdAt, ...stateJSON(st), attempts: st.attempts,
    what: st.what.slice(0, 280),
  });
  const visible = out.tasks.filter((t) => t.status !== 'closed');
  const shipped = visible.filter((t) => t.status === 'done').sort((a, b) => b.doneAt - a.doneAt);
  const counts = {};
  for (const t of shipped) if (t.credit) counts[t.credit.login] = (counts[t.credit.login] || 0) + 1;
  return {
    generatedAt: iso(Date.now()),
    hub: REPO,
    protocol: 1,
    stats: {
      open: visible.filter((t) => t.status === 'open').length,
      working: visible.filter((t) => t.status === 'claimed').length,
      review: visible.filter((t) => t.status === 'review').length,
      shipped: shipped.length,
      builders: Object.keys(counts).length,
    },
    tasks: visible.filter((t) => t.status !== 'done').sort((a, b) => a.priority - b.priority || a.number - b.number).map(pick),
    agents: visible.filter((t) => t.status === 'claimed').map((t) => ({ login: t.claim.login, agent: t.claim.agent, machine: t.claim.machine, task: t.number, heartbeat: iso(t.claim.heartbeat) })),
    shipped: shipped.slice(0, 100).map(pick),
    leaderboard: Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([login, n]) => ({ login, shipped: n })),
  };
}

const tasks = await loadTasks();
const prs = await loadPRs(tasks);
const out = fold(tasks, { config: cfg, prs });
console.log(`${tasks.length} tasks · ${out.results.filter((r) => !tasks.flatMap((t) => t.comments).find((c) => c.id === r.id)?.handled).length} new commands`);
for (const t of out.tasks) console.log(`#${t.number} ${t.status.padEnd(8)} ${t.claim ? '@' + t.claim.login : ''} ${t.title}`);
if (!DRY) await project(tasks, out);
if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(board(out), null, 2));
  console.log(`wrote ${OUT}`);
}
