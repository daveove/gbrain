import { createHash } from 'node:crypto';
import { z } from 'zod';
import { htmlToText } from '../src/core/google/google-render.ts';

export interface ReferenceSnapshot {
  source_id: string;
  record_id: string | null;
  compiled_truth: string;
  readwise?: boolean;
}

export interface PageSnapshot extends ReferenceSnapshot {
  id: number;
  slug: string;
  title: string;
}

export interface Projection {
  caption: string;
  display_body: string;
  status: 'complete' | 'held';
  reasons: string[];
  warnings: string[];
}

const HTML_TAGS: Record<string, true> = {
  a: true, abbr: true, address: true, article: true, aside: true, audio: true, b: true, blockquote: true, body: true,
  br: true, button: true, caption: true, code: true, col: true, colgroup: true, dd: true, del: true, details: true,
  div: true, dl: true, dt: true, em: true, fieldset: true, figcaption: true, figure: true, footer: true, form: true,
  h1: true, h2: true, h3: true, h4: true, h5: true, h6: true, head: true, header: true, hr: true, html: true, i: true,
  iframe: true, img: true, input: true, label: true, li: true, link: true, main: true, mark: true, meta: true, nav: true,
  ol: true, option: true, p: true, pre: true, s: true, script: true, section: true, select: true, small: true, source: true,
  span: true, strong: true, style: true, sub: true, summary: true, sup: true, table: true, tbody: true, td: true,
  textarea: true, tfoot: true, th: true, thead: true, time: true, title: true, tr: true, u: true, ul: true, video: true, wbr: true,
};
const VOID_TAGS: Record<string, true> = {
  br: true, col: true, hr: true, img: true, input: true, link: true, meta: true, source: true, wbr: true,
};
const PRESENTATION_ATTRIBUTES: Record<string, true> = { class: true, dir: true, id: true, lang: true, style: true };
const TAG_PATTERN = /<\/?([a-z][a-z0-9:-]*)(?=[\s/>])(?:"[^"]*"|'[^']*'|[^'">])*>/gi;
const SPAN_TAG_PATTERN = /<\/?span(?=[\s/>])(?:"[^"]*"|'[^']*'|[^'">])*>/gi;
const ATTRIBUTE_PATTERN = /\s([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const ENTITY_PATTERN = /&(?:amp|lt|gt|quot|apos|nbsp|mdash|ndash|hellip|#\d+|#x[0-9a-fA-F]+);/g;
const ESCAPED_NEWLINES = /\\+(?:r\\+n|n)/g;
const READWISE_URL = /\bhttps?:\/\/(?:www\.|read\.)?readwise\.io(?=[/?#:\s"'<>]|$)/i;
const DateAttribute = z.strictObject({
  dateTimeString: z.string().refine((value) => value.trim().length > 0),
  timezone: z.string().refine((value) => value.trim().length > 0).optional(),
  hasTime: z.boolean().optional(),
});
const nodeText = z.string().min(1).nullable().catch(null);
const LenientTanaNode = z.object({
  id: nodeText,
  props: z.object({ name: nodeText, description: nodeText, _docType: nodeText, _ownerId: nodeText }).nullable().catch(null),
  children: z.array(z.unknown()).catch([]),
});
const StrictTanaNode = z.object({
  id: z.string().min(1),
  props: z.object({
    name: z.string().optional(),
    description: z.string().optional(),
    _docType: z.string().optional(),
    _ownerId: z.string().optional(),
  }),
  children: z.array(z.string().min(1)).optional(),
});
const DOC_TYPE_RENDERING: Partial<Record<string, 'content' | 'field'>> = {
  journal: 'content',
  journalPart: 'content',
  tuple: 'field',
  url: 'content',
};
const HELD = '[held reference]';
const CAPTION_CODE_POINTS = 120;
const MAX_NODE_DEPTH = 128;
const MAX_NODE_VISITS = 10_000;
const MAX_NESTED_ROOTS = 8;

interface TanaNode {
  id: string | null;
  ownerId: string | null;
  docType: string | null;
  name: string | null;
  description: string | null;
  children: string[];
  invalid: boolean;
}

type Content =
  | { kind: 'text'; text: string }
  | { kind: 'malformed' }
  | { kind: 'node'; node: TanaNode };

type Readable = Exclude<Content, { kind: 'malformed' }>;

interface Item {
  text: string;
  children: Item[];
}

interface InlineSpan {
  start: number;
  end: number;
  node: string | undefined;
  date: string | undefined;
  inner: string;
  closed: boolean;
}

function hasHtml(text: string): boolean {
  if (/<!--[\s\S]*?-->/.test(text)) return true;
  for (const match of text.matchAll(TAG_PATTERN)) {
    if (Object.hasOwn(HTML_TAGS, match[1]!.toLowerCase())) return true;
  }
  return false;
}

function looksLikeNode(text: string): boolean {
  return /^\s*\{/.test(text) && /"(?:children|props)(?:"|\b)/.test(text);
}

function decodeEntities(text: string): string {
  return text.replace(ENTITY_PATTERN, (entity) => {
    const decimal = entity.replace(/^&#x([0-9a-f]+);$/i, (_match, hex: string) => `&#${parseInt(hex, 16)};`);
    return htmlToText(`x${decimal}x`).slice(1, -1);
  });
}

function decodeFully(text: string): string {
  while (true) {
    const next = decodeEntities(text);
    if (next === text) return text;
    text = next;
  }
}

function attributes(tag: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of tag.replace(/^<\/?[a-z][a-z0-9:-]*/i, '').matchAll(ATTRIBUTE_PATTERN)) {
    const name = match[1]!.toLowerCase();
    if (!found.has(name)) found.set(name, match[2] ?? match[3] ?? match[4] ?? '');
  }
  return found;
}

function inlineSpans(text: string): InlineSpan[] {
  const tags = [...text.matchAll(SPAN_TAG_PATTERN)];
  const spans: InlineSpan[] = [];
  for (let i = 0; i < tags.length; i++) {
    const open = tags[i]!;
    if (open[0].startsWith('</')) continue;
    const attrs = attributes(open[0]);
    const node = attrs.get('data-inlineref-node');
    const date = attrs.get('data-inlineref-date');
    if (node === undefined && date === undefined) continue;
    const start = open.index!;
    let end = start + open[0].length;
    let inner = '';
    let closed = /\/\s*>$/.test(open[0]);
    if (!closed) {
      let depth = 1;
      for (let j = i + 1; j < tags.length; j++) {
        const tag = tags[j]!;
        if (tag[0].startsWith('</')) depth--;
        else if (!/\/\s*>$/.test(tag[0])) depth++;
        if (depth === 0) {
          inner = text.slice(end, tag.index!);
          end = tag.index! + tag[0].length;
          closed = true;
          i = j;
          break;
        }
      }
    }
    spans.push({ start, end, node, date, inner, closed });
  }
  return spans;
}

function replaceSpans(text: string, render: (span: InlineSpan) => string): string {
  let out = '';
  let cursor = 0;
  for (const span of inlineSpans(text)) {
    out += text.slice(cursor, span.start) + render(span);
    cursor = span.end;
  }
  return cursor === 0 ? text : out + text.slice(cursor);
}

function renderDate(raw: string): string | null {
  let value = raw;
  let parsed: unknown;
  while (true) {
    try {
      parsed = JSON.parse(value);
      break;
    } catch {
      const next = decodeEntities(value);
      if (next === value) return null;
      value = next;
    }
  }
  const date = DateAttribute.safeParse(parsed);
  if (!date.success) return null;
  const { dateTimeString, timezone, hasTime } = date.data;
  const details = [
    ...(timezone === undefined ? [] : [timezone]),
    ...(hasTime === undefined ? [] : [`hasTime=${hasTime}`]),
  ];
  return details.length === 0 ? dateTimeString : `${dateTimeString} (${details.join(', ')})`;
}

function parseNode(text: string): Content | null {
  if (!looksLikeNode(text)) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: 'malformed' };
  }
  const strict = StrictTanaNode.safeParse(value);
  const parsed = strict.success ? strict : LenientTanaNode.safeParse(value);
  if (!parsed.success) return { kind: 'malformed' };
  const { id, props, children } = parsed.data;
  return {
    kind: 'node',
    node: {
      id,
      ownerId: props?._ownerId || null,
      docType: props?._docType || null,
      name: props?.name || null,
      description: props?.description || null,
      children: strict.success ? strict.data.children ?? []
        : (children ?? []).filter((child): child is string => typeof child === 'string' && child.length > 0),
      invalid: !strict.success,
    },
  };
}

function readwiseMarked(content: Readable): boolean {
  const texts = content.kind === 'text' ? [content.text] : [content.node.name ?? '', content.node.description ?? ''];
  return texts.some((text) => READWISE_URL.test(decodeFully(text)));
}

function outline(text: string, indent: number): string {
  const prefix = '  '.repeat(indent);
  const lines = text.split('\n');
  return `${prefix}- ${lines[0]}${lines.slice(1).map((line) => `\n${prefix}  ${line}`).join('')}`;
}

function serialize(item: Item, indent: number): string[] {
  const named = item.text.trim().length > 0;
  const own = !named ? [] : indent < 0 ? [item.text] : [outline(item.text, indent)];
  const childIndent = indent < 0 ? 0 : named ? indent + 1 : indent;
  return [...own, ...item.children.flatMap((child) => serialize(child, childIndent))];
}

function textIsStable(text: string): boolean {
  return text.search(ESCAPED_NEWLINES) < 0 && decodeEntities(text) === text && !hasHtml(text);
}

interface CaptionLine {
  text: string;
  heading: boolean;
}

function captionLines(text: string, fromBody: boolean): CaptionLine[] {
  const lines: CaptionLine[] = [];
  for (const raw of text.split(/\r\n|[\r\n]/)) {
    let line = raw.trim();
    if (fromBody) line = line.replace(/^-\s+/, '');
    const heading = /^#{1,6}(?:\s+|$)/.test(line);
    line = line.replace(/^(?:#{1,6}(?:\s+|$))+/, '').trim();
    if (line.length > 0 && line !== HELD) lines.push({ text: line, heading });
  }
  return lines;
}

function pickCaption(lines: CaptionLine[]): string {
  if (lines.length === 0) return '';
  const contextIndex = Math.max(0, lines.findIndex((line) => line.heading));
  const context = lines[contextIndex]!.text;
  const key = (text: string) => text.replace(/\s+/g, ' ').toLowerCase();
  const detail = lines.slice(contextIndex + 1).find((line) => !line.heading && key(line.text) !== key(context));
  const joined = detail === undefined ? context : `${context} · ${detail.text}`;
  return textIsStable(joined) ? joined : context;
}

function truncate(text: string, codePoints: number): string {
  const points = Array.from(text);
  return points.length <= codePoints ? text : points.slice(0, codePoints).join('').trimEnd();
}

export function projectPage(page: PageSnapshot, nodes: ReadonlyMap<string, ReferenceSnapshot>): Projection {
  const reasons = new Set<string>();
  const warningCounts = new Map<string, number>();
  const warn = (code: string) => warningCounts.set(code, (warningCounts.get(code) ?? 0) + 1);
  const active = new Set<string>();
  let visits = 0;

  function normalize(text: string, depth: number): string {
    const decodedSource = decodeFully(text);
    if (/[\uE000\uE001]/.test(decodedSource)) warn('reserved_character');
    for (let index = text.indexOf(HELD); index >= 0; index = text.indexOf(HELD, index + HELD.length)) warn('held_placeholder');
    let marker = 0;
    while (decodedSource.includes(`\uE000projection${marker}:`)) marker++;
    const insertPrefix = `\uE000projection${marker}:`;
    const inserts: string[] = [];
    const extract = (value: string) => replaceSpans(value, (span) => {
      if (!span.closed) warn('invalid_inline_markup');
      if (span.inner.replace(TAG_PATTERN, '').trim().length > 0 || inlineSpans(decodeFully(span.inner)).length > 0) {
        warn('inline_content_discarded');
      }
      let rendered: string;
      if (span.node !== undefined && span.date !== undefined) {
        warn('invalid_inline_reference');
        rendered = HELD;
      } else if (span.node !== undefined) {
        reasons.add('inline_reference');
        rendered = label(decodeFully(span.node), depth + 1);
      } else {
        const date = renderDate(span.date!);
        if (date === null) warn('malformed_date');
        else reasons.add('inline_date');
        rendered = date ?? HELD;
      }
      inserts.push(rendered);
      return `${insertPrefix}${inserts.length - 1}\uE001`;
    });
    while (true) {
      let next = text.replace(ESCAPED_NEWLINES, '\n');
      if (next !== text) reasons.add('escaped_newlines');
      next = extract(next);
      const html = hasHtml(next);
      if (html) {
        if (attributeOnlyMarkup(next)) warn('unsupported_markup');
        next = next.replace(TAG_PATTERN, (tag, name: string) => tag.startsWith('</') ? `</${name}>` : `<${name}>`);
      }
      const decoded = html ? htmlToText(next.replace(/&amp;/g, '&amp;amp;')) : decodeEntities(next);
      if (html) reasons.add('html');
      else if (decoded !== next) reasons.add('entities');
      next = decoded;
      if (next === text) break;
      text = next;
    }
    if (inserts.length === 0) return text;
    const restored = text.replace(new RegExp(`${insertPrefix}(\\d+)\uE001`, 'g'), (sentinel, index: string) => inserts[Number(index)] ?? sentinel);
    if (!textIsStable(restored)) warn('unstable_inline_value');
    return restored;
  }

  function attributeOnlyMarkup(text: string): boolean {
    const visible = text.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
    for (const match of visible.matchAll(TAG_PATTERN)) {
      const name = match[1]!.toLowerCase();
      if (match[0].startsWith('</') || !Object.hasOwn(HTML_TAGS, name)) continue;
      if (![...attributes(match[0]).keys()].some((key) => !Object.hasOwn(PRESENTATION_ATTRIBUTES, key))) continue;
      const after = visible.slice(match.index! + match[0].length);
      if (Object.hasOwn(VOID_TAGS, name) || /\/\s*>$/.test(match[0])) return true;
      const closing = new RegExp(`</${name}\\s*>`, 'i').exec(after);
      if (closing !== null && htmlToText(after.slice(0, closing.index)).trim().length === 0) return true;
    }
    return false;
  }

  function read(text: string, depth: number): Content {
    while (true) {
      const parsed = parseNode(text);
      if (parsed !== null) return parsed;
      const normalized = normalize(text, depth);
      if (normalized === text || !looksLikeNode(normalized)) return { kind: 'text', text: normalized };
      text = normalized;
    }
  }

  function resolve(ref: string, depth: number): ReferenceSnapshot | null {
    const hold = (code: string) => {
      warn(code);
      return null;
    };
    if (depth > MAX_NODE_DEPTH || visits >= MAX_NODE_VISITS) return hold('traversal_limit');
    visits++;
    const snapshot = nodes.get(ref);
    if (snapshot === undefined) return hold('missing_reference');
    if (snapshot.source_id !== page.source_id) return hold('source_mismatch');
    if (snapshot.record_id !== ref) return hold('record_id_mismatch');
    if (active.has(ref)) return hold('cycle');
    if (snapshot.readwise === true) return hold('readwise_boundary');
    return snapshot;
  }

  function visit<T>(ref: string, depth: number, use: (content: Readable) => T | null): T | null {
    const snapshot = resolve(ref, depth);
    if (snapshot === null) return null;
    active.add(ref);
    try {
      if (READWISE_URL.test(decodeFully(snapshot.compiled_truth))) {
        warn('readwise_boundary');
        return null;
      }
      const content = read(snapshot.compiled_truth, depth);
      if (content.kind === 'malformed') {
        warn('malformed_json');
        return null;
      }
      if (content.kind === 'node' && content.node.id !== null && content.node.id !== ref) {
        warn('record_id_mismatch');
        return null;
      }
      if (readwiseMarked(content)) {
        warn('readwise_boundary');
        return null;
      }
      return use(content);
    } finally {
      active.delete(ref);
    }
  }

  function labelOf(content: Readable, depth: number, fieldKey = false): string {
    if (content.kind === 'node') {
      const { node } = content;
      if (node.invalid) warn('invalid_node');
      if (node.docType !== null && DOC_TYPE_RENDERING[node.docType] !== 'content'
        && !(fieldKey && node.docType === 'attrDef')) {
        warn('unsupported_doc_type');
        return HELD;
      }
    }
    const raw = content.kind === 'text' ? content.text : content.node.name === null ? '' : normalize(content.node.name, depth);
    const text = raw.replace(/\s+/g, ' ').trim();
    if (text.length > 0) return text;
    warn('empty_reference_label');
    return HELD;
  }

  function label(ref: string, depth: number, fieldKey = false): string {
    return visit(ref, depth, (content) => labelOf(content, depth, fieldKey)) ?? HELD;
  }

  function ownText(node: TanaNode, depth: number): string[] {
    if (node.description !== null) reasons.add('description');
    return [node.name, node.description]
      .map((value) => value === null ? '' : normalize(value, depth))
      .filter((value) => value.trim().length > 0);
  }

  function childItems(ref: string, parentId: string | null, depth: number): Item[] {
    const items = visit(ref, depth, (content): Item[] | null => {
      if (content.kind === 'text') return content.text.trim().length > 0 ? [{ text: content.text, children: [] }] : [];
      const { node } = content;
      if (parentId !== null && node.ownerId !== null && node.ownerId !== parentId) {
        reasons.add('reference_label');
        return [{ text: labelOf(content, depth), children: [] }];
      }
      const item = nodeItem(node, ref, depth);
      if (item === null) return null;
      return item.text.trim().length > 0 || item.children.length > 0 ? [item] : [];
    });
    return items ?? [{ text: HELD, children: [] }];
  }

  function childrenItems(refs: string[], parentId: string | null, depth: number): Item[] {
    const items: Item[] = [];
    for (const ref of refs) {
      if (visits >= MAX_NODE_VISITS) {
        warn('traversal_limit');
        items.push({ text: HELD, children: [] });
        break;
      }
      items.push(...childItems(ref, parentId, depth));
    }
    return items;
  }

  function nodeItem(node: TanaNode, id: string | null, depth: number): Item | null {
    if (node.invalid) warn('invalid_node');
    const ownId = node.id ?? id;
    const rendering = node.docType === null ? 'content' : DOC_TYPE_RENDERING[node.docType];
    if (rendering === 'content') {
      const text = ownText(node, depth).join('\n');
      return { text, children: childrenItems(node.children, ownId, depth + 1) };
    }
    if (rendering === 'field') {
      reasons.add('field');
      const [keyRef, ...valueRefs] = node.children;
      const values = childrenItems(valueRefs, ownId, depth + 1);
      const extra = ownText(node, depth);
      if (keyRef === undefined) {
        warn('invalid_tuple');
        return { text: extra.join('\n') || HELD, children: values };
      }
      if (values.length === 0 && extra.length === 0) {
        warn('empty_field');
        return { text: `${label(keyRef, depth + 1, true)}:`, children: [] };
      }
      const key = label(keyRef, depth + 1, true);
      const only = values.length === 1 ? values[0]! : null;
      if (only !== null && extra.length === 0 && only.children.length === 0 && !only.text.includes('\n')) {
        return { text: `${key}: ${only.text.trim()}`, children: [] };
      }
      return { text: [`${key}:`, ...extra].join('\n'), children: values };
    }
    warn('unsupported_doc_type');
    return null;
  }

  function renderRoot(text: string, recordId: string | null): { content: Content; display: string; rootId: string | null } {
    const content = read(text, 0);
    if (content.kind === 'text') return { content, display: content.text, rootId: recordId };
    if (content.kind === 'malformed') {
      warn('malformed_json');
      return { content, display: '', rootId: recordId };
    }
    reasons.add('tana_json');
    const { node } = content;
    if (recordId !== null && node.id !== null && recordId !== node.id) warn('record_id_mismatch');
    const rootId = recordId ?? node.id;
    if (rootId !== null) active.add(rootId);
    const item = nodeItem(node, rootId, 0);
    if (rootId !== null) active.delete(rootId);
    return { content, display: item === null ? '' : serialize(item, -1).join('\n'), rootId };
  }

  visits++;
  const root = renderRoot(page.compiled_truth, page.record_id);
  const sourceRoot = page.record_id === null ? undefined : nodes.get(page.record_id);
  if (page.readwise === true || (sourceRoot?.source_id === page.source_id && sourceRoot.record_id === page.record_id && sourceRoot.readwise === true)
    || READWISE_URL.test(decodeFully(page.compiled_truth))
    || (root.content.kind !== 'malformed' && readwiseMarked(root.content))) warn('readwise_boundary');
  let display = root.display;
  let tana = root.content.kind === 'node';
  for (let nested = 0; looksLikeNode(display); nested++) {
    if (nested === MAX_NESTED_ROOTS) {
      warn('traversal_limit');
      display = HELD;
      break;
    }
    const next = renderRoot(display, null);
    if (next.content.kind === 'node') tana = true;
    if (next.display === display) break;
    display = next.display;
  }
  if (display.trim().length === 0) warn('empty_output');

  if (root.rootId !== null) active.add(root.rootId);
  let titleText = normalize(page.title, 0);
  if (root.rootId !== null) active.delete(root.rootId);
  const suffix = `[p${page.id.toString(36)}]`;
  const trimmedTitle = titleText.trimEnd();
  if (trimmedTitle === suffix || trimmedTitle.endsWith(` ${suffix}`)) {
    tana = true;
    titleText = trimmedTitle.slice(0, -suffix.length);
  }
  let base = pickCaption(captionLines(titleText, false));
  if (base.length === 0) {
    base = pickCaption(captionLines(display, true));
    if (base.length > 0) reasons.add('caption_from_body');
  }
  const budget = tana ? CAPTION_CODE_POINTS - Array.from(suffix).length - 1 : CAPTION_CODE_POINTS;
  const shortened = truncate(base, budget);
  if (shortened !== base) reasons.add('caption_shortened');
  const caption = !tana ? shortened : shortened.length > 0 ? `${shortened} ${suffix}` : suffix;
  if (caption !== page.title) reasons.add('caption_changed');

  return {
    caption,
    display_body: display,
    status: warningCounts.size === 0 ? 'complete' : 'held',
    reasons: [...reasons].sort(),
    warnings: [...warningCounts].sort(([a], [b]) => a.localeCompare(b)).map(([code, count]) => `${code}:${count}`),
  };
}

export function referencedRecordIds(snapshot: ReferenceSnapshot): string[] {
  const ids = new Set<string>();
  const collect = (text: string) => replaceSpans(text, (span) => {
    if (span.node !== undefined) ids.add(decodeFully(span.node));
    return '';
  });
  const scan = (text: string): string => {
    while (true) {
      const next = collect(decodeEntities(collect(text.replace(ESCAPED_NEWLINES, '\n'))));
      if (next === text) return text;
      text = next;
    }
  };
  const pending = [{ text: snapshot.compiled_truth, depth: 0 }];
  while (pending.length > 0) {
    const entry = pending.pop()!;
    let body = entry.text;
    while (true) {
      const content = parseNode(body);
      if (content?.kind === 'node') {
        for (const child of content.node.children) ids.add(child);
        for (const value of [content.node.name, content.node.description]) {
          if (value === null) continue;
          const decoded = scan(value);
          if (entry.depth < MAX_NESTED_ROOTS && looksLikeNode(decoded)) {
            pending.push({ text: decoded, depth: entry.depth + 1 });
          }
        }
        break;
      }
      if (content !== null) break;
      const decoded = scan(body);
      if (decoded === body || !looksLikeNode(decoded)) break;
      body = decoded;
    }
  }
  if ('title' in snapshot && typeof snapshot.title === 'string') scan(snapshot.title);
  return [...ids];
}

export function textFingerprint(title: string, body: string): string {
  return createHash('sha256').update(JSON.stringify([title, body])).digest('hex');
}

export function redactedPreview(text: string): {
  text: string;
  characters: number;
  lines: number;
  html_tags: string[];
  raw_tana_json: boolean;
} {
  const tags = new Set<string>();
  const markup = text.replace(/<!--[\s\S]*?(?:-->|$)/g, '<!--[redacted]-->')
    .replace(/<\/?([a-z][a-z0-9:-]*)(?=[\s/>]|$)(?:"[^"]*(?:"|$)|'[^']*(?:'|$)|[^'">])*(?:>|$)/gi, (tag, name: string) => {
      const safeName = name.toLowerCase();
      if (!Object.hasOwn(HTML_TAGS, safeName)) return '[redacted]';
      tags.add(safeName);
      return `<${tag.startsWith('</') ? '/' : ''}${safeName}${/\/\s*>$/.test(tag) ? '/' : ''}>`;
    });
  const redacted = markup.replace(/<\/?[a-z][a-z0-9]*\/?>|\[redacted\]|[\p{L}\p{M}\p{N}\p{Pc}\p{Cf}\p{Extended_Pictographic}\p{Regional_Indicator}]+/gu, (run) => /^<\/?[a-z][a-z0-9]*\/?>$/.test(run) ? run : '[redacted]');
  const preview: string[] = [];
  let characters = 0;
  for (const token of redacted.matchAll(/<!--\[redacted\]-->|<\/?[a-z][a-z0-9]*\/?>|\[redacted\]|[\s\S]/gu)) {
    const length = Array.from(token[0]).length;
    if (characters + length > 500) break;
    preview.push(token[0]);
    characters += length;
  }
  return {
    text: preview.join(''),
    characters: Array.from(text).length,
    lines: text.length === 0 ? 0 : text.split(/\r\n|[\r\n]/).length,
    html_tags: [...tags],
    raw_tana_json: looksLikeNode(text),
  };
}
