// design.md's `CAPTCHA` entity (§3.3's closed vocabulary — "non-PII marker: detection of CAPTCHA
// widgets") / FR-8 / NG-8 (T-6.13). A CAPTCHA widget is a structural marker, not a value-bearing
// field — `channel-d.ts`'s `classifyChannelD` can't cover it at all (it only ever looks at
// `HTMLInputElement`/`HTMLTextAreaElement`/`HTMLSelectElement`); this is the same shape of check
// against real, publicly-documented widget markup instead.
//
// Covers the two providers real pages actually use: reCAPTCHA (the `g-recaptcha` container
// Google's own docs specify, plus the `google.com/recaptcha`-hosted iframe it renders into once
// its script runs) and hCaptcha (the same shape, `h-captcha` / `hcaptcha.com`). Not a NG-8
// solving mechanism of any kind — this only ever answers "is this element a CAPTCHA widget",
// never inspects or interacts with the widget's own challenge content.

const CAPTCHA_SELECTORS = [
  '.g-recaptcha[data-sitekey]',
  'iframe[src*="google.com/recaptcha"]',
  'iframe[src*="recaptcha.net"]',
  '.h-captcha[data-sitekey]',
  'iframe[src*="hcaptcha.com"]',
];

export function isCaptchaElement(el: Element): boolean {
  return CAPTCHA_SELECTORS.some((selector) => el.matches(selector));
}
