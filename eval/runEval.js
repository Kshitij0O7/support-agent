// Eval: runs makeDecision on the 10 labelled examples from GET /examples and scores
// it against Nordavo's labels. Nothing is posted to the helpdesk.
//
//   npm run eval                          # 3 runs, label "run"
//   npm run eval -- --runs 5 --label fix-faq-answer
//
// Writes eval/results/<timestamp>-<label>.json with every decision, so before/after
// comparisons are in the repo. The labels come from Nordavo, never from the model.
//
// What it measures, per run:
//   - exact match of language, category, priority and action against the label
//   - unsafe replies: the label says handoff/close but the agent replied (worst case:
//     a customer gets an answer a human should have given)
//   - over-escalations: the label says reply but the agent handed off
//   - token usage and cost (published per-token prices x logged usage)
// Not yet measured: whether a reply's content is correct and FAQ-only.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getExamples } from '../tickets/readTickets.js';
import { getContext } from '../context/getContext.js';
import { makeDecision } from '../decision.js';
import { applyGuard } from '../guard.js';
import { redact } from '../logger.js';
import { estimateCostUsd } from '../pricing.js';

const FIELDS = ['language', 'category', 'priority', 'action'];
const RESULTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'results');

function parseArgs(argv) {
  const args = { runs: 3, label: 'run' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--runs') args.runs = Number(argv[++i]);
    else if (argv[i] === '--label') args.label = argv[++i];
  }
  if (!Number.isInteger(args.runs) || args.runs < 1) throw new Error('--runs must be a positive integer');
  args.label = args.label.replace(/[^\w-]/g, '-');
  return args;
}

function scoreOne(label, decision) {
  const matches = Object.fromEntries(FIELDS.map((f) => [f, decision[f] === label[f]]));
  return {
    matches,
    unsafeReply: decision.action === 'reply' && label.action !== 'reply',
    overEscalation: decision.action === 'handoff' && label.action === 'reply',
  };
}

async function runOnce(examples, context) {
  const items = [];
  for (const example of examples) {
    // Score what would actually reach the helpdesk: the model's decision after the guard.
    const { decision: proposed, meta } = await makeDecision(example, context);
    const { decision, changes } = applyGuard(proposed, example, context);
    items.push({
      id: example.id,
      subject: example.subject,
      label: example.label,
      decision,
      proposedAction: proposed.action,
      guardChanges: changes,
      score: scoreOne(example.label, decision),
      meta: { model: meta.model, fallback: meta.fallback, usage: meta.usage, costUsd: estimateCostUsd(meta.model, meta.usage) },
    });
  }
  const count = (fn) => items.filter(fn).length;
  const costs = items.map((i) => i.meta.costUsd);
  return {
    items,
    totals: {
      ...Object.fromEntries(FIELDS.map((f) => [f, count((i) => i.score.matches[f])])),
      unsafeReplies: count((i) => i.score.unsafeReply),
      overEscalations: count((i) => i.score.overEscalation),
      guardChanged: count((i) => i.guardChanges.length > 0),
      costUsd: costs.includes(null) ? null : costs.reduce((a, b) => a + b, 0),
    },
  };
}

function summarize(runs, n) {
  const keys = [...FIELDS, 'unsafeReplies', 'overEscalations', 'guardChanged'];
  const summary = {};
  for (const key of keys) {
    const values = runs.map((r) => r.totals[key]);
    summary[key] = {
      mean: values.reduce((a, b) => a + b, 0) / values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      of: n,
    };
  }
  const costs = runs.map((r) => r.totals.costUsd);
  summary.costPer100TicketsUsd = costs.includes(null)
    ? null
    : (costs.reduce((a, b) => a + b, 0) / costs.length / n) * 100;
  return summary;
}

// Per example: which runs disagreed with the label, and whether the runs disagreed with each other.
function perExample(runs) {
  const ids = runs[0].items.map((i) => i.id);
  return ids.map((id) => {
    const items = runs.map((r) => r.items.find((i) => i.id === id));
    const misses = FIELDS.flatMap((f) =>
      items.some((i) => !i.score.matches[f]) ? [`${f}: want ${items[0].label[f]}, got ${items.map((i) => i.decision[f]).join('/')}`] : [],
    );
    const unstable = FIELDS.some((f) => new Set(items.map((i) => i.decision[f])).size > 1);
    const guard = [...new Set(items.flatMap((i) => i.guardChanges))];
    return { id, subject: items[0].subject, misses, unstable, guard };
  });
}

function printReport(summary, examples, meta) {
  const fmt = (s) => (s.min === s.max ? `${s.mean}/${s.of}` : `${s.mean.toFixed(1)}/${s.of} (${s.min}-${s.max})`);
  console.log(`\nEval "${meta.label}": ${meta.runs} run(s) x ${meta.examples} examples, model ${meta.model}`);
  for (const f of FIELDS) console.log(`  ${f.padEnd(16)} ${fmt(summary[f])}`);
  console.log(`  ${'unsafe replies'.padEnd(16)} ${fmt(summary.unsafeReplies)}   (must be 0)`);
  console.log(`  ${'over-escalations'.padEnd(16)} ${fmt(summary.overEscalations)}`);
  console.log(`  ${'guard changed'.padEnd(16)} ${fmt(summary.guardChanged)}`);
  if (summary.costPer100TicketsUsd != null) {
    console.log(`  ${'cost'.padEnd(16)} $${summary.costPer100TicketsUsd.toFixed(4)} per 100 tickets`);
  }
  const notable = examples.filter((e) => e.misses.length || e.unstable || e.guard.length);
  if (notable.length) {
    console.log('\n  Misses and guard changes (got values listed per run):');
    for (const e of notable) {
      console.log(`  ${e.id} ${e.subject}${e.unstable ? '  [runs disagree]' : ''}`);
      for (const m of e.misses) console.log(`      ${m}`);
      for (const g of e.guard) console.log(`      guard: ${g}`);
    }
  }
}

const args = parseArgs(process.argv.slice(2));
const examples = await getExamples();
const context = getContext();

const runs = [];
for (let r = 1; r <= args.runs; r++) {
  process.stdout.write(`run ${r}/${args.runs}... `);
  runs.push(await runOnce(examples, context));
  console.log('done');
}

const summary = summarize(runs, examples.length);
const byExample = perExample(runs);
const meta = {
  label: args.label,
  runs: args.runs,
  examples: examples.length,
  model: runs[0].items.find((i) => i.meta.model)?.meta.model ?? null,
  startedAt: new Date().toISOString(),
};

printReport(summary, byExample, meta);

fs.mkdirSync(RESULTS_DIR, { recursive: true });
const file = path.join(RESULTS_DIR, `${meta.startedAt.replace(/[:.]/g, '-')}-${args.label}.json`);
fs.writeFileSync(file, JSON.stringify(redact({ meta, summary, byExample, runs }), null, 2) + '\n');
console.log(`\nSaved ${path.relative(process.cwd(), file)}`);
