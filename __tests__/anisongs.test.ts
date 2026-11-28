import { describe, it, expect, vi } from 'vitest';
import {
  validateAniSongsConfig,
  buildProviderUrl,
  openAniSongsModal,
  DEFAULT_ANISONGS_CONFIG,
  DEFAULT_PRESETS,
  type SongParams,
  type SongProviderPreset
} from '../src/modules/anisongs/anisongModal';
import {
  extractSongParams,
  parseTheme,
  groupThemes,
  resolveProviderLink,
  sortEpisodes,
  formatEpsTag,
  createSongCard,
  createSongGroup,
  type SongEntry,
  type AnimeMetaInfo
} from '../src/modules/anisongs/anisongs';

describe('AniSongs: validateAniSongsConfig', () => {
  it('validates default config successfully with empty active array', () => {
    const res = validateAniSongsConfig(DEFAULT_ANISONGS_CONFIG);
    expect(res.valid).toBe(true);
    expect(res.config?.active).toEqual([]);
    expect(res.config?.presets).toHaveLength(DEFAULT_PRESETS.length);
  });

  it('parses valid JSON string configuration', () => {
    const raw = JSON.stringify({
      active: ['custom'],
      presets: [{ id: 'custom', name: 'Custom Search', url: 'https://search.com?q={title}' }]
    });
    const res = validateAniSongsConfig(raw);
    expect(res.valid).toBe(true);
    expect(res.config?.active).toEqual(['custom']);
  });

  it('filters out active items that do not exist in presets', () => {
    const raw = {
      active: ['ghost_service', 'youtube'],
      presets: [{ id: 'youtube', name: 'YouTube', url: 'https://youtube.com/search?q={title}' }]
    };
    const res = validateAniSongsConfig(raw);
    expect(res.valid).toBe(true);
    expect(res.config?.active).toEqual(['youtube']);
  });
});

describe('AniSongs: buildProviderUrl template substitution', () => {
  const song: SongParams = {
    title: 'KICK BACK',
    title_romaji: 'KICK BACK',
    title_jp: 'キックバック',
    artist: 'Kenshi Yonezu',
    artists: 'Kenshi Yonezu, Daiki Tsuneta',
    anime: 'Chainsaw Man',
    anime_romaji: 'Chainsaw Man',
    anime_en: 'Chainsaw Man',
    anime_jp: 'チェンソーマン',
    year: 2022,
    season: 'FALL',
    type: 'OP',
    number: 1
  };

  it('substitutes Japanese title and Japanese anime name without corrupting base tags', () => {
    const template = 'https://youtube.com/results?search_query={anime_jp}+{title_jp}';
    const result = buildProviderUrl(template, song);
    expect(result).toBe('https://youtube.com/results?search_query=%E3%83%81%E3%82%A7%E3%83%B3%E3%82%BD%E3%83%BC%E3%83%9E%E3%83%B3+%E3%82%AD%E3%83%83%E3%82%AF%E3%83%90%E3%83%83%E3%82%AF');
  });

  it('substitutes theme code and query_jp shortcut', () => {
    const template = 'https://youtube.com/results?search_query={query_jp}';
    const result = buildProviderUrl(template, song);
    expect(result).toBe(
      'https://youtube.com/results?search_query=%E3%83%81%E3%82%A7%E3%83%B3%E3%82%BD%E3%83%BC%E3%83%9E%E3%83%B3%20OP1'
    );

    const templateWithPlus = 'https://youtube.com/results?search_query={anime_jp}+{theme}';
    const resultWithPlus = buildProviderUrl(templateWithPlus, song);
    expect(resultWithPlus).toBe(
      'https://youtube.com/results?search_query=%E3%83%81%E3%82%A7%E3%83%B3%E3%82%BD%E3%83%BC%E3%83%9E%E3%83%B3+OP1'
    );
  });

  it('substitutes multiple artists and year/season', () => {
    const template = 'https://open.spotify.com/search/{title}%20{artists}%20{year}';
    const result = buildProviderUrl(template, song);
    expect(result).toBe('https://open.spotify.com/search/KICK%20BACK%20Kenshi%20Yonezu%2C%20Daiki%20Tsuneta%202022');
  });

  it('substitutes combined {query}', () => {
    const template = 'https://aniplaylist.com/?search={query}';
    const result = buildProviderUrl(template, song);
    expect(result).toBe('https://aniplaylist.com/?search=KICK%20BACK%20Kenshi%20Yonezu');
  });
});

describe('AniSongs: extractSongParams legacy fallback', () => {
  it('correctly parses legacy cached entries missing title/artists', () => {
    const legacySong = {
      sequence: 2,
      name: '2. "Gurenge" by LiSA (eps 1-13)',
      url: 'https://example.com/video.webm'
    };
    const params = extractSongParams(legacySong, 'OP');
    expect(params.title).toBe('Gurenge');
    expect(params.artist).toBe('LiSA');
    expect(params.type).toBe('OP');
    expect(params.number).toBe(2);
    expect(params.title_jp).toBe('Gurenge');
  });
});

describe('AniSongs: GraphQL Theme Parsing & Video Resolution', () => {
  const meta: AnimeMetaInfo = {
    animeName: 'Chainsaw Man',
    animeRomaji: 'Chainsaw Man',
    animeEn: 'Chainsaw Man',
    animeJp: 'チェンソーマン',
    year: 2022,
    season: 'FALL'
  };

  it('parses AnimeThemes GraphQL theme with SongTitle, staff, ThemeGroup and resources', () => {
    const rawTheme = {
      type: 'OP',
      sequence: 1,
      group: { name: 'Main' },
      song: {
        title: {
          romaji: 'KICK BACK',
          native: 'キックバック'
        },
        staff: [
          { role: 'Performance', relevance: 1, as: null, artist: { name: { main: 'Kenshi Yonezu' } } },
          { role: 'Arrangement', relevance: 2, as: null, artist: { name: { main: 'Daiki Tsuneta' } } }
        ],
        resources: {
          nodes: [
            { site: 'SPOTIFY', link: 'https://open.spotify.com/track/3khEEPRyBeOUabbmOPJzAG' },
            { site: 'YOUTUBE', link: 'https://www.youtube.com/watch?v=M2cckDmNLMI' }
          ]
        }
      },
      entries: [
        {
          episodes: '1-12',
          version: 1,
          videos: {
            nodes: [
              { link: 'https://v.animethemes.moe/ChainsawMan-OP1-NCBD1080.webm', source: 'BD', basename: 'ChainsawMan-OP1-NCBD1080.webm' },
              { link: 'https://v.animethemes.moe/ChainsawMan-OP1.webm', source: 'WEB', basename: 'ChainsawMan-OP1.webm' }
            ]
          }
        }
      ]
    };

    const entry = parseTheme(rawTheme, meta);
    expect(entry).not.toBeNull();
    expect(entry?.sequence).toBe(1);
    expect(entry?.title).toBe('KICK BACK');
    expect(entry?.title_romaji).toBe('KICK BACK');
    expect(entry?.title_jp).toBe('キックバック');
    expect(entry?.artists).toEqual(['Kenshi Yonezu']);
    expect(entry?.type).toBe('OP');
    expect(entry?.eps).toBe('1-12');
    expect(entry?.resources).toEqual({
      SPOTIFY: 'https://open.spotify.com/track/3khEEPRyBeOUabbmOPJzAG',
      YOUTUBE: 'https://www.youtube.com/watch?v=M2cckDmNLMI'
    });
    expect(entry?.url).toBe('https://v.animethemes.moe/ChainsawMan-OP1.webm');
  });

  it('defaults sequence to 1 when sequence is null in GraphQL response', () => {
    const rawTheme = {
      type: 'ED',
      sequence: null,
      group: null,
      song: {
        title: { romaji: 'Vita Philosophica', native: null },
        staff: [{ as: null, artist: { name: { main: 'Kashitarou Itou' } } }]
      },
      entries: [
        {
          episodes: '2-11',
          version: 1,
          videos: {
            nodes: [{ link: 'https://v.animethemes.moe/WatashiNoShiawase-ED1.webm', source: 'WEB' }]
          }
        }
      ]
    };

    const entry = parseTheme(rawTheme, meta);
    expect(entry?.sequence).toBe(1);
    expect(entry?.name).toContain('1. "Vita Philosophica" by Kashitarou Itou (eps 2-11)');
  });

  it('correctly sorts and groups OP and ED themes in groupThemes', () => {
    const anime = {
      title: { romaji: 'Chainsaw Man' },
      themes: [
        {
          type: 'ED',
          sequence: 2,
          song: { title: { romaji: 'Zanki' } }
        },
        {
          type: 'OP',
          sequence: 1,
          song: { title: { romaji: 'KICK BACK' } }
        },
        {
          type: 'ED',
          sequence: 1,
          song: { title: { romaji: 'Chainsaw Blood' } }
        }
      ]
    };

    const grouped = groupThemes(anime, meta);
    expect(grouped.OP).toHaveLength(1);
    expect(grouped.OP[0].title).toBe('KICK BACK');
    expect(grouped.ED).toHaveLength(2);
    expect(grouped.ED[0].title).toBe('Chainsaw Blood');
    expect(grouped.ED[1].title).toBe('Zanki');
  });

  it('filters out non-performer roles and deduplicates multi-role artists (e.g. Sugar Salt)', () => {
    const rawTheme = {
      type: 'OP',
      sequence: 1,
      song: {
        title: { romaji: 'Sugar Salt' },
        staff: [
          { role: 'Arrangement', relevance: 4, artist: { name: { main: 'Masayoshi Ooishi' } } },
          { role: 'Composition', relevance: 3, artist: { name: { main: 'Masayoshi Ooishi' } } },
          { role: 'Lyrics', relevance: 2, artist: { name: { main: 'Masayoshi Ooishi' } } },
          { role: 'Performance', relevance: 1, artist: { name: { main: 'Masayoshi Ooishi' } } }
        ]
      },
      entries: [{ episodes: '1-' }]
    };

    const entry = parseTheme(rawTheme, meta);
    expect(entry?.artists).toEqual(['Masayoshi Ooishi']);
    expect(entry?.name).toBe('1. "Sugar Salt" by Masayoshi Ooishi (eps 1-)');
  });

  it('formats Performance + Featuring roles with feat. and sorts by relevance (e.g. Hatsukoi Reply)', () => {
    const rawTheme = {
      type: 'OP',
      sequence: 1,
      song: {
        title: { romaji: 'Hatsukoi Reply' },
        staff: [
          { role: 'Arrangement', relevance: 7, artist: { name: { main: 'HoneyWorks' } } },
          { role: 'Lyrics', relevance: 3, artist: { name: { main: 'HoneyWorks' } } },
          { role: 'Featuring', relevance: 2, artist: { name: { main: 'Sara Hoshikawa' } } },
          { role: 'Performance', relevance: 1, artist: { name: { main: 'HoneyWorks' } } },
          { role: 'Composition', relevance: 6, artist: { name: { main: 'MARUMOCHI' } } }
        ]
      },
      entries: [{ episodes: '1-' }]
    };

    const entry = parseTheme(rawTheme, meta);
    expect(entry?.artists).toEqual(['HoneyWorks', 'Sara Hoshikawa']);
    expect(entry?.name).toBe('1. "Hatsukoi Reply" by HoneyWorks feat. Sara Hoshikawa (eps 1-)');
  });

  it('deduplicates repeated group/band credits across member rows (e.g. Kessoku Band)', () => {
    const rawTheme = {
      type: 'OP',
      sequence: 1,
      song: {
        title: { romaji: 'Seishun Complex' },
        staff: [
          { role: 'Performance', relevance: 3, as: null, artist: { name: { main: 'Kessoku Band' } }, memberAs: 'Hitori Gotou' },
          { role: 'Performance', relevance: 1, as: null, artist: { name: { main: 'Kessoku Band' } }, memberAs: 'Nijika Ijichi' },
          { role: 'Performance', relevance: 2, as: null, artist: { name: { main: 'Kessoku Band' } }, memberAs: 'Ikuyo Kita' },
          { role: 'Performance', relevance: 4, as: null, artist: { name: { main: 'Kessoku Band' } }, memberAs: 'Ryou Yamada' }
        ]
      }
    };

    const entry = parseTheme(rawTheme, meta);
    expect(entry?.artists).toEqual(['Kessoku Band']);
    expect(entry?.name).toBe('1. "Seishun Complex" by Kessoku Band');
  });

  it('orders multi-character performers by relevance and prefers as over artist name', () => {
    const rawTheme = {
      type: 'ED',
      sequence: 7,
      song: {
        title: { romaji: 'Yume Kataru Yori Yume Utaou' },
        staff: [
          { role: 'Performance', relevance: 3, as: 'Yoshiko Tsushima', artist: { name: { main: 'Aika Kobayashi' } } },
          { role: 'Performance', relevance: 1, as: 'Hanamaru Kunikida', artist: { name: { main: 'Kanako Takatsuki' } } },
          { role: 'Performance', relevance: 2, as: 'Ruby Kurosawa', artist: { name: { main: 'Ai Furihata' } } }
        ]
      }
    };

    const entry = parseTheme(rawTheme, meta);
    expect(entry?.artists).toEqual(['Hanamaru Kunikida', 'Ruby Kurosawa', 'Yoshiko Tsushima']);
    expect(entry?.name).toBe('7. "Yume Kataru Yori Yume Utaou" by Hanamaru Kunikida, Ruby Kurosawa, Yoshiko Tsushima');
  });
});

