/**
 * Azure DevOps Pipelines Semantic YAML Resolver
 *
 * Models real Azure Pipelines constructs — never naive every-key indexing:
 *
 *   - Nodes:
 *       * `AzurePipeline/<relPathWithoutExt>` (`module`) — root pipelines and reusable templates
 *       * `AzureStage/<stem>/<stageId>` (`function`) — pipeline stages
 *       * `AzureJob/<stem>/<jobId>` (`function`) — `job:` and `deployment:` jobs
 *   - Edges (all `azdo:`-scoped with `claimsReference` + `ownsReference`):
 *       * Pipeline → its stages / jobs (`calls`)
 *       * Stage → its jobs (`calls`), Stage `dependsOn:` → upstream stages (`references`)
 *       * Job `dependsOn:` → upstream jobs (`references`)
 *       * `extends.template` → base template (`extends`)
 *       * `stages[].template` / `jobs[].template` / `steps[].template` → included template (`calls`)
 *       * `variables[].template` → variable template (`imports`)
 *       * Transparently recurses into `${{ if ... }}` / `${{ each ... }}` compile-time wrappers
 *         and `deployment:` `strategy.{runOnce,rolling,canary}` hooks (`deploy`, `preDeploy`, …)
 *       * `script:` / `bash:` / `pwsh:` / `powershell:` and `Bash@3`/`PowerShell@2`/`PythonScript@0`
 *         `inputs.filePath`/`inputs.scriptPath`/`inputs.script` → indexed repository scripts (`calls`)
 *       * Cross-repo templates (`foo.yml@externalRepo`) stay unresolved visible boundaries;
 *         `@self` resolves locally.
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
  type YamlMap,
  type YamlValue,
} from './yaml-parser';

const AZDO_PATH_RE = /(?:^|\/)(?:azure-pipelines(?:[-.][^/]*)?\.ya?ml|\.(?:azure-pipelines|azuredevops)\/.+\.ya?ml)$/i;
const ACTIONS_PATH_RE = /(?:^|\/)\.(?:github|forgejo|gitea)\/workflows\//i;
const COMPOSE_PATH_RE = /(?:^|\/)(?:docker-)?compose(?:\.[^/]+)?\.ya?ml$/i;

const INDEXABLE_SCRIPT_EXTS = new Set([
  '.py', '.pyw', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '.go', '.rb', '.rake', '.php', '.rs', '.lua', '.dart', '.kt', '.kts',
]);

const SCRIPT_PATH_RE = /(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\/|\$\([A-Za-z0-9_.]+\)\/)?(?:\.\.?\/)?([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:pyw?|tsx?|mts|cts|jsx?|mjs|cjs|go|rb|rake|php|rs|lua|dart|kts?))\b/g;

function isYamlFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.yaml') || lower.endsWith('.yml');
}

function isAzdoFilePath(filePath: string): boolean {
  return AZDO_PATH_RE.test(filePath.replace(/\\/g, '/'));
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

function joinTemplatePath(fromFile: string, rawTemplate: string): string | null {
  let cleaned = rawTemplate.trim();
  if (!cleaned || cleaned.includes('${{') || cleaned.includes('$(')) return null;
  const atIdx = cleaned.indexOf('@');
  if (atIdx >= 0) {
    const repoAlias = cleaned.slice(atIdx + 1).trim();
    if (repoAlias.toLowerCase() !== 'self') return null; // external repository template — visible boundary
    cleaned = cleaned.slice(0, atIdx).trim();
  }
  if (!cleaned) return null;
  cleaned = cleaned.replace(/\\/g, '/');
  if (cleaned.startsWith('/')) return normalizeRel(cleaned.slice(1));
  const base = dirOf(fromFile);
  return normalizeRel(base === '.' ? cleaned : `${base}/${cleaned}`);
}

function pipelineLabelFor(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/\.(?:ya?ml)$/i, '');
}

function stemOf(filePath: string): string {
  const base = path.posix.basename(filePath.replace(/\\/g, '/'));
  return base.replace(/\.(?:ya?ml)$/i, '');
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

function scanScriptRefs(
  command: string,
  startLine: number,
  fromNodeId: string,
  filePath: string,
  refs: UnresolvedRef[],
  seen: Set<string>
): void {
  const lines = command.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    SCRIPT_PATH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SCRIPT_PATH_RE.exec(line)) !== null) {
      const full = m[0]!;
      const before = line.slice(Math.max(0, m.index - 8), m.index);
      if (/:\/\/\S*$/.test(before)) continue;
      if (m.index > 0 && line[m.index - 1] === '/' && !full.startsWith('$')) continue;
      const rawRel = m[1]!;
      const ext = path.posix.extname(rawRel).toLowerCase();
      if (!INDEXABLE_SCRIPT_EXTS.has(ext)) continue;
      const cleaned = normalizeRel(rawRel);
      if (!cleaned || cleaned === '.') continue;
      pushRef(refs, seen, fromNodeId, `azdo:script:${cleaned}`, 'calls', startLine + i, filePath);
    }
  }
}

/** True when a YAML root looks like an Azure DevOps Pipeline or Pipeline Template. */
function isAzdoRoot(filePath: string, root: YamlMap): { isPipeline: boolean; isTemplate: boolean } | null {
  const norm = filePath.replace(/\\/g, '/');
  if (ACTIONS_PATH_RE.test(norm) || COMPOSE_PATH_RE.test(norm)) return null;
  if (path.posix.basename(norm).toLowerCase().startsWith('.gitlab-ci.')) return null;
  if (yamlGetString(root, 'apiVersion') && yamlGetString(root, 'kind')) return null;
  if (yamlGetString(root, 'openapi') || yamlGetString(root, 'swagger')) return null;
  // GitHub Actions `jobs` is a map, whereas Azure Pipelines `jobs` is a sequence!
  const jobsVal = yamlGet(root, 'jobs');
  if (jobsVal && jobsVal.kind === 'map') return null;

  const hasTrigger = yamlGet(root, 'trigger') !== null || yamlGet(root, 'pr') !== null || yamlGet(root, 'schedules') !== null;
  const hasPool = yamlGet(root, 'pool') !== null;
  const hasStages = yamlGet(root, 'stages')?.kind === 'seq';
  const hasJobs = jobsVal?.kind === 'seq';
  const hasSteps = yamlGet(root, 'steps')?.kind === 'seq';
  const hasExtends = yamlGetMap(root, 'extends') !== null && yamlGetString(yamlGetMap(root, 'extends'), 'template') !== null;
  const hasVariables = yamlGet(root, 'variables') !== null;
  const hasParameters = yamlGet(root, 'parameters')?.kind === 'seq';

  if (isAzdoFilePath(filePath) && (hasTrigger || hasPool || hasStages || hasJobs || hasSteps || hasExtends || hasVariables)) {
    return { isPipeline: true, isTemplate: !hasTrigger && !hasPool && hasParameters };
  }

  // Root pipeline anywhere in the repo (e.g. `pipelines/ci.yml`): requires Azure trigger/pr/pool + body
  if ((hasTrigger || hasPool) && (hasStages || hasJobs || hasSteps || hasExtends)) {
    return { isPipeline: true, isTemplate: false };
  }

  // Template files (`stages:` / `jobs:` / `steps:` sequence, or `parameters:` + `variables:`)
  if (hasStages || hasJobs || hasSteps || hasExtends) {
    return { isPipeline: false, isTemplate: true };
  }
  if (hasVariables && (hasParameters || /(?:^|\/)(?:templates?|vars?|variables?|pipelines?|\.azuredevops|\.azure-pipelines)\//i.test(norm))) {
    return { isPipeline: false, isTemplate: true };
  }

  return null;
}

/**
 * Flatten a YAML sequence while transparently unwrapping Azure compile-time
 * expressions (`- ${{ if ... }}: [items]` or `- ${{ each ... }}: [items]`).
 */
function flattenAzdoList(val: YamlValue | null | undefined): YamlMap[] {
  if (!val) return [];
  const out: YamlMap[] = [];
  const visit = (node: YamlValue) => {
    if (node.kind === 'seq') {
      for (const item of node.items) visit(item);
    } else if (node.kind === 'map') {
      // Check if this map is a `${{ if ... }}:` / `${{ each ... }}:` wrapper
      const isWrapper = node.entries.length > 0 && node.entries.every((e) => e.key.trim().startsWith('${{'));
      if (isWrapper) {
        for (const e of node.entries) visit(e.value);
      } else {
        out.push(node);
        // Also unwrap any nested `${{ if ... }}:` keys inside a map item if they hold sub-lists
        for (const e of node.entries) {
          if (e.key.trim().startsWith('${{') && e.value.kind === 'seq') {
            visit(e.value);
          }
        }
      }
    }
  };
  visit(val);
  return out;
}

function readDependsOn(map: YamlMap): Array<{ name: string; line: number }> {
  const entry = yamlGetEntry(map, 'dependsOn');
  if (!entry) return [];
  const out: Array<{ name: string; line: number }> = [];
  if (entry.value.kind === 'scalar' && entry.value.value) {
    out.push({ name: entry.value.value, line: entry.keyLine });
  } else if (entry.value.kind === 'seq') {
    for (const item of entry.value.items) {
      if (item.kind === 'scalar' && item.value) {
        out.push({ name: item.value, line: item.startLine });
      }
    }
  }
  return out;
}

function extractSteps(
  stepsVal: YamlValue | null | undefined,
  ownerNodeId: string,
  filePath: string,
  refs: UnresolvedRef[],
  seen: Set<string>
): void {
  for (const step of flattenAzdoList(stepsVal)) {
    // Template include step: `- template: templates/install.yml`
    const tplEntry = yamlGetEntry(step, 'template');
    if (tplEntry && tplEntry.value.kind === 'scalar' && tplEntry.value.value) {
      const targetFile = joinTemplatePath(filePath, tplEntry.value.value);
      if (targetFile) {
        const targetName = `AzurePipeline/${pipelineLabelFor(targetFile)}`;
        pushRef(refs, seen, ownerNodeId, `azdo:tpl:${targetFile}:${targetName}`, 'calls', tplEntry.keyLine, filePath);
      }
      continue;
    }

    // Inline script shorthands (`script:`, `bash:`, `pwsh:`, `powershell:`)
    for (const key of ['script', 'bash', 'pwsh', 'powershell'] as const) {
      const entry = yamlGetEntry(step, key);
      if (entry && entry.value.kind === 'scalar' && entry.value.value) {
        scanScriptRefs(entry.value.value, entry.keyLine, ownerNodeId, filePath, refs, seen);
      }
    }

    // Tasks (`task: Bash@3`, `PowerShell@2`, `PythonScript@0`, etc.)
    const inputs = yamlGetMap(step, 'inputs');
    if (inputs) {
      for (const pathKey of ['filePath', 'scriptPath'] as const) {
        const entry = yamlGetEntry(inputs, pathKey);
        if (entry && entry.value.kind === 'scalar' && entry.value.value) {
          scanScriptRefs(entry.value.value, entry.keyLine, ownerNodeId, filePath, refs, seen);
        }
      }
      const scriptEntry = yamlGetEntry(inputs, 'script');
      if (scriptEntry && scriptEntry.value.kind === 'scalar' && scriptEntry.value.value) {
        scanScriptRefs(scriptEntry.value.value, scriptEntry.keyLine, ownerNodeId, filePath, refs, seen);
      }
    }
  }
}

/** Recursively extract `steps:` inside a deployment job's `strategy` block (`runOnce`, `rolling`, `canary`). */
function extractStrategySteps(
  strategyVal: YamlValue | null | undefined,
  ownerNodeId: string,
  filePath: string,
  refs: UnresolvedRef[],
  seen: Set<string>
): void {
  if (!strategyVal || strategyVal.kind !== 'map') return;
  for (const entry of strategyVal.entries) {
    if (entry.key === 'steps') {
      extractSteps(entry.value, ownerNodeId, filePath, refs, seen);
    } else if (entry.value.kind === 'map') {
      extractStrategySteps(entry.value, ownerNodeId, filePath, refs, seen);
    }
  }
}

function extractVariablesTemplates(
  varsVal: YamlValue | null | undefined,
  ownerNodeId: string,
  filePath: string,
  refs: UnresolvedRef[],
  seen: Set<string>
): void {
  for (const v of flattenAzdoList(varsVal)) {
    const tplEntry = yamlGetEntry(v, 'template');
    if (tplEntry && tplEntry.value.kind === 'scalar' && tplEntry.value.value) {
      const targetFile = joinTemplatePath(filePath, tplEntry.value.value);
      if (targetFile) {
        const targetName = `AzurePipeline/${pipelineLabelFor(targetFile)}`;
        pushRef(refs, seen, ownerNodeId, `azdo:tpl:${targetFile}:${targetName}`, 'imports', tplEntry.keyLine, filePath);
      }
    }
  }
}

function extractJobsList(
  jobsVal: YamlValue | null | undefined,
  parentNodeId: string,
  filePath: string,
  stem: string,
  now: number,
  nodes: Node[],
  refs: UnresolvedRef[],
  seen: Set<string>
): void {
  for (const jobMap of flattenAzdoList(jobsVal)) {
    // Job template include: `- template: templates/test-jobs.yml`
    const tplEntry = yamlGetEntry(jobMap, 'template');
    if (tplEntry && tplEntry.value.kind === 'scalar' && tplEntry.value.value) {
      const targetFile = joinTemplatePath(filePath, tplEntry.value.value);
      if (targetFile) {
        const targetName = `AzurePipeline/${pipelineLabelFor(targetFile)}`;
        pushRef(refs, seen, parentNodeId, `azdo:tpl:${targetFile}:${targetName}`, 'calls', tplEntry.keyLine, filePath);
      }
      continue;
    }

    const jobName = yamlGetString(jobMap, 'job');
    const deployName = yamlGetString(jobMap, 'deployment');
    const id = jobName ?? deployName;
    if (!id) continue;

    const isDeployment = deployName !== null;
    const nodeName = `AzureJob/${stem}/${id}`;
    const jobNodeId = `azdo:job:${filePath}:${jobMap.startLine}:${id}`;
    const envVal = yamlGet(jobMap, 'environment');
    const envName =
      envVal?.kind === 'scalar'
        ? envVal.value
        : envVal?.kind === 'map'
          ? yamlGetString(envVal, 'name')
          : null;

    const sigParts = [isDeployment ? `deployment ${id}` : `job ${id}`];
    if (envName) sigParts.push(`[env: ${envName}]`);

    nodes.push({
      id: jobNodeId,
      kind: 'function',
      name: nodeName,
      qualifiedName: `azdo:${filePath}::${nodeName}`,
      filePath,
      startLine: jobMap.startLine,
      endLine: jobMap.endLine,
      startColumn: 0,
      endColumn: 0,
      language: 'yaml',
      signature: sigParts.join(' '),
      updatedAt: now,
    });

    pushRef(refs, seen, parentNodeId, `azdo:job:${filePath}:${nodeName}`, 'calls', jobMap.startLine, filePath);

    for (const dep of readDependsOn(jobMap)) {
      pushRef(refs, seen, jobNodeId, `azdo:job:${filePath}:AzureJob/${stem}/${dep.name}`, 'references', dep.line, filePath);
    }

    extractVariablesTemplates(yamlGet(jobMap, 'variables'), jobNodeId, filePath, refs, seen);
    extractSteps(yamlGet(jobMap, 'steps'), jobNodeId, filePath, refs, seen);
    if (isDeployment) {
      extractStrategySteps(yamlGet(jobMap, 'strategy'), jobNodeId, filePath, refs, seen);
    }
  }
}

function extractAzurePipeline(
  filePath: string,
  root: YamlMap,
  kindInfo: { isPipeline: boolean; isTemplate: boolean },
  now: number
): FrameworkExtractionResult {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const seen = new Set<string>();

  const label = pipelineLabelFor(filePath);
  const stem = stemOf(filePath);
  const pipeName = `AzurePipeline/${label}`;
  const pipeId = `azdo:pipe:${filePath}:${root.startLine}`;
  const displayName = yamlGetString(root, 'name');

  const sigParts = [kindInfo.isTemplate ? 'Azure Template' : 'Azure Pipeline', filePath];
  if (displayName) sigParts.push(`"${displayName}"`);

  nodes.push({
    id: pipeId,
    kind: 'module',
    name: pipeName,
    qualifiedName: `azdo:${filePath}::${pipeName}`,
    filePath,
    startLine: root.startLine,
    endLine: root.endLine,
    startColumn: 0,
    endColumn: 0,
    language: 'yaml',
    signature: sigParts.join(' '),
    updatedAt: now,
  });

  // `extends: { template: ... }`
  const extendsMap = yamlGetMap(root, 'extends');
  if (extendsMap) {
    const tplEntry = yamlGetEntry(extendsMap, 'template');
    if (tplEntry && tplEntry.value.kind === 'scalar' && tplEntry.value.value) {
      const targetFile = joinTemplatePath(filePath, tplEntry.value.value);
      if (targetFile) {
        const targetName = `AzurePipeline/${pipelineLabelFor(targetFile)}`;
        pushRef(references, seen, pipeId, `azdo:tpl:${targetFile}:${targetName}`, 'extends', tplEntry.keyLine, filePath);
      }
    }
  }

  // Top-level `variables:` templates
  extractVariablesTemplates(yamlGet(root, 'variables'), pipeId, filePath, references, seen);

  // Top-level `stages:`
  const stagesVal = yamlGet(root, 'stages');
  if (stagesVal) {
    for (const stageMap of flattenAzdoList(stagesVal)) {
      const tplEntry = yamlGetEntry(stageMap, 'template');
      if (tplEntry && tplEntry.value.kind === 'scalar' && tplEntry.value.value) {
        const targetFile = joinTemplatePath(filePath, tplEntry.value.value);
        if (targetFile) {
          const targetName = `AzurePipeline/${pipelineLabelFor(targetFile)}`;
          pushRef(references, seen, pipeId, `azdo:tpl:${targetFile}:${targetName}`, 'calls', tplEntry.keyLine, filePath);
        }
        continue;
      }

      const stageId = yamlGetString(stageMap, 'stage');
      if (!stageId) continue;
      const stageNodeName = `AzureStage/${stem}/${stageId}`;
      const stageNodeId = `azdo:stage:${filePath}:${stageMap.startLine}:${stageId}`;

      nodes.push({
        id: stageNodeId,
        kind: 'function',
        name: stageNodeName,
        qualifiedName: `azdo:${filePath}::${stageNodeName}`,
        filePath,
        startLine: stageMap.startLine,
        endLine: stageMap.endLine,
        startColumn: 0,
        endColumn: 0,
        language: 'yaml',
        signature: `stage ${stageId}`,
        updatedAt: now,
      });

      pushRef(references, seen, pipeId, `azdo:stage:${filePath}:${stageNodeName}`, 'calls', stageMap.startLine, filePath);

      for (const dep of readDependsOn(stageMap)) {
        pushRef(references, seen, stageNodeId, `azdo:stage:${filePath}:AzureStage/${stem}/${dep.name}`, 'references', dep.line, filePath);
      }

      extractVariablesTemplates(yamlGet(stageMap, 'variables'), stageNodeId, filePath, references, seen);
      extractJobsList(yamlGet(stageMap, 'jobs'), stageNodeId, filePath, stem, now, nodes, references, seen);
    }
  }

  // Top-level `jobs:` (single-stage pipeline or job template)
  extractJobsList(yamlGet(root, 'jobs'), pipeId, filePath, stem, now, nodes, references, seen);

  // Top-level `steps:` (single-job pipeline or step template)
  extractSteps(yamlGet(root, 'steps'), pipeId, filePath, references, seen);

  return { nodes, references };
}

interface AzdoIndex {
  pipelinesByFile: Map<string, Node>;
  stagesByFileAndName: Map<string, Node>;
  jobsByFileAndName: Map<string, Node>;
}

interface CachedAzdoIndex {
  refs: readonly [Node[], Node[]];
  index: AzdoIndex;
}

const azdoIndexCache = new WeakMap<ResolutionContext, CachedAzdoIndex>();

function getAzdoIndex(context: ResolutionContext): AzdoIndex {
  const modules = context.getNodesByKind('module');
  const functions = context.getNodesByKind('function');
  const cached = azdoIndexCache.get(context);
  if (cached && cached.refs[0] === modules && cached.refs[1] === functions) {
    return cached.index;
  }

  const pipelinesByFile = new Map<string, Node>();
  const stagesByFileAndName = new Map<string, Node>();
  const jobsByFileAndName = new Map<string, Node>();

  for (const n of modules) {
    if (n.id.startsWith('azdo:pipe:')) pipelinesByFile.set(n.filePath, n);
  }
  for (const n of functions) {
    if (n.id.startsWith('azdo:stage:')) stagesByFileAndName.set(`${n.filePath}\0${n.name}`, n);
    else if (n.id.startsWith('azdo:job:')) jobsByFileAndName.set(`${n.filePath}\0${n.name}`, n);
  }

  const index: AzdoIndex = { pipelinesByFile, stagesByFileAndName, jobsByFileAndName };
  azdoIndexCache.set(context, { refs: [modules, functions], index });
  return index;
}

function resolveAzdoScript(scriptPath: string, ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const exactNode = context.getNodesInFile(scriptPath).find((n) => n.kind === 'file');
  if (exactNode) {
    return { original: ref, targetNodeId: exactNode.id, confidence: 0.95, resolvedBy: 'framework' };
  }
  const allFiles = context.getAllFiles();
  const segments = scriptPath.split('/').filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    const candidate = segments.slice(i).join('/');
    if (i > 0 && !candidate.includes('/')) {
      const rootNode = context.getNodesInFile(candidate).find((n) => n.kind === 'file');
      if (rootNode) return { original: ref, targetNodeId: rootNode.id, confidence: 0.85, resolvedBy: 'framework' };
      break;
    }
    const matches = allFiles.filter((f) => f === candidate || f.endsWith(`/${candidate}`));
    if (matches.length === 1) {
      const fileNode = context.getNodesInFile(matches[0]!).find((n) => n.kind === 'file');
      if (fileNode) return { original: ref, targetNodeId: fileNode.id, confidence: 0.9, resolvedBy: 'framework' };
    }
  }
  return null;
}

