/**
 * Docker Compose Semantic YAML Resolver
 *
 * Recognizes `compose.{yml,yaml}`, `compose.*.{yml,yaml}`,
 * `docker-compose.{yml,yaml}`, and `docker-compose.*.{yml,yaml}` files and
 * models only semantic Compose constructs — never naive every-key indexing:
 *
 *   - Nodes:
 *       * `Compose/<file>` (`module`)
 *       * `ComposeService/<name>` (`component`)
 *       * `ComposeNetwork/<name>` (`namespace`)
 *       * `ComposeVolume/<name>` (`constant`)
 *       * `ComposeSecret/<name>` (`constant`)
 *       * `ComposeConfig/<name>` (`constant`)
 *   - Edges (all `dc:`-scoped with `claimsReference` + `ownsReference`):
 *       * `Compose` → its declared services (`calls`)
 *       * `include:` → included Compose file(s) (`imports`)
 *       * Service `depends_on:` (list or `{ svc: { condition } }` map) & `links:` → target service (`calls`)
 *       * Service `extends:` (`service` + optional `file`) → parent service (`extends`)
 *       * Service `networks:` → top-level `ComposeNetwork` (`references`)
 *       * Service `volumes:` (named volumes only; bind mounts skipped) → top-level `ComposeVolume` (`references`)
 *       * Service `secrets:` / `configs:` → top-level `ComposeSecret` / `ComposeConfig` (`references`)
 *       * Top-level `secrets.<name>.file` / `configs.<name>.file` → indexed local file node when present (`imports`)
 *
 * YAML anchors and `<<:` merge keys (`x-common: &common`) are resolved natively
 * by `yaml-parser.ts`.
 */

import * as path from 'path';
import type { Node } from '../../types';
import type {
  FrameworkExtractionResult,
  FrameworkResolver,
  ResolutionContext,
  ResolvedRef,
  UnresolvedRef,
} from '../types';
import {
  parseYamlDocuments,
  yamlGet,
  yamlGetEntry,
  yamlGetMap,
  yamlGetString,
  yamlStringList,
  type YamlMap,
  type YamlValue,
} from './yaml-parser';

const COMPOSE_FILE_RE = /(?:^|\/)(?:docker-)?compose(?:\.[^/]+)?\.ya?ml$/i;

function isComposeFile(filePath: string): boolean {
  return COMPOSE_FILE_RE.test(filePath.replace(/\\/g, '/'));
}

function dirOf(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const d = path.posix.dirname(norm);
  return d === '' ? '.' : d;
}

function normalizeRel(p: string): string {
  const norm = path.posix.normalize(p.replace(/\\/g, '/')).replace(/^\/+/, '').replace(/\/+$/, '');
  return norm === '' ? '.' : norm;
}

function joinRel(baseDir: string, rel: string): string {
  const cleaned = rel.replace(/\\/g, '/');
  if (cleaned.startsWith('/')) return normalizeRel(cleaned.slice(1));
  return normalizeRel(baseDir === '.' ? cleaned : `${baseDir}/${cleaned}`);
}

function pushRef(
  refs: UnresolvedRef[],
  seen: Set<string>,
  fromNodeId: string,
  referenceName: string,
  referenceKind: UnresolvedRef['referenceKind'],
  line: number,
  filePath: string
): void {
  const key = `${fromNodeId}\0${referenceKind}\0${referenceName}`;
  if (seen.has(key)) return;
  seen.add(key);
  refs.push({
    fromNodeId,
    referenceName,
    referenceKind,
    line,
    column: 0,
    filePath,
    language: 'yaml',
  });
}

function extractComposeIncludes(val: YamlValue | null, baseDir: string): Array<{ relPath: string; line: number }> {
  if (!val || val.kind !== 'seq') return [];
  const out: Array<{ relPath: string; line: number }> = [];
  for (const item of val.items) {
    if (item.kind === 'scalar' && item.value) {
      out.push({ relPath: joinRel(baseDir, item.value), line: item.startLine });
    } else if (item.kind === 'map') {
      const pathVal = yamlGet(item, 'path');
      if (pathVal?.kind === 'scalar' && pathVal.value) {
        out.push({ relPath: joinRel(baseDir, pathVal.value), line: pathVal.startLine });
      } else if (pathVal?.kind === 'seq') {
        for (const p of pathVal.items) {
          if (p.kind === 'scalar' && p.value) {
            out.push({ relPath: joinRel(baseDir, p.value), line: p.startLine });
          }
        }
      }
    }
  }
  return out;
}

