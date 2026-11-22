/**
 * Line-aware, zero-dependency YAML parser for semantic YAML framework resolvers.
 *
 * Designed for structural extraction of Kubernetes, Kustomize, Helm, CI, Docker
 * Compose, and OpenAPI documents:
 *   - Tracks exact 1-indexed `startLine` / `endLine` spans on every node.
 *   - Supports multi-document streams (`---` / `...`).
 *   - Supports block mappings/sequences, compact sequences (`key:\n- item`),
 *     inline map items (`- key: val\n  key2: val2`), block scalars (`|`, `|-`,
 *     `>`, `>-`), and single- or multi-line flow mappings/sequences (`{...}`, `[...]`).
 *   - Tolerates Helm Go-template control lines (`{{- if ... }}`, `{{- end }}`)
 *     without crashing or breaking document indentation, while preserving inline
 *     `{{ ... }}` expressions inside scalar values.
 *   - Never throws on malformed input — degrades gracefully so indexing never fails.
 */

export type YamlValue = YamlMap | YamlSeq | YamlScalar;

export interface YamlMapEntry {
  key: string;
  keyLine: number;
  value: YamlValue;
  startLine: number;
  endLine: number;
}

export interface YamlMap {
  kind: 'map';
  entries: YamlMapEntry[];
  startLine: number;
  endLine: number;
}

export interface YamlSeq {
  kind: 'seq';
  items: YamlValue[];
  startLine: number;
  endLine: number;
}

export interface YamlScalar {
  kind: 'scalar';
  value: string;
  raw: string;
  quoted: boolean;
  startLine: number;
  endLine: number;
}

export interface YamlDocument {
  root: YamlValue | null;
  startLine: number;
  endLine: number;
}

interface RawLine {
  lineNum: number; // 1-indexed
  text: string;
  indent: number;
  trimmed: string;
}

const MAX_DEPTH = 64;

/**
 * Parse a YAML string (potentially multi-document) into line-attributed AST documents.
 */
export function parseYamlDocuments(content: string): YamlDocument[] {
  const rawLines = content.split(/\r?\n/);
  const docRanges = splitDocumentRanges(rawLines);
  const docs: YamlDocument[] = [];

  for (const range of docRanges) {
    const lines = buildLines(rawLines, range.startIdx, range.endIdx);
    const parser = new BlockParser(lines);
    const root = parser.parseRoot();
    if (root) {
      docs.push({
        root,
        startLine: root.startLine,
        endLine: root.endLine,
      });
    }
  }

  return docs;
}

/**
 * Split raw lines into document index ranges on column-0 `---` / `...` markers,
 * ignoring markers inside indented block scalars.
 */
function splitDocumentRanges(rawLines: string[]): Array<{ startIdx: number; endIdx: number }> {
  const ranges: Array<{ startIdx: number; endIdx: number }> = [];
  let start = 0;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]!;
    if (/^---(?:\s|$|#)/.test(line)) {
      if (i > start) ranges.push({ startIdx: start, endIdx: i });
      start = i + 1;
    } else if (/^\.\.\.(?:\s|$|#)/.test(line)) {
      if (i > start) ranges.push({ startIdx: start, endIdx: i });
      start = i + 1;
    }
  }
  if (start < rawLines.length) {
    ranges.push({ startIdx: start, endIdx: rawLines.length });
  }
  return ranges;
}

function buildLines(rawLines: string[], startIdx: number, endIdx: number): RawLine[] {
  const out: RawLine[] = [];
  for (let i = startIdx; i < endIdx; i++) {
    const text = rawLines[i]!;
    let indent = 0;
    while (indent < text.length && text[indent] === ' ') indent++;
    // Treat leading tabs as 2 spaces for indentation fallback
    if (indent < text.length && text[indent] === '\t') {
      while (indent < text.length && (text[indent] === ' ' || text[indent] === '\t')) {
        indent++;
      }
    }
    const trimmed = text.slice(indent);
    out.push({ lineNum: i + 1, text, indent, trimmed });
  }
  return out;
}