export const azurePipelinesResolver: FrameworkResolver = {
  name: 'azure-pipelines',
  languages: ['yaml'],

  detect(context: ResolutionContext): boolean {
    const yamlFiles = context.getAllFiles().filter(isYamlFile);
    if (yamlFiles.length === 0) return false;
    if (yamlFiles.some(isAzdoFilePath)) return true;

    for (const f of yamlFiles) {
      if (ACTIONS_PATH_RE.test(f) || COMPOSE_PATH_RE.test(f)) continue;
      if (
        context.fileContains &&
        !context.fileContains(f, 'trigger:') &&
        !context.fileContains(f, 'pool:') &&
        !context.fileContains(f, 'pr:')
      ) {
        continue;
      }
      const content = context.readFile(f);
      if (!content) continue;
      if (
        /^(?:trigger|pr|pool):/m.test(content) &&
        /^(?:stages|jobs|steps|extends):/m.test(content) &&
        !/^apiVersion:/m.test(content)
      ) {
        return true;
      }
    }
    return false;
  },

  claimsReference(name: string): boolean {
    return name.startsWith('azdo:');
  },

  ownsReference(ref: UnresolvedRef): boolean {
    return ref.language === 'yaml' && ref.referenceName.startsWith('azdo:');
  },

  extract(filePath: string, content: string): FrameworkExtractionResult {
    if (!isYamlFile(filePath)) return { nodes: [], references: [] };
    const docs = parseYamlDocuments(content);
    const root = docs[0]?.root;
    if (!root || root.kind !== 'map') return { nodes: [], references: [] };
    const kindInfo = isAzdoRoot(filePath, root);
    if (!kindInfo) return { nodes: [], references: [] };
    return extractAzurePipeline(filePath, root, kindInfo, Date.now());
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.language !== 'yaml' || !ref.referenceName.startsWith('azdo:')) return null;
    const name = ref.referenceName;

    // 1. Local script: `azdo:script:<relPath>`
    if (name.startsWith('azdo:script:')) {
      return resolveAzdoScript(name.slice('azdo:script:'.length), ref, context);
    }

    const index = getAzdoIndex(context);

    // 2. Template / pipeline: `azdo:tpl:<targetFile>:AzurePipeline/<label>`
    if (name.startsWith('azdo:tpl:')) {
      const rest = name.slice('azdo:tpl:'.length);
      const marker = ':AzurePipeline/';
      const idx = rest.lastIndexOf(marker);
      if (idx < 0) return null;
      const targetFile = rest.slice(0, idx);
      const target = index.pipelinesByFile.get(targetFile);
      if (!target || target.id === ref.fromNodeId) return null;
      return { original: ref, targetNodeId: target.id, confidence: 0.95, resolvedBy: 'framework' };
    }

    // 3. Stage: `azdo:stage:<filePath>:AzureStage/<stem>/<stageId>`
    if (name.startsWith('azdo:stage:')) {
      const rest = name.slice('azdo:stage:'.length);
      const marker = ':AzureStage/';
      const idx = rest.lastIndexOf(marker);
      if (idx < 0) return null;
      const targetFile = rest.slice(0, idx);
      const stageName = rest.slice(idx + 1);
      const target = index.stagesByFileAndName.get(`${targetFile}\0${stageName}`);
      if (!target || target.id === ref.fromNodeId) return null;
      return { original: ref, targetNodeId: target.id, confidence: 0.95, resolvedBy: 'framework' };
    }

    // 4. Job: `azdo:job:<filePath>:AzureJob/<stem>/<jobId>`
    if (name.startsWith('azdo:job:')) {
      const rest = name.slice('azdo:job:'.length);
      const marker = ':AzureJob/';
      const idx = rest.lastIndexOf(marker);
      if (idx < 0) return null;
      const targetFile = rest.slice(0, idx);
      const jobName = rest.slice(idx + 1);
      const target = index.jobsByFileAndName.get(`${targetFile}\0${jobName}`);
      if (!target || target.id === ref.fromNodeId) return null;
      return { original: ref, targetNodeId: target.id, confidence: 0.95, resolvedBy: 'framework' };
    }

    return null;
  },
};
