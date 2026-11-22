/**
 * CI/CD Workflow Semantic YAML Resolvers
 *
 * Covers:
 *   1. GitHub Actions, Forgejo Actions, and Gitea Actions (`actionsWorkflowResolver`):
 *      - `.github/workflows/*.{yml,yaml}`, `.forgejo/workflows/*.{yml,yaml}`,
 *        `.gitea/workflows/*.{yml,yaml}`
 *      - Local composite actions (`action.{yml,yaml}` with `runs:`)
 *      - Nodes: `Workflow/<stem>`, `Job/<stem>/<jobId>`, `Action/<dir>`
 *      - Edges: Workflow → Jobs, Job `needs` → upstream Jobs, reusable workflow
 *        `uses: ./.github|./.forgejo|./.gitea/workflows/...` → target Workflow,
 *        step `uses: ./local/action` → local Composite Action, and literal repo
 *        script invocations inside `run:` → indexed source file nodes.
 *
 *   2. GitLab CI (`gitlabCiResolver`):
 *      - `.gitlab-ci.{yml,yaml}` and included local CI templates
 *      - Nodes: `Pipeline/<stem>`, `Job/<stem>/<jobName>` (including `.hidden` templates)
 *      - Edges: `include: local:` → included pipeline, `extends:` → template job,
 *        `needs:` / `dependencies:` → upstream job, `trigger: include:` → child
 *        pipeline, and literal repo script invocations inside `script:` → indexed files.
 *
 * Every cross-file reference uses a strict `ci:` or `glci:` prefix with
 * `claimsReference` + `ownsReference` so unresolved external actions/scripts
 * remain visible boundaries and never leak into the generic name matcher.
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
  yamlGetSeq,
  yamlGetString,
  yamlStringList,
  type YamlMap,
  type YamlValue,
} from './yaml-parser';

// ---------------------------------------------------------------------------
// Shared Helpers
// ---------------------------------------------------------------------------

const INDEXABLE_SCRIPT_EXTS = new Set([
  '.py', '.pyw', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '.go', '.rb', '.rake', '.php', '.rs', '.lua', '.pl', '.r', '.dart', '.kt', '.kts',
]);

/**
 * Extract literal script paths referenced in a shell command block (`run:` or
 * GitLab `script:`). Matches both direct relative paths (`./scripts/check.py`,
 * `scripts/build.mjs`) and variable-prefixed paths (`$work/harness/scripts/pod_test.py`).
 */
const SCRIPT_PATH_RE = /(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\/)?(?:\.\.?\/)?([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:pyw?|tsx?|mts|cts|jsx?|mjs|cjs|go|rb|rake|php|rs|lua|dart|kts?))\b/g;

function isYamlFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.yaml') || lower.endsWith('.yml');
}

function normalizeRel(p: string): string {
  const norm = path.posix.normalize(p.replace(/\\/g, '/')).replace(/^\/+/, '').replace(/\/+$/, '');
  return norm === '' ? '.' : norm;
}

function dirOf(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const d = path.posix.dirname(norm);
  return d === '' ? '.' : d;
}

function stemOf(p: string): string {
  const base = path.posix.basename(p.replace(/\\/g, '/'));
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
  prefix: 'ci' | 'glci',
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
      // Skip URLs (`https://.../foo.js`) and obvious absolute system paths (`/usr/bin/...`)
      const before = line.slice(Math.max(0, m.index - 8), m.index);
      if (/:\/\/\S*$/.test(before)) continue;
      if (m.index > 0 && line[m.index - 1] === '/' && !full.startsWith('$')) continue;

      const rawRel = m[1]!;
      const ext = path.posix.extname(rawRel).toLowerCase();
      if (!INDEXABLE_SCRIPT_EXTS.has(ext)) continue;

      const cleaned = normalizeRel(rawRel);
      if (!cleaned || cleaned === '.') continue;
      pushRef(refs, seen, fromNodeId, `${prefix}:script:${cleaned}`, 'calls', startLine + i, filePath);
    }
  }
}