/** True when a trimmed line is blank, a comment, or a pure Helm template control directive. */
function isSkippableLine(trimmed: string): boolean {
  if (!trimmed || trimmed.startsWith('#')) return true;
  if (trimmed.startsWith('{{')) {
    // Pure Go-template directive line (e.g. `{{- if ... }}`, `{{- end }}`, `{{- range ... }}`)
    // that doesn't define a YAML key outside `{{ ... }}`.
    const withoutBraces = stripTemplateBlocks(trimmed);
    if (!withoutBraces.trim() || !findMappingColon(trimmed)) return true;
  }
  return false;
}

function stripTemplateBlocks(s: string): string {
  return s.replace(/\{\{[\s\S]*?\}\}/g, '');
}

/** Strip inline `# comment` outside quotes and `{{ ... }}`. */
function stripInlineComment(s: string): string {
  let inSingle = false;
  let inDouble = false;
  let braceDepth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inSingle) {
      if (ch === "'" && s[i + 1] === "'") {
        i++;
      } else if (ch === "'") {
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '\\') {
        i++;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (ch === '{' && s[i + 1] === '{') {
      braceDepth++;
      i++;
      continue;
    }
    if (ch === '}' && s[i + 1] === '}' && braceDepth > 0) {
      braceDepth--;
      i++;
      continue;
    }
    if (braceDepth > 0) continue;
    if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === '#' && (i === 0 || s[i - 1] === ' ' || s[i - 1] === '\t')) {
      return s.slice(0, i).trimEnd();
    }
  }
  return s.trimEnd();
}

/**
 * Find the index of the mapping `:` separator in a trimmed line, ignoring colons
 * inside quotes, flow collections, and `{{ ... }}` template expressions.
 * Returns -1 when the line is not a YAML mapping entry.
 */
function findMappingColon(s: string): number {
  let inSingle = false;
  let inDouble = false;
  let flowDepth = 0;
  let tplDepth = 0;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inSingle) {
      if (ch === "'" && s[i + 1] === "'") i++;
      else if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '\\') i++;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === '{' && s[i + 1] === '{') {
      tplDepth++;
      i++;
      continue;
    }
    if (ch === '}' && s[i + 1] === '}' && tplDepth > 0) {
      tplDepth--;
      i++;
      continue;
    }
    if (tplDepth > 0) continue;
    if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === '{' || ch === '[') {
      flowDepth++;
    } else if ((ch === '}' || ch === ']') && flowDepth > 0) {
      flowDepth--;
    } else if (ch === '#' && flowDepth === 0 && (i === 0 || s[i - 1] === ' ' || s[i - 1] === '\t')) {
      return -1;
    } else if (ch === ':' && flowDepth === 0) {
      const next = s[i + 1];
      if (next === undefined || next === ' ' || next === '\t') {
        return i;
      }
    }
  }
  return -1;
}

/** True when a trimmed line starts a block sequence item (`-` alone or `- ...`). */
function isSeqItemLine(trimmed: string): boolean {
  return trimmed === '-' || trimmed.startsWith('- ') || trimmed.startsWith('-\t');
}

/** Extract optional YAML anchor (`&name`) and strip anchor/tag prefixes from a value header. */
function extractAnchorAndStrip(s: string): { anchor: string | null; rest: string } {
  let cur = s.trimStart();
  let anchor: string | null = null;
  for (let i = 0; i < 2; i++) {
    const am = cur.match(/^&([^\s,[\]{}]+)\s*(.*)$/);
    if (am) {
      anchor = am[1]!;
      cur = am[2]!;
      continue;
    }
    const tm = cur.match(/^![^\s,[\]{}]*\s*(.*)$/);
    if (tm) {
      cur = tm[1]!;
      continue;
    }
    break;
  }
  return { anchor, rest: cur };
}

