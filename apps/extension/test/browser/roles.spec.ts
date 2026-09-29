import { afterEach, describe, expect, it } from 'vitest';
import { computeRole } from '../../src/content/screen-graph/roles';

afterEach(() => {
  document.body.innerHTML = '';
});

function role(html: string): string {
  document.body.innerHTML = html;
  return computeRole(document.body.firstElementChild as Element);
}

describe('computeRole — explicit role wins', () => {
  it('an explicit role attribute overrides the implicit tag role', () => {
    expect(role('<div role="button">Go</div>')).toBe('button');
  });

  it('uses only the first token of a multi-value role attribute', () => {
    expect(role('<div role="switch checkbox">Toggle</div>')).toBe('switch');
  });
});

describe('computeRole — implicit roles', () => {
  it('a[href] is a link; a without href is generic', () => {
    expect(role('<a href="/x">Go</a>')).toBe('link');
    expect(role('<a>Go</a>')).toBe('generic');
  });

  it('button is button', () => {
    expect(role('<button>Go</button>')).toBe('button');
  });

  it.each([
    ['checkbox', 'checkbox'],
    ['radio', 'radio'],
    ['range', 'slider'],
    ['submit', 'button'],
    ['button', 'button'],
    ['file', 'button'],
    ['hidden', 'none'],
    ['text', 'textbox'],
    ['email', 'textbox'],
    ['password', 'textbox'],
  ])('input[type=%s] is %s', (type, expected) => {
    expect(role(`<input type="${type}">`)).toBe(expected);
  });

  it('select is combobox; multiple select is listbox', () => {
    expect(role('<select><option>a</option></select>')).toBe('combobox');
    expect(role('<select multiple><option>a</option></select>')).toBe('listbox');
  });

  it('textarea is textbox', () => {
    expect(role('<textarea></textarea>')).toBe('textbox');
  });

  it('nav/main/aside map to their landmark roles', () => {
    expect(role('<nav></nav>')).toBe('navigation');
    expect(role('<main></main>')).toBe('main');
    expect(role('<aside></aside>')).toBe('complementary');
  });

  it('a top-level header/footer is banner/contentinfo', () => {
    document.body.innerHTML = '<header id="h"></header><footer id="f"></footer>';
    expect(computeRole(document.getElementById('h')!)).toBe('banner');
    expect(computeRole(document.getElementById('f')!)).toBe('contentinfo');
  });

  it('a header/footer nested in sectioning content is generic', () => {
    document.body.innerHTML = '<article><header id="h"></header><footer id="f"></footer></article>';
    expect(computeRole(document.getElementById('h')!)).toBe('generic');
    expect(computeRole(document.getElementById('f')!)).toBe('generic');
  });

  it('form is form; article is article; img is img', () => {
    expect(role('<form></form>')).toBe('form');
    expect(role('<article></article>')).toBe('article');
    expect(role('<img src="x.png">')).toBe('img');
  });

  it('a section is a region only when it has an accessible-name hint', () => {
    document.body.innerHTML = '<section id="a"></section><section id="b" aria-label="Results"></section>';
    expect(computeRole(document.getElementById('a')!)).toBe('generic');
    expect(computeRole(document.getElementById('b')!)).toBe('region');
  });

  it('h1..h6 are heading', () => {
    for (let level = 1; level <= 6; level += 1) {
      expect(role(`<h${level}>Title</h${level}>`)).toBe('heading');
    }
  });

  it('a plain div/span is generic', () => {
    expect(role('<div>x</div>')).toBe('generic');
    expect(role('<span>x</span>')).toBe('generic');
  });
});

describe('computeRole — opaque embedded content goes to vision', () => {
  it.each(['<iframe src="about:blank"></iframe>', '<embed src="x.pdf">', '<object data="x.pdf"></object>'])('%s is routed as img', (html) => {
    expect(role(html)).toBe('img');
  });
});