function extractServiceRefs(val: YamlValue | null): Array<{ name: string; line: number }> {
  if (!val) return [];
  const out: Array<{ name: string; line: number }> = [];
  if (val.kind === 'seq') {
    for (const item of val.items) {
      if (item.kind === 'scalar' && item.value) {
        // `links` may carry `service:alias`
        const svc = item.value.split(':')[0]!.trim();
        if (svc) out.push({ name: svc, line: item.startLine });
      }
    }
  } else if (val.kind === 'map') {
    for (const e of val.entries) {
      out.push({ name: e.key, line: e.keyLine });
    }
  }
  return out;
}

function extractNamedVolumeRefs(val: YamlValue | null): Array<{ name: string; line: number }> {
  if (!val || val.kind !== 'seq') return [];
  const out: Array<{ name: string; line: number }> = [];
  for (const item of val.items) {
    if (item.kind === 'scalar' && item.value) {
      const colon = item.value.indexOf(':');
      if (colon <= 0) continue;
      const source = item.value.slice(0, colon).trim();
      // Skip host bind mounts (./path, ../path, /abs, ~/home, $VAR, C:\...)
      if (!source || /^[./~$\\]/.test(source) || /^[A-Za-z]:/.test(source)) continue;
      out.push({ name: source, line: item.startLine });
    } else if (item.kind === 'map') {
      const type = yamlGetString(item, 'type');
      const source = yamlGetString(item, 'source');
      if (source && (!type || type === 'volume') && !/^[./~$\\]/.test(source)) {
        out.push({ name: source, line: item.startLine });
      }
    }
  }
  return out;
}

function extractSourceListRefs(val: YamlValue | null): Array<{ name: string; line: number }> {
  if (!val || val.kind !== 'seq') return [];
  const out: Array<{ name: string; line: number }> = [];
  for (const item of val.items) {
    if (item.kind === 'scalar' && item.value) {
      out.push({ name: item.value, line: item.startLine });
    } else if (item.kind === 'map') {
      const src = yamlGetString(item, 'source');
      if (src) out.push({ name: src, line: item.startLine });
    }
  }
  return out;
}