/** Unquote a YAML scalar string (handles single and double quotes). */
function unquoteScalar(raw: string): { value: string; quoted: boolean } {
  const s = raw.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    const inner = s.slice(1, -1);
    const unescaped = inner.replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})/g, (_m, esc: string) => {
      switch (esc) {
        case '"': return '"';
        case '\\': return '\\';
        case '/': return '/';
        case 'b': return '\b';
        case 'f': return '\f';
        case 'n': return '\n';
        case 'r': return '\r';
        case 't': return '\t';
        default:
          return esc.startsWith('u') ? String.fromCharCode(parseInt(esc.slice(1), 16)) : esc;
      }
    });
    return { value: unescaped, quoted: true };
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return { value: s.slice(1, -1).replace(/''/g, "'"), quoted: true };
  }
  if (s === '~' || s === 'null' || s === 'Null' || s === 'NULL') {
    return { value: '', quoted: false };
  }
  return { value: s, quoted: false };
}

/** Check if a value token opens a block scalar (`|`, `|-`, `|+`, `>`, `>-`, `>+`, optional indent digit). */
function parseBlockScalarHeader(s: string): { style: '|' | '>'; chomp: '' | '-' | '+'; explicitIndent: number | null } | null {
  const clean = stripInlineComment(s).trim();
  const m = clean.match(/^([|>])([+-]?)([1-9]?)([+-]?)$/);
  if (!m) return null;
  const style = m[1] as '|' | '>';
  const chomp = (m[2] || m[4] || '') as '' | '-' | '+';
  const explicitIndent = m[3] ? parseInt(m[3], 10) : null;
  return { style, chomp, explicitIndent };
}

/** Check whether a flow collection string has balanced `{}` and `[]` outside quotes. */
function isFlowBalanced(s: string): boolean {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inSingle) {
      if (ch === "'" && s[i + 1] === "'") i++;
      else if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '\\') i++;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    else if (ch === '#' && (i === 0 || s[i - 1] === ' ' || s[i - 1] === '\t')) {
      // Comment runs to newline
      const nl = s.indexOf('\n', i);
      if (nl < 0) break;
      i = nl;
    } else if (ch === '{' || ch === '[') {
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;
      if (depth <= 0) return true;
    }
  }
  return depth <= 0;
}

class BlockParser {
  private pos = 0;
  private anchors = new Map<string, YamlValue>();

  constructor(private readonly lines: RawLine[]) {}

  parseRoot(): YamlValue | null {
    this.skipBlank();
    if (this.pos >= this.lines.length) return null;
    const first = this.lines[this.pos]!;
    if (isSeqItemLine(first.trimmed)) {
      return this.parseBlockSeq(first.indent, 0);
    }
    if (first.trimmed.startsWith('{') || first.trimmed.startsWith('[')) {
      return this.parseFlowFromCurrent(first.trimmed, first.lineNum, 0);
    }
    if (findMappingColon(first.trimmed) >= 0) {
      return this.parseBlockMap(first.indent, 0);
    }
    // Single scalar document
    this.pos++;
    return makeScalar(stripInlineComment(first.trimmed), first.lineNum, first.lineNum);
  }

  private skipBlank(): void {
    while (this.pos < this.lines.length && isSkippableLine(this.lines[this.pos]!.trimmed)) {
      this.pos++;
    }
  }

  private peek(): RawLine | null {
    let i = this.pos;
    while (i < this.lines.length && isSkippableLine(this.lines[i]!.trimmed)) i++;
    return i < this.lines.length ? this.lines[i]! : null;
  }

  private parseBlockMap(minIndent: number, depth: number): YamlMap {
    const entries: YamlMapEntry[] = [];
    const startLine = this.lines[this.pos]?.lineNum ?? 1;
    let endLine = startLine;

    if (depth >= MAX_DEPTH) {
      return { kind: 'map', entries, startLine, endLine };
    }

    while (this.pos < this.lines.length) {
      this.skipBlank();
      if (this.pos >= this.lines.length) break;
      const line = this.lines[this.pos]!;
      if (line.indent < minIndent) break;
      if (line.indent > minIndent) {
        // Unexpected over-indented line (e.g. inside a Helm conditional branch that
        // indented a stray line) — consume to avoid infinite loop.
        this.pos++;
        continue;
      }
      if (isSeqItemLine(line.trimmed)) break;

      const colonIdx = findMappingColon(line.trimmed);
      if (colonIdx < 0) {
        this.pos++;
        continue;
      }

      const entry = this.parseMapEntry(line, colonIdx, minIndent, depth);
      if (entry.key === '<<') {
        this.mergeIntoEntries(entries, entry.value);
      } else {
        entries.push(entry);
      }
      if (entry.endLine > endLine) endLine = entry.endLine;
    }

    return {
      kind: 'map',
      entries: dedupeMergedEntries(entries),
      startLine: entries[0]?.startLine ?? startLine,
      endLine,
    };
  }