describe('AniSongs: resolveProviderLink Strict ID Matching', () => {
  const songWithDirect: SongEntry = {
    sequence: 1,
    name: '1. "KICK BACK" by Kenshi Yonezu',
    url: 'https://v.animethemes.moe/ChainsawMan-OP1.webm',
    title: 'KICK BACK',
    artists: ['Kenshi Yonezu'],
    type: 'OP',
    animeName: 'Chainsaw Man',
    resources: {
      SPOTIFY: 'https://open.spotify.com/track/3khEEPRyBeOUabbmOPJzAG',
      YOUTUBE: 'https://www.youtube.com/watch?v=M2cckDmNLMI'
    }
  };

  const songWithoutDirect: SongEntry = {
    sequence: 1,
    name: '1. "KICK BACK" by Kenshi Yonezu',
    url: 'https://v.animethemes.moe/ChainsawMan-OP1.webm',
    title: 'KICK BACK',
    artists: ['Kenshi Yonezu'],
    type: 'OP',
    animeName: 'Chainsaw Man',
    resources: {}
  };

  const spotifyPreset: SongProviderPreset = {
    id: 'spotify',
    name: 'Spotify',
    icon: 'https://example.com/spotify.png',
    url: 'https://open.spotify.com/search/{title}%20{artist}'
  };

  const youtubePreset: SongProviderPreset = {
    id: 'youtube',
    name: 'YouTube',
    icon: 'https://example.com/yt.png',
    url: 'https://www.youtube.com/results?search_query={title}+{artist}'
  };

  const youtubeThemePreset: SongProviderPreset = {
    id: 'youtube_theme',
    name: 'YouTube (Anime + Theme)',
    icon: 'https://example.com/yt.png',
    url: 'https://www.youtube.com/results?search_query={anime}+{theme}'
  };

  const youtubeJpPreset: SongProviderPreset = {
    id: 'youtube_jp',
    name: 'YouTube (Japanese Anime + Theme)',
    icon: 'https://example.com/yt.png',
    url: 'https://www.youtube.com/results?search_query={anime_jp}+{theme}'
  };

  const aniplaylistPreset: SongProviderPreset = {
    id: 'aniplaylist',
    name: 'AniPlaylist',
    icon: 'https://example.com/aniplaylist.png',
    url: 'https://aniplaylist.com/{title}'
  };

  it('uses direct link when preset ID strictly matches and direct link is present', () => {
    const spotifyRes = resolveProviderLink(spotifyPreset, songWithDirect, 'OP');
    expect(spotifyRes.isDirect).toBe(true);
    expect(spotifyRes.url).toBe('https://open.spotify.com/track/3khEEPRyBeOUabbmOPJzAG');

    const ytRes = resolveProviderLink(youtubePreset, songWithDirect, 'OP');
    expect(ytRes.isDirect).toBe(true);
    expect(ytRes.url).toBe('https://www.youtube.com/watch?v=M2cckDmNLMI');
  });

  it('falls back to search template when direct link is not present for matching preset ID', () => {
    const spotifyRes = resolveProviderLink(spotifyPreset, songWithoutDirect, 'OP');
    expect(spotifyRes.isDirect).toBe(false);
    expect(spotifyRes.url).toBe('https://open.spotify.com/search/KICK%20BACK%20Kenshi%20Yonezu');
  });

  it('never uses direct link for youtube_theme or youtube_jp even when YOUTUBE direct link exists', () => {
    const themeRes = resolveProviderLink(youtubeThemePreset, songWithDirect, 'OP');
    expect(themeRes.isDirect).toBe(false);
    expect(themeRes.url).toBe('https://www.youtube.com/results?search_query=Chainsaw+Man+OP1');

    const jpRes = resolveProviderLink(youtubeJpPreset, songWithDirect, 'OP');
    expect(jpRes.isDirect).toBe(false);
    expect(jpRes.url).toBe('https://www.youtube.com/results?search_query=Chainsaw+Man+OP1');
  });

  it('never uses direct link for custom or third-party preset IDs like aniplaylist', () => {
    const aniRes = resolveProviderLink(aniplaylistPreset, songWithDirect, 'OP');
    expect(aniRes.isDirect).toBe(false);
    expect(aniRes.url).toBe('https://aniplaylist.com/KICK%20BACK');
  });
});

