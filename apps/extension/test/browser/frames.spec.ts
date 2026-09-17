import { afterEach, describe, expect, it } from 'vitest';
import {
  createFrameIdGenerator,
  extractChildFrames,
  handshake,
  installFrameHandshakeResponder,
} from '../../src/content/screen-graph/frames';
import { ContainerResolver, createNodeIdentityRegistry } from '../../src/content/screen-graph/identity';

afterEach(() => {
  document.body.innerHTML = '';
});

function createIframe(srcdoc: string, style = ''): Promise<HTMLIFrameElement> {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.style.cssText = style;
    iframe.addEventListener('load', () => resolve(iframe), { once: true });
    iframe.srcdoc = srcdoc;
    document.body.appendChild(iframe);
  });
}

describe('handshake (design.md §3.5 / architecture §5.4)', () => {
  it('resolves true when the frame answers with the exact nonce it was challenged with', async () => {
    const iframe = await createIframe('<button>Hi</button>');
    const stop = installFrameHandshakeResponder(iframe.contentWindow!);
    try {
      await expect(handshake(iframe.contentWindow!, 250)).resolves.toBe(true);
    } finally {
      stop();
    }
  });

  it('rejects a forged reply dispatched directly by a page script (not a genuine postMessage IPC delivery)', async () => {
    const iframe = await createIframe('<button>Hi</button>');
    // No real responder installed — nobody in this frame legitimately answers. A hostile page
    // script sharing our `window` can call `dispatchEvent` with any `data`/`origin` it likes —
    // even the *correct*-looking nonce, if it somehow guessed it — but it can never make the
    // browser mark that event `isTrusted`, which only a genuine cross-window postMessage gets.
    const result = handshake(iframe.contentWindow!, 50);
    queueMicrotask(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'aegis:frame-response', nonce: 'guessed-nonce' },
        }),
      );
    });
    await expect(result).resolves.toBe(false);
  });

  it('rejects a genuine but wrong-nonce reply', async () => {
    const iframe = await createIframe('<button>Hi</button>');
    // A live-but-wrong responder: replies for real (trusted postMessage) but with a nonce it made
    // up instead of echoing the challenge — must still be rejected.
    const badResponder = (): void => {
      iframe.contentWindow!.parent.postMessage({ type: 'aegis:frame-response', nonce: 'not-the-real-nonce' }, '*');
    };
    iframe.contentWindow!.addEventListener('message', badResponder);
    try {
      await expect(handshake(iframe.contentWindow!, 50)).resolves.toBe(false);
    } finally {
      iframe.contentWindow!.removeEventListener('message', badResponder);
    }
  });

  it('times out (fails closed) when nothing answers at all', async () => {
    const iframe = await createIframe('<button>Hi</button>');
    await expect(handshake(iframe.contentWindow!, 50)).resolves.toBe(false);
  });
});

describe('extractChildFrames (design.md §3.5 AC)', () => {
  it('translates a same-origin child frame sub-graph into top-level coordinates after a successful handshake', async () => {
    const iframe = await createIframe(
      '<button style="position:absolute;top:10px;left:20px;width:80px;height:30px;box-sizing:border-box;margin:0;border:0;">Child</button>',
      'position:absolute;top:100px;left:200px;width:300px;height:200px;border:0;',
    );
    const stop = installFrameHandshakeResponder(iframe.contentWindow!);

    try {
      const { nodes } = await extractChildFrames(document.body, {
        identity: createNodeIdentityRegistry(),
        containerResolver: new ContainerResolver(),
        nextFrameId: createFrameIdGenerator(),
      });

      const child = nodes.find((n) => n.name === 'Child');
      expect(child).toBeDefined();
      expect(child!.frame).toBe('f-1');
      // top-level box = iframe's own box (100,200) + the button's local box (10,20)
      expect(child!.box[0]).toBeCloseTo(220, 0);
      expect(child!.box[1]).toBeCloseTo(110, 0);
    } finally {
      stop();
    }
  });

  it('on a 2-frame fixture, a frame with no live content script contributes no nodes while its sibling still does', async () => {
    const legit = await createIframe('<button>Legit</button>', 'position:absolute;top:0;left:0;');
    const stopLegit = installFrameHandshakeResponder(legit.contentWindow!);
    // No responder for this one — simulates a frame AEGIS could not (or did not) instrument.
    await createIframe('<button>Unanswered</button>', 'position:absolute;top:0;left:0;');

    try {
      const { nodes } = await extractChildFrames(document.body, {
        identity: createNodeIdentityRegistry(),
        containerResolver: new ContainerResolver(),
        nextFrameId: createFrameIdGenerator(),
        handshakeTimeoutMs: 50,
      });

      expect(nodes.some((n) => n.name === 'Legit')).toBe(true);
      expect(nodes.some((n) => n.name === 'Unanswered')).toBe(false);
    } finally {
      stopLegit();
    }
  });
});