  private mergeIntoEntries(entries: YamlMapEntry[], merged: YamlValue): void {
    const sources: YamlMap[] = [];
    if (merged.kind === 'map') {
      sources.push(merged);
    } else if (merged.kind === 'seq') {
      for (const item of merged.items) {
        if (item.kind === 'map') sources.push(item);
      }
    }
    for (const src of sources) {
      for (const e of src.entries) {
        entries.push({ ...e });
      }
    }
  }

  private parseMapEntry(line: RawLine, colonIdx: number, mapIndent: number, depth: number): YamlMapEntry {
    const rawKey = line.trimmed.slice(0, colonIdx).trim();
    const key = unquoteScalar(rawKey).value;
    const { anchor, rest: afterColon } = extractAnchorAndStrip(line.trimmed.slice(colonIdx + 1));
    this.pos++;

    const value = this.parseValueAfterHeader(afterColon, line.lineNum, mapIndent, depth + 1);
    if (anchor) this.anchors.set(anchor, value);
    return {
      key,
      keyLine: line.lineNum,
      value,
      startLine: line.lineNum,
      endLine: Math.max(line.lineNum, value.endLine),
    };
  }

  private parseValueAfterHeader(
    afterHeader: string,
    headerLineNum: number,
    parentIndent: number,
    depth: number
  ): YamlValue {
    const withoutComment = stripInlineComment(afterHeader).trim();

    // 1. Block scalar (`|`, `|-`, `>`, `>-`)
    if (withoutComment) {
      // Alias reference (`*anchor`)
      if (withoutComment.startsWith('*') && /^\*[^\s,[\]{}]+$/.test(withoutComment)) {
        const target = this.anchors.get(withoutComment.slice(1));
        if (target) return target;
      }

      const blockHeader = parseBlockScalarHeader(withoutComment);
      if (blockHeader) {
        return this.parseBlockScalar(headerLineNum, parentIndent, blockHeader);
      }

      // 2. Flow collection (`{...}` or `[...]`)
      // Guard against Go-template `{{ ... }}` which starts with `{`!
      if (
        (withoutComment.startsWith('{') && !withoutComment.startsWith('{{')) ||
        withoutComment.startsWith('[')
      ) {
        return this.parseFlowFromRemainder(withoutComment, headerLineNum, depth);
      }

      // 3. Inline scalar
      return makeScalar(withoutComment, headerLineNum, headerLineNum);
    }

    // 4. Nested block child on subsequent lines
    const next = this.peek();
    if (!next) {
      return makeScalar('', headerLineNum, headerLineNum);
    }

    // Block sequence can sit at the same indent as its parent mapping key (`key:\n- a`)
    if (isSeqItemLine(next.trimmed) && next.indent >= parentIndent) {
      this.skipBlank();
      return this.parseBlockSeq(next.indent, depth);
    }

    if (next.indent > parentIndent) {
      this.skipBlank();
      if (next.trimmed.startsWith('{') && !next.trimmed.startsWith('{{')) {
        return this.parseFlowFromCurrent(next.trimmed, next.lineNum, depth);
      }
      if (next.trimmed.startsWith('[')) {
        return this.parseFlowFromCurrent(next.trimmed, next.lineNum, depth);
      }
      if (findMappingColon(next.trimmed) >= 0) {
        return this.parseBlockMap(next.indent, depth);
      }
      // Plain multiline scalar continuation
      this.pos++;
      return makeScalar(stripInlineComment(next.trimmed), next.lineNum, next.lineNum);
    }

    return makeScalar('', headerLineNum, headerLineNum);
  }