describe('AniSongs: Episode Sorting, Formatting & Multi-Version Theme Cards', () => {
  const meta: AnimeMetaInfo = {
    animeName: 'Kyouran Reijou Nia Liston',
    animeRomaji: 'Kyouran Reijou Nia Liston',
    animeEn: 'Nia Liston',
    animeJp: '',
    year: 2026,
    season: 'FALL'
  };

  it('sorts comma-separated episode segments numerically and formats ep vs eps', () => {
    expect(sortEpisodes('2, 5, 3, 6, 4')).toBe('2, 3, 4, 5, 6');
    expect(sortEpisodes('1-47, 1-47, 1000')).toBe('1-47, 1000');
    expect(sortEpisodes('10, 2, 1-3')).toBe('1-3, 2, 10');
    expect(sortEpisodes('7-')).toBe('7-');
    expect(formatEpsTag('4')).toBe('(ep 4)');
    expect(formatEpsTag('2, 5')).toBe('(eps 2, 5)');
    expect(formatEpsTag('1-3, 5-6')).toBe('(eps 1-3, 5-6)');
    expect(formatEpsTag('7-')).toBe('(eps 7-)');
  });

  it('parses multi-version theme entries sorted by version with notes and separate URLs', () => {
    const rawTheme = {
      type: 'ED',
      sequence: 1,
      song: {
        title: { romaji: 'Tokimeki Un Deux Trois♪' },
        staff: [{ role: 'Performance', relevance: 1, artist: { name: { main: 'Magic Vision Hirome-tai' } } }]
      },
      entries: [
        {
          version: 2,
          episodes: '3, 6',
          notes: 'rock',
          videos: { nodes: [{ link: 'https://v.animethemes.moe/NiaListon-ED1v2.webm', source: 'WEB' }] }
        },
        {
          version: 3,
          episodes: '4',
          notes: 'paper',
          videos: { nodes: [{ link: 'https://v.animethemes.moe/NiaListon-ED1v3.webm', source: 'WEB' }] }
        },
        {
          version: 1,
          episodes: '5, 2',
          notes: 'scissors',
          videos: { nodes: [{ link: 'https://v.animethemes.moe/NiaListon-ED1.webm', source: 'WEB' }] }
        }
      ]
    };

    const entry = parseTheme(rawTheme, meta);
    expect(entry).not.toBeNull();
    expect(entry?.name).toBe('1. "Tokimeki Un Deux Trois♪" by Magic Vision Hirome-tai');
    expect(entry?.eps).toBe('2, 3, 4, 5, 6');
    expect(entry?.versions).toEqual([
      {
        version: 1,
        label: 'v1',
        episodes: '2, 5',
        notes: 'scissors',
        url: 'https://v.animethemes.moe/NiaListon-ED1.webm'
      },
      {
        version: 2,
        label: 'v2',
        episodes: '3, 6',
        notes: 'rock',
        url: 'https://v.animethemes.moe/NiaListon-ED1v2.webm'
      },
      {
        version: 3,
        label: 'v3',
        episodes: '4',
        notes: 'paper',
        url: 'https://v.animethemes.moe/NiaListon-ED1v3.webm'
      }
    ]);
  });

  it('merges same-sequence themes across language/dub groups with Japanese/English labels (One Piece)', () => {
    const onePieceAnime = {
      title: { romaji: 'One Piece' },
      themes: [
        {
          type: 'OP',
          sequence: 1,
          group: { name: 'English Version', slug: 'EN' },
          song: { title: { romaji: 'We Are!' }, staff: [] },
          entries: [{ version: 1, episodes: '1-47', videos: { nodes: [{ link: 'https://v.animethemes.moe/OnePiece-OP1-EN.webm' }] } }]
        },
        {
          type: 'OP',
          sequence: 1,
          group: null,
          song: {
            title: { romaji: 'We Are!' },
            staff: [{ role: 'Performance', relevance: 1, artist: { name: { main: 'Hiroshi Kitadani' } } }]
          },
          entries: [
            { version: 1, episodes: '1-47', videos: { nodes: [{ link: 'https://v.animethemes.moe/OnePiece-OP1.webm' }] } },
            { version: 2, episodes: '1000', videos: { nodes: [{ link: 'https://v.animethemes.moe/OnePiece-OP1v2.webm' }] } }
          ]
        },
        {
          type: 'OP',
          sequence: 1,
          group: { name: 'English Version - 4Kids', slug: 'EN4Kids' },
          song: { title: { romaji: 'One Piece Theme' }, staff: [] },
          entries: [{ version: 1, episodes: null, videos: { nodes: [{ link: 'https://v.animethemes.moe/OnePiece-OP1-EN4Kids.webm' }] } }]
        },
        {
          type: 'ED',
          sequence: 1,
          group: { name: 'English Version', slug: 'EN' },
          song: { title: { romaji: 'memories' }, staff: [] },
          entries: [{ version: 1, episodes: '1-30', videos: { nodes: [{ link: 'https://v.animethemes.moe/OnePiece-ED1-EN.webm' }] } }]
        },
        {
          type: 'ED',
          sequence: 1,
          group: null,
          song: {
            title: { romaji: 'memories' },
            staff: [{ role: 'Performance', relevance: 1, artist: { name: { main: 'Maki Ootsuki' } } }]
          },
          entries: [{ version: 1, episodes: '1-30', videos: { nodes: [{ link: 'https://v.animethemes.moe/OnePiece-ED1.webm' }] } }]
        }
      ]
    };

    const grouped = groupThemes(onePieceAnime, meta);
    expect(grouped.OP).toHaveLength(1);
    expect(grouped.OP[0].name).toBe('1. "We Are!" by Hiroshi Kitadani');
    expect(grouped.OP[0].artists).toEqual(['Hiroshi Kitadani']);
    expect(grouped.OP[0].eps).toBe('1-47, 1000');
    expect(grouped.OP[0].versions).toEqual([
      { version: 1, label: 'Japanese v1', episodes: '1-47', url: 'https://v.animethemes.moe/OnePiece-OP1.webm' },
      { version: 2, label: 'Japanese v2', episodes: '1000', url: 'https://v.animethemes.moe/OnePiece-OP1v2.webm' },
      { version: 1, label: 'English', episodes: '1-47', url: 'https://v.animethemes.moe/OnePiece-OP1-EN.webm' },
      { version: 1, label: 'English - 4Kids', songTitle: 'One Piece Theme', url: 'https://v.animethemes.moe/OnePiece-OP1-EN4Kids.webm' }
    ]);

    expect(grouped.ED).toHaveLength(1);
    expect(grouped.ED[0].name).toBe('1. "memories" by Maki Ootsuki');
    expect(grouped.ED[0].versions).toEqual([
      { version: 1, label: 'Japanese', episodes: '1-30', url: 'https://v.animethemes.moe/OnePiece-ED1.webm' },
      { version: 1, label: 'English', episodes: '1-30', url: 'https://v.animethemes.moe/OnePiece-ED1-EN.webm' }
    ]);
  });

  it('does not collapse distinct unnumbered (sequence: null) themes together', () => {
    const anime = {
      themes: [
        { type: 'ED', sequence: null, group: null, song: { title: { romaji: 'Song A' } } },
        { type: 'ED', sequence: null, group: null, song: { title: { romaji: 'Song B' } } }
      ]
    };
    const grouped = groupThemes(anime, meta);
    expect(grouped.ED).toHaveLength(2);
  });

  it('limits song groups to 5 items initially with independent Show all / Show less toggles and scroll follow', () => {
    vi.useFakeTimers();
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const scrollBySpy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    const originalMatchMedia = window.matchMedia;
    const origScrollYDesc = Object.getOwnPropertyDescriptor(window, 'scrollY');
    const origDocScrollHeightDesc = Object.getOwnPropertyDescriptor(document.documentElement, 'scrollHeight');
    let reduced = false;
    let scrollY = 700;
    let docHeight = 3000;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)' ? reduced : false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false
    }));
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, get: () => docHeight });

    try {
      const fiveSongs: SongEntry[] = Array.from({ length: 5 }, (_, i) => ({
        sequence: i + 1,
        name: `${i + 1}. "OP ${i + 1}"`,
        url: null
      }));
      const fiveGroup = createSongGroup('Openings', fiveSongs, [], 'OP');
      expect(fiveGroup.querySelectorAll('.daiya-anisong-entry')).toHaveLength(5);
      expect(fiveGroup.querySelector('.daiya-anisongs-toggle')).toBeNull();

      const eightSongs: SongEntry[] = Array.from({ length: 8 }, (_, i) => ({
        sequence: i + 1,
        name: `${i + 1}. "ED ${i + 1}"`,
        url: `https://v.animethemes.moe/ED${i + 1}.webm`
      }));
      const eightGroup = createSongGroup('Endings', eightSongs, [], 'ED');
      document.body.appendChild(eightGroup);
      const extraWrap = eightGroup.querySelector('.daiya-anisongs-extra') as HTMLElement;
      const toggleBtn = eightGroup.querySelector('.daiya-anisongs-toggle') as HTMLButtonElement;

      expect(extraWrap).not.toBeNull();
      expect(extraWrap.classList.contains('is-open')).toBe(false);
      expect(toggleBtn.textContent).toBe('Show all (8)');
      expect(toggleBtn.getAttribute('aria-expanded')).toBe('false');

      toggleBtn.click();
      expect(extraWrap.classList.contains('is-open')).toBe(true);
      expect(toggleBtn.textContent).toBe('Show less');
      expect(toggleBtn.getAttribute('aria-expanded')).toBe('true');

      const hiddenHeader = extraWrap.querySelector('.daiya-anisong-header') as HTMLElement;
      hiddenHeader.click();
      const pausesBeforeCollapse = pauseSpy.mock.calls.length;

      let btnDocTop = 1200;
      scrollY = 700;
      docHeight = 3000;
      scrollBySpy.mockImplementation((_x: any, y: any) => {
        scrollY += Number(y || 0);
      });
      toggleBtn.getBoundingClientRect = () => ({ top: btnDocTop - scrollY } as DOMRect);

      toggleBtn.click();
      expect(pauseSpy.mock.calls.length).toBe(pausesBeforeCollapse + 1);
      expect(extraWrap.classList.contains('is-open')).toBe(false);
      expect(toggleBtn.textContent).toBe('Show all (8)');
      expect(toggleBtn.getAttribute('aria-expanded')).toBe('false');

      btnDocTop = 800;
      docHeight = 2600;
      vi.advanceTimersByTime(100);
      expect(toggleBtn.getBoundingClientRect().top).toBe(500);
      expect(scrollY).toBe(300);

      btnDocTop = 600;
      docHeight = 2400;
      vi.advanceTimersByTime(200);
      expect(toggleBtn.getBoundingClientRect().top).toBe(500);
      expect(scrollY).toBe(100);

      btnDocTop = 1200;
      docHeight = 3000;
      scrollY = 700;
      toggleBtn.click();
      scrollBySpy.mockClear();
      toggleBtn.click();
      btnDocTop = 600;
      docHeight = 3000;
      vi.advanceTimersByTime(300);
      expect(scrollBySpy).not.toHaveBeenCalled();
      expect(scrollY).toBe(700);

      btnDocTop = 1200;
      docHeight = 3000;
      scrollY = 700;
      toggleBtn.click();
      scrollBySpy.mockClear();
      toggleBtn.click();
      btnDocTop = 600;
      docHeight = 2850;
      vi.advanceTimersByTime(300);
      expect(scrollY).toBe(550);

      reduced = true;
      let isOpen = false;
      let collapsedDocHeight = 3000;
      const prevToggle = extraWrap.classList.toggle.bind(extraWrap.classList);
      vi.spyOn(extraWrap.classList, 'toggle').mockImplementation((cls, force) => {
        if (cls === 'is-open') {
          isOpen = Boolean(force);
          docHeight = isOpen ? 3000 : collapsedDocHeight;
        }
        return prevToggle(cls, force);
      });
      toggleBtn.getBoundingClientRect = () => ({ top: (isOpen ? 1200 : 600) - scrollY } as DOMRect);

      toggleBtn.click();
      scrollY = 700;
      collapsedDocHeight = 3000;
      scrollBySpy.mockClear();
      toggleBtn.click();
      expect(scrollBySpy).not.toHaveBeenCalled();
      expect(scrollY).toBe(700);

      toggleBtn.click();
      scrollY = 700;
      collapsedDocHeight = 2400;
      toggleBtn.click();
      expect(scrollY).toBe(100);
    } finally {
      document.querySelectorAll('.daiya-anisongs-group').forEach((el) => el.remove());
      if (origScrollYDesc) Object.defineProperty(window, 'scrollY', origScrollYDesc);
      else delete (window as any).scrollY;
      if (origDocScrollHeightDesc) Object.defineProperty(document.documentElement, 'scrollHeight', origDocScrollHeightDesc);
      else delete (document.documentElement as any).scrollHeight;
      window.matchMedia = originalMatchMedia;
      vi.useRealTimers();
      scrollBySpy.mockRestore();
      pauseSpy.mockRestore();
      playSpy.mockRestore();
    }
  });

  it('keeps single-version card clickable via header and animates multi-version switching across rows', () => {
    vi.useFakeTimers();
    const singleSong: SongEntry = {
      sequence: 1,
      name: '1. "Anata no Soba ni." by Riria. (eps 1-12)',
      url: 'https://v.animethemes.moe/Single.webm',
      title: 'Anata no Soba ni.'
    };
    const playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const originalMatchMedia = window.matchMedia;
    let reduced = false;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)' ? reduced : false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false
    }));

    const testTimeout = (fn: () => void, ms: number) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    };

    try {
      const singleCard = createSongCard(singleSong, [], 'OP', testTimeout);
      expect(singleCard.classList.contains('has-video')).toBe(true);
      expect(singleCard.querySelector('.daiya-anisongs-versions')).toBeNull();

      const singleHeader = singleCard.querySelector('.daiya-anisong-header') as HTMLElement;
      singleHeader.click();
      const singleWrap = singleCard.querySelector('.daiya-anisong-collapsible') as HTMLElement;
      expect(singleWrap).not.toBeNull();
      expect(singleWrap.classList.contains('is-open')).toBe(true);
      expect(singleWrap.querySelector('video')?.src).toBe('https://v.animethemes.moe/Single.webm');

      singleHeader.click();
      expect(singleWrap.classList.contains('is-open')).toBe(false);
      expect(singleCard.querySelectorAll('.daiya-anisong-collapsible')).toHaveLength(1);
      vi.advanceTimersByTime(260);
      expect(singleCard.querySelectorAll('.daiya-anisong-collapsible')).toHaveLength(0);

      const multiSong: SongEntry = {
        sequence: 1,
        name: '1. "Tokimeki Un Deux Trois♪" by Magic Vision Hirome-tai',
        url: 'https://v.animethemes.moe/NiaListon-ED1.webm',
        title: 'Tokimeki Un Deux Trois♪',
        versions: [
          { version: 1, label: 'v1', episodes: '2, 5', notes: 'scissors', url: 'https://v.animethemes.moe/NiaListon-ED1.webm' },
          { version: 2, label: 'v2', episodes: '3, 6', notes: 'rock', url: 'https://v.animethemes.moe/NiaListon-ED1v2.webm' },
          { version: 3, label: 'v3', episodes: '4', notes: 'paper', url: 'https://v.animethemes.moe/NiaListon-ED1v3.webm' }
        ]
      };

      const multiCard = createSongCard(multiSong, [], 'ED', testTimeout);
      expect(multiCard.classList.contains('has-versions')).toBe(true);
      expect(multiCard.classList.contains('has-video')).toBe(false);

      const multiHeader = multiCard.querySelector('.daiya-anisong-header') as HTMLElement;
      multiHeader.click();
      expect(multiCard.querySelectorAll('video')).toHaveLength(0);

      const versionsList = multiCard.querySelector('.daiya-anisongs-versions') as HTMLElement;
      const rows = multiCard.querySelectorAll<HTMLElement>('.daiya-anisong-version');
      expect(rows).toHaveLength(3);
      expect(rows[0].querySelector('.daiya-anisong-version-tag')?.textContent).toBe('v1');
      expect(rows[0].querySelector('.daiya-anisong-version-meta')?.textContent).toBe('(eps 2, 5) — scissors');
      expect(rows[1].querySelector('.daiya-anisong-version-tag')?.textContent).toBe('v2');
      expect(rows[1].querySelector('.daiya-anisong-version-meta')?.textContent).toBe('(eps 3, 6) — rock');
      expect(rows[2].querySelector('.daiya-anisong-version-tag')?.textContent).toBe('v3');
      expect(rows[2].querySelector('.daiya-anisong-version-meta')?.textContent).toBe('(ep 4) — paper');

      rows[0].click();
      const wrapV1 = rows[0].nextElementSibling as HTMLElement;
      expect(wrapV1?.classList.contains('daiya-anisong-collapsible')).toBe(true);
      expect(wrapV1?.classList.contains('is-open')).toBe(true);
      expect(wrapV1?.querySelector('video')?.src).toBe('https://v.animethemes.moe/NiaListon-ED1.webm');
      expect(rows[0].classList.contains('is-active')).toBe(true);

      const pausesBeforeSwitch = pauseSpy.mock.calls.length;
      rows[1].click();
      expect(pauseSpy.mock.calls.length).toBe(pausesBeforeSwitch + 1);
      const wrapV2 = rows[1].nextElementSibling as HTMLElement;
      expect(wrapV1.classList.contains('is-open')).toBe(false);
      expect(wrapV2?.classList.contains('daiya-anisong-collapsible')).toBe(true);
      expect(wrapV2?.classList.contains('is-open')).toBe(true);
      expect(wrapV2?.querySelector('video')?.src).toBe('https://v.animethemes.moe/NiaListon-ED1v2.webm');
      expect(rows[0].classList.contains('is-active')).toBe(false);
      expect(rows[1].classList.contains('is-active')).toBe(true);

      rows[0].click();
      expect(multiCard.querySelectorAll('.daiya-anisong-collapsible')).toHaveLength(2);
      expect(wrapV1.classList.contains('is-open')).toBe(true);
      expect(wrapV2.classList.contains('is-open')).toBe(false);

      vi.advanceTimersByTime(260);
      expect(multiCard.querySelectorAll('.daiya-anisong-collapsible')).toHaveLength(1);
      expect(Array.from(versionsList.children)).toEqual([rows[0], wrapV1, rows[1], rows[2]]);

      reduced = true;
      rows[1].click();
      expect(multiCard.querySelectorAll('.daiya-anisong-collapsible')).toHaveLength(1);
      const wrapV2Immediate = rows[1].nextElementSibling as HTMLElement;
      expect(Array.from(versionsList.children)).toEqual([rows[0], rows[1], wrapV2Immediate, rows[2]]);

      rows[1].click();
      expect(multiCard.querySelectorAll('.daiya-anisong-collapsible')).toHaveLength(0);
      expect(Array.from(versionsList.children)).toEqual([rows[0], rows[1], rows[2]]);
    } finally {
      window.matchMedia = originalMatchMedia;
      vi.useRealTimers();
      playSpy.mockRestore();
      pauseSpy.mockRestore();
    }
  });
});