/**
 * Resolve a script path extracted from a shell step to an indexed `file` node.
 * Prefers exact repo-relative match; if the command used a variable/subdir prefix
 * (e.g. `$work/harness/scripts/pod_test.py` → `harness/scripts/pod_test.py`),
 * strips leading segments and accepts a UNIQUE indexed file suffix match.
 */
function resolveScriptFile(scriptPath: string, ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const allFiles = context.getAllFiles();

  // 1. Exact path match
  const exactNode = context.getNodesInFile(scriptPath).find((n) => n.kind === 'file');
  if (exactNode) {
    return { original: ref, targetNodeId: exactNode.id, confidence: 0.95, resolvedBy: 'framework' };
  }

  // 2. Progressive suffix match for variable-prefixed paths (`harness/scripts/pod_test.py` → `scripts/pod_test.py`)
  const segments = scriptPath.split('/').filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    const candidate = segments.slice(i).join('/');
    // Require at least one directory segment for suffix matching (or exact root file)
    if (i > 0 && !candidate.includes('/')) {
      const rootNode = context.getNodesInFile(candidate).find((n) => n.kind === 'file');
      if (rootNode) {
        return { original: ref, targetNodeId: rootNode.id, confidence: 0.85, resolvedBy: 'framework' };
      }
      break;
    }
    const matches = allFiles.filter((f) => f === candidate || f.endsWith(`/${candidate}`));
    if (matches.length === 1) {
      const fileNode = context.getNodesInFile(matches[0]!).find((n) => n.kind === 'file');
      if (fileNode) {
        return { original: ref, targetNodeId: fileNode.id, confidence: 0.9, resolvedBy: 'framework' };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// 1. GitHub Actions / Forgejo Actions / Gitea Actions
// ---------------------------------------------------------------------------

const ACTIONS_WORKFLOW_PATH_RE = /(?:^|\/)\.(github|forgejo|gitea)\/workflows\/[^/]+\.ya?ml$/i;
const ACTIONS_FILE_RE = /(?:^|\/)action\.ya?ml$/i;

function actionsPlatformFor(filePath: string): 'GitHub' | 'Forgejo' | 'Gitea' | null {
  const m = filePath.replace(/\\/g, '/').match(ACTIONS_WORKFLOW_PATH_RE);
  if (!m) return null;
  const dir = m[1]!.toLowerCase();
  if (dir === 'forgejo') return 'Forgejo';
  if (dir === 'gitea') return 'Gitea';
  return 'GitHub';
}

function isCompositeActionFile(filePath: string): boolean {
  return ACTIONS_FILE_RE.test(filePath.replace(/\\/g, '/'));
}

function formatTriggers(onVal: YamlValue | null): string {
  if (!onVal) return '';
  if (onVal.kind === 'scalar') return onVal.value;
  if (onVal.kind === 'seq') return yamlStringList(onVal).join(', ');
  if (onVal.kind === 'map') return onVal.entries.map((e) => e.key).join(', ');
  return '';
}

function extractLocalUsesTarget(uses: string): { kind: 'workflow' | 'action'; relPath: string } | null {
  const trimmed = uses.trim();
  if (!trimmed.startsWith('./')) return null;
  // Strip optional `@ref` (not normally present on local uses, but safe)
  const clean = normalizeRel(trimmed.replace(/@.*$/, ''));
  if (ACTIONS_WORKFLOW_PATH_RE.test(clean) || /\.(?:ya?ml)$/i.test(clean)) {
    return { kind: 'workflow', relPath: clean };
  }
  return { kind: 'action', relPath: clean };
}

function extractActionsWorkflow(
  filePath: string,
  platform: 'GitHub' | 'Forgejo' | 'Gitea',
  root: YamlMap,
  now: number
): FrameworkExtractionResult {
  const jobsMap = yamlGetMap(root, 'jobs');
  if (!jobsMap || jobsMap.entries.length === 0) return { nodes: [], references: [] };

  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const seen = new Set<string>();

  const stem = stemOf(filePath);
  const displayName = yamlGetString(root, 'name') ?? stem;
  const triggers = formatTriggers(yamlGet(root, 'on') ?? yamlGet(root, 'true'));

  const wfId = `ci:wf:${filePath}:${root.startLine}:${stem}`;
  nodes.push({
    id: wfId,
    kind: 'module',
    name: `Workflow/${stem}`,
    qualifiedName: `ci:${filePath}::Workflow/${stem}`,
    filePath,
    startLine: root.startLine,
    endLine: root.endLine,
    startColumn: 0,
    endColumn: 0,
    language: 'yaml',
    signature: `${platform} Workflow "${displayName}"${triggers ? ` [on: ${triggers}]` : ''}`,
    updatedAt: now,
  });

  for (const jobEntry of jobsMap.entries) {
    if (jobEntry.value.kind !== 'map') continue;
    const jobId = jobEntry.key;
    const jobMap = jobEntry.value;
    const runsOn = yamlGetString(jobMap, 'runs-on') ?? '';
    const reusableUses = yamlGetString(jobMap, 'uses') ?? '';

    const jobNodeName = `Job/${stem}/${jobId}`;
    const jobNodeId = `ci:job:${filePath}:${jobEntry.keyLine}:${jobId}`;

    const sigParts = [`job ${jobId}`];
    if (runsOn) sigParts.push(`(${runsOn})`);
    if (reusableUses) sigParts.push(`-> ${reusableUses}`);

    nodes.push({
      id: jobNodeId,
      kind: 'function',
      name: jobNodeName,
      qualifiedName: `ci:${filePath}::${jobNodeName}`,
      filePath,
      startLine: jobEntry.startLine,
      endLine: jobEntry.endLine,
      startColumn: 0,
      endColumn: 0,
      language: 'yaml',
      signature: sigParts.join(' '),
      updatedAt: now,
    });

    // Workflow → Job
    pushRef(references, seen, wfId, `ci:job:${filePath}:${jobNodeName}`, 'calls', jobEntry.keyLine, filePath);

    // Job `needs:` (string or string list) → upstream job in the same workflow
    const needsVal = yamlGet(jobMap, 'needs');
    const needsList =
      needsVal?.kind === 'scalar' && needsVal.value
        ? [needsVal.value]
        : needsVal?.kind === 'seq'
          ? yamlStringList(needsVal)
          : [];
    const needsLine = yamlGetEntry(jobMap, 'needs')?.keyLine ?? jobEntry.keyLine;
    for (const dep of needsList) {
      pushRef(references, seen, jobNodeId, `ci:job:${filePath}:Job/${stem}/${dep}`, 'references', needsLine, filePath);
    }

    // Reusable workflow call (`jobs.<id>.uses: ./.github/workflows/deploy.yml`)
    if (reusableUses) {
      const local = extractLocalUsesTarget(reusableUses);
      if (local && local.kind === 'workflow') {
        const usesLine = yamlGetEntry(jobMap, 'uses')?.keyLine ?? jobEntry.keyLine;
        const targetStem = stemOf(local.relPath);
        pushRef(references, seen, jobNodeId, `ci:wf:${local.relPath}:Workflow/${targetStem}`, 'calls', usesLine, filePath);
      }
    }

    // Steps: local composite actions (`uses: ./path`) and local scripts (`run: ...`)
    const steps = yamlGetSeq(jobMap, 'steps');
    if (steps) {
      for (const step of steps.items) {
        if (step.kind !== 'map') continue;
        const stepUses = yamlGetString(step, 'uses');
        if (stepUses) {
          const local = extractLocalUsesTarget(stepUses);
          if (local && local.kind === 'action') {
            const usesLine = yamlGetEntry(step, 'uses')?.keyLine ?? step.startLine;
            pushRef(references, seen, jobNodeId, `ci:act:${local.relPath}:Action/${local.relPath}`, 'calls', usesLine, filePath);
          }
        }
        const runEntry = yamlGetEntry(step, 'run');
        if (runEntry && runEntry.value.kind === 'scalar' && runEntry.value.value) {
          scanScriptRefs(runEntry.value.value, runEntry.keyLine, jobNodeId, filePath, 'ci', references, seen);
        }
      }
    }
  }

  return { nodes, references };
}

function extractCompositeAction(
  filePath: string,
  root: YamlMap,
  now: number
): FrameworkExtractionResult {
  const runs = yamlGetMap(root, 'runs');
  if (!runs) return { nodes: [], references: [] };
  const using = yamlGetString(runs, 'using') ?? '';
  if (!using) return { nodes: [], references: [] };

  const dir = dirOf(filePath);
  const dirLabel = dir === '.' ? 'root' : dir;
  const actionName = yamlGetString(root, 'name') ?? dirLabel;
  const actionId = `ci:act:${filePath}:${root.startLine}:${dirLabel}`;

  const nodes: Node[] = [{
    id: actionId,
    kind: 'component',
    name: `Action/${dirLabel}`,
    qualifiedName: `ci:${filePath}::Action/${dirLabel}`,
    filePath,
    startLine: root.startLine,
    endLine: root.endLine,
    startColumn: 0,
    endColumn: 0,
    language: 'yaml',
    signature: `Action "${actionName}" (${using})`,
    updatedAt: now,
  }];

  const references: UnresolvedRef[] = [];
  const seen = new Set<string>();

  // JavaScript/Docker action entrypoint (`runs.main: dist/index.js`)
  const mainEntry = yamlGetEntry(runs, 'main');
  if (mainEntry && mainEntry.value.kind === 'scalar' && mainEntry.value.value) {
    const mainRel = normalizeRel(dir === '.' ? mainEntry.value.value : `${dir}/${mainEntry.value.value}`);
    pushRef(references, seen, actionId, `ci:script:${mainRel}`, 'calls', mainEntry.keyLine, filePath);
  }

  // Composite action steps
  const steps = yamlGetSeq(runs, 'steps');
  if (steps) {
    for (const step of steps.items) {
      if (step.kind !== 'map') continue;
      const stepUses = yamlGetString(step, 'uses');
      if (stepUses) {
        const local = extractLocalUsesTarget(stepUses);
        if (local && local.kind === 'action') {
          const usesLine = yamlGetEntry(step, 'uses')?.keyLine ?? step.startLine;
          pushRef(references, seen, actionId, `ci:act:${local.relPath}:Action/${local.relPath}`, 'calls', usesLine, filePath);
        }
      }
      const runEntry = yamlGetEntry(step, 'run');
      if (runEntry && runEntry.value.kind === 'scalar' && runEntry.value.value) {
        scanScriptRefs(runEntry.value.value, runEntry.keyLine, actionId, filePath, 'ci', references, seen);
      }
    }
  }

  return { nodes, references };
}

interface ActionsIndex {
  workflowsByFile: Map<string, Node>;
  jobsByFileAndName: Map<string, Node>;
  actionsByDir: Map<string, Node>;
}

interface CachedActionsIndex {
  refs: readonly [Node[], Node[], Node[]];
  index: ActionsIndex;
}

const actionsIndexCache = new WeakMap<ResolutionContext, CachedActionsIndex>();

function getActionsIndex(context: ResolutionContext): ActionsIndex {
  const modules = context.getNodesByKind('module');
  const functions = context.getNodesByKind('function');
  const components = context.getNodesByKind('component');
  const cached = actionsIndexCache.get(context);
  if (cached && cached.refs[0] === modules && cached.refs[1] === functions && cached.refs[2] === components) {
    return cached.index;
  }

  const workflowsByFile = new Map<string, Node>();
  const jobsByFileAndName = new Map<string, Node>();
  const actionsByDir = new Map<string, Node>();

  for (const n of modules) {
    if (n.id.startsWith('ci:wf:')) workflowsByFile.set(n.filePath, n);
  }
  for (const n of functions) {
    if (n.id.startsWith('ci:job:')) jobsByFileAndName.set(`${n.filePath}\0${n.name}`, n);
  }
  for (const n of components) {
    if (n.id.startsWith('ci:act:')) actionsByDir.set(dirOf(n.filePath), n);
  }

  const index: ActionsIndex = { workflowsByFile, jobsByFileAndName, actionsByDir };
  actionsIndexCache.set(context, { refs: [modules, functions, components], index });
  return index;
}

export const actionsWorkflowResolver: FrameworkResolver = {
  name: 'ci-actions',
  languages: ['yaml'],

  detect(context: ResolutionContext): boolean {
    const files = context.getAllFiles();
    for (const f of files) {
      if (actionsPlatformFor(f) !== null) return true;
      if (isCompositeActionFile(f)) {
        if (context.fileContains ? context.fileContains(f, 'runs:') : context.readFile(f)?.includes('runs:')) {
          return true;
        }
      }
    }
    return false;
  },

  claimsReference(name: string): boolean {
    return name.startsWith('ci:');
  },

  ownsReference(ref: UnresolvedRef): boolean {
    return ref.language === 'yaml' && ref.referenceName.startsWith('ci:');
  },

  extract(filePath: string, content: string): FrameworkExtractionResult {
    if (!isYamlFile(filePath)) return { nodes: [], references: [] };
    const platform = actionsPlatformFor(filePath);
    const isAction = platform === null && isCompositeActionFile(filePath);
    if (!platform && !isAction) return { nodes: [], references: [] };

    const docs = parseYamlDocuments(content);
    const root = docs[0]?.root;
    if (!root || root.kind !== 'map') return { nodes: [], references: [] };

    const now = Date.now();
    if (platform) return extractActionsWorkflow(filePath, platform, root, now);
    return extractCompositeAction(filePath, root, now);
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.language !== 'yaml' || !ref.referenceName.startsWith('ci:')) return null;
    const name = ref.referenceName;

    // 1. Local script call: `ci:script:<relPath>`
    if (name.startsWith('ci:script:')) {
      return resolveScriptFile(name.slice('ci:script:'.length), ref, context);
    }

    const index = getActionsIndex(context);

    // 2. Job reference: `ci:job:<filePath>:Job/<stem>/<jobId>`
    if (name.startsWith('ci:job:')) {
      const rest = name.slice('ci:job:'.length);
      const marker = ':Job/';
      const idx = rest.lastIndexOf(marker);
      if (idx < 0) return null;
      const targetFile = rest.slice(0, idx);
      const jobName = rest.slice(idx + 1);
      const target = index.jobsByFileAndName.get(`${targetFile}\0${jobName}`);
      if (!target || target.id === ref.fromNodeId) return null;
      return { original: ref, targetNodeId: target.id, confidence: 0.95, resolvedBy: 'framework' };
    }

    // 3. Reusable workflow call: `ci:wf:<filePath>:Workflow/<stem>`
    if (name.startsWith('ci:wf:')) {
      const rest = name.slice('ci:wf:'.length);
      const marker = ':Workflow/';
      const idx = rest.lastIndexOf(marker);
      if (idx < 0) return null;
      const targetFile = rest.slice(0, idx);
      const target = index.workflowsByFile.get(targetFile);
      if (!target || target.id === ref.fromNodeId) return null;
      return { original: ref, targetNodeId: target.id, confidence: 0.95, resolvedBy: 'framework' };
    }

    // 4. Local composite action: `ci:act:<dirPath>:Action/<dirPath>`
    if (name.startsWith('ci:act:')) {
      const rest = name.slice('ci:act:'.length);
      const marker = ':Action/';
      const idx = rest.lastIndexOf(marker);
      if (idx < 0) return null;
      const targetDir = normalizeRel(rest.slice(0, idx));
      const target = index.actionsByDir.get(targetDir);
      if (!target || target.id === ref.fromNodeId) return null;
      return { original: ref, targetNodeId: target.id, confidence: 0.95, resolvedBy: 'framework' };
    }

    return null;
  },
};

// ---------------------------------------------------------------------------
// 2. GitLab CI
// ---------------------------------------------------------------------------

const GITLAB_RESERVED_KEYS = new Set([
  'stages', 'variables', 'default', 'workflow', 'include', 'image', 'services',
  'before_script', 'after_script', 'cache', 'pages', 'spec',
]);

function isGitLabRootFile(filePath: string): boolean {
  const base = path.posix.basename(filePath.replace(/\\/g, '/')).toLowerCase();
  return base === '.gitlab-ci.yml' || base === '.gitlab-ci.yaml';
}

/** True when a YAML file (in a repo that has `.gitlab-ci.ya?ml`) looks like a GitLab CI file or included template. */
function isGitLabCiCandidate(filePath: string, root: YamlMap): boolean {
  if (isGitLabRootFile(filePath)) return true;
  // Never steal K8s, Compose, OpenAPI, or Actions files
  if (actionsPlatformFor(filePath) || isCompositeActionFile(filePath)) return false;
  if (yamlGetString(root, 'apiVersion') && yamlGetString(root, 'kind')) return false;
  if (yamlGetString(root, 'openapi') || yamlGetString(root, 'swagger')) return false;
  if (yamlGetMap(root, 'jobs') && (yamlGet(root, 'on') || yamlGet(root, 'true'))) return false;

  // Must declare at least one GitLab job/template-shaped map (`script:` / `before_script:` /
  // `after_script:` / `trigger:` / `extends:` / `stage:` / `rules:`) or hidden `.template`
  let jobLikeCount = 0;
  for (const e of root.entries) {
    if (GITLAB_RESERVED_KEYS.has(e.key)) continue;
    if (e.value.kind !== 'map') continue;
    if (
      yamlGet(e.value, 'script') ||
      yamlGet(e.value, 'before_script') ||
      yamlGet(e.value, 'after_script') ||
      yamlGet(e.value, 'trigger') ||
      yamlGet(e.value, 'extends') ||
      yamlGet(e.value, 'stage') ||
      yamlGet(e.value, 'rules') ||
      (e.key.startsWith('.') && (yamlGet(e.value, 'image') || yamlGet(e.value, 'variables')))
    ) {
      jobLikeCount++;
    }
  }
  return jobLikeCount > 0;
}

function extractGitLabIncludes(val: YamlValue | null): Array<{ path: string; line: number }> {
  if (!val) return [];
  const out: Array<{ path: string; line: number }> = [];
  const visit = (item: YamlValue) => {
    if (item.kind === 'scalar' && item.value && !/^[a-z]+:\/\//i.test(item.value)) {
      out.push({ path: normalizeRel(item.value), line: item.startLine });
    } else if (item.kind === 'map') {
      const local = yamlGetString(item, 'local');
      if (local) out.push({ path: normalizeRel(local), line: item.startLine });
    } else if (item.kind === 'seq') {
      for (const child of item.items) visit(child);
    }
  };
  visit(val);
  return out;
}

function extractGitLabJobDeps(val: YamlValue | null): Array<{ job: string; line: number }> {
  if (!val) return [];
  const out: Array<{ job: string; line: number }> = [];
  if (val.kind === 'scalar' && val.value) {
    out.push({ job: val.value, line: val.startLine });
  } else if (val.kind === 'seq') {
    for (const item of val.items) {
      if (item.kind === 'scalar' && item.value) {
        out.push({ job: item.value, line: item.startLine });
      } else if (item.kind === 'map') {
        const job = yamlGetString(item, 'job');
        if (job) out.push({ job, line: item.startLine });
      }
    }
  }
  return out;
}

function extractGitLabCi(filePath: string, root: YamlMap, now: number): FrameworkExtractionResult {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const seen = new Set<string>();

  const stem = stemOf(filePath);
  const pipeId = `glci:pipe:${filePath}:${root.startLine}:${stem}`;
  const stages = yamlStringList(yamlGetSeq(root, 'stages'));

  nodes.push({
    id: pipeId,
    kind: 'module',
    name: `Pipeline/${stem}`,
    qualifiedName: `glci:${filePath}::Pipeline/${stem}`,
    filePath,
    startLine: root.startLine,
    endLine: root.endLine,
    startColumn: 0,
    endColumn: 0,
    language: 'yaml',
    signature: `GitLab CI ${filePath}${stages.length > 0 ? ` [stages: ${stages.join(', ')}]` : ''}`,
    updatedAt: now,
  });

  // Top-level `include:` → local YAML templates
  for (const inc of extractGitLabIncludes(yamlGet(root, 'include'))) {
    const targetStem = stemOf(inc.path);
    pushRef(references, seen, pipeId, `glci:file:${inc.path}:Pipeline/${targetStem}`, 'imports', inc.line, filePath);
  }

  // Jobs & hidden templates (`.base_job`)
  for (const entry of root.entries) {
    if (GITLAB_RESERVED_KEYS.has(entry.key)) continue;
    if (entry.value.kind !== 'map') continue;
    const jobMap = entry.value;
    const isHidden = entry.key.startsWith('.');
    const hasJobShape =
      isHidden ||
      yamlGet(jobMap, 'script') !== null ||
      yamlGet(jobMap, 'trigger') !== null ||
      yamlGet(jobMap, 'extends') !== null ||
      yamlGet(jobMap, 'stage') !== null;
    if (!hasJobShape) continue;

    const jobName = entry.key;
    const stage = yamlGetString(jobMap, 'stage') ?? '';
    const jobId = `glci:job:${filePath}:${entry.keyLine}:${jobName}`;
    const nodeName = `Job/${jobName}`;

    const sigParts = [isHidden ? `template ${jobName}` : `job ${jobName}`];
    if (stage) sigParts.push(`[stage: ${stage}]`);

    nodes.push({
      id: jobId,
      kind: 'function',
      name: nodeName,
      qualifiedName: `glci:${filePath}::${nodeName}`,
      filePath,
      startLine: entry.startLine,
      endLine: entry.endLine,
      startColumn: 0,
      endColumn: 0,
      language: 'yaml',
      signature: sigParts.join(' '),
      updatedAt: now,
    });

    if (!isHidden) {
      pushRef(references, seen, pipeId, `glci:job:${filePath}:${nodeName}`, 'calls', entry.keyLine, filePath);
    }

    // `extends:` → template job(s)
    const extVal = yamlGet(jobMap, 'extends');
    const extList =
      extVal?.kind === 'scalar' && extVal.value
        ? [extVal.value]
        : extVal?.kind === 'seq'
          ? yamlStringList(extVal)
          : [];
    const extLine = yamlGetEntry(jobMap, 'extends')?.keyLine ?? entry.keyLine;
    for (const parentJob of extList) {
      pushRef(references, seen, jobId, `glci:job::Job/${parentJob}`, 'references', extLine, filePath);
    }

    // `needs:` & `dependencies:` → upstream job(s)
    for (const depField of ['needs', 'dependencies'] as const) {
      for (const dep of extractGitLabJobDeps(yamlGet(jobMap, depField))) {
        pushRef(references, seen, jobId, `glci:job::Job/${dep.job}`, 'references', dep.line, filePath);
      }
    }

    // `trigger: include:` → child pipeline YAML
    const triggerMap = yamlGetMap(jobMap, 'trigger');
    if (triggerMap) {
      for (const inc of extractGitLabIncludes(yamlGet(triggerMap, 'include'))) {
        const targetStem = stemOf(inc.path);
        pushRef(references, seen, jobId, `glci:file:${inc.path}:Pipeline/${targetStem}`, 'calls', inc.line, filePath);
      }
    }

    // `script:` / `before_script:` / `after_script:` → local repo scripts
    for (const sField of ['script', 'before_script', 'after_script'] as const) {
      const sVal = yamlGet(jobMap, sField);
      if (!sVal) continue;
      if (sVal.kind === 'scalar' && sVal.value) {
        scanScriptRefs(sVal.value, sVal.startLine, jobId, filePath, 'glci', references, seen);
      } else if (sVal.kind === 'seq') {
        for (const item of sVal.items) {
          if (item.kind === 'scalar' && item.value) {
            scanScriptRefs(item.value, item.startLine, jobId, filePath, 'glci', references, seen);
          }
        }
      }
    }
  }

  return { nodes, references };
}

interface GitLabIndex {
  pipelinesByFile: Map<string, Node>;
  jobsByFileAndName: Map<string, Node>;
  jobsByName: Map<string, Node[]>;
}

interface CachedGitLabIndex {
  refs: readonly [Node[], Node[]];
  index: GitLabIndex;
}

const gitlabIndexCache = new WeakMap<ResolutionContext, CachedGitLabIndex>();

function getGitLabIndex(context: ResolutionContext): GitLabIndex {
  const modules = context.getNodesByKind('module');
  const functions = context.getNodesByKind('function');
  const cached = gitlabIndexCache.get(context);
  if (cached && cached.refs[0] === modules && cached.refs[1] === functions) {
    return cached.index;
  }

  const pipelinesByFile = new Map<string, Node>();
  const jobsByFileAndName = new Map<string, Node>();
  const jobsByName = new Map<string, Node[]>();

  for (const n of modules) {
    if (n.id.startsWith('glci:pipe:')) pipelinesByFile.set(n.filePath, n);
  }
  for (const n of functions) {
    if (!n.id.startsWith('glci:job:')) continue;
    jobsByFileAndName.set(`${n.filePath}\0${n.name}`, n);
    let list = jobsByName.get(n.name);
    if (!list) {
      list = [];
      jobsByName.set(n.name, list);
    }
    list.push(n);
  }

  const index: GitLabIndex = { pipelinesByFile, jobsByFileAndName, jobsByName };
  gitlabIndexCache.set(context, { refs: [modules, functions], index });
  return index;
}

export const gitlabCiResolver: FrameworkResolver = {
  name: 'gitlab-ci',
  languages: ['yaml'],

  detect(context: ResolutionContext): boolean {
    return context.getAllFiles().some(isGitLabRootFile);
  },

  claimsReference(name: string): boolean {
    return name.startsWith('glci:');
  },

  ownsReference(ref: UnresolvedRef): boolean {
    return ref.language === 'yaml' && ref.referenceName.startsWith('glci:');
  },

  extract(filePath: string, content: string): FrameworkExtractionResult {
    if (!isYamlFile(filePath)) return { nodes: [], references: [] };
    const docs = parseYamlDocuments(content);
    const root = docs[0]?.root;
    if (!root || root.kind !== 'map') return { nodes: [], references: [] };
    if (!isGitLabCiCandidate(filePath, root)) return { nodes: [], references: [] };
    return extractGitLabCi(filePath, root, Date.now());
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.language !== 'yaml' || !ref.referenceName.startsWith('glci:')) return null;
    const name = ref.referenceName;

    // 1. Local script call: `glci:script:<relPath>`
    if (name.startsWith('glci:script:')) {
      return resolveScriptFile(name.slice('glci:script:'.length), ref, context);
    }

    const index = getGitLabIndex(context);

    // 2. Included / child pipeline: `glci:file:<relPath>:Pipeline/<stem>`
    if (name.startsWith('glci:file:')) {
      const rest = name.slice('glci:file:'.length);
      const marker = ':Pipeline/';
      const idx = rest.lastIndexOf(marker);
      if (idx < 0) return null;
      const targetFile = rest.slice(0, idx);
      const target = index.pipelinesByFile.get(targetFile);
      if (!target || target.id === ref.fromNodeId) return null;
      return { original: ref, targetNodeId: target.id, confidence: 0.95, resolvedBy: 'framework' };
    }

    // 3. Job / template reference: `glci:job:<optionalFile>:Job/<name>`
    if (name.startsWith('glci:job:')) {
      const rest = name.slice('glci:job:'.length);
      const marker = ':Job/';
      const idx = rest.lastIndexOf(marker);
      if (idx < 0) return null;
      const explicitFile = rest.slice(0, idx);
      const jobName = rest.slice(idx + 1);

      if (explicitFile) {
        const exact = index.jobsByFileAndName.get(`${explicitFile}\0${jobName}`);
        if (exact && exact.id !== ref.fromNodeId) {
          return { original: ref, targetNodeId: exact.id, confidence: 0.95, resolvedBy: 'framework' };
        }
        return null;
      }

      // Same-file job first, then unique across included GitLab CI files
      const sameFile = index.jobsByFileAndName.get(`${ref.filePath}\0${jobName}`);
      if (sameFile && sameFile.id !== ref.fromNodeId) {
        return { original: ref, targetNodeId: sameFile.id, confidence: 0.95, resolvedBy: 'framework' };
      }
      const candidates = (index.jobsByName.get(jobName) ?? []).filter((n) => n.id !== ref.fromNodeId);
      if (candidates.length === 1) {
        return { original: ref, targetNodeId: candidates[0]!.id, confidence: 0.9, resolvedBy: 'framework' };
      }
      return null;
    }

    return null;
  },
};