  private parseBlockSeq(seqIndent: number, depth: number): YamlSeq {
    const items: YamlValue[] = [];
    const startLine = this.lines[this.pos]?.lineNum ?? 1;
    let endLine = startLine;

    if (depth >= MAX_DEPTH) {
      return { kind: 'seq', items, startLine, endLine };
    }

    while (this.pos < this.lines.length) {
      this.skipBlank();
      if (this.pos >= this.lines.length) break;
      const line = this.lines[this.pos]!;
      if (line.indent < seqIndent) break;
      if (line.indent > seqIndent) {
        this.pos++;
        continue;
      }
      if (!isSeqItemLine(line.trimmed)) break;

      const item = this.parseSeqItem(line, seqIndent, depth + 1);
      items.push(item);
      if (item.endLine > endLine) endLine = item.endLine;
    }

    return {
      kind: 'seq',
      items,
      startLine: items[0]?.startLine ?? startLine,
      endLine,
    };
  }

  private parseSeqItem(line: RawLine, seqIndent: number, depth: number): YamlValue {
    const afterDashRaw = line.trimmed.slice(1);
    const wsMatch = afterDashRaw.match(/^(\s*)(.*)$/);
    const spacesAfterDash = wsMatch ? wsMatch[1]!.length : 0;
    const content = wsMatch ? wsMatch[2]! : '';
    const itemContentIndent = seqIndent + 1 + spacesAfterDash;

    // Empty `-` followed by indented block
    if (!stripInlineComment(content).trim()) {
      this.pos++;
      return this.parseValueAfterHeader('', line.lineNum, seqIndent, depth);
    }

    const { anchor: itemAnchor, rest: stripped } = extractAnchorAndStrip(content);

    // Alias reference as sequence item: `- *defaults`
    const strippedNoComment = stripInlineComment(stripped).trim();
    if (strippedNoComment.startsWith('*') && /^\*[^\s,[\]{}]+$/.test(strippedNoComment)) {
      const target = this.anchors.get(strippedNoComment.slice(1));
      if (target) {
        this.pos++;
        return target;
      }
    }

    // Nested sequence on same line: `- - foo`
    if (isSeqItemLine(stripped)) {
      const synthLine: RawLine = {
        lineNum: line.lineNum,
        text: line.text,
        indent: itemContentIndent,
        trimmed: stripped,
      };
      // Parse single nested item + any sibling items at itemContentIndent
      const nestedFirst = this.parseSeqItem(synthLine, itemContentIndent, depth + 1);
      const nestedItems: YamlValue[] = [nestedFirst];
      let endLine = nestedFirst.endLine;
      const more = this.peek();
      if (more && more.indent === itemContentIndent && isSeqItemLine(more.trimmed)) {
        const rest = this.parseBlockSeq(itemContentIndent, depth);
        nestedItems.push(...rest.items);
        if (rest.endLine > endLine) endLine = rest.endLine;
      }
      const seqVal: YamlSeq = { kind: 'seq', items: nestedItems, startLine: line.lineNum, endLine };
      if (itemAnchor) this.anchors.set(itemAnchor, seqVal);
      return seqVal;
    }

    // Inline flow collection as sequence item: `- {name: http, containerPort: 8094}`
    if (
      (stripped.startsWith('{') && !stripped.startsWith('{{')) ||
      stripped.startsWith('[')
    ) {
      this.pos++;
      const flowVal = this.parseFlowFromRemainder(stripInlineComment(stripped), line.lineNum, depth);
      if (itemAnchor) this.anchors.set(itemAnchor, flowVal);
      return flowVal;
    }

    // Block scalar as sequence item: `- |-`
    const blockHeader = parseBlockScalarHeader(stripped);
    if (blockHeader) {
      this.pos++;
      const scalarVal = this.parseBlockScalar(line.lineNum, seqIndent, blockHeader);
      if (itemAnchor) this.anchors.set(itemAnchor, scalarVal);
      return scalarVal;
    }

    // Inline mapping item: `- name: api\n  image: foo`
    const colonIdx = findMappingColon(stripped);
    if (colonIdx >= 0) {
      const synthLine: RawLine = {
        lineNum: line.lineNum,
        text: line.text,
        indent: itemContentIndent,
        trimmed: stripped,
      };
      const firstEntry = this.parseMapEntry(synthLine, colonIdx, itemContentIndent, depth);
      const entries: YamlMapEntry[] = [];
      if (firstEntry.key === '<<') this.mergeIntoEntries(entries, firstEntry.value);
      else entries.push(firstEntry);
      let endLine = firstEntry.endLine;

      // Read sibling mapping entries indented at `itemContentIndent`
      while (this.pos < this.lines.length) {
        this.skipBlank();
        if (this.pos >= this.lines.length) break;
        const next = this.lines[this.pos]!;
        if (next.indent < itemContentIndent) break;
        if (next.indent > itemContentIndent) {
          this.pos++;
          continue;
        }
        if (isSeqItemLine(next.trimmed)) break;
        const nextColon = findMappingColon(next.trimmed);
        if (nextColon < 0) {
          this.pos++;
          continue;
        }
        const sibling = this.parseMapEntry(next, nextColon, itemContentIndent, depth);
        if (sibling.key === '<<') this.mergeIntoEntries(entries, sibling.value);
        else entries.push(sibling);
        if (sibling.endLine > endLine) endLine = sibling.endLine;
      }

      const mapVal: YamlMap = { kind: 'map', entries: dedupeMergedEntries(entries), startLine: line.lineNum, endLine };
      if (itemAnchor) this.anchors.set(itemAnchor, mapVal);
      return mapVal;
    }

    // Plain scalar sequence item
    this.pos++;
    const plainVal = makeScalar(stripInlineComment(stripped), line.lineNum, line.lineNum);
    if (itemAnchor) this.anchors.set(itemAnchor, plainVal);
    return plainVal;
  }

