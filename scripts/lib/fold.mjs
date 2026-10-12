// The Swarm state machine.
//
// Every task's state is recomputed from scratch on every run by folding all
// commands (issue comments) and PR outcomes, across all tasks, in time order.
// Nothing is stored except the comments themselves, so a missed or cancelled
// workflow run loses nothing: the next run sees the same history and gets the
// same answer. Labels and the bot's state comment are projections of this.

export const STATUSES = ['proposed', 'open', 'claimed', 'review', 'done', 'blocked', 'closed'];

export const DEFAULTS = {
  ttlHours: 3,            // a claim lapses after this long without /claim or /progress
  maxLeaseHours: 8,       // ...and after this long in total, heartbeat or not (one-session tasks)
  maxClaimsPerUser: 2,    // active claims one GitHub account may hold at once
  fleet: {},              // { login: cap } trusted accounts that run many workers (e.g. a team's machines)
  minAccountAgeDays: 7,   // brand-new accounts can't claim (anti-sybil)
  projects: [],           // allowlist of "owner/repo" a task may target ([] = any)
};

const MAINTAINER = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const COMMANDS = new Set(['claim', 'progress', 'release', 'revoke', 'submit', 'done', 'reject', 'approve', 'block', 'reopen']);
const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/;

export function isMaintainer(assoc) {
  return MAINTAINER.has(String(assoc || '').toUpperCase());
}