describe('AniSongs: Cycle 1 Bug Fixes (BUG-61..BUG-64)', () => {
  it('BUG-61: rejects unsafe icon schemes, escapes preset fields in renderUI, and binds image fallback programmatically', async () => {
    for (const badIcon of [
      'javascript:alert(1)',
      '  javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd'
    ]) {
      const check = validateAniSongsConfig({
        active: ['evil'],
        presets: [{ id: 'evil', name: 'Evil', url: 'https://example.com/{title}', icon: badIcon }]
      });
      expect(check.valid).toBe(false);
    }

    const okCheck = validateAniSongsConfig({
      active: ['good'],
      presets: [{ id: 'good', name: 'Good', url: 'https://example.com/{title}', icon: '  http://example.com/icon.png  ' }]
    });
    expect(okCheck.valid).toBe(true);
    expect(okCheck.config?.presets[0].icon).toBe('http://example.com/icon.png');

    const xssName = '<img src=x onerror=alert(1)> "quote" & <script>window.__xss=1</script>';
    const xssUrl = 'https://example.com/?q={title}&x="><svg onload=alert(1)>';
    const validIcon = 'https://example.com/icon.png';

    const onApply = vi.fn();
    let modalBackdrop!: HTMLElement;
    const windowAlertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const ctxAlertSpy = vi.fn().mockResolvedValue(undefined);

    try {
      const edAc = new AbortController();
      openAniSongsModal({
        value: {
          active: ['xss_active'],
          presets: [
            { id: 'xss_active', name: xssName, url: xssUrl, icon: validIcon },
            { id: 'xss_inactive', name: '<b>Inactive</b>', url: 'https://example.org/{title}', icon: validIcon }
          ]
        },
        onApply,
        signal: edAc.signal,
        getId: (n) => `test-${n || 'id'}`,
        addStyle: vi.fn(),
        listen: (target, type, listener, opts) => {
          target.addEventListener(type, listener as EventListener, opts);
          return () => target.removeEventListener(type, listener as EventListener, opts);
        },
        timeout: (fn, ms) => {
          const id = setTimeout(fn, ms);
          return () => clearTimeout(id);
        },
        observe: () => () => {},
        onCleanup: vi.fn(),
        confirm: vi.fn().mockResolvedValue(true),
        alert: ctxAlertSpy,
        toast: { show: vi.fn(), success: vi.fn(), error: vi.fn() },
        modal: ({ id, bodyHtml, footerHtml }) => {
          const modalAc = new AbortController();
          const modalCleanups: Array<() => void> = [];
          const modalId = id || 'anisongs-modal';
          const backdrop = document.createElement('div');
          backdrop.id = modalId;
          backdrop.innerHTML = `${bodyHtml || ''}${footerHtml || ''}`;
          const close = () => {
            modalAc.abort();
            backdrop.remove();
            for (const fn of modalCleanups.splice(0)) fn();
          };
          backdrop.addEventListener('click', (e) => {
            const target = e.target instanceof Element ? e.target : null;
            if (e.target === backdrop || target?.closest('[data-ala-close]')) close();
          });
          document.body.appendChild(backdrop);
          modalBackdrop = backdrop;
          return {
            id: modalId,
            selector: `#${modalId}`,
            signal: modalAc.signal,
            backdrop,
            sheet: backdrop,
            body: backdrop,
            footer: backdrop,
            close,
            listen: (target, type, listener, opts) => {
              target.addEventListener(type, listener, opts);
              const off = () => target.removeEventListener(type, listener, opts);
              modalCleanups.push(off);
              return off;
            },
            timeout: () => () => {},
            onCleanup: (fn) => modalCleanups.push(fn)
          };
        }
      });

      expect(modalBackdrop.querySelectorAll('script')).toHaveLength(0);
      expect(modalBackdrop.querySelectorAll('svg')).toHaveLength(0);
      expect(modalBackdrop.querySelectorAll('img[src="x"]')).toHaveLength(0);

      const activeNameEl = modalBackdrop.querySelector('#ala-as-active-list .ala-as-item-name') as HTMLElement;
      const activeUrlEl = modalBackdrop.querySelector('#ala-as-active-list .ala-as-item-url') as HTMLElement;
      expect(activeNameEl.textContent).toBe(xssName);
      expect(activeUrlEl.textContent).toBe(xssUrl);

      const chipSpan = modalBackdrop.querySelector('#ala-as-available-chips .ala-as-chip span') as HTMLElement;
      expect(chipSpan.textContent).toBe('+ <b>Inactive</b>');

      const icons = modalBackdrop.querySelectorAll<HTMLImageElement>('img.ala-as-item-icon');
      expect(icons.length).toBeGreaterThanOrEqual(2);
      icons.forEach((img) => {
        expect(img.getAttribute('onerror')).toBeNull();
      });

      icons[0].dispatchEvent(new Event('error'));
      expect(icons[0].src).toBe('https://www.google.com/s2/favicons?domain=youtube.com&sz=32');

      const nameInput = modalBackdrop.querySelector('#ala-as-in-name') as HTMLInputElement;
      const urlInput = modalBackdrop.querySelector('#ala-as-in-url') as HTMLInputElement;
      const iconInput = modalBackdrop.querySelector('#ala-as-in-icon') as HTMLInputElement;
      const saveBtn = modalBackdrop.querySelector('#ala-as-btn-save-preset') as HTMLButtonElement;

      nameInput.value = 'Bad Icon Preset';
      urlInput.value = 'https://example.com/{title}';
      iconInput.value = 'javascript:alert(1)';
      saveBtn.click();
      await Promise.resolve();

      expect(ctxAlertSpy).toHaveBeenCalledTimes(1);
      expect(windowAlertSpy).not.toHaveBeenCalled();
      expect(modalBackdrop.querySelectorAll('#ala-as-preset-list .ala-as-item')).toHaveLength(2);
    } finally {
      modalBackdrop?.remove();
      windowAlertSpy.mockRestore();
    }
  });

  it('IMP-10: uses async ec.confirm / ec.alert / ec.toast with re-entrancy guards in openAniSongsModal', async () => {
    const windowAlertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const windowConfirmSpy = vi.spyOn(window, 'confirm').mockImplementation(() => true);
    const onApply = vi.fn();

    let resolveConfirm!: (v: boolean) => void;
    let resolveAlert!: () => void;
    const confirmMock = vi.fn().mockImplementation(
      () =>
        new Promise<boolean>((res) => {
          resolveConfirm = res;
        })
    );
    const alertMock = vi.fn().mockImplementation(
      () =>
        new Promise<void>((res) => {
          resolveAlert = res;
        })
    );
    const toastMock = { show: vi.fn(), success: vi.fn(), error: vi.fn() };
    const origClipboard = navigator.clipboard;
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: writeTextMock }
    });

    let modalBackdrop!: HTMLElement;
    const edAc = new AbortController();

    try {
      openAniSongsModal({
        value: {
          active: ['p1'],
          presets: [
            { id: 'p1', name: 'One', url: 'https://example.com/{title}', icon: 'https://example.com/1.png' },
            { id: 'p2', name: 'Two', url: 'https://example.org/{title}', icon: 'https://example.org/2.png' }
          ]
        },
        onApply,
        signal: edAc.signal,
        getId: (n) => `test-${n || 'id'}`,
        addStyle: vi.fn(),
        listen: (target, type, listener, opts) => {
          target.addEventListener(type, listener as EventListener, opts);
          return () => target.removeEventListener(type, listener as EventListener, opts);
        },
        timeout: (fn, ms) => {
          const id = setTimeout(fn, ms);
          return () => clearTimeout(id);
        },
        observe: () => () => {},
        onCleanup: vi.fn(),
        confirm: confirmMock,
        alert: alertMock,
        toast: toastMock,
        modal: ({ id, bodyHtml, footerHtml }) => {
          const modalAc = new AbortController();
          const modalCleanups: Array<() => void> = [];
          const modalId = id || 'anisongs-modal';
          const backdrop = document.createElement('div');
          backdrop.id = modalId;
          backdrop.innerHTML = `${bodyHtml || ''}${footerHtml || ''}`;
          const close = () => {
            modalAc.abort();
            backdrop.remove();
            for (const fn of modalCleanups.splice(0)) fn();
          };
          backdrop.addEventListener('click', (e) => {
            const target = e.target instanceof Element ? e.target : null;
            if (e.target === backdrop || target?.closest('[data-ala-close]')) close();
          });
          document.body.appendChild(backdrop);
          modalBackdrop = backdrop;
          return {
            id: modalId,
            selector: `#${modalId}`,
            signal: modalAc.signal,
            backdrop,
            sheet: backdrop,
            body: backdrop,
            footer: backdrop,
            close,
            listen: (target, type, listener, opts) => {
              target.addEventListener(type, listener, opts);
              const off = () => target.removeEventListener(type, listener, opts);
              modalCleanups.push(off);
              return off;
            },
            timeout: () => () => {},
            onCleanup: (fn) => modalCleanups.push(fn)
          };
        }
      });

      // 1. Delete preset uses async confirm and prevents re-entrant clicks while pending
      const delBtns = modalBackdrop.querySelectorAll<HTMLButtonElement>('.ala-as-btn-del-preset');
      expect(delBtns).toHaveLength(2);
      delBtns[1].click();
      expect(delBtns[1].disabled).toBe(true);
      delBtns[0].click(); // ignored while pending
      expect(confirmMock).toHaveBeenCalledTimes(1);

      resolveConfirm(true);
      await Promise.resolve();
      await Promise.resolve();
      expect(modalBackdrop.querySelectorAll('.ala-as-btn-del-preset')).toHaveLength(1);

      // 2. Deleting the last remaining preset uses async alert with button guard
      const lastDelBtn = modalBackdrop.querySelector<HTMLButtonElement>('.ala-as-btn-del-preset')!;
      lastDelBtn.click();
      expect(lastDelBtn.disabled).toBe(true);
      lastDelBtn.click();
      expect(alertMock).toHaveBeenCalledTimes(1);
      resolveAlert();
      await Promise.resolve();
      await Promise.resolve();
      expect(lastDelBtn.disabled).toBe(false);

      // 3. Copy JSON uses toast.success without window.alert
      const copyBtn = modalBackdrop.querySelector<HTMLButtonElement>('#ala-as-btn-copy-json')!;
      copyBtn.click();
      await Promise.resolve();
      await Promise.resolve();
      expect(writeTextMock).toHaveBeenCalledTimes(1);
      expect(toastMock.success).toHaveBeenCalledWith('Copied configuration to clipboard!');

      // 4. Reset defaults uses async confirm and guards against re-entrant clicks
      const resetBtn = modalBackdrop.querySelector<HTMLButtonElement>('#ala-as-btn-reset-defaults')!;
      resetBtn.click();
      expect(resetBtn.disabled).toBe(true);
      resetBtn.click();
      expect(confirmMock).toHaveBeenCalledTimes(2);
      resolveConfirm(false);
      await Promise.resolve();
      await Promise.resolve();
      expect(resetBtn.disabled).toBe(false);
      expect(modalBackdrop.querySelectorAll('#ala-as-preset-list .ala-as-item')).toHaveLength(1);

      expect(windowAlertSpy).not.toHaveBeenCalled();
      expect(windowConfirmSpy).not.toHaveBeenCalled();
    } finally {
      modalBackdrop?.remove();
      if (origClipboard !== undefined) {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: origClipboard });
      }
      windowAlertSpy.mockRestore();
      windowConfirmSpy.mockRestore();
    }
  });

  it('BUG-62: stops followElementWhileCollapsing rAF loop via onCleanup and when detached from DOM', () => {
    vi.useFakeTimers();
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const scrollBySpy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    const cancelRafSpy = vi.spyOn(window, 'cancelAnimationFrame');
    const originalMatchMedia = window.matchMedia;
    const origScrollYDesc = Object.getOwnPropertyDescriptor(window, 'scrollY');
    const origDocScrollHeightDesc = Object.getOwnPropertyDescriptor(document.documentElement, 'scrollHeight');

    let scrollY = 700;
    let docHeight = 3000;
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: false,
      media: '',
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false
    }));
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, get: () => docHeight });

    try {
      const songs: SongEntry[] = Array.from({ length: 7 }, (_, i) => ({
        sequence: i + 1,
        name: `${i + 1}. "OP ${i + 1}"`,
        url: null
      }));
      const cleanups: Array<() => void> = [];
      const group1 = createSongGroup(
        'Openings',
        songs,
        [],
        'OP',
        undefined,
        (fn, ms) => {
          const id = setTimeout(fn, ms);
          return () => clearTimeout(id);
        },
        (fn) => cleanups.push(fn)
      );
      document.body.appendChild(group1);

      const toggle1 = group1.querySelector('.daiya-anisongs-toggle') as HTMLButtonElement;
      let btnDocTop = 1200;
      toggle1.getBoundingClientRect = () => ({ top: btnDocTop - scrollY } as DOMRect);

      toggle1.click();
      expect(cleanups).toHaveLength(0);

      toggle1.click();
      expect(cleanups).toHaveLength(1);

      btnDocTop = 800;
      docHeight = 2600;
      cleanups[0]();
      expect(cancelRafSpy).toHaveBeenCalled();

      scrollBySpy.mockClear();
      vi.advanceTimersByTime(100);
      expect(scrollBySpy).not.toHaveBeenCalled();
      group1.remove();

      scrollY = 700;
      docHeight = 3000;
      cancelRafSpy.mockClear();
      const group2 = createSongGroup('Openings', songs, [], 'OP');
      document.body.appendChild(group2);
      const toggle2 = group2.querySelector('.daiya-anisongs-toggle') as HTMLButtonElement;
      toggle2.getBoundingClientRect = () => ({ top: btnDocTop - scrollY } as DOMRect);

      toggle2.click();
      toggle2.click();

      group2.remove();
      scrollBySpy.mockClear();
      btnDocTop = 800;
      docHeight = 2500;
      vi.advanceTimersByTime(100);
      expect(cancelRafSpy).toHaveBeenCalled();
      expect(scrollBySpy).not.toHaveBeenCalled();
    } finally {
      document.querySelectorAll('.daiya-anisongs-group').forEach((el) => el.remove());
      if (origScrollYDesc) Object.defineProperty(window, 'scrollY', origScrollYDesc);
      else delete (window as any).scrollY;
      if (origDocScrollHeightDesc) Object.defineProperty(document.documentElement, 'scrollHeight', origDocScrollHeightDesc);
      else delete (document.documentElement as any).scrollHeight;
      window.matchMedia = originalMatchMedia;
      vi.useRealTimers();
      cancelRafSpy.mockRestore();
      scrollBySpy.mockRestore();
      pauseSpy.mockRestore();
    }
  });

  it('BUG-63: does not cache failed or aborted AnimeThemes fetches and re-fetches expired cache entries in-session', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const baseTime = new Date('2026-01-01T00:00:00Z').getTime();
    vi.setSystemTime(baseTime);

    try {
      const [observer, settings, registry, anilist] = await Promise.all([
        import('../src/core/observer'),
        import('../src/settings/settings'),
        import('../src/core/registry'),
        import('../src/api/anilist')
      ]);

      const querySpy = vi.spyOn(anilist.anilistApiClient, 'query').mockResolvedValue({
        Media: {
          title: { userPreferred: 'Test Anime', english: 'Test Anime', romaji: 'Test Anime', native: 'テスト' },
          seasonYear: 2026,
          season: 'WINTER'
        }
      });

      registry.configureCoreServices({
        api: anilist.anilistApiClient,
        session: anilist.AniList.session
      });

      await import('../src/modules/anisongs/index');
      settings.Settings.set('aniSongsEnabled', true);

      let atCalls = 0;
      let mode: 'fail' | 'abort-on-dispose' | 'ok' = 'fail';
      let songVersion = 1;
      let disposeModuleAfterAtRequest = false;

      const gmReqMock = (globalThis.GM_xmlhttpRequest as ReturnType<typeof vi.fn>).mockImplementation((opts: any) => {
        const url = String(opts.url || '');
        if (url.includes('rs.animethemes.moe')) {
          atCalls++;
          if (mode === 'fail') {
            Promise.resolve().then(() => opts.onload?.({ status: 500, responseText: 'Internal Server Error' }));
            return { abort: vi.fn() };
          }
          if (mode === 'abort-on-dispose') {
            if (disposeModuleAfterAtRequest) {
              Promise.resolve().then(() => {
                settings.Settings.set('aniSongsEnabled', false);
                registry.createModuleHost().reload(['aniSongs']);
              });
            }
            return {
              abort: vi.fn(() => {
                opts.onerror?.({ error: 'aborted' });
              })
            };
          }
          const ver = songVersion;
          Promise.resolve().then(() =>
            opts.onload?.({
              status: 200,
              responseText: JSON.stringify({
                data: {
                  filterAnimeByExternalSite: [
                    {
                      title: { romaji: 'Test Anime', native: 'テスト' },
                      themes: [
                        {
                          type: 'OP',
                          sequence: 1,
                          song: { title: { romaji: `Theme v${ver}` }, staff: [] },
                          entries: [{ version: 1, videos: { nodes: [] } }]
                        }
                      ]
                    }
                  ]
                }
              })
            })
          );
          return { abort: vi.fn() };
        }
        return { abort: vi.fn() };
      });
      void gmReqMock;
      void querySpy;

      document.body.innerHTML = '<div class="overview"></div>';
      history.replaceState({}, '', '/anime/4242');

      const flushMicrotasks = async () => {
        for (let i = 0; i < 12; i++) await Promise.resolve();
      };

      await registry.bootModuleForTest('aniSongs');
      await flushMicrotasks();
      vi.advanceTimersByTime(600);

      expect(atCalls).toBe(1);
      const cacheKey = 'ala_mod_aniSongs_daiya_anisongs_cache_v8';
      expect(globalThis.GM_getValue(cacheKey)).toBeUndefined();

      mode = 'ok';
      vi.advanceTimersByTime(31_000);
      history.pushState({}, '', '/home');
      await flushMicrotasks();
      history.pushState({}, '', '/anime/4242');
      await flushMicrotasks();
      vi.advanceTimersByTime(600);

      expect(atCalls).toBe(2);
      expect(document.body.textContent).toContain('Theme v1');
      const rawCached = globalThis.GM_getValue(cacheKey);
      const cached = typeof rawCached === 'string' ? JSON.parse(rawCached) : rawCached;
      expect(cached['4242']?.data?.OP).toHaveLength(1);

      songVersion = 2;
      vi.advanceTimersByTime(7 * 86400_000 + 1000);
      history.pushState({}, '', '/anime/9999');
      await flushMicrotasks();
      history.pushState({}, '', '/anime/4242');
      await flushMicrotasks();
      vi.advanceTimersByTime(600);

      expect(atCalls).toBe(4);
      expect(document.body.textContent).toContain('Theme v2');

      mode = 'abort-on-dispose';
      disposeModuleAfterAtRequest = true;
      history.pushState({}, '', '/anime/5555');
      await flushMicrotasks();
      vi.advanceTimersByTime(600);

      expect(atCalls).toBe(5);
      const rawAfterAbort = globalThis.GM_getValue(cacheKey);
      const cacheAfterAbort = typeof rawAfterAbort === 'string' ? JSON.parse(rawAfterAbort) : rawAfterAbort;
      expect(cacheAfterAbort['5555']).toBeUndefined();
      void observer;
    } finally {
      vi.useRealTimers();
    }
  });

  it('BUG-64: uses tracked timeout registrar for fallback collapse timers on the first 5 songs', () => {
    vi.useFakeTimers();
    const playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: false,
      media: '',
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false
    }));

    const cancelFns: Array<() => void> = [];
    const trackedTimeout = vi.fn((fn: () => void, ms: number) => {
      const id = setTimeout(fn, ms);
      const cancel = () => clearTimeout(id);
      cancelFns.push(cancel);
      return cancel;
    });

    try {
      const songs: SongEntry[] = Array.from({ length: 6 }, (_, i) => ({
        sequence: i + 1,
        name: `${i + 1}. "OP ${i + 1}"`,
        url: `https://v.animethemes.moe/OP${i + 1}.webm`
      }));

      const group = createSongGroup('Openings', songs, [], 'OP', undefined, trackedTimeout);
      const firstFiveHeader = group.querySelector('.daiya-anisong-entry .daiya-anisong-header') as HTMLElement;

      firstFiveHeader.click();
      expect(group.querySelector('.daiya-anisong-collapsible')).not.toBeNull();

      firstFiveHeader.click();
      expect(trackedTimeout).toHaveBeenCalledTimes(1);
      expect(trackedTimeout).toHaveBeenCalledWith(expect.any(Function), 260);

      cancelFns[0]();
      vi.advanceTimersByTime(300);
      expect(group.querySelector('.daiya-anisong-collapsible')).not.toBeNull();
    } finally {
      window.matchMedia = originalMatchMedia;
      vi.useRealTimers();
      playSpy.mockRestore();
      pauseSpy.mockRestore();
    }
  });

  it('IMP-04: delegates followElementWhileCollapsing frames to tracked raf registrar and cancels via its cleanup handle', () => {
    const scrollBySpy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    const originalMatchMedia = window.matchMedia;
    const origScrollYDesc = Object.getOwnPropertyDescriptor(window, 'scrollY');
    const origDocScrollHeightDesc = Object.getOwnPropertyDescriptor(document.documentElement, 'scrollHeight');

    let scrollY = 700;
    let docHeight = 3000;
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: false,
      media: '',
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false
    }));
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, get: () => docHeight });

    const pendingFrames: FrameRequestCallback[] = [];
    const cancelSpies: Array<ReturnType<typeof vi.fn>> = [];
    const trackedRaf = vi.fn((fn: FrameRequestCallback) => {
      pendingFrames.push(fn);
      const cancel = vi.fn();
      cancelSpies.push(cancel);
      return cancel;
    });
    const cleanups: Array<() => void> = [];

    try {
      const songs: SongEntry[] = Array.from({ length: 7 }, (_, i) => ({
        sequence: i + 1,
        name: `${i + 1}. "OP ${i + 1}"`,
        url: null
      }));
      const group = createSongGroup(
        'Openings',
        songs,
        [],
        'OP',
        undefined,
        () => () => {},
        (fn) => cleanups.push(fn),
        trackedRaf
      );
      document.body.appendChild(group);

      const toggle = group.querySelector('.daiya-anisongs-toggle') as HTMLButtonElement;
      let btnDocTop = 1200;
      toggle.getBoundingClientRect = () => ({ top: btnDocTop - scrollY } as DOMRect);

      toggle.click();
      toggle.click();
      expect(trackedRaf).toHaveBeenCalledTimes(1);

      btnDocTop = 800;
      docHeight = 2600;
      pendingFrames[0](16);
      expect(trackedRaf).toHaveBeenCalledTimes(2);
      expect(scrollBySpy).toHaveBeenCalled();

      cleanups[0]();
      expect(cancelSpies[1]).toHaveBeenCalledTimes(1);
    } finally {
      document.querySelectorAll('.daiya-anisongs-group').forEach((el) => el.remove());
      if (origScrollYDesc) Object.defineProperty(window, 'scrollY', origScrollYDesc);
      else delete (window as any).scrollY;
      if (origDocScrollHeightDesc) Object.defineProperty(document.documentElement, 'scrollHeight', origDocScrollHeightDesc);
      else delete (document.documentElement as any).scrollHeight;
      window.matchMedia = originalMatchMedia;
      scrollBySpy.mockRestore();
    }
  });
});

