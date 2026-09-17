import { afterEach, describe, expect, it } from 'vitest';
import { ContainerResolver } from '../../src/content/screen-graph/identity';
import { computeStackingRank } from '../../src/content/screen-graph/visibility';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('computeStackingRank (design.md §3.1 z field)', () => {
  it('is 0 for an unobstructed element (topmost at its own center)', () => {
    document.body.innerHTML = '<button id="t">Submit</button>';
    const el = document.getElementById('t')!;
    expect(computeStackingRank(el, el.getBoundingClientRect())).toBe(0);
  });

  it('is greater than 0 when something else is drawn on top of its center', () => {
    document.body.innerHTML = `
      <div style="position:relative;width:200px;height:100px;">
        <button id="target" style="box-sizing:border-box;margin:0;padding:0;border:0;position:absolute;top:0;left:0;width:200px;height:100px;">Submit</button>
        <div id="overlay" style="position:absolute;top:0;left:0;width:200px;height:100px;"></div>
      </div>
    `;
    const target = document.getElementById('target')!;
    const box = target.getBoundingClientRect();
    expect(computeStackingRank(target, box)).toBeGreaterThan(0);
  });
});

describe('ContainerResolver (design.md §5.5)', () => {
  it('resolves to a form ancestor', () => {
    document.body.innerHTML = '<form id="f"><input id="i"></form>';
    const resolver = new ContainerResolver();
    const container = resolver.resolve(document.getElementById('i')!);
    expect(container).not.toBe('root');
  });

  it('gives the same container id for two elements in the same form', () => {
    document.body.innerHTML = '<form id="f"><input id="a"><input id="b"></form>';
    const resolver = new ContainerResolver();
    const a = resolver.resolve(document.getElementById('a')!);
    const b = resolver.resolve(document.getElementById('b')!);
    expect(a).toBe(b);
  });

  it('gives different container ids for elements in different forms', () => {
    document.body.innerHTML = '<form id="f1"><input id="a"></form><form id="f2"><input id="b"></form>';
    const resolver = new ContainerResolver();
    const a = resolver.resolve(document.getElementById('a')!);
    const b = resolver.resolve(document.getElementById('b')!);
    expect(a).not.toBe(b);
  });

  it('resolves to a position:fixed ancestor when there is no form/landmark/dialog', () => {
    document.body.innerHTML = '<div id="fixed" style="position:fixed;top:0;left:0;"><span id="inner">x</span></div>';
    const resolver = new ContainerResolver();
    expect(resolver.resolve(document.getElementById('inner')!)).not.toBe('root');
  });

  it('resolves to a role=dialog ancestor', () => {
    document.body.innerHTML = '<div role="dialog"><button id="ok">OK</button></div>';
    const resolver = new ContainerResolver();
    expect(resolver.resolve(document.getElementById('ok')!)).not.toBe('root');
  });

  it('falls back to root when no container ancestor exists', () => {
    document.body.innerHTML = '<div><span id="s">x</span></div>';
    const resolver = new ContainerResolver();
    expect(resolver.resolve(document.getElementById('s')!)).toBe('root');
  });
});
