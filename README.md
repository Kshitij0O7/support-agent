# Roosterly support agent

## How to run

```bash
git clone https://github.com/Kshitij0O7/support-agent.git && cd support-agent
npm install && cp .env.example .env   # Node 20.6+; fill in the keys and your email
npm test && npm run eval -- --runs 3 --label x   # 22 tests, then eval (posts nothing)
set -a && . ./.env && set +a && curl -X POST "$HELPDESK_URL/practice/reset" -H "Authorization: Bearer $HELPDESK_KEY" -H "X-Candidate-Email: $CANDIDATE_EMAIL"
npm start                             # add -- --dry-run to post nothing
```

## Decisions

1. **A fixed pipeline, not a tool-calling agent.** One model call per ticket; my code posts the decision, so "never answer twice" and "ticket text is data" live in code. The 12-article FAQ fits in a cached prompt.
2. **Dutch goes straight to the model.** Haiku 5.5 replies in the customer's language plus an English copy (`replyEn` in the log), which I checked. The catch: one call writes both, so there's no independent check.
3. **If in doubt, hand off.** A wrong refund or GDPR reply reaches a customer; a handoff costs a minute. A deterministic guard can turn a reply into a handoff or raise priority, never the reverse.

I assumed "unsure" is confidence below 0.7, thank-yous get closed, and vague tickets or ones not in Dutch, English or German go to a human. I talked through the architecture with Claude Code, wrote the low-level design myself, and used it for code snippets and tests.

## Reliability

- **503:** backoff with jitter (0.5–8 s, 6 tries). Safe for POSTs, since a 503 saves nothing.
- **429:** every call pauses until `Retry-After`, and requests go out 300 ms apart.
- **409:** logged, never retried. A POST with no response is resent only if the ticket is still open.
- **Crash:** no local state, so a re-run picks up only tickets that are still open.
- **Security:** keys in a git-ignored `.env`, tickets sent as escaped JSON, IBANs and card numbers redacted.

## Eval and fix

| Version | Action | Priority (range) | Unsafe | Over-escalated |
|---|---|---|---|---|
| Baseline | 8/10 | 8.3 (8–9) | 0 | 2 |
| + guard, + "answered" rule | 8/10 | 9.3 (9–10) | 0 | 2 |

Language and category scored 10/10 in `eval/runEval.js`. Priority is noise: the guard changed nothing, and repeat runs scored 8 to 10. The agent hands off E01 (iOS crash) and E05 (feature idea), which the FAQ answers. A prompt rule defining "answered" failed; the model read it backwards. No model is right every time. These over-escalations annoy the support team, but beat a wrong answer reaching a customer, so I left them.

Final run: 12 replies, 1 close, 17 handoffs (8 always-human, 6 non-FAQ bugs, 3 judged). About $0.025 per 100 tickets: 3,613 input × $0.10 + 129,240 cached × $0.01 + 11,401 output × $0.50 per 1M tokens = $0.0074 for 30.

## What I would improve

This is a working prototype. A bigger FAQ would need a vector store and RAG. More tickets would need a queue with a database record per ticket, so workers can share the rate limit without answering twice. Another provider's model should check each translation. In the brief, I'd add privacy obligations to P2 to cover GDPR.