  private parseBlockScalar(
    headerLineNum: number,
    parentIndent: number,
    header: { style: '|' | '>'; chomp: '' | '-' | '+'; explicitIndent: number | null }
  ): YamlScalar {
    const collected: string[] = [];
    let blockIndent: number | null = header.explicitIndent !== null ? parentIndent + header.explicitIndent : null;
    let endLine = headerLineNum;

    while (this.pos < this.lines.length) {
      const line = this.lines[this.pos]!;
      const isBlank = line.trimmed.length === 0;
      if (isBlank) {
        collected.push('');
        this.pos++;
        continue;
      }
      if (blockIndent === null) {
        if (line.indent <= parentIndent) break;
        blockIndent = line.indent;
      }
      if (line.indent < blockIndent) break;
      collected.push(line.text.slice(blockIndent));
      endLine = line.lineNum;
      this.pos++;
    }

    // Trim trailing blank lines unless `+` keep chomping
    if (header.chomp !== '+') {
      while (collected.length > 0 && collected[collected.length - 1] === '') {
        collected.pop();
      }
    }

    const value = header.style === '>'
      ? collected.join(' ').trim()
      : collected.join('\n');

    return {
      kind: 'scalar',
      value,
      raw: value,
      quoted: false,
      startLine: headerLineNum,
      endLine,
    };
  }

  private parseFlowFromCurrent(firstText: string, startLine: number, depth: number): YamlValue {
    this.pos++;
    return this.parseFlowFromRemainder(stripInlineComment(firstText), startLine, depth);
  }

  private parseFlowFromRemainder(initial: string, startLine: number, depth: number): YamlValue {
    const parts = [initial];
    let endLine = startLine;

    while (!isFlowBalanced(parts.join('\n')) && this.pos < this.lines.length) {
      const next = this.lines[this.pos]!;
      parts.push(stripInlineComment(next.trimmed));
      endLine = next.lineNum;
      this.pos++;
    }

    const joined = parts.join('\n');
    const fp = new FlowParser(joined, startLine, endLine, this.anchors);
    return fp.parseValue(depth);
  }
}