function extractComposeFile(filePath: string, root: YamlMap, now: number): FrameworkExtractionResult {
  const servicesMap = yamlGetMap(root, 'services');
  const includeVal = yamlGet(root, 'include');
  const networksMap = yamlGetMap(root, 'networks');
  const volumesMap = yamlGetMap(root, 'volumes');
  const secretsMap = yamlGetMap(root, 'secrets');
  const configsMap = yamlGetMap(root, 'configs');

  if (!servicesMap && !includeVal && !networksMap && !volumesMap && !secretsMap && !configsMap) {
    return { nodes: [], references: [] };
  }

  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const seen = new Set<string>();
  const baseDir = dirOf(filePath);

  const composeName = `Compose/${filePath}`;
  const composeId = `dc:file:${filePath}:${root.startLine}`;
  const projectName = yamlGetString(root, 'name');
  nodes.push({
    id: composeId,
    kind: 'module',
    name: composeName,
    qualifiedName: `dc:${filePath}::${composeName}`,
    filePath,
    startLine: root.startLine,
    endLine: root.endLine,
    startColumn: 0,
    endColumn: 0,
    language: 'yaml',
    signature: `Docker Compose${projectName ? ` "${projectName}"` : ''} (${filePath})`,
    updatedAt: now,
  });

  // Top-level `include:` → other compose files
  for (const inc of extractComposeIncludes(includeVal, baseDir)) {
    pushRef(references, seen, composeId, `dc:file:${inc.relPath}:Compose/${inc.relPath}`, 'imports', inc.line, filePath);
  }

  // Top-level networks / volumes / secrets / configs
  const emitTopResources = (
    map: YamlMap | null,
    prefix: 'ComposeNetwork' | 'ComposeVolume' | 'ComposeSecret' | 'ComposeConfig',
    nodeKind: Node['kind'],
    idTag: 'net' | 'vol' | 'sec' | 'cfg'
  ) => {
    if (!map) return;
    for (const entry of map.entries) {
      const id = `dc:${idTag}:${filePath}:${entry.keyLine}:${entry.key}`;
      const name = `${prefix}/${entry.key}`;
      const driver = entry.value.kind === 'map' ? yamlGetString(entry.value, 'driver') : null;
      const ext = entry.value.kind === 'map' ? yamlGetString(entry.value, 'external') : null;
      const sigParts = [`${prefix.replace('Compose', '').toLowerCase()} ${entry.key}`];
      if (driver) sigParts.push(`(driver: ${driver})`);
      if (ext === 'true') sigParts.push('[external]');
      nodes.push({
        id,
        kind: nodeKind,
        name,
        qualifiedName: `dc:${filePath}::${name}`,
        filePath,
        startLine: entry.startLine,
        endLine: entry.endLine,
        startColumn: 0,
        endColumn: 0,
        language: 'yaml',
        signature: sigParts.join(' '),
        updatedAt: now,
      });

      // Top-level `secrets.<name>.file` / `configs.<name>.file`
      if ((idTag === 'sec' || idTag === 'cfg') && entry.value.kind === 'map') {
        const fileEntry = yamlGetEntry(entry.value, 'file');
        if (fileEntry && fileEntry.value.kind === 'scalar' && fileEntry.value.value) {
          const targetRel = joinRel(baseDir, fileEntry.value.value);
          pushRef(references, seen, id, `dc:localfile:${targetRel}`, 'imports', fileEntry.keyLine, filePath);
        }
      }
    }
  };

  emitTopResources(networksMap, 'ComposeNetwork', 'namespace', 'net');
  emitTopResources(volumesMap, 'ComposeVolume', 'constant', 'vol');
  emitTopResources(secretsMap, 'ComposeSecret', 'constant', 'sec');
  emitTopResources(configsMap, 'ComposeConfig', 'constant', 'cfg');

  // Services
  if (servicesMap) {
    for (const entry of servicesMap.entries) {
      if (entry.value.kind !== 'map') continue;
      const svcName = entry.key;
      const svcMap = entry.value;
      const svcNodeName = `ComposeService/${svcName}`;
      const svcId = `dc:svc:${filePath}:${entry.keyLine}:${svcName}`;

      const image = yamlGetString(svcMap, 'image');
      const buildVal = yamlGet(svcMap, 'build');
      const buildCtx =
        buildVal?.kind === 'scalar'
          ? buildVal.value
          : buildVal?.kind === 'map'
            ? yamlGetString(buildVal, 'context')
            : null;
      const ports = yamlStringList(yamlGet(svcMap, 'ports'));
      const sigParts = [`service ${svcName}`];
      if (image) sigParts.push(`(${image})`);
      else if (buildCtx) sigParts.push(`(build: ${buildCtx})`);
      if (ports.length > 0) sigParts.push(`[ports: ${ports.slice(0, 3).join(', ')}]`);

      nodes.push({
        id: svcId,
        kind: 'component',
        name: svcNodeName,
        qualifiedName: `dc:${filePath}::${svcNodeName}`,
        filePath,
        startLine: entry.startLine,
        endLine: entry.endLine,
        startColumn: 0,
        endColumn: 0,
        language: 'yaml',
        signature: sigParts.join(' '),
        updatedAt: now,
      });

      // Compose module → Service
      pushRef(references, seen, composeId, `dc:svc:${filePath}:${svcNodeName}`, 'calls', entry.keyLine, filePath);

      // `depends_on` & `links` → target service
      for (const dep of extractServiceRefs(yamlGet(svcMap, 'depends_on'))) {
        pushRef(references, seen, svcId, `dc:svc::ComposeService/${dep.name}`, 'calls', dep.line, filePath);
      }
      for (const link of extractServiceRefs(yamlGet(svcMap, 'links'))) {
        pushRef(references, seen, svcId, `dc:svc::ComposeService/${link.name}`, 'calls', link.line, filePath);
      }

      // `extends:` (string or `{ file, service }`) → parent service
      const extVal = yamlGet(svcMap, 'extends');
      if (extVal?.kind === 'scalar' && extVal.value) {
        pushRef(references, seen, svcId, `dc:svc:${filePath}:ComposeService/${extVal.value}`, 'extends', extVal.startLine, filePath);
      } else if (extVal?.kind === 'map') {
        const extSvc = yamlGetString(extVal, 'service');
        const extFile = yamlGetString(extVal, 'file');
        if (extSvc) {
          const targetFile = extFile ? joinRel(baseDir, extFile) : filePath;
          pushRef(references, seen, svcId, `dc:svc:${targetFile}:ComposeService/${extSvc}`, 'extends', extVal.startLine, filePath);
        }
      }

      // `networks` → ComposeNetwork
      for (const net of extractServiceRefs(yamlGet(svcMap, 'networks'))) {
        pushRef(references, seen, svcId, `dc:net::ComposeNetwork/${net.name}`, 'references', net.line, filePath);
      }

      // `volumes` → named ComposeVolume
      for (const vol of extractNamedVolumeRefs(yamlGet(svcMap, 'volumes'))) {
        pushRef(references, seen, svcId, `dc:vol::ComposeVolume/${vol.name}`, 'references', vol.line, filePath);
      }

      // `secrets` / `configs` → ComposeSecret / ComposeConfig
      for (const sec of extractSourceListRefs(yamlGet(svcMap, 'secrets'))) {
        pushRef(references, seen, svcId, `dc:sec::ComposeSecret/${sec.name}`, 'references', sec.line, filePath);
      }
      for (const cfg of extractSourceListRefs(yamlGet(svcMap, 'configs'))) {
        pushRef(references, seen, svcId, `dc:cfg::ComposeConfig/${cfg.name}`, 'references', cfg.line, filePath);
      }
    }
  }

  return { nodes, references };
}