describe('AniSongs: Cycle 2 Bug Fixes (BUG-36..BUG-39)', () => {
  it('BUG-36: tears down #ala-aniSongs-root on route exit and registers at most one cleanup per song group across repeated collapses', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const scrollBySpy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    const cancelRafSpy = vi.spyOn(window, 'cancelAnimationFrame');
    const originalMatchMedia = window.matchMedia;
    const origScrollYDesc = Object.getOwnPropertyDescriptor(window, 'scrollY');
    const origDocScrollHeightDesc = Object.getOwnPropertyDescriptor(document.documentElement, 'scrollHeight');

    let scrollY = 700;
    let docHeight = 3000;
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: false,
      media: '',
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false
    }));
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, get: () => docHeight });

    try {
      // Part 1: createSongGroup registers at most one cleanup closure across repeated collapse toggles
      const songs: SongEntry[] = Array.from({ length: 7 }, (_, i) => ({
        sequence: i + 1,
        name: `${i + 1}. "OP ${i + 1}"`,
        url: null
      }));
      const cleanups: Array<() => void> = [];
      const group = createSongGroup(
        'Openings',
        songs,
        [],
        'OP',
        undefined,
        (fn, ms) => {
          const id = setTimeout(fn, ms);
          return () => clearTimeout(id);
        },
        (fn) => cleanups.push(fn)
      );
      document.body.appendChild(group);
      const toggle = group.querySelector('.daiya-anisongs-toggle') as HTMLButtonElement;
      let btnDocTop = 1200;
      toggle.getBoundingClientRect = () => ({ top: btnDocTop - scrollY } as DOMRect);

      for (let i = 0; i < 4; i++) {
        toggle.click(); // expand
        toggle.click(); // collapse
      }
      expect(cleanups).toHaveLength(1);

      cleanups[0]();
      expect(cancelRafSpy).toHaveBeenCalled();
      group.remove();

      // Part 2: leaving /anime/:id removes #ala-aniSongs-root even if .overview persists
      const [settings, registry, anilist] = await Promise.all([
        import('../src/settings/settings'),
        import('../src/core/registry'),
        import('../src/api/anilist')
      ]);

      vi.spyOn(anilist.anilistApiClient, 'query').mockResolvedValue({
        Media: {
          title: { userPreferred: 'Route Exit Anime', english: 'Route Exit Anime', romaji: 'Route Exit Anime', native: 'テスト' },
          seasonYear: 2026,
          season: 'SPRING'
        }
      });
      registry.configureCoreServices({
        api: anilist.anilistApiClient,
        session: anilist.AniList.session
      });
      await import('../src/modules/anisongs/index');
      settings.Settings.set('aniSongsEnabled', true);

      (globalThis.GM_xmlhttpRequest as ReturnType<typeof vi.fn>).mockImplementation((opts: any) => {
        if (String(opts.url || '').includes('rs.animethemes.moe')) {
          Promise.resolve().then(() =>
            opts.onload?.({
              status: 200,
              responseText: JSON.stringify({
                data: {
                  filterAnimeByExternalSite: [
                    {
                      title: { romaji: 'Route Exit Anime', native: 'テスト' },
                      themes: [
                        {
                          type: 'OP',
                          sequence: 1,
                          song: { title: { romaji: 'Exit Theme' }, staff: [] },
                          entries: [{ version: 1, videos: { nodes: [] } }]
                        }
                      ]
                    }
                  ]
                }
              })
            })
          );
        }
        return { abort: vi.fn() };
      });

      document.body.innerHTML = '<div class="overview"></div>';
      history.replaceState({}, '', '/anime/7777');

      const flushMicrotasks = async () => {
        for (let i = 0; i < 12; i++) await Promise.resolve();
      };

      await registry.bootModuleForTest('aniSongs');
      await flushMicrotasks();
      vi.advanceTimersByTime(600);

      expect(document.getElementById('ala-aniSongs-root')).not.toBeNull();
      expect(document.body.textContent).toContain('Exit Theme');

      // Navigate away while .overview stays in DOM
      history.pushState({}, '', '/home');
      await flushMicrotasks();

      expect(document.querySelector('.overview')).not.toBeNull();
      expect(document.getElementById('ala-aniSongs-root')).toBeNull();
    } finally {
      document.querySelectorAll('.daiya-anisongs-group').forEach((el) => el.remove());
      if (origScrollYDesc) Object.defineProperty(window, 'scrollY', origScrollYDesc);
      else delete (window as any).scrollY;
      if (origDocScrollHeightDesc) Object.defineProperty(document.documentElement, 'scrollHeight', origDocScrollHeightDesc);
      else delete (document.documentElement as any).scrollHeight;
      window.matchMedia = originalMatchMedia;
      vi.useRealTimers();
      cancelRafSpy.mockRestore();
      scrollBySpy.mockRestore();
    }
  });

  it('BUG-37: passes type ANIME to Media query, skips 7-day caching on AniList rejection, and aborts cleanly on route exit', async () => {
    vi.resetModules();
    vi.useFakeTimers();

    try {
      const [settings, registry, anilist] = await Promise.all([
        import('../src/settings/settings'),
        import('../src/core/registry'),
        import('../src/api/anilist')
      ]);

      let alMode: 'reject' | 'ok' | 'hang' = 'reject';
      let capturedQuery = '';
      let capturedVars: Record<string, any> | undefined;
      let capturedSignal: AbortSignal | undefined;

      const querySpy = vi.spyOn(anilist.anilistApiClient, 'query').mockImplementation((q, vars, opts) => {
        capturedQuery = q;
        capturedVars = vars;
        capturedSignal = typeof opts === 'object' ? opts?.signal : undefined;
        if (alMode === 'reject') {
          return Promise.reject(new Error('HTTP 500'));
        }
        if (alMode === 'hang') {
          return new Promise((_resolve, reject) => {
            capturedSignal?.addEventListener(
              'abort',
              () => {
                const err = new Error('Request aborted');
                err.name = 'AbortError';
                reject(err);
              },
              { once: true }
            );
          });
        }
        return Promise.resolve({
          Media: {
            title: { userPreferred: 'Resolved Anime', english: 'Resolved Anime EN', romaji: 'Resolved Anime', native: '解決アニメ' },
            seasonYear: 2026,
            season: 'SUMMER'
          }
        });
      });

      registry.configureCoreServices({
        api: anilist.anilistApiClient,
        session: anilist.AniList.session
      });
      await import('../src/modules/anisongs/index');
      settings.Settings.set('aniSongsEnabled', true);

      let atMode: 'ok' | 'hang' = 'ok';
      let atAborted = false;
      (globalThis.GM_xmlhttpRequest as ReturnType<typeof vi.fn>).mockImplementation((opts: any) => {
        if (String(opts.url || '').includes('rs.animethemes.moe')) {
          if (atMode === 'hang') {
            return {
              abort: vi.fn(() => {
                atAborted = true;
                opts.onerror?.({ error: 'aborted' });
              })
            };
          }
          Promise.resolve().then(() =>
            opts.onload?.({
              status: 200,
              responseText: JSON.stringify({
                data: {
                  filterAnimeByExternalSite: [
                    {
                      title: { romaji: 'Fallback Romaji', native: 'フォールバック' },
                      themes: [
                        {
                          type: 'OP',
                          sequence: 1,
                          song: { title: { romaji: 'Test OP' }, staff: [] },
                          entries: [{ version: 1, videos: { nodes: [] } }]
                        }
                      ]
                    }
                  ]
                }
              })
            })
          );
        }
        return { abort: vi.fn() };
      });

      document.body.innerHTML = '<div class="overview"></div>';
      history.replaceState({}, '', '/anime/8888');

      const flushMicrotasks = async () => {
        for (let i = 0; i < 12; i++) await Promise.resolve();
      };

      await registry.bootModuleForTest('aniSongs');
      await flushMicrotasks();
      vi.advanceTimersByTime(600);

      expect(capturedQuery).toContain('$type: MediaType');
      expect(capturedQuery).toContain('Media(id: $id, type: $type)');
      expect(capturedVars).toEqual({ id: 8888, type: 'ANIME' });

      // Renders fallback data for current visit, but does NOT persist to persistent cache
      expect(document.body.textContent).toContain('Test OP');
      const cacheKey = 'ala_mod_aniSongs_daiya_anisongs_cache_v8';
      expect(globalThis.GM_getValue(cacheKey)).toBeUndefined();

      // Subsequent visit after AniList recovers re-queries and persists for 7 days
      alMode = 'ok';
      history.pushState({}, '', '/home');
      await flushMicrotasks();
      history.pushState({}, '', '/anime/8888');
      await flushMicrotasks();
      vi.advanceTimersByTime(600);

      expect(querySpy).toHaveBeenCalledTimes(2);
      const rawCached = globalThis.GM_getValue(cacheKey);
      const cached = typeof rawCached === 'string' ? JSON.parse(rawCached) : rawCached;
      expect(cached['8888']?.data?.OP?.[0]?.animeEn).toBe('Resolved Anime EN');

      // Route exit aborts in-flight requests cleanly without persisting
      alMode = 'hang';
      atMode = 'hang';
      history.pushState({}, '', '/anime/8889');
      await flushMicrotasks();
      expect(capturedSignal?.aborted).toBe(false);

      history.pushState({}, '', '/home');
      await flushMicrotasks();
      expect(capturedSignal?.aborted).toBe(true);
      expect(atAborted).toBe(true);
      const rawAfterExit = globalThis.GM_getValue(cacheKey);
      const cacheAfterExit = typeof rawAfterExit === 'string' ? JSON.parse(rawAfterExit) : rawAfterExit;
      expect(cacheAfterExit['8889']).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('BUG-38: discards non-HTTP(S) resource URLs in extractRawTheme and falls back to preset search URLs', () => {
    const meta: AnimeMetaInfo = {
      animeName: 'Test Anime',
      animeRomaji: 'Test Anime',
      animeEn: 'Test Anime',
      animeJp: 'テスト',
      year: 2026,
      season: 'SPRING'
    };

    const rawTheme = {
      type: 'OP',
      sequence: 1,
      song: {
        title: { romaji: 'Safe Song' },
        staff: [{ role: 'Performance', relevance: 1, artist: { name: { main: 'Artist' } } }],
        resources: {
          nodes: [
            { site: 'SPOTIFY', link: 'javascript:alert(1)' },
            { site: 'YOUTUBE', link: '  data:text/html,<script>alert(1)</script>  ' },
            { site: 'APPLE_MUSIC', link: 'ftp://example.com/track' },
            { site: 'YOUTUBE_MUSIC', link: '  https://music.youtube.com/watch?v=abc123  ' }
          ]
        }
      },
      entries: []
    };

    const entry = parseTheme(rawTheme, meta)!;
    expect(entry).not.toBeNull();
    expect(entry.resources).toEqual({
      YOUTUBE_MUSIC: 'https://music.youtube.com/watch?v=abc123'
    });

    const spotifyPreset: SongProviderPreset = {
      id: 'spotify',
      name: 'Spotify',
      icon: 'https://example.com/spotify.png',
      url: 'https://open.spotify.com/search/{title}%20{artist}'
    };
    const ytMusicPreset: SongProviderPreset = {
      id: 'youtube_music',
      name: 'YouTube Music',
      icon: 'https://example.com/ytm.png',
      url: 'https://music.youtube.com/search?q={title}+{artist}'
    };

    const spotifyRes = resolveProviderLink(spotifyPreset, entry, 'OP');
    expect(spotifyRes.isDirect).toBe(false);
    expect(spotifyRes.url).toBe('https://open.spotify.com/search/Safe%20Song%20Artist');

    const ytmRes = resolveProviderLink(ytMusicPreset, entry, 'OP');
    expect(ytmRes.isDirect).toBe(true);
    expect(ytmRes.url).toBe('https://music.youtube.com/watch?v=abc123');

    const card = createSongCard(entry, [spotifyPreset, ytMusicPreset], 'OP');
    const links = card.querySelectorAll<HTMLAnchorElement>('.daiya-anisong-link');
    expect(links).toHaveLength(2);
    expect(links[0].href).toBe('https://open.spotify.com/search/Safe%20Song%20Artist');
    expect(links[1].href).toBe('https://music.youtube.com/watch?v=abc123');
  });

  it('BUG-39: resets editing state on Reset Defaults / Apply JSON and disambiguates colliding custom preset IDs', async () => {
    const onApply = vi.fn();
    let modalBackdrop!: HTMLElement;
    const edAc = new AbortController();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);

    try {
      openAniSongsModal({
        value: {
          active: ['custom_a'],
          presets: [
            { id: 'custom_a', name: 'Custom A', url: 'https://example.com/a/{title}', icon: 'https://example.com/a.png' },
            { id: 'dup_500', name: 'Existing 500', url: 'https://example.com/500/{title}', icon: 'https://example.com/500.png' }
          ]
        },
        onApply,
        signal: edAc.signal,
        getId: (n) => `test-${n || 'id'}`,
        addStyle: vi.fn(),
        listen: (target, type, listener, opts) => {
          target.addEventListener(type, listener as EventListener, opts);
          return () => target.removeEventListener(type, listener as EventListener, opts);
        },
        timeout: () => () => {},
        observe: () => () => {},
        onCleanup: vi.fn(),
        confirm: vi.fn().mockResolvedValue(true),
        alert: vi.fn().mockResolvedValue(undefined),
        toast: { show: vi.fn(), success: vi.fn(), error: vi.fn() },
        modal: ({ id, bodyHtml, footerHtml }) => {
          const modalAc = new AbortController();
          const modalCleanups: Array<() => void> = [];
          const modalId = id || 'anisongs-modal';
          const backdrop = document.createElement('div');
          backdrop.id = modalId;
          backdrop.innerHTML = `${bodyHtml || ''}${footerHtml || ''}`;
          const close = () => {
            modalAc.abort();
            backdrop.remove();
            for (const fn of modalCleanups.splice(0)) fn();
          };
          document.body.appendChild(backdrop);
          modalBackdrop = backdrop;
          return {
            id: modalId,
            selector: `#${modalId}`,
            signal: modalAc.signal,
            backdrop,
            sheet: backdrop,
            body: backdrop,
            footer: backdrop,
            close,
            listen: (target, type, listener, opts) => {
              target.addEventListener(type, listener, opts);
              const off = () => target.removeEventListener(type, listener, opts);
              modalCleanups.push(off);
              return off;
            },
            timeout: () => () => {},
            onCleanup: (fn) => modalCleanups.push(fn)
          };
        }
      });

      const nameInput = modalBackdrop.querySelector('#ala-as-in-name') as HTMLInputElement;
      const urlInput = modalBackdrop.querySelector('#ala-as-in-url') as HTMLInputElement;
      const iconInput = modalBackdrop.querySelector('#ala-as-in-icon') as HTMLInputElement;
      const formHeading = modalBackdrop.querySelector('#ala-as-form-heading') as HTMLElement;
      const savePresetBtn = modalBackdrop.querySelector('#ala-as-btn-save-preset') as HTMLButtonElement;
      const cancelPresetBtn = modalBackdrop.querySelector('#ala-as-btn-cancel-preset') as HTMLButtonElement;
      const jsonArea = modalBackdrop.querySelector('#ala-as-json-area') as HTMLTextAreaElement;
      const applyJsonBtn = modalBackdrop.querySelector('#ala-as-btn-apply-json') as HTMLButtonElement;
      const resetDefaultsBtn = modalBackdrop.querySelector('#ala-as-btn-reset-defaults') as HTMLButtonElement;
      const doneBtn = modalBackdrop.querySelector('#ala-as-btn-done') as HTMLButtonElement;

      // 1. Edit a preset, then Apply JSON -> form must reset (no stale editingPresetId)
      const editBtn1 = modalBackdrop.querySelector<HTMLButtonElement>('.ala-as-btn-edit-preset[data-id="custom_a"]')!;
      editBtn1.click();
      expect(formHeading.textContent).toContain('Edit Preset:');
      expect(savePresetBtn.textContent).toBe('Update Preset');
      expect(cancelPresetBtn.style.display).toBe('inline-flex');

      jsonArea.value = JSON.stringify({
        active: ['dup_500'],
        presets: [
          { id: 'dup_500', name: 'Dup', url: 'https://example.com/dup/{title}', icon: 'https://example.com/dup.png' }
        ]
      });
      applyJsonBtn.click();

      expect(formHeading.textContent).toBe('Add Custom Preset');
      expect(savePresetBtn.textContent).toBe('Add Preset');
      expect(cancelPresetBtn.style.display).toBe('none');
      expect(nameInput.value).toBe('');

      // 2. Add two presets that collide on random ID -> disambiguated uniquely
      nameInput.value = 'Dup';
      urlInput.value = 'https://example.com/one/{title}';
      iconInput.value = 'https://example.com/one.png';
      savePresetBtn.click();
      await Promise.resolve();

      nameInput.value = 'Dup';
      urlInput.value = 'https://example.com/two/{title}';
      iconInput.value = 'https://example.com/two.png';
      savePresetBtn.click();
      await Promise.resolve();

      const itemsAfterAdd = Array.from(modalBackdrop.querySelectorAll<HTMLElement>('#ala-as-preset-list .ala-as-item')).map(
        (el) => el.dataset.id
      );
      expect(itemsAfterAdd).toHaveLength(3);
      expect(new Set(itemsAfterAdd).size).toBe(3);
      expect(itemsAfterAdd).toEqual(['dup_500', 'dup_500_1', 'dup_500_2']);

      // 3. Edit a preset, then Reset Defaults -> form must reset and subsequent Add Preset works
      const editBtn2 = modalBackdrop.querySelector<HTMLButtonElement>('.ala-as-btn-edit-preset[data-id="dup_500_1"]')!;
      editBtn2.click();
      expect(savePresetBtn.textContent).toBe('Update Preset');

      resetDefaultsBtn.click();
      await Promise.resolve();
      await Promise.resolve();

      expect(formHeading.textContent).toBe('Add Custom Preset');
      expect(savePresetBtn.textContent).toBe('Add Preset');
      expect(cancelPresetBtn.style.display).toBe('none');
      expect(nameInput.value).toBe('');

      nameInput.value = 'Post Reset';
      urlInput.value = 'https://example.com/post/{title}';
      iconInput.value = 'https://example.com/post.png';
      savePresetBtn.click();
      await Promise.resolve();

      doneBtn.click();
      await Promise.resolve();
      expect(onApply).toHaveBeenCalledTimes(1);
      const savedConfig = onApply.mock.calls[0][0];
      expect(savedConfig.presets.some((p: SongProviderPreset) => p.name === 'Post Reset')).toBe(true);
    } finally {
      randomSpy.mockRestore();
      modalBackdrop?.remove();
    }
  });
});