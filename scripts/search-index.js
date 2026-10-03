/*
 * Search index generator.
 *
 * Runs inside `hexo generate`, so `publish.sh` needs no new step: the index is
 * rebuilt on every publish and lands in public/ like any other asset.
 *
 * What it writes is a FlexSearch export, not the posts themselves. The browser
 * re-hydrates the index with `import(key, data)` instead of parsing markdown,
 * which is why the payload is a few KB rather than the full text.
 *
 * Two indexes are kept apart on purpose:
 *   title — title + description + categories + tags
 *   body  — the full text
 * A hit in the first should outrank a hit in the second, and a single index
 * over both fields cannot express that.
 *
 * The tokenizer below is duplicated in themes/willowxi/source/js/willowxi.js.
 * Both copies MUST stay byte-identical in behaviour: the index is written with
 * this one and queried with that one, and FlexSearch gives no error when a
 * query is segmented differently from the documents — it just returns nothing.
 */

'use strict';

const crypto = require('crypto');
const path = require('path');

const SEGMENTER =
  typeof Intl !== 'undefined' && Intl.Segmenter
    ? new Intl.Segmenter('zh-CN', { granularity: 'word' })
    : null;

/*
 * Chinese has no spaces, so a whole word cannot be recovered by splitting on
 * whitespace. Segments from Intl.Segmenter are cut into overlapping bigrams:
 * "层叠上下文" becomes 层叠 / 叠上 / 上文 / 层叠上下文. A bigram index answers
 * "层叠" and "上下文" both, and tolerates a dropped character for free — a
 * typo costs one bigram out of several, so the intersection still clears.
 * Latin runs stay whole words, lower-cased.
 */
function tokenize(text) {
  const value = String(text == null ? '' : text);
  const out = [];

  if (!SEGMENTER) {
    // No Intl.Segmenter (very old runtimes). Fall back to character unigrams,
    // which still searches but loses phrase ranking.
    for (const ch of value.toLowerCase()) {
      if (/[\u3400-\u9fff]/.test(ch) || /\w/.test(ch)) out.push(ch);
    }
    return out;
  }

  for (const part of SEGMENTER.segment(value)) {
    const word = part.segment.trim();
    if (!word) continue;

    if (/[\u3400-\u9fff]/.test(word)) {
      if (word.length === 1) {
        out.push(word);
        continue;
      }
      for (let i = 0; i + 1 < word.length; i++) out.push(word.slice(i, i + 2));
      if (word.length > 2) out.push(word);
    } else if (/[\w]/.test(word)) {
      out.push(word.toLowerCase());
    }
  }

  return out;
}