// "/claim agent=claude-opus-5.5 machine=atlas" -> {cmd, args, text}
export function parseCommand(body) {
  const line = String(body || '').trim().split('\n')[0].trim();
  const m = line.match(/^\/([a-z]+)\b\s*(.*)$/i);
  if (!m) return null;
  let cmd = m[1].toLowerCase();
  if (!COMMANDS.has(cmd)) return null;
  if (cmd === 'revoke') cmd = 'release';
  const rest = m[2].trim();
  const args = {};
  for (const kv of rest.matchAll(/\b([a-z]+)=("[^"]*"|\S+)/gi)) {
    args[kv[1].toLowerCase()] = kv[2].replace(/^"|"$/g, '').slice(0, 80);
  }
  return { cmd, args, text: rest.slice(0, 500) };
}

// Issue-form bodies render as "### Label\n\nvalue". Returns {label: value}.
export function parseSections(body) {
  const out = {};
  const parts = String(body || '').split(/^###\s+/m).slice(1);
  for (const p of parts) {
    const nl = p.indexOf('\n');
    const key = (nl < 0 ? p : p.slice(0, nl)).trim().toLowerCase();
    let val = (nl < 0 ? '' : p.slice(nl + 1)).trim();
    if (val === '_No response_' || val === 'None') val = '';
    out[key] = val;
  }
  return out;
}

export function parseTask(issue) {
  const s = parseSections(issue.body);
  const project = normalizeProject(s['project'] || s['target repository'] || '');
  const priority = parseInt((s['priority'] || '').match(/[123]/)?.[0] || '2', 10);
  const size = (s['size'] || '').split(/\s|\(/)[0] || 'S';
  const depends = [...(s['depends on'] || '').matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
  return {
    project,
    priority,
    size,
    depends,
    what: s['what and why'] || '',
    scope: s['scope'] || '',
    nonGoals: s['out of scope'] || '',
    doneWhen: s['done when'] || '',
    skills: s['skills'] || '',
  };
}

export function normalizeProject(v) {
  const t = String(v || '').trim().replace(/\.git$/, '').replace(/\/$/, '');
  const m = t.match(/^(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+)$/);
  return m ? m[1] : '';
}

// tasks: [{number, title, url, body, state, stateReason, createdAt, authorAssociation,
//          author:{login}, comments:[{id, body, createdAt, authorAssociation,
//          author:{login, type, createdAt}}]}]
// prs: { [url]: {repo, author, merged, mergedAt, mergedBy, closed, closedAt} }  (PR facts we looked up)
export function fold(tasks, { now = new Date(), config = {}, prs = {} } = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const ttl = cfg.ttlHours * 3600e3;
  const nowMs = +new Date(now);
  const byNum = new Map();
  const events = [];

  for (const issue of tasks) {
    const meta = parseTask(issue);
    const projectOk = !cfg.projects.length || cfg.projects.includes(meta.project);
    const st = {
      number: issue.number,
      title: issue.title,
      url: issue.url,
      createdAt: issue.createdAt,
      author: issue.author?.login || null,
      ...meta,
      projectOk,
      status: isMaintainer(issue.authorAssociation) && projectOk ? 'open' : 'proposed',
      claim: null,
      pr: null,
      credit: null,
      doneAt: null,
      approvedBy: null,
      note: null,
      attempts: 0,
      log: [],
    };
    byNum.set(issue.number, st);
    for (const c of issue.comments || []) {
      if (c.author?.type === 'Bot') continue;
      const p = parseCommand(c.body);
      if (!p) continue;
      events.push({
        kind: 'command', task: issue.number, id: c.id, t: +new Date(c.createdAt),
        login: c.author?.login, accountCreatedAt: c.author?.createdAt,
        maintainer: isMaintainer(c.authorAssociation), ...p,
      });
    }
  }

  // A maintainer closing an issue by hand is an event too (the bot's own closes are projections).
  for (const issue of tasks) {
    if (issue.state === 'CLOSED' && issue.closedAt && !issue.closedByBot) {
      events.push({ kind: 'issue-closed', task: issue.number, t: +new Date(issue.closedAt), reason: issue.stateReason, id: 'close' });
    }
  }

  // PR outcomes become events too: a merge by someone other than the PR's author is the approval.
  const prEvents = [];
  for (const [url, pr] of Object.entries(prs)) {
    if (pr.merged) prEvents.push({ kind: 'pr-merged', url, t: +new Date(pr.mergedAt), login: pr.mergedBy, pr });
    else if (pr.closed) prEvents.push({ kind: 'pr-closed', url, t: +new Date(pr.closedAt), pr });
  }
  events.push(...prEvents);
  events.sort((a, b) => a.t - b.t || String(a.id || '').localeCompare(String(b.id || ''), 'en', { numeric: true }));

  const maxLease = cfg.maxLeaseHours * 3600e3;
  const expired = (st, t) => st.status === 'claimed' && st.claim && (t - st.claim.heartbeat > ttl || t - st.claim.since > maxLease);
  const lapse = (st, t) => {
    if (expired(st, t)) {
      st.log.push({ t, what: `claim by @${st.claim.login} lapsed` });
      st.status = 'open';
      st.claim = null;
    }
  };
  const activeClaims = (login, t) =>
    [...byNum.values()].filter((s) => s.status === 'claimed' && s.claim?.login === login && !expired(s, t)).length;

  const results = []; // {id, task, ok, message}

  for (const ev of events) {
    if (ev.kind === 'issue-closed') {
      const st = byNum.get(ev.task);
      if (['done', 'closed'].includes(st.status)) continue;
      if (st.status === 'review' && ev.reason === 'COMPLETED') {
        st.status = 'done'; st.doneAt = ev.t; st.log.push({ t: ev.t, what: 'shipped: issue closed as completed' });
      } else {
        st.status = 'closed'; st.claim = null; st.log.push({ t: ev.t, what: 'closed by a maintainer' });
      }
      continue;
    }
    if (ev.kind !== 'command') {
      const st = [...byNum.values()].find((s) => s.pr === ev.url);
      if (!st || st.status !== 'review') continue;
      if (ev.kind === 'pr-merged') {
        if (!ev.login || ev.login === ev.pr.author) {
          st.log.push({ t: ev.t, what: `PR merged by its own author; needs /done from a maintainer` });
          continue;
        }
        st.status = 'done'; st.doneAt = ev.t; st.approvedBy = ev.login;
        st.log.push({ t: ev.t, what: `shipped: PR merged by @${ev.login}` });
      } else {
        st.log.push({ t: ev.t, what: `PR closed without merge; task reopened` });
        st.status = 'open'; st.claim = null; st.pr = null; st.credit = null;
      }
      continue;
    }

    const st = byNum.get(ev.task);
    lapse(st, ev.t);
    const r = (ok, message, code) => {
      results.push({ id: ev.id, task: ev.task, cmd: ev.cmd, login: ev.login, ok, message, code: code || (ok ? ev.cmd.toUpperCase() : 'REFUSED') });
      if (ok) st.log.push({ t: ev.t, what: message });
    };
    const L = ev.login;

    switch (ev.cmd) {
      case 'claim': {
        const ageDays = ev.accountCreatedAt ? (ev.t - +new Date(ev.accountCreatedAt)) / 864e5 : Infinity;
        if (ageDays < cfg.minAccountAgeDays) { r(false, `GitHub accounts younger than ${cfg.minAccountAgeDays} days can't claim yet.`); break; }
        if (st.status === 'claimed' && st.claim.login === L) {
          st.claim.heartbeat = ev.t; st.claim.agent = ev.args.agent || st.claim.agent; st.claim.machine = ev.args.machine || st.claim.machine;
          r(true, `claim refreshed by @${L}`); break;
        }
        if (st.status === 'proposed') { r(false, `Not open yet: a maintainer has to /approve this task first.`); break; }
        if (st.status === 'claimed') { r(false, `Already claimed by @${st.claim.login} (lapses ${iso(st.claim.heartbeat + ttl)} without a heartbeat).`); break; }
        if (st.status !== 'open') { r(false, `Can't claim: the task is ${st.status}.`); break; }
        const waiting = st.depends.filter((n) => byNum.get(n)?.status !== 'done');
        if (waiting.length) { r(false, `Waiting on ${waiting.map((n) => '#' + n).join(', ')} to ship first.`); break; }
        const cap = cfg.fleet[L] ?? cfg.maxClaimsPerUser;
        if (activeClaims(L, ev.t) >= cap) { r(false, `@${L} already holds ${cap} active claims. Finish or /release one first.`, 'CLAIM_LIMIT'); break; }
        st.status = 'claimed'; st.attempts += 1;
        st.claim = { login: L, agent: ev.args.agent || null, machine: ev.args.machine || null, since: ev.t, heartbeat: ev.t };
        st.note = null;
        r(true, `claimed by @${L}${ev.args.agent ? ` (${ev.args.agent}${ev.args.machine ? ' on ' + ev.args.machine : ''})` : ''}`);
        break;
      }
      case 'progress': {
        if (st.status !== 'claimed' || st.claim.login !== L) { r(false, `Only the current claimant can post progress (status: ${st.status}).`); break; }
        st.claim.heartbeat = ev.t; st.note = ev.text || st.note;
        r(true, `progress from @${L}${ev.text ? ': ' + ev.text : ''}`);
        break;
      }
      case 'release': {
        if (st.status !== 'claimed') { r(false, `Nothing to release (status: ${st.status}).`); break; }
        if (st.claim.login !== L && !ev.maintainer) { r(false, `Only @${st.claim.login} or a maintainer can release this claim.`); break; }
        r(true, `claim by @${st.claim.login} released by @${L}`);
        st.status = 'open'; st.claim = null;
        break;
      }
      case 'submit': {
        if (st.status !== 'claimed' || st.claim.login !== L) { r(false, `Only the current claimant can submit (status: ${st.status}).`); break; }
        const m = ev.text.split(/\s+/)[0].match(PR_URL);
        if (!m) { r(false, `Submit a pull request URL: /submit https://github.com/<owner>/<repo>/pull/<n>`); break; }
        const url = m[0].replace(/\/$/, '');
        const facts = prs[url];
        if (st.project && m[1].toLowerCase() !== st.project.toLowerCase()) { r(false, `That PR is in ${m[1]}, but this task targets ${st.project}.`); break; }
        if (!facts) { r(false, `Couldn't verify that pull request (it must exist and be readable by the hub).`, 'INVALID_PR'); break; }
        if (facts.author !== L) { r(false, `That PR was opened by @${facts.author}, not @${L}.`, 'INVALID_PR'); break; }
        if (facts.closed && !facts.merged && +new Date(facts.closedAt) <= ev.t) { r(false, `That PR is already closed.`, 'INVALID_PR'); break; }
        st.status = 'review'; st.pr = url;
        st.credit = { login: L, agent: st.claim.agent, machine: st.claim.machine };
        r(true, `submitted for review by @${L}: ${url}`);
        break;
      }
      case 'done': {
        if (!ev.maintainer) { r(false, `Only maintainers can mark a task done.`); break; }
        if (st.status !== 'review') { r(false, `Only tasks in review can be marked done (status: ${st.status}).`); break; }
        if (st.credit?.login === L) { r(false, `No self-approval: another maintainer has to approve @${L}'s work.`); break; }
        st.status = 'done'; st.doneAt = ev.t; st.approvedBy = L;
        r(true, `shipped: approved by @${L}`);
        break;
      }
      case 'reject': {
        if (!ev.maintainer) { r(false, `Only maintainers can reject a submission.`); break; }
        if (st.status !== 'review') { r(false, `Nothing in review to reject (status: ${st.status}).`); break; }
        r(true, `submission rejected by @${L}${ev.text ? ': ' + ev.text : ''}; task reopened`);
        st.status = 'open'; st.claim = null; st.pr = null; st.credit = null; st.note = ev.text || null;
        break;
      }
      case 'approve': {
        if (!ev.maintainer) { r(false, `Only maintainers can approve a proposed task.`); break; }
        if (st.status !== 'proposed') { r(false, `Task isn't waiting for approval (status: ${st.status}).`); break; }
        st.status = 'open';
        r(true, `approved by @${L}; open for claims`);
        break;
      }
      case 'block': {
        if (!ev.maintainer) { r(false, `Only maintainers can block a task.`); break; }
        st.status = 'blocked'; st.claim = null; st.note = ev.text || null;
        r(true, `blocked by @${L}${ev.text ? ': ' + ev.text : ''}`);
        break;
      }
      case 'reopen': {
        if (!ev.maintainer) { r(false, `Only maintainers can reopen a task.`); break; }
        st.status = 'open'; st.claim = null; st.pr = null; st.credit = null; st.doneAt = null; st.approvedBy = null;
        r(true, `reopened by @${L}`);
        break;
      }
    }
  }

  for (const st of byNum.values()) lapse(st, nowMs);

  return { tasks: [...byNum.values()], results };
}

export function iso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
