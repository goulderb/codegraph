/**
 * OpenAPI 3.x & Swagger 2.0 Semantic YAML Resolver
 *
 * Recognizes OpenAPI (`openapi: 3.*`) and Swagger (`swagger: 2.*`) YAML specs
 * and referenced schema fragments — never naive every-key indexing:
 *
 *   - Nodes:
 *       * `OpenAPI/<stem>` (`module`) — root specification
 *       * `<METHOD> <path>` (`route`) — each path operation (with `operationId` in signature)
 *       * `Schema/<Name>` (`interface`) — `components.schemas` / `definitions` / external schema files
 *       * `Parameter/<Name>` (`variable`) — `components.parameters`
 *       * `Response/<Name>` (`type_alias`) — `components.responses`
 *       * `RequestBody/<Name>` (`type_alias`) — `components.requestBodies`
 *       * `SecurityScheme/<Name>` (`constant`) — `components.securitySchemes`
 *   - Edges (all `oa:`-scoped with `claimsReference` + `ownsReference`):
 *       * `OpenAPI/<stem>` → its endpoint `route` nodes (`calls`)
 *       * Local & cross-file `$ref` (`#/components/schemas/User`, `./schemas/user.yaml#/User`,
 *         `./schemas/error.yaml`, `#/definitions/User`) → target component node (`references`)
 *       * Endpoint `route` → matching backend code `route` (Express/FastAPI/Spring/Go/Elysia/etc.,
 *         normalizing `:id` / `{id}` / `<id>` params) or unambiguous `operationId` handler (`calls`)
 */

import * as path from 'path';
import type { Node, NodeKind } from '../../types';
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
  type YamlMap,
  type YamlValue,
} from './yaml-parser';

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);

const COMPONENT_SECTIONS: Array<{
  section: string;
  swaggerSection?: string;
  prefix: 'Schema' | 'Parameter' | 'Response' | 'RequestBody' | 'SecurityScheme';
  nodeKind: NodeKind;
}> = [
  { section: 'schemas', swaggerSection: 'definitions', prefix: 'Schema', nodeKind: 'interface' },
  { section: 'parameters', swaggerSection: 'parameters', prefix: 'Parameter', nodeKind: 'variable' },
  { section: 'responses', swaggerSection: 'responses', prefix: 'Response', nodeKind: 'type_alias' },
  { section: 'requestBodies', prefix: 'RequestBody', nodeKind: 'type_alias' },
  { section: 'securitySchemes', swaggerSection: 'securityDefinitions', prefix: 'SecurityScheme', nodeKind: 'constant' },
];

const SECTION_TO_PREFIX: Record<string, string> = {
  schemas: 'Schema',
  definitions: 'Schema',
  parameters: 'Parameter',
  responses: 'Response',
  requestBodies: 'RequestBody',
  securitySchemes: 'SecurityScheme',
  securityDefinitions: 'SecurityScheme',
};

function isYamlFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.yaml') || lower.endsWith('.yml');
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

function stemOf(p: string): string {
  const base = path.posix.basename(p.replace(/\\/g, '/'));
  return base.replace(/\.(?:ya?ml)$/i, '');
}

