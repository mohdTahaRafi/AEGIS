// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { computeAccessibleName } from '../../src/content/screen-graph/accname';

function el(html: string): Element {
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container);
  return container.firstElementChild as Element;
}

describe('computeAccessibleName — precedence order (design.md §5.4)', () => {
  it('1. aria-labelledby wins over every other source', () => {
    document.body.innerHTML = '<span id="lbl">Labelled name</span>';
    const target = el(
      '<input aria-labelledby="lbl" aria-label="aria label" placeholder="placeholder" value="ignored">',
    );
    expect(computeAccessibleName(target)).toBe('Labelled name');
  });

  it('2. aria-label wins over label/alt/placeholder/text/value', () => {
    const target = el('<input aria-label="Aria label" placeholder="placeholder">');
    expect(computeAccessibleName(target)).toBe('Aria label');
  });

  it('3a. associated label (for/id) wins over alt/title/placeholder/text/value', () => {
    document.body.innerHTML = '<label for="f1">For label</label><input id="f1" title="title text">';
    const target = document.getElementById('f1') as Element;
    expect(computeAccessibleName(target)).toBe('For label');
  });

  it('3b. wrapping label wins over alt/title/placeholder/text/value', () => {
    document.body.innerHTML = '<label>Wrapping label <input title="title text"></label>';
    const target = document.querySelector('input') as Element;
    expect(computeAccessibleName(target)).toBe('Wrapping label');
  });

  it('4a. img alt wins over title/placeholder/text', () => {
    const target = el('<img alt="Alt text" title="Title text">');
    expect(computeAccessibleName(target)).toBe('Alt text');
  });

  it('4b. title wins over placeholder/text/value when no label/alt applies', () => {
    const target = el('<div title="Title text">Text content</div>');
    expect(computeAccessibleName(target)).toBe('Title text');
  });

  it('5. placeholder wins over text content and button value', () => {
    const target = el('<input placeholder="Placeholder text" value="Value text">');
    expect(computeAccessibleName(target)).toBe('Placeholder text');
  });

  it('6. text content is used when no higher-precedence source applies', () => {
    const target = el('<button>Button text</button>');
    expect(computeAccessibleName(target)).toBe('Button text');
  });

  it('7. button value is the last resort (input[type=submit/button/reset] cannot hold text-node children)', () => {
    const target = el('<input type="submit" value="Submit value">');
    expect(computeAccessibleName(target)).toBe('Submit value');
  });

  it('7b. button value is not used for a plain text input', () => {
    const target = el('<input type="text" value="Should not be used as a name">');
    expect(computeAccessibleName(target)).toBe('');
  });

  it('returns empty string when no source applies', () => {
    const target = el('<div></div>');
    expect(computeAccessibleName(target)).toBe('');
  });
});

describe('computeAccessibleName — aria-labelledby cycles', () => {
  it('terminates on a two-node cycle instead of recursing forever', () => {
    document.body.innerHTML =
      '<span id="a" aria-labelledby="b">Fallback A</span>' +
      '<span id="b" aria-labelledby="a">Fallback B</span>';
    const a = document.getElementById('a') as Element;
    // a → labelledby b → labelledby a (already visited, contributes '') → b falls through
    // to its own text content. Must return synchronously, not hang or throw.
    expect(computeAccessibleName(a)).toBe('Fallback B');
  });

  it('terminates on a self-referencing node', () => {
    document.body.innerHTML = '<span id="self" aria-labelledby="self">Self text</span>';
    const target = document.getElementById('self') as Element;
    expect(computeAccessibleName(target)).toBe('Self text');
  });
});

describe('computeAccessibleName — text content truncation', () => {
  it('truncates a 400-char text content to 120 characters', () => {
    const long = 'x'.repeat(400);
    const target = el(`<div>${long}</div>`);
    const name = computeAccessibleName(target);
    expect(name.length).toBe(120);
    expect(name).toBe('x'.repeat(120));
  });

  it('collapses internal whitespace before truncating', () => {
    const target = el('<div>  hello   world  </div>');
    expect(computeAccessibleName(target)).toBe('hello world');
  });
});

describe('computeAccessibleName — a field value never becomes part of its name', () => {
  it('a wrapping label does not pick up a nested textarea’s prefilled content', () => {
    document.body.innerHTML = '<label>Address <textarea id="t">12 MG Road, Pune</textarea></label>';
    expect(computeAccessibleName(document.getElementById('t')!)).toBe('Address');
  });

  it('a wrapping label does not pick up a nested select’s options', () => {
    document.body.innerHTML = '<label>State <select id="s"><option>Kerala</option><option>Goa</option></select></label>';
    expect(computeAccessibleName(document.getElementById('s')!)).toBe('State');
  });

  it('an unlabelled textarea gets no name from its own content', () => {
    document.body.innerHTML = '<textarea id="t">my secret notes</textarea>';
    expect(computeAccessibleName(document.getElementById('t')!)).toBe('');
  });
});