/** When `<<:` merges keys, explicit keys written later in the same mapping win over merged keys. */
function dedupeMergedEntries(entries: YamlMapEntry[]): YamlMapEntry[] {
  const byKey = new Map<string, YamlMapEntry>();
  for (const e of entries) {
    byKey.set(e.key, e);
  }
  return [...byKey.values()];
}

class FlowParser {
  private i = 0;

  constructor(
    private readonly src: string,
    private readonly startLine: number,
    private readonly endLine: number,
    private readonly anchors: Map<string, YamlValue>
  ) {}

  private skipWs(): void {
    while (this.i < this.src.length) {
      const ch = this.src[this.i]!;
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        this.i++;
      } else if (ch === '#') {
        while (this.i < this.src.length && this.src[this.i] !== '\n') this.i++;
      } else {
        break;
      }
    }
  }

  parseValue(depth: number): YamlValue {
    this.skipWs();
    if (depth >= MAX_DEPTH || this.i >= this.src.length) {
      return makeScalar('', this.startLine, this.endLine);
    }
    const ch = this.src[this.i]!;
    if (ch === '{' && !(this.src[this.i + 1] === '{')) {
      return this.parseMap(depth + 1);
    }
    if (ch === '[') {
      return this.parseSeq(depth + 1);
    }
    const scalar = this.parseScalar(false);
    if (!scalar.quoted && scalar.value.startsWith('*')) {
      const target = this.anchors.get(scalar.value.slice(1));
      if (target) return target;
    }
    return scalar;
  }

  private parseMap(depth: number): YamlMap {
    const entries: YamlMapEntry[] = [];
    this.i++; // consume '{'
    while (this.i < this.src.length) {
      this.skipWs();
      if (this.i >= this.src.length || this.src[this.i] === '}') {
        if (this.src[this.i] === '}') this.i++;
        break;
      }
      if (this.src[this.i] === ',') {
        this.i++;
        continue;
      }

      const keyScalar = this.parseScalar(true);
      this.skipWs();
      let value: YamlValue;
      if (this.src[this.i] === ':') {
        this.i++; // consume ':'
        this.skipWs();
        if (this.i >= this.src.length || this.src[this.i] === ',' || this.src[this.i] === '}') {
          value = makeScalar('', this.startLine, this.endLine);
        } else {
          value = this.parseValue(depth);
        }
      } else {
        value = makeScalar('', this.startLine, this.endLine);
      }

      if (keyScalar.value) {
        entries.push({
          key: keyScalar.value,
          keyLine: this.startLine,
          value,
          startLine: this.startLine,
          endLine: this.endLine,
        });
      }

      this.skipWs();
      if (this.src[this.i] === ',') this.i++;
    }
    return { kind: 'map', entries, startLine: this.startLine, endLine: this.endLine };
  }

  private parseSeq(depth: number): YamlSeq {
    const items: YamlValue[] = [];
    this.i++; // consume '['
    while (this.i < this.src.length) {
      this.skipWs();
      if (this.i >= this.src.length || this.src[this.i] === ']') {
        if (this.src[this.i] === ']') this.i++;
        break;
      }
      if (this.src[this.i] === ',') {
        this.i++;
        continue;
      }
      items.push(this.parseValue(depth));
      this.skipWs();
      if (this.src[this.i] === ',') this.i++;
    }
    return { kind: 'seq', items, startLine: this.startLine, endLine: this.endLine };
  }

  private parseScalar(isMapKey: boolean): YamlScalar {
    this.skipWs();
    if (this.i >= this.src.length) return makeScalar('', this.startLine, this.endLine);

    const ch = this.src[this.i]!;
    if (ch === '"' || ch === "'") {
      const start = this.i;
      this.i++;
      while (this.i < this.src.length) {
        const c = this.src[this.i]!;
        if (ch === '"') {
          if (c === '\\') {
            this.i += 2;
            continue;
          }
          if (c === '"') {
            this.i++;
            break;
          }
        } else {
          if (c === "'" && this.src[this.i + 1] === "'") {
            this.i += 2;
            continue;
          }
          if (c === "'") {
            this.i++;
            break;
          }
        }
        this.i++;
      }
      return makeScalar(this.src.slice(start, this.i), this.startLine, this.endLine);
    }

    const start = this.i;
    let tplDepth = 0;
    while (this.i < this.src.length) {
      const c = this.src[this.i]!;
      if (c === '{' && this.src[this.i + 1] === '{') {
        tplDepth++;
        this.i += 2;
        continue;
      }
      if (c === '}' && this.src[this.i + 1] === '}' && tplDepth > 0) {
        tplDepth--;
        this.i += 2;
        continue;
      }
      if (tplDepth > 0) {
        this.i++;
        continue;
      }
      if (c === ',' || c === '}' || c === ']') break;
      if (isMapKey && c === ':') {
        const next = this.src[this.i + 1];
        if (
          next === undefined ||
          next === ' ' ||
          next === '\t' ||
          next === '\n' ||
          next === ',' ||
          next === '}' ||
          next === ']' ||
          next === '{' ||
          next === '[' ||
          next === '"' ||
          next === "'"
        ) {
          break;
        }
      }
      this.i++;
    }
    return makeScalar(this.src.slice(start, this.i).trim(), this.startLine, this.endLine);
  }
}

