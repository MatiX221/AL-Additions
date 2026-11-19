import { describe, it, expect } from 'vitest';
import { findExactText, mediaRoute, icon } from '../src/utils/dom';

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
