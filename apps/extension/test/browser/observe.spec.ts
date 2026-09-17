import { afterEach, describe, expect, it } from 'vitest';
import { classifyMutation } from '../../src/content/observe/classify';
import { EpochTracker } from '../../src/content/observe/epochs';
import { startObserving } from '../../src/content/observe/observers';
import { ContainerResolver } from '../../src/content/screen-graph/identity';

afterEach(() => {
  document.body.innerHTML = '';
});

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function captureOneMutation(setup: () => void, mutate: () => void): Promise<MutationRecord> {
  document.body.innerHTML = '';
  setup();
  return new Promise((resolve) => {
    const observer = new MutationObserver((records) => {
      observer.disconnect();
      resolve(records[0]!);
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeOldValue: true, characterData: true });
    mutate();
  });
}

describe('classifyMutation (design.md §5.5)', () => {
  it('classifies a transform-only style change as cosmetic', async () => {
    const record = await captureOneMutation(
      () => {
        document.body.innerHTML = '<div id="t" style="transform:translateX(0px)"></div>';
      },
      () => {
        document.getElementById('t')!.style.transform = 'translateX(10px)';
      },
    );
    expect(classifyMutation(record)).toBe('cosmetic');
  });

  it('classifies a display-affecting style change as semantic', async () => {
    const record = await captureOneMutation(
      () => {
        document.body.innerHTML = '<div id="t" style="display:block"></div>';
      },
      () => {
        document.getElementById('t')!.style.display = 'none';
      },
    );
    expect(classifyMutation(record)).toBe('semantic');
  });

  it('classifies adding a plain non-interactive element as cosmetic', async () => {
    const record = await captureOneMutation(
      () => {
        document.body.innerHTML = '<div id="container"></div>';
      },
      () => {
        document.getElementById('container')!.innerHTML = '<span>decorative</span>';
      },
    );
    expect(classifyMutation(record)).toBe('cosmetic');
  });

  it('classifies adding an interactive element (button) as semantic', async () => {
    const record = await captureOneMutation(
      () => {
        document.body.innerHTML = '<div id="container"></div>';
      },
      () => {
        document.getElementById('container')!.innerHTML = '<button>Go</button>';
      },
    );
    expect(classifyMutation(record)).toBe('semantic');
  });

  it('classifies adding a new input as privacy-relevant', async () => {
    const record = await captureOneMutation(
      () => {
        document.body.innerHTML = '<div id="container"></div>';
      },
      () => {
        document.getElementById('container')!.innerHTML = '<input type="password">';
      },
    );
    expect(classifyMutation(record)).toBe('privacy-relevant');
  });

  it('classifies a type attribute change as privacy-relevant', async () => {
    const record = await captureOneMutation(
      () => {
        document.body.innerHTML = '<input id="t" type="text">';
      },
      () => {
        document.getElementById('t')!.setAttribute('type', 'password');
      },
    );
    expect(classifyMutation(record)).toBe('privacy-relevant');
  });

  it('classifies a text content change as cosmetic', async () => {
    const record = await captureOneMutation(
      () => {
        document.body.innerHTML = '<div id="clock">12:00</div>';
      },
      () => {
        document.getElementById('clock')!.firstChild!.textContent = '12:01';
      },
    );
    expect(classifyMutation(record)).toBe('cosmetic');
  });
});

describe('EpochTracker', () => {
  it('cosmetic mutations change nothing', () => {
    const tracker = new EpochTracker();
    tracker.apply('cosmetic', 'c-1');
    expect(tracker.containerEpoch('c-1')).toBe(0);
    expect(tracker.privacyEpoch).toBe(0);
  });

  it('semantic mutations bump only the container epoch', () => {
    const tracker = new EpochTracker();
    tracker.apply('semantic', 'c-1');
    expect(tracker.containerEpoch('c-1')).toBe(1);
    expect(tracker.containerEpoch('c-2')).toBe(0);
    expect(tracker.privacyEpoch).toBe(0);
  });

  it('privacy-relevant mutations bump both the container epoch and the global privacyEpoch', () => {
    const tracker = new EpochTracker();
    tracker.apply('privacy-relevant', 'c-1');
    expect(tracker.containerEpoch('c-1')).toBe(1);
    expect(tracker.privacyEpoch).toBe(1);
  });
});

describe('startObserving — integration (design.md §5.5 AC)', () => {
  it('a CSS-animation-style transform change produces no epoch change', async () => {
    document.body.innerHTML = '<div id="container"><div id="anim" style="transform:translateX(0px)"></div></div>';
    const containerResolver = new ContainerResolver();
    const epochTracker = new EpochTracker();
    const handle = startObserving(document.body, containerResolver, epochTracker, () => {});

    try {
      document.getElementById('anim')!.style.transform = 'translateX(50px)';
      await nextMacrotask();
      expect(epochTracker.privacyEpoch).toBe(0);
    } finally {
      handle.disconnect();
    }
  });

  it('adding a button increments the container epoch', async () => {
    document.body.innerHTML = '<form id="f"></form>';
    const containerResolver = new ContainerResolver();
    const epochTracker = new EpochTracker();
    const form = document.getElementById('f')!;
    const containerId = containerResolver.resolve(form);
    const handle = startObserving(document.body, containerResolver, epochTracker, () => {});

    try {
      form.innerHTML = '<button>Submit</button>';
      await nextMacrotask();
      expect(epochTracker.containerEpoch(containerId)).toBeGreaterThan(0);
    } finally {
      handle.disconnect();
    }
  });

  it('adding an <input type=password> increments the global privacyEpoch', async () => {
    document.body.innerHTML = '<form id="f"></form>';
    const containerResolver = new ContainerResolver();
    const epochTracker = new EpochTracker();
    const handle = startObserving(document.body, containerResolver, epochTracker, () => {});

    try {
      document.getElementById('f')!.innerHTML = '<input type="password">';
      await nextMacrotask();
      expect(epochTracker.privacyEpoch).toBeGreaterThan(0);
    } finally {
      handle.disconnect();
    }
  });

  it('a scrollend event triggers onChange (not a bare scroll event, per design.md §5.5)', async () => {
    document.body.innerHTML = '<div id="f"></div>';
    let changeCount = 0;
    const handle = startObserving(document.body, new ContainerResolver(), new EpochTracker(), () => {
      changeCount += 1;
    });

    // try/finally: an assertion failure here must not skip disconnect() and leak this test's
    // window-level scrollend/focus listeners into every later test in this file.
    try {
      window.dispatchEvent(new Event('scroll'));
      await nextMacrotask();
      expect(changeCount).toBe(0);

      window.dispatchEvent(new Event('scrollend'));
      await nextMacrotask();
      expect(changeCount).toBe(1);
    } finally {
      handle.disconnect();
    }
  });

  it('disconnect() stops further mutations from being observed', async () => {
    document.body.innerHTML = '<form id="f"></form>';
    const containerResolver = new ContainerResolver();
    const epochTracker = new EpochTracker();
    const handle = startObserving(document.body, containerResolver, epochTracker, () => {});
    handle.disconnect();

    document.getElementById('f')!.innerHTML = '<input type="password">';
    await nextMacrotask();

    expect(epochTracker.privacyEpoch).toBe(0);
  });
});