function makeScalar(raw: string, startLine: number, endLine: number): YamlScalar {
  const { value, quoted } = unquoteScalar(raw);
  return { kind: 'scalar', value, raw: raw.trim(), quoted, startLine, endLine };
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

export function yamlGetEntry(node: YamlValue | null | undefined, key: string): YamlMapEntry | null {
  if (!node || node.kind !== 'map') return null;
  for (const e of node.entries) {
    if (e.key === key) return e;
  }
  return null;
}

export function yamlGet(node: YamlValue | null | undefined, key: string): YamlValue | null {
  return yamlGetEntry(node, key)?.value ?? null;
}

export function yamlGetPath(node: YamlValue | null | undefined, ...keys: string[]): YamlValue | null {
  let cur: YamlValue | null | undefined = node;
  for (const k of keys) {
    cur = yamlGet(cur, k);
    if (!cur) return null;
  }
  return cur ?? null;
}

export function yamlGetString(node: YamlValue | null | undefined, key: string): string | null {
  const v = yamlGet(node, key);
  return v && v.kind === 'scalar' && v.value !== '' ? v.value : null;
}

export function yamlGetPathString(node: YamlValue | null | undefined, ...keys: string[]): string | null {
  const v = yamlGetPath(node, ...keys);
  return v && v.kind === 'scalar' && v.value !== '' ? v.value : null;
}

export function yamlGetMap(node: YamlValue | null | undefined, key: string): YamlMap | null {
  const v = yamlGet(node, key);
  return v && v.kind === 'map' ? v : null;
}

export function yamlGetPathMap(node: YamlValue | null | undefined, ...keys: string[]): YamlMap | null {
  const v = yamlGetPath(node, ...keys);
  return v && v.kind === 'map' ? v : null;
}

export function yamlGetSeq(node: YamlValue | null | undefined, key: string): YamlSeq | null {
  const v = yamlGet(node, key);
  return v && v.kind === 'seq' ? v : null;
}

export function yamlGetPathSeq(node: YamlValue | null | undefined, ...keys: string[]): YamlSeq | null {
  const v = yamlGetPath(node, ...keys);
  return v && v.kind === 'seq' ? v : null;
}

/** Extract a flat string→string record from a YAML mapping (ignores non-scalar values). */
export function yamlStringMap(node: YamlValue | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!node || node.kind !== 'map') return out;
  for (const e of node.entries) {
    if (e.value.kind === 'scalar' && e.value.value !== '') {
      out[e.key] = e.value.value;
    }
  }
  return out;
}

/** Extract string items from a YAML sequence. */
export function yamlStringList(node: YamlValue | null | undefined): string[] {
  if (!node || node.kind !== 'seq') return [];
  const out: string[] = [];
  for (const item of node.items) {
    if (item.kind === 'scalar' && item.value !== '') out.push(item.value);
  }
  return out;
}