/** Normalize an HTTP path so `/users/{id}`, `/users/:id`, and `/users/<int:id>` all compare equal. */
function normalizeRoutePath(rawPath: string): string {
  const withSlash = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  const trimmed = withSlash.length > 1 ? withSlash.replace(/\/+$/, '') : withSlash;
  return trimmed
    .split('/')
    .map((seg) => {
      if (!seg) return '';
      if (
        (seg.startsWith('{') && seg.endsWith('}')) ||
        (seg.startsWith(':') && seg.length > 1) ||
        (seg.startsWith('<') && seg.endsWith('>'))
      ) {
        return '{}';
      }
      return seg;
    })
    .join('/');
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

/** Parse a `$ref` string into a target `(filePath, componentNodeName)` pair. */
function parseDollarRef(
  refValue: string,
  currentFilePath: string
): { targetFile: string; targetNodeName: string } | null {
  const trimmed = refValue.trim();
  if (!trimmed || /^[a-z]+:\/\//i.test(trimmed)) return null; // external HTTP URL

  const hashIdx = trimmed.indexOf('#');
  const filePart = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed;
  const pointer = hashIdx >= 0 ? trimmed.slice(hashIdx + 1) : '';
  const targetFile = filePart ? joinRel(dirOf(currentFilePath), filePart) : currentFilePath;

  if (!pointer || pointer === '/') {
    // Whole-file fragment reference (`./schemas/user.yaml`)
    return { targetFile, targetNodeName: `Schema/${stemOf(targetFile)}` };
  }

  const segs = pointer.replace(/^\/+/, '').split('/').filter(Boolean).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (segs.length >= 3 && segs[0] === 'components') {
    const prefix = SECTION_TO_PREFIX[segs[1]!];
    if (prefix) return { targetFile, targetNodeName: `${prefix}/${segs[2]!}` };
  }
  if (segs.length >= 2) {
    const prefix = SECTION_TO_PREFIX[segs[0]!];
    if (prefix) return { targetFile, targetNodeName: `${prefix}/${segs[1]!}` };
  }
  if (segs.length === 1) {
    // External fragment like `./schemas/models.yaml#/User`
    return { targetFile, targetNodeName: `Schema/${segs[0]!}` };
  }

  return null;
}

/** Recursively walk any YAML subtree and emit `oa:ref:` edges for every `$ref`. */
function collectDollarRefs(
  val: YamlValue | null | undefined,
  fromNodeId: string,
  filePath: string,
  refs: UnresolvedRef[],
  seen: Set<string>
): void {
  if (!val) return;
  if (val.kind === 'map') {
    for (const entry of val.entries) {
      if (entry.key === '$ref' && entry.value.kind === 'scalar' && entry.value.value) {
        const parsed = parseDollarRef(entry.value.value, filePath);
        if (parsed) {
          pushRef(refs, seen, fromNodeId, `oa:ref:${parsed.targetFile}:${parsed.targetNodeName}`, 'references', entry.keyLine, filePath);
        }
      } else {
        collectDollarRefs(entry.value, fromNodeId, filePath, refs, seen);
      }
    }
  } else if (val.kind === 'seq') {
    for (const item of val.items) {
      collectDollarRefs(item, fromNodeId, filePath, refs, seen);
    }
  }
}

function isSchemaObject(map: YamlMap): boolean {
  return (
    yamlGet(map, 'type') !== null ||
    yamlGet(map, 'properties') !== null ||
    yamlGet(map, 'allOf') !== null ||
    yamlGet(map, 'oneOf') !== null ||
    yamlGet(map, 'anyOf') !== null ||
    yamlGet(map, 'enum') !== null ||
    yamlGet(map, 'items') !== null ||
    yamlGet(map, '$ref') !== null
  );
}

function extractComponentMap(
  map: YamlMap,
  prefix: 'Schema' | 'Parameter' | 'Response' | 'RequestBody' | 'SecurityScheme',
  nodeKind: NodeKind,
  filePath: string,
  now: number,
  nodes: Node[],
  references: UnresolvedRef[],
  seen: Set<string>
): void {
  for (const entry of map.entries) {
    const nodeName = `${prefix}/${entry.key}`;
    const nodeId = `oa:comp:${filePath}:${entry.keyLine}:${nodeName}`;
    const schemaType = entry.value.kind === 'map' ? yamlGetString(entry.value, 'type') : null;
    nodes.push({
      id: nodeId,
      kind: nodeKind,
      name: nodeName,
      qualifiedName: `openapi:${filePath}::${nodeName}`,
      filePath,
      startLine: entry.startLine,
      endLine: entry.endLine,
      startColumn: 0,
      endColumn: 0,
      language: 'yaml',
      signature: `${prefix} ${entry.key}${schemaType ? ` (${schemaType})` : ''}`,
      updatedAt: now,
    });
    collectDollarRefs(entry.value, nodeId, filePath, references, seen);
  }
}

function extractOpenApiSpec(filePath: string, root: YamlMap, now: number): FrameworkExtractionResult {
  const openapiVer = yamlGetString(root, 'openapi');
  const swaggerVer = yamlGetString(root, 'swagger');
  const isSpec =
    (openapiVer !== null && /^3\./.test(openapiVer)) ||
    (swaggerVer !== null && /^2\./.test(swaggerVer));

  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const seen = new Set<string>();

  if (isSpec) {
    const version = openapiVer ?? swaggerVer!;
    const specLabel = openapiVer ? `OpenAPI ${version}` : `Swagger ${version}`;
    const info = yamlGetMap(root, 'info');
    const title = yamlGetString(info, 'title') ?? stemOf(filePath);
    const apiVer = yamlGetString(info, 'version') ?? '';
    const basePath = swaggerVer ? (yamlGetString(root, 'basePath') ?? '') : '';

    const stem = stemOf(filePath);
    const specName = `OpenAPI/${stem}`;
    const specId = `oa:spec:${filePath}:${root.startLine}`;
    nodes.push({
      id: specId,
      kind: 'module',
      name: specName,
      qualifiedName: `openapi:${filePath}::${specName}`,
      filePath,
      startLine: root.startLine,
      endLine: root.endLine,
      startColumn: 0,
      endColumn: 0,
      language: 'yaml',
      signature: `${specLabel} "${title}"${apiVer ? ` (${apiVer})` : ''}`,
      updatedAt: now,
    });

    // Paths & operations
    const pathsMap = yamlGetMap(root, 'paths');
    if (pathsMap) {
      for (const pathEntry of pathsMap.entries) {
        if (pathEntry.value.kind !== 'map') continue;
        const pathItem = pathEntry.value;
        const rawFullPath = basePath
          ? `${basePath.replace(/\/+$/, '')}/${pathEntry.key.replace(/^\/+/, '')}`
          : pathEntry.key;
        const pathParams = yamlGet(pathItem, 'parameters');

        for (const opEntry of pathItem.entries) {
          const methodLower = opEntry.key.toLowerCase();
          if (!HTTP_METHODS.has(methodLower)) continue;
          const method = methodLower.toUpperCase();
          const opName = `${method} ${rawFullPath}`;
          const opId = `oa:op:${filePath}:${opEntry.keyLine}:${method}:${rawFullPath}`;

          const opMap = opEntry.value.kind === 'map' ? opEntry.value : null;
          const operationId = yamlGetString(opMap, 'operationId');
          const summary = yamlGetString(opMap, 'summary');
          const sigParts: string[] = [];
          if (operationId) sigParts.push(`${operationId} —`);
          sigParts.push(opName);
          if (summary) sigParts.push(`(${summary.slice(0, 60)})`);

          nodes.push({
            id: opId,
            kind: 'route',
            name: opName,
            qualifiedName: `openapi:${filePath}::${method}:${rawFullPath}`,
            filePath,
            startLine: opEntry.startLine,
            endLine: opEntry.endLine,
            startColumn: 0,
            endColumn: 0,
            language: 'yaml',
            signature: sigParts.join(' '),
            updatedAt: now,
          });

          // Spec → Operation
          pushRef(references, seen, specId, `oa:op:${filePath}:${opName}`, 'calls', opEntry.keyLine, filePath);

          // Collect `$ref`s in operation + path-level parameters
          collectDollarRefs(opEntry.value, opId, filePath, references, seen);
          if (pathParams) collectDollarRefs(pathParams, opId, filePath, references, seen);

          // Bridge OpenAPI operation → backend code route or operationId handler
          const normPath = normalizeRoutePath(rawFullPath);
          const implRef = operationId
            ? `oa:impl:${method}:${normPath}|${operationId}`
            : `oa:impl:${method}:${normPath}`;
          const implLine = yamlGetEntry(opMap, 'operationId')?.keyLine ?? opEntry.keyLine;
          pushRef(references, seen, opId, implRef, 'calls', implLine, filePath);
        }
      }
    }

    // Components (OpenAPI 3.x) & Swagger 2.0 top-level definitions/parameters/responses
    const components = yamlGetMap(root, 'components');
    for (const sec of COMPONENT_SECTIONS) {
      const m = yamlGetMap(components, sec.section) ?? (sec.swaggerSection ? yamlGetMap(root, sec.swaggerSection) : null);
      if (m) extractComponentMap(m, sec.prefix, sec.nodeKind, filePath, now, nodes, references, seen);
    }

    return { nodes, references };
  }

  // External referenced OpenAPI schema / component fragment (only runs when OpenAPI is detected in the repo)
  // Guard strictly against K8s, CI, and Compose shapes.
  if (yamlGetString(root, 'apiVersion') && yamlGetString(root, 'kind')) return { nodes: [], references: [] };
  if (yamlGetMap(root, 'jobs') && yamlGet(root, 'on')) return { nodes: [], references: [] };
  if (yamlGetMap(root, 'services')) return { nodes: [], references: [] };

  const components = yamlGetMap(root, 'components');
  if (components) {
    for (const sec of COMPONENT_SECTIONS) {
      const m = yamlGetMap(components, sec.section);
      if (m) extractComponentMap(m, sec.prefix, sec.nodeKind, filePath, now, nodes, references, seen);
    }
    if (nodes.length > 0) return { nodes, references };
  }

  // Single-schema file (e.g. `schemas/user.yaml` with top-level `type: object` + `properties:`)
  if (isSchemaObject(root) && (yamlGet(root, 'properties') || yamlGet(root, 'allOf') || yamlGet(root, 'oneOf') || yamlGet(root, 'anyOf') || yamlGet(root, 'enum'))) {
    const schemaName = stemOf(filePath);
    const nodeName = `Schema/${schemaName}`;
    const nodeId = `oa:comp:${filePath}:${root.startLine}:${nodeName}`;
    const schemaType = yamlGetString(root, 'type');
    nodes.push({
      id: nodeId,
      kind: 'interface',
      name: nodeName,
      qualifiedName: `openapi:${filePath}::${nodeName}`,
      filePath,
      startLine: root.startLine,
      endLine: root.endLine,
      startColumn: 0,
      endColumn: 0,
      language: 'yaml',
      signature: `Schema ${schemaName}${schemaType ? ` (${schemaType})` : ''}`,
      updatedAt: now,
    });
    collectDollarRefs(root, nodeId, filePath, references, seen);
    return { nodes, references };
  }

  // Multi-schema fragment file (e.g. `schemas/models.yaml` with `User: { type: object, properties: ... }`)
  const schemaEntries = root.entries.filter(
    (e) => e.value.kind === 'map' && isSchemaObject(e.value) && (yamlGet(e.value, 'properties') || yamlGet(e.value, 'allOf') || yamlGet(e.value, 'oneOf') || yamlGet(e.value, 'enum'))
  );
  if (schemaEntries.length > 0 && schemaEntries.length === root.entries.length) {
    extractComponentMap(root, 'Schema', 'interface', filePath, now, nodes, references, seen);
    return { nodes, references };
  }

  return { nodes: [], references: [] };
}

interface OpenApiIndex {
  componentsByFileAndName: Map<string, Node>;
  opsByFileAndName: Map<string, Node>;
  codeRoutesByMethodPath: Map<string, Node[]>;
}

interface CachedOpenApiIndex {
  refs: readonly [Node[], Node[], Node[], Node[], Node[]];
  index: OpenApiIndex;
}

const openApiIndexCache = new WeakMap<ResolutionContext, CachedOpenApiIndex>();

function getOpenApiIndex(context: ResolutionContext): OpenApiIndex {
  const routes = context.getNodesByKind('route');
  const interfaces = context.getNodesByKind('interface');
  const variables = context.getNodesByKind('variable');
  const typeAliases = context.getNodesByKind('type_alias');
  const constants = context.getNodesByKind('constant');

  const cached = openApiIndexCache.get(context);
  if (
    cached &&
    cached.refs[0] === routes &&
    cached.refs[1] === interfaces &&
    cached.refs[2] === variables &&
    cached.refs[3] === typeAliases &&
    cached.refs[4] === constants
  ) {
    return cached.index;
  }

  const componentsByFileAndName = new Map<string, Node>();
  const opsByFileAndName = new Map<string, Node>();
  const codeRoutesByMethodPath = new Map<string, Node[]>();

  for (const r of routes) {
    if (r.id.startsWith('oa:op:')) {
      opsByFileAndName.set(`${r.filePath}\0${r.name}`, r);
      continue;
    }
    if (r.language === 'yaml') continue;
    // Index backend code routes (`GET /users/:id`, `POST /orders`, etc.)
    const m = r.name.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|ANY)\s+(\/\S*)$/i);
    if (!m) continue;
    const method = m[1]!.toUpperCase();
    const normPath = normalizeRoutePath(m[2]!);
    const key = `${method} ${normPath}`;
    let list = codeRoutesByMethodPath.get(key);
    if (!list) {
      list = [];
      codeRoutesByMethodPath.set(key, list);
    }
    list.push(r);
  }

  for (const bucket of [interfaces, variables, typeAliases, constants]) {
    for (const n of bucket) {
      if (n.id.startsWith('oa:comp:')) {
        componentsByFileAndName.set(`${n.filePath}\0${n.name}`, n);
      }
    }
  }

  const index: OpenApiIndex = { componentsByFileAndName, opsByFileAndName, codeRoutesByMethodPath };
  openApiIndexCache.set(context, { refs: [routes, interfaces, variables, typeAliases, constants], index });
  return index;
}