interface ComposeIndex {
  filesByPath: Map<string, Node>;
  servicesByFileAndName: Map<string, Node>;
  servicesByName: Map<string, Node[]>;
  resourcesByFileAndName: Map<string, Node>;
  resourcesByName: Map<string, Node[]>;
}

interface CachedComposeIndex {
  refs: readonly [Node[], Node[], Node[], Node[]];
  index: ComposeIndex;
}

const composeIndexCache = new WeakMap<ResolutionContext, CachedComposeIndex>();

function getComposeIndex(context: ResolutionContext): ComposeIndex {
  const modules = context.getNodesByKind('module');
  const components = context.getNodesByKind('component');
  const namespaces = context.getNodesByKind('namespace');
  const constants = context.getNodesByKind('constant');
  const cached = composeIndexCache.get(context);
  if (
    cached &&
    cached.refs[0] === modules &&
    cached.refs[1] === components &&
    cached.refs[2] === namespaces &&
    cached.refs[3] === constants
  ) {
    return cached.index;
  }

  const filesByPath = new Map<string, Node>();
  const servicesByFileAndName = new Map<string, Node>();
  const servicesByName = new Map<string, Node[]>();
  const resourcesByFileAndName = new Map<string, Node>();
  const resourcesByName = new Map<string, Node[]>();

  for (const n of modules) {
    if (n.id.startsWith('dc:file:')) filesByPath.set(n.filePath, n);
  }
  for (const n of components) {
    if (!n.id.startsWith('dc:svc:')) continue;
    servicesByFileAndName.set(`${n.filePath}\0${n.name}`, n);
    let list = servicesByName.get(n.name);
    if (!list) {
      list = [];
      servicesByName.set(n.name, list);
    }
    list.push(n);
  }
  for (const bucket of [namespaces, constants]) {
    for (const n of bucket) {
      if (!n.id.startsWith('dc:')) continue;
      resourcesByFileAndName.set(`${n.filePath}\0${n.name}`, n);
      let list = resourcesByName.get(n.name);
      if (!list) {
        list = [];
        resourcesByName.set(n.name, list);
      }
      list.push(n);
    }
  }

  const index: ComposeIndex = {
    filesByPath,
    servicesByFileAndName,
    servicesByName,
    resourcesByFileAndName,
    resourcesByName,
  };
  composeIndexCache.set(context, { refs: [modules, components, namespaces, constants], index });
  return index;
}

