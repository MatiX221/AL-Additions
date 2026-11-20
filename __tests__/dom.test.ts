import { describe, it, expect, vi } from 'vitest';
import { findExactText, mediaRoute, icon } from '../src/utils/dom';
import { downloadFile } from '../src/utils/helpers';

describe('DOM Utilities (src/utils/dom.ts)', () => {
  it('findExactText returns null safely when document.body is null', () => {
    const origBody = document.body;
    Object.defineProperty(document, 'body', { value: null, configurable: true });
    try {
      expect(findExactText('Profile')).toBeNull();
    } finally {
      delete (document as any).body;
      if (!document.body && origBody) document.documentElement.appendChild(origBody);
    }
  });

  it('findExactText locates exact text elements and walks single-text ancestor wrappers', () => {
    document.body.innerHTML = `
      <nav id="nav">
        <a id="profile-link" href="/settings"><span>Profile</span></a>
        <div id="dev-wrap">  Developer  </div>
        <div id="partial">Developer Tools</div>
      </nav>
    `;

    expect(findExactText('Profile')).toBe(document.getElementById('profile-link'));
    expect(findExactText('Developer')).toBe(document.getElementById('dev-wrap'));
    expect(findExactText('Missing')).toBeNull();
    expect(findExactText('Tools')).toBeNull();
  });

  it('mediaRoute parses anime/manga routes and ignores unrelated paths', () => {
    history.replaceState({}, '', '/anime/16498/Shingeki-no-Kyojin');
    expect(mediaRoute()).toEqual({ kind: 'anime', type: 'ANIME', id: 16498 });

    history.replaceState({}, '', '/manga/2');
    expect(mediaRoute()).toEqual({ kind: 'manga', type: 'MANGA', id: 2 });

    history.replaceState({}, '', '/settings');
    expect(mediaRoute()).toBeNull();
  });

  it('icon renders SVG markup with requested dimensions', () => {
    const svg = icon('close', 20);
    expect(svg).toContain('width="20"');
    expect(svg).toContain('height="20"');
    expect(svg).toContain('aria-hidden="true"');
  });
});

describe('downloadFile (src/utils/helpers.ts)', () => {
  it('handles onload, onerror fallback, ontimeout, onabort, sync throw, and missing GM_download', () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const dlSpy = vi.spyOn(globalThis, 'GM_download');

    try {
      const outcomes: string[] = [];
      dlSpy.mockImplementationOnce((opts: any) => {
        opts.onload?.();
        return { abort: vi.fn() };
      });
      downloadFile('https://example.com/1.png', '1.png', { onComplete: (m) => outcomes.push(m) });
      expect(outcomes).toEqual(['download']);
      expect(clickSpy).not.toHaveBeenCalled();

      dlSpy.mockImplementationOnce((opts: any) => {
        opts.onerror?.({ error: 'failed' });
      });
      downloadFile('https://example.com/2.png', '2.png', { onComplete: (m) => outcomes.push(m) });
      expect(outcomes).toEqual(['download', 'tab']);
      expect(clickSpy).toHaveBeenCalledTimes(1);

      const errors: unknown[] = [];
      dlSpy.mockImplementationOnce((opts: any) => {
        opts.onerror?.(new Error('nope'));
      });
      downloadFile('https://example.com/3.png', '3.png', {
        openTabOnError: false,
        onError: (e) => errors.push(e)
      });
      expect(errors).toHaveLength(1);
      expect(clickSpy).toHaveBeenCalledTimes(1);

      dlSpy.mockImplementationOnce((opts: any) => {
        opts.ontimeout?.();
      });
      downloadFile('https://example.com/4.png', '4.png', { onComplete: (m) => outcomes.push(m) });
      expect(outcomes).toEqual(['download', 'tab', 'tab']);
      expect(clickSpy).toHaveBeenCalledTimes(2);

      let aborted = 0;
      dlSpy.mockImplementationOnce((opts: any) => {
        opts.onabort?.();
      });
      downloadFile('https://example.com/5.png', '5.png', { onAbort: () => aborted++ });
      expect(aborted).toBe(1);
      expect(clickSpy).toHaveBeenCalledTimes(2);

      dlSpy.mockImplementationOnce(() => {
        throw new Error('sync boom');
      });
      downloadFile('https://example.com/6.png', '6.png', { onComplete: (m) => outcomes.push(m) });
      expect(outcomes).toEqual(['download', 'tab', 'tab', 'tab']);
      expect(clickSpy).toHaveBeenCalledTimes(3);

      const origDl = globalThis.GM_download;
      (globalThis as any).GM_download = undefined;
      try {
        downloadFile('https://example.com/7.png', '7.png', { onComplete: (m) => outcomes.push(m) });
        expect(outcomes).toEqual(['download', 'tab', 'tab', 'tab', 'tab']);
      } finally {
        globalThis.GM_download = origDl;
      }
    } finally {
      clickSpy.mockRestore();
      dlSpy.mockRestore();
    }
  });
});