/* Markdown/HTML leftovers that would otherwise become searchable noise. */
function plainText(input) {
  return String(input == null ? '' : input)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function uniq(list) {
  return Array.from(new Set(list.filter(Boolean)));
}

function taxonomyNames(taxonomy) {
  if (!taxonomy) return [];
  const list = typeof taxonomy.toArray === 'function' ? taxonomy.toArray() : [];
  return uniq(list.map((item) => (item && item.name ? item.name : String(item))));
}

function formatDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function postUrl(post, root) {
  const prefix = root && root !== '/' ? root.replace(/\/$/, '') : '';
  return `${prefix}/${String(post.path || '').replace(/^\//, '')}`;
}

function summaryOf(post, length) {
  const explicit = plainText(post.summary || post.description || '');
  if (explicit) return explicit;
  return plainText(post.content || post.raw || '').slice(0, length || 118);
}

/*
 * FlexSearch's export/import pair is a callback protocol, not an object:
 *   index.export((key, json) => ...)  ->  [['1.reg', '[1,2]'], ['1.map', '...']]
 *   index.import('1.reg', '[1,2]')
 * Passing the collected array straight back into import() silently yields an
 * empty index — the keys are parsed with split('.') and an array stringifies
 * to nothing that matches. The order matters too: reg before map.
 */
function exportIndex(FlexSearch, encode, entries) {
  const index = new FlexSearch.Index({ encode, cache: 64 });
  for (const [id, text] of entries) index.add(id, text);

  const chunks = [];
  index.export((key, value) => chunks.push([key, value]));
  chunks.sort((a, b) => {
    const rank = (key) => (/^[^.]+\.reg$/.test(key) ? 0 : /^[^.]+\.map$/.test(key) ? 1 : 2);
    return rank(a[0]) - rank(b[0]);
  });
  return chunks;
}

/*
 * The hash has to reach templates, and a generator is too early for that:
 * Hexo snapshots locals into `site` before any generator runs (_runGenerators
 * calls toObject() and passes the result on), so anything a generator stores
 * with hexo.locals.set() is invisible to the EJS that renders afterwards.
 * template_locals runs per route inside _routerRefresh, which is late enough.
 */
let indexHash = '';

hexo.extend.filter.register('template_locals', function (locals) {
  if (indexHash) locals.search_index_hash = indexHash;
  return locals;
});

hexo.extend.generator.register('search_index', function (locals) {
  const themeConfig = (hexo.theme && hexo.theme.config) || {};
  const search = themeConfig.search || {};

  if (search.enabled === false) return [];

  let FlexSearch;
  try {
    // eslint-disable-next-line import/no-dynamic-require
    FlexSearch = require(path.join(
      hexo.base_dir,
      'themes',
      hexo.config.theme || 'willowxi',
      'source/vendor/flexsearch/flexsearch.compact.min.js'
    ));
  } catch (error) {
    hexo.log.error('[search] FlexSearch not vendored:', error.message);
    return [];
  }

  FlexSearch = FlexSearch.FlexSearch || FlexSearch;

  const root = hexo.config.root || '/';
  const source = (locals && locals.posts) || hexo.locals.posts;
  if (!source) {
    hexo.log.warn('[search] locals.posts unavailable, index skipped');
    return [];
  }

  const posts = source
    .toArray()
    .filter((post) => post.published !== false && post.published !== undefined)
    .sort((a, b) => (b.date && a.date ? b.date - a.date : 0));

  const metas = [];
  const titleEntries = [];
  const bodyEntries = [];

  posts.forEach((post, i) => {
    const id = i + 1;
    const title = plainText(post.title || '');
    const summary = summaryOf(post, themeConfig.post && themeConfig.post.excerpt_length);
    const cats = taxonomyNames(post.categories);
    const tags = taxonomyNames(post.tags);
    const body = plainText(post.content || post.raw || '');

    metas.push({
      i: id,
      u: postUrl(post, root),
      t: title,
      d: summary,
      c: cats,
      g: tags,
      y: formatDate(post.date)
    });

    titleEntries.push([id, [title, summary, cats.join(' '), tags.join(' ')].join(' ')]);
    bodyEntries.push([id, body]);
  });

  const encode = (text) => tokenize(text);
  const payload = {
    v: 1,
    count: metas.length,
    posts: metas,
    title: exportIndex(FlexSearch, encode, titleEntries),
    body: exportIndex(FlexSearch, encode, bodyEntries),
    syn: search.synonyms || {}
  };

  const json = JSON.stringify(payload);
  const hash = crypto.createHash('sha1').update(json).digest('hex').slice(0, 10);
  const name = 'search-index.json';

  // The hash rides on the query string rather than in the filename, for two
  // reasons. Cloudflare Pages matches _headers rules by path, so a fixed name
  // lets /search-index.json be served immutable while the URL still changes
  // with the content. And the template does not have to know where the
  // generator decided to write — it only appends the hash it is handed.
  indexHash = hash;

  hexo.log.info(`[search] ${metas.length} posts -> ${name} (${(json.length / 1024).toFixed(1)} KB, ${hash})`);

  return [{ path: name, data: json }];
});