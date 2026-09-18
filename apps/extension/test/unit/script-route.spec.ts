import { describe, expect, it } from 'vitest';
import { routeScript } from '../../src/perception/models/script-route';

describe('routeScript — design.md §6.4 script routing (T-6.4)', () => {
  it('routes Hindi, Marathi and other Devanagari-script languages to the Devanagari recognizer', () => {
    expect(routeScript('hi')).toBe('devanagari');
    expect(routeScript('mr')).toBe('devanagari');
    expect(routeScript('ne')).toBe('devanagari');
    expect(routeScript('hi-IN')).toBe('devanagari'); // BCP-47 region subtag ignored for routing
  });

  it('routes English and unrelated languages to Latin', () => {
    expect(routeScript('en')).toBe('latin');
    expect(routeScript('en-US')).toBe('latin');
    expect(routeScript('fr')).toBe('latin');
  });

  it('routes a script this project has no bundled recognizer for to Latin, not a throw — a disclosed gap, not a crash', () => {
    expect(routeScript('ta')).toBe('latin'); // Tamil — eval corpus has fixtures for it, no bundled recognizer yet
    expect(routeScript('bn')).toBe('latin'); // Bengali — same
  });

  it('defaults to Latin when no lang is declared', () => {
    expect(routeScript(undefined)).toBe('latin');
    expect(routeScript('')).toBe('latin');
  });

  it('is case-insensitive', () => {
    expect(routeScript('HI')).toBe('devanagari');
    expect(routeScript('Hi-Latn')).toBe('devanagari');
  });
});
