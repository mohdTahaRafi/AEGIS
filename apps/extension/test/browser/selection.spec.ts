import { afterEach, describe, expect, it } from 'vitest';
import { AEGIS_IGNORE_ATTR, computeAffordances, isCandidateNode } from '../../src/content/screen-graph/selection';
import { computeRole } from '../../src/content/screen-graph/roles';

afterEach(() => {
  document.body.innerHTML = '';
});

// T-2.7's fixture: a long form page exercising every included/excluded category at once.
const LONG_FORM_FIXTURE = `
  <nav id="nav">Site nav</nav>
  <main id="main">
    <h2 id="heading">Account details</h2>
    <form id="form">
      <label id="label" for="name">Full name</label>
      <input id="input" type="text" name="name">
      <button id="button">Submit</button>
      <a id="link" href="/help">Help</a>
    </form>
    <p id="paragraph">Please fill in every field before continuing.</p>
    <div id="hidden" style="display:none">Not shown</div>
    <script id="script">/* noop */</script>
    <style id="style">.x{color:red}</style>
    <template id="template"><div>Not rendered</div></template>
    <div id="aegis-ui" data-aegis-ignore>
      <button id="aegis-ui-button">Injected overlay button</button>
    </div>
  </main>
`;

describe('isCandidateNode — T-2.7 node selection', () => {
  it('includes interactive elements, landmarks, headings, labels and text-bearing blocks; excludes hidden/script/style/template/extension UI', () => {
    document.body.innerHTML = LONG_FORM_FIXTURE;

    const included = ['nav', 'main', 'heading', 'form', 'label', 'input', 'button', 'link', 'paragraph'];
    for (const id of included) {
      const el = document.getElementById(id)!;
      expect(isCandidateNode(el), `#${id} should be a candidate`).toBe(true);
    }

    const excluded = ['hidden', 'script', 'style', 'template', 'aegis-ui', 'aegis-ui-button'];
    for (const id of excluded) {
      const el = document.getElementById(id)!;
      expect(isCandidateNode(el), `#${id} should NOT be a candidate`).toBe(false);
    }
  });

  it('excludes an element nested under the extension\'s own ignore marker even without the attribute itself', () => {
    document.body.innerHTML = `<div ${AEGIS_IGNORE_ATTR}><span id="nested">x</span></div>`;
    expect(isCandidateNode(document.getElementById('nested')!)).toBe(false);
  });

  it('includes an element with a click-cursor heuristic even with no direct text or interactive role', () => {
    // Text lives in a child <span>, not directly in the div, so this isolates the cursor
    // heuristic from the text-bearing-block path (which would also select it either way).
    document.body.innerHTML = '<div id="clickable" style="cursor:pointer"><span>Card</span></div>';
    expect(isCandidateNode(document.getElementById('clickable')!)).toBe(true);
  });

  it('includes an element with tabindex=0 even with no direct text or interactive role', () => {
    document.body.innerHTML = '<div id="focusable" tabindex="0"><span>Card</span></div>';
    expect(isCandidateNode(document.getElementById('focusable')!)).toBe(true);
  });

  it('does not include a plain inline span with no direct text and no interactive signal', () => {
    document.body.innerHTML = '<span id="wrapper"><b>bold</b></span>';
    expect(isCandidateNode(document.getElementById('wrapper')!)).toBe(false);
  });

  // T-6.13 (FR-8) — a real reCAPTCHA/hCaptcha container has no click-cursor style, no direct
  // text and no landmark role of its own, the same reachability gap MEDIA_TAGS closes for
  // canvas/img/video (see selection.ts's own doc comment).
  it('includes a real reCAPTCHA container div even though it has none of the other candidate signals', () => {
    document.body.innerHTML = '<div id="cap" class="g-recaptcha" data-sitekey="6Le-real-site-key"></div>';
    expect(isCandidateNode(document.getElementById('cap')!)).toBe(true);
  });

  it('includes the reCAPTCHA-hosted iframe once its script has rendered one', () => {
    document.body.innerHTML = '<iframe id="cap" src="https://www.google.com/recaptcha/api2/anchor?k=x"></iframe>';
    expect(isCandidateNode(document.getElementById('cap')!)).toBe(true);
  });

  it('includes a real hCaptcha container div', () => {
    document.body.innerHTML = '<div id="cap" class="h-captcha" data-sitekey="10000000-ffff-ffff-ffff-000000000001"></div>';
    expect(isCandidateNode(document.getElementById('cap')!)).toBe(true);
  });

  it('a div that merely LOOKS like a captcha class name with no data-sitekey is not treated as one', () => {
    document.body.innerHTML = '<div id="not-cap" class="g-recaptcha"></div>';
    expect(isCandidateNode(document.getElementById('not-cap')!)).toBe(false);
  });
});

describe('computeAffordances (design.md §3.1/§4.3)', () => {
  it('a text input gets click + type, matching the design.md §4.3 worked example', () => {
    document.body.innerHTML = '<input id="t" type="text">';
    const el = document.getElementById('t')!;
    expect(computeAffordances(el, computeRole(el)).sort()).toEqual(['click', 'type']);
  });

  it('a button gets click only', () => {
    document.body.innerHTML = '<button id="t">Go</button>';
    const el = document.getElementById('t')!;
    expect(computeAffordances(el, computeRole(el))).toEqual(['click']);
  });

  it('a checkbox gets click + toggle', () => {
    document.body.innerHTML = '<input id="t" type="checkbox">';
    const el = document.getElementById('t')!;
    expect(computeAffordances(el, computeRole(el)).sort()).toEqual(['click', 'toggle']);
  });

  it('a select gets click + select', () => {
    document.body.innerHTML = '<select id="t"><option>a</option></select>';
    const el = document.getElementById('t')!;
    expect(computeAffordances(el, computeRole(el)).sort()).toEqual(['click', 'select']);
  });

  it('a hidden input gets no affordances', () => {
    document.body.innerHTML = '<input id="t" type="hidden" value="x">';
    const el = document.getElementById('t')!;
    expect(computeAffordances(el, computeRole(el))).toEqual([]);
  });

  it('a scrollable container gets the scroll affordance in addition to any others', () => {
    document.body.innerHTML =
      '<div id="t" style="overflow-y:scroll;height:50px;">' +
      '<div style="height:500px;">tall content</div></div>';
    const el = document.getElementById('t')!;
    expect(computeAffordances(el, computeRole(el))).toContain('scroll');
  });

  it('a plain non-scrollable div gets no affordances', () => {
    document.body.innerHTML = '<div id="t">Just text</div>';
    const el = document.getElementById('t')!;
    expect(computeAffordances(el, computeRole(el))).toEqual([]);
  });
});
