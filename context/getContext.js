import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The client's help centre (faq.md) is the only knowledge the agent may answer from.
// At 12 short articles (~1.5k tokens) it goes into the prompt whole; no retrieval.

const FAQ_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'faq.md');

let cached;

/**
 * Returns { faqText, faqIds }.
 * - faqText: the full FAQ, including the client's rules for the support team.
 * - faqIds:  ['F01', ..., 'F12'], to check later that a reply cites a real article.
 *
 * Read once and reused: the text must stay byte-identical between calls so the
 * system prompt can be prompt-cached.
 */
export const getContext = () => {
  if (!cached) {
    const faqText = fs.readFileSync(FAQ_PATH, 'utf8');
    const faqIds = [...faqText.matchAll(/^## (F\d{2}) /gm)].map((match) => match[1]);
    if (faqIds.length === 0) throw new Error(`No FAQ articles found in ${FAQ_PATH}`);
    cached = { faqText, faqIds };
  }
  return cached;
};