function pickLocalOrSameDir(
  byFileAndName: Map<string, Node>,
  byName: Map<string, Node[]>,
  explicitFile: string,
  nodeName: string,
  ref: UnresolvedRef
): Node | null {
  if (explicitFile) {
    const exact = byFileAndName.get(`${explicitFile}\0${nodeName}`);
    return exact && exact.id !== ref.fromNodeId ? exact : null;
  }
  const sameFile = byFileAndName.get(`${ref.filePath}\0${nodeName}`);
  if (sameFile && sameFile.id !== ref.fromNodeId) return sameFile;

  const all = (byName.get(nodeName) ?? []).filter((n) => n.id !== ref.fromNodeId);
  if (all.length === 0) return null;
  const refDir = dirOf(ref.filePath);
  const sameDir = all.filter((n) => dirOf(n.filePath) === refDir);
  if (sameDir.length === 1) return sameDir[0]!;
  if (all.length === 1) return all[0]!;
  return null;
}

export const dockerComposeResolver: FrameworkResolver = {
  name: 'docker-compose',
  languages: ['yaml'],

  detect(context: ResolutionContext): boolean {
    return context.getAllFiles().some(isComposeFile);
  },

  claimsReference(name: string): boolean {
    return name.startsWith('dc:');
  },

  ownsReference(ref: UnresolvedRef): boolean {
    return ref.language === 'yaml' && ref.referenceName.startsWith('dc:');
  },

  extract(filePath: string, content: string): FrameworkExtractionResult {
    if (!isComposeFile(filePath)) return { nodes: [], references: [] };
    const docs = parseYamlDocuments(content);
    const root = docs[0]?.root;
    if (!root || root.kind !== 'map') return { nodes: [], references: [] };
    return extractComposeFile(filePath, root, Date.now());
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.language !== 'yaml' || !ref.referenceName.startsWith('dc:')) return null;
    const name = ref.referenceName;

    // 1. Local file referenced by secret/config `file:`
    if (name.startsWith('dc:localfile:')) {
      const targetPath = name.slice('dc:localfile:'.length);
      const fileNode = context.getNodesInFile(targetPath).find((n) => n.kind === 'file');
      if (!fileNode) return null;
      return { original: ref, targetNodeId: fileNode.id, confidence: 0.9, resolvedBy: 'framework' };
    }

    const index = getComposeIndex(context);

    // 2. Included Compose file: `dc:file:<relPath>:Compose/<relPath>`
    if (name.startsWith('dc:file:')) {
      const rest = name.slice('dc:file:'.length);
      const marker = ':Compose/';
      const idx = rest.lastIndexOf(marker);
      if (idx < 0) return null;
      const targetFile = rest.slice(0, idx);
      const target = index.filesByPath.get(targetFile);
      if (!target || target.id === ref.fromNodeId) return null;
      return { original: ref, targetNodeId: target.id, confidence: 0.95, resolvedBy: 'framework' };
    }

    // 3. Compose service: `dc:svc:<optionalFile>:ComposeService/<name>`
    if (name.startsWith('dc:svc:')) {
      const rest = name.slice('dc:svc:'.length);
      const marker = ':ComposeService/';
      const idx = rest.lastIndexOf(marker);
      if (idx < 0) return null;
      const explicitFile = rest.slice(0, idx);
      const svcNodeName = rest.slice(idx + 1);
      const target = pickLocalOrSameDir(index.servicesByFileAndName, index.servicesByName, explicitFile, svcNodeName, ref);
      if (!target) return null;
      return { original: ref, targetNodeId: target.id, confidence: 0.95, resolvedBy: 'framework' };
    }

    // 4. Compose network / volume / secret / config: `dc:(net|vol|sec|cfg)::<NodeName>`
    const m = name.match(/^dc:(?:net|vol|sec|cfg):([^:]*):(Compose(?:Network|Volume|Secret|Config)\/.+)$/);
    if (m) {
      const target = pickLocalOrSameDir(index.resourcesByFileAndName, index.resourcesByName, m[1]!, m[2]!, ref);
      if (!target) return null;
      return { original: ref, targetNodeId: target.id, confidence: 0.95, resolvedBy: 'framework' };
    }

    return null;
  },
};