export const openApiResolver: FrameworkResolver = {
  name: 'openapi',
  languages: ['yaml'],

  detect(context: ResolutionContext): boolean {
    const yamlFiles = context.getAllFiles().filter(isYamlFile);
    for (const f of yamlFiles) {
      if (context.fileContains && !context.fileContains(f, 'openapi:') && !context.fileContains(f, 'swagger:')) {
        continue;
      }
      const content = context.readFile(f);
      if (!content) continue;
      if (/^(?:openapi:\s*['"]?3\.|swagger:\s*['"]?2\.)/m.test(content)) {
        return true;
      }
    }
    return false;
  },

  claimsReference(name: string): boolean {
    return name.startsWith('oa:');
  },

  ownsReference(ref: UnresolvedRef): boolean {
    return ref.language === 'yaml' && ref.referenceName.startsWith('oa:');
  },

  extract(filePath: string, content: string): FrameworkExtractionResult {
    if (!isYamlFile(filePath)) return { nodes: [], references: [] };
    const docs = parseYamlDocuments(content);
    const root = docs[0]?.root;
    if (!root || root.kind !== 'map') return { nodes: [], references: [] };
    return extractOpenApiSpec(filePath, root, Date.now());
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.language !== 'yaml' || !ref.referenceName.startsWith('oa:')) return null;
    const index = getOpenApiIndex(context);
    const name = ref.referenceName;

    // 1. Spec → Operation: `oa:op:<filePath>:<METHOD> <path>`
    if (name.startsWith('oa:op:')) {
      const rest = name.slice('oa:op:'.length);
      const colon = rest.indexOf(':');
      if (colon < 0) return null;
      const targetFile = rest.slice(0, colon);
      const opName = rest.slice(colon + 1);
      const target = index.opsByFileAndName.get(`${targetFile}\0${opName}`);
      if (!target || target.id === ref.fromNodeId) return null;
      return { original: ref, targetNodeId: target.id, confidence: 0.95, resolvedBy: 'framework' };
    }

    // 2. Local or cross-file `$ref`: `oa:ref:<targetFile>:<Kind>/<Name>`
    if (name.startsWith('oa:ref:')) {
      const rest = name.slice('oa:ref:'.length);
      const colon = rest.lastIndexOf(':');
      if (colon < 0) return null;
      const targetFile = rest.slice(0, colon);
      const compName = rest.slice(colon + 1);
      const target = index.componentsByFileAndName.get(`${targetFile}\0${compName}`);
      if (!target || target.id === ref.fromNodeId) return null;
      return { original: ref, targetNodeId: target.id, confidence: 0.95, resolvedBy: 'framework' };
    }

    // 3. Operation → Backend code route or operationId handler: `oa:impl:<METHOD>:<normPath>[|<operationId>]`
    if (name.startsWith('oa:impl:')) {
      const rest = name.slice('oa:impl:'.length);
      const pipe = rest.indexOf('|');
      const methodAndPath = pipe >= 0 ? rest.slice(0, pipe) : rest;
      const operationId = pipe >= 0 ? rest.slice(pipe + 1) : '';
      const colon = methodAndPath.indexOf(':');
      if (colon < 0) return null;
      const method = methodAndPath.slice(0, colon);
      const normPath = methodAndPath.slice(colon + 1);

      // 3a. Exact (METHOD, normalized path) match against backend code routes
      const exactRoutes = index.codeRoutesByMethodPath.get(`${method} ${normPath}`) ?? [];
      if (exactRoutes.length === 1) {
        return { original: ref, targetNodeId: exactRoutes[0]!.id, confidence: 0.9, resolvedBy: 'framework' };
      }

      // 3b. Unique `operationId` match against a code function or method
      if (operationId) {
        const handlers = context
          .getNodesByName(operationId)
          .filter((n) => n.language !== 'yaml' && (n.kind === 'function' || n.kind === 'method'));
        if (handlers.length === 1) {
          return { original: ref, targetNodeId: handlers[0]!.id, confidence: 0.85, resolvedBy: 'framework' };
        }
      }

      return null;
    }

    return null;
  },
};
