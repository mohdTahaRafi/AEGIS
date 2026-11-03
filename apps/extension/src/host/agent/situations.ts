// Rules that hold only in some situations. The system prompt carries what is true on every step;
// each step's prompt adds the rules below whose situation it is in (the task asks for content to be
// written, the page shows a failed result, the last steps went nowhere, ...), so the model reads the
// guidance that applies now instead of every rule for every kind of task. Detected from the guarded
// step only: the sanitized task, page title, element names, page text and HISTORY.

import type { SanitizedContext } from '@aegis/protocol';
import type { PromptProfile } from '../egress/providers';
import { isOneTimeAction } from '../actions/risk';

export type SituationId = 'failed_result' | 'stuck' | 'produce' | 'code' | 'lasting' | 'compare' | 'answer';

export interface Situation {
  id: SituationId;
  rule: string;
}

interface StepView {
  task: string;
  /** Page title, element names and page text, joined. */
  page: string;
  history: SanitizedContext['history'];
  elementNames: string[];
}

const FAILED_RESULT =
  /\b(?:wrong answer|compilation error|compile error|runtime error|time limit exceeded|memory limit exceeded|idleness limit exceeded|presentation error|failed (?:on )?(?:pre)?tests?|tests? failed|build failed|syntax error)\b/i;
const NOT_WORKING = /no visible change|failed|rejected|refused|same plan|NOT repeated/i;
const PRODUCE = /\b(?:write|solve|code|program|implement|compose|draft|reply|respond|fill (?:in|out)|create an? |generate|translate|summari[sz]e|rewrite|essay|answer (?:the|this|these))/i;
const CODE_TASK = /\b(?:cpp|python|java(?:script)?|typescript|golang|rust|kotlin|c#|program|code|solve|leetcode|codeforces|hackerrank|codechef|atcoder|submission|verdict|accepted)\b|c\+\+/i;
const CODE_PAGE = /\b(?:source code|code editor|submit (?:solution|code)|sample (?:input|output|test)|time limit per test)\b/i;
const LASTING_TASK = /\b(?:add(?:ed)? to (?:cart|basket|bag|wishlist)|buy|purchase|order|book|reserve|subscribe|follow|vote|rsvp|wishlist)\b/i;
const COMPARE = /\b(?:compare|comparison|cheapest|lowest price|best (?:price|deal|offer)|versus|vs\.?|which (?:is|one is) (?:better|cheaper))\b/i;
const QUESTION = /\?|^\s*(?:what|which|who|whose|when|where|why|how|is|are|does|do|can)\b|\b(?:find|tell me|look up|check|explain|list|show me|get me|price|how much|how many|report|summari[sz]e)\b/i;

const SITUATIONS: { id: SituationId; applies: (view: StepView) => boolean; rule: string }[] = [
  {
    id: 'failed_result',
    applies: (v) => (v.history?.length ?? 0) > 0 && FAILED_RESULT.test(v.page),
    rule:
      'The page shows a failed result (e.g. "Wrong answer on test 1", a compile error). If it is about your own work, it is yours to fix: ' +
      'read the details (which test, the error message, expected vs. received), work out the mistake, correct it and submit again. ' +
      'Never ask the user to fix it. After 3 corrected attempts that still fail, stop with cannot_proceed and say what you tried.',
  },
  {
    id: 'stuck',
    applies: (v) => {
      const last = v.history?.slice(-2) ?? [];
      return last.length === 2 && last.every((h) => NOT_WORKING.test(h.outcome));
    },
    rule:
      'Your last steps did not work (see HISTORY). Do not repeat them: use another element, scroll or find, read_page, ' +
      "another route or another site. If nothing is left, stop with the reason.",
  },
  {
    id: 'produce',
    applies: (v) => PRODUCE.test(v.task),
    rule:
      'The TASK asks you to produce something (code, text, an answer). You write it yourself from what you know and what the page ' +
      'says: ask_user is never for content you can produce. Plan it in "notes" first when it is long or tricky; type it with one ' +
      'type action (at most 2000 characters).',
  },
  {
    id: 'code',
    applies: (v) => CODE_TASK.test(v.task) || CODE_PAGE.test(v.page),
    rule:
      'Code: write one complete program in the language the TASK names (select it in the page\'s language list). Read input and print ' +
      'output exactly as the statement\'s format says. Before you submit or report it, trace every sample test through your code ' +
      'in "notes" (input -> what your code prints -> expected output) and fix any mismatch first. A code editor may ' +
      're-indent or add closing brackets as you type: after typing, check the editor shows your code as written, and if it is garbled ' +
      'use the site\'s plain-text option (e.g. "switch off editor") and type it again. A file-upload field cannot be filled: use a ' +
      'page with a text box for the code (the site\'s Submit page).',
  },
  {
    id: 'lasting',
    applies: (v) => LASTING_TASK.test(v.task) || v.elementNames.some(isOneTimeAction),
    rule:
      'Lasting actions (add to cart, wishlist, subscribe, book): do each ONCE. Before one, check NOTES and LASTING ACTIONS DONE; ' +
      'right after it, write "DONE: <what, where, price>" in NOTES. Do NOT send done in the same list: check the next step\'s page ' +
      '(cart count, "added" message) first, then finish.',
  },
  {
    id: 'compare',
    applies: (v) => COMPARE.test(v.task),
    rule:
      'Compare / cheapest / best across sites: check at least 3 different sites before choosing (one checklist item each, with the ' +
      'price or "blocked/not found" as its result). A site that blocks you, asks you to log in or lacks the item is noted and ' +
      'skipped: go to the next site. Never stop because one site failed while others can still be tried.',
  },
  {
    id: 'answer',
    applies: (v) => QUESTION.test(v.task),
    rule:
      'The TASK wants an answer: collect the facts in NOTES as you go, then send {"op":"report","content":"<complete answer, short ' +
      'lines or bullets>"} followed by {"op":"done","summary":"<one sentence>"}.',
  },
];

/** How many situation rules one step carries: the compact profile's token budget is tight. */
const MAX_SITUATIONS: Record<PromptProfile, number> = { compact: 2, rich: 4 };

/** The situations `step` is in, most pressing first, capped for the profile. */
export function detectSituations(step: SanitizedContext, profile: PromptProfile = 'compact'): Situation[] {
  const elementNames = step.nodes.map((n) => n.name);
  const view: StepView = {
    task: step.task,
    page: [step.page.title, ...elementNames, ...step.text.map((t) => t.text)].join('\n'),
    history: step.history,
    elementNames,
  };
  return SITUATIONS.filter((s) => s.applies(view))
    .slice(0, MAX_SITUATIONS[profile])
    .map(({ id, rule }) => ({ id, rule }));
}

export function renderSituations(situations: readonly Situation[]): string {
  if (situations.length === 0) return '';
  return `SITUATION (rules for this step):\n${situations.map((s) => `- ${s.rule}`).join('\n')}\n`;
}
