/**
 * Kubernetes, Kustomize, and Helm Framework Resolvers
 *
 * Semantic YAML resolvers — never naive every-key-as-node indexing. Only real
 * Kubernetes resources, Kustomization overlays, Helm charts, Helm values keys,
 * and `_helpers.tpl` template definitions become nodes, and every cross-resource
 * / cross-file reference is scoped (`k8s:` / `helm:`) with `claimsReference` +
 * `ownsReference` so YAML symbols never collide with code symbols or get
 * mis-bound by the generic name matcher.
 *
 * Node naming uses idiomatic kubectl notation (`Deployment/api`, `Service/api`,
 * `Ingress/web`, `Kustomization/deploy/k8s`, `Chart/app`) — naturally collision-
 * free against source identifiers and directly searchable via FTS5.
 *
 * Edges modeled:
 *   - Ingress / Gateway API (`HTTPRoute`/`GRPCRoute`/`TCPRoute`/`TLSRoute`/`UDPRoute`)
 *     → backend `Service` (and TLS `Secret`, `Gateway` parentRef)
 *   - `Service` / `PodDisruptionBudget` / `NetworkPolicy` (podSelector + peer
 *     ingress/egress podSelector+namespaceSelector) → matching workloads via
 *     label-selector subset matching (namespace-aware, 1-to-many via `alsoTargets`)
 *   - Workloads (`Deployment`/`StatefulSet`/`DaemonSet`/`Job`/`CronJob`/`Pod`/
 *     `ReplicaSet`) → `ConfigMap`, `Secret`, `ServiceAccount`, `PVC`,
 *     `PriorityClass`, plus cluster-internal DNS (`<svc>.<ns>.svc(.cluster.local)?`)
 *     → target `Service`
 *   - `HorizontalPodAutoscaler` → `scaleTargetRef`
 *   - `RoleBinding` / `ClusterRoleBinding` → `roleRef` + `ServiceAccount` subjects
 *   - `Role` / `ClusterRole` explicit `resourceNames` → targeted resources
 *   - `Kustomization` → `resources`/`bases`/`components`/`patches` files & nested
 *     kustomizations, `configMapGenerator`/`secretGenerator` nodes + input files,
 *     and `postExtract` namespace propagation to included manifests
 *   - Helm: `Chart.yaml` (`file://` subchart deps), `values.yaml` keys (capped),
 *     `templates/*.{yaml,yml}` (`.Values.*` + `include`/`template` helper refs),
 *     and `templates/*.tpl` `define` helper nodes via `crossFileNodes`
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Node, NodeKind } from '../../types';
import type {
  CrossFileNodes,
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
  yamlGetPathMap,
  yamlGetPathSeq,
  yamlGetPathString,
  yamlGetSeq,
  yamlGetString,
  yamlStringList,
  yamlStringMap,
  type YamlMap,
  type YamlValue,
} from './yaml-parser';

// ---------------------------------------------------------------------------
// Constants & Kind Tables
// ---------------------------------------------------------------------------

const WORKLOAD_KINDS = new Set([
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'ReplicaSet',
  'Job',
  'CronJob',
  'Pod',
]);

const ROUTE_KINDS = new Set([
  'Ingress',
  'HTTPRoute',
  'GRPCRoute',
  'TCPRoute',
  'TLSRoute',
  'UDPRoute',
  'IngressRoute',
  'IngressRouteTCP',
  'IngressRouteUDP',
]);

const CONFIG_KINDS = new Set(['ConfigMap', 'Secret']);

const CLUSTER_SCOPED_KINDS = new Set([
  'Namespace',
  'ClusterRole',
  'ClusterRoleBinding',
  'PriorityClass',
  'StorageClass',
  'IngressClass',
  'PersistentVolume',
  'CustomResourceDefinition',
  'Node',
]);

/** Canonical mapping from RBAC plural resource names to Kubernetes Kinds. */
const PLURAL_TO_KIND: Record<string, string> = {
  deployments: 'Deployment',
  statefulsets: 'StatefulSet',
  daemonsets: 'DaemonSet',
  replicasets: 'ReplicaSet',
  jobs: 'Job',
  cronjobs: 'CronJob',
  pods: 'Pod',
  services: 'Service',
  ingresses: 'Ingress',
  httproutes: 'HTTPRoute',
  grpcroutes: 'GRPCRoute',
  tcproutes: 'TCPRoute',
  tlsroutes: 'TLSRoute',
  gateways: 'Gateway',
  networkpolicies: 'NetworkPolicy',
  poddisruptionbudgets: 'PodDisruptionBudget',
  horizontalpodautoscalers: 'HorizontalPodAutoscaler',
  configmaps: 'ConfigMap',
  secrets: 'Secret',
  serviceaccounts: 'ServiceAccount',
  persistentvolumeclaims: 'PersistentVolumeClaim',
  roles: 'Role',
  rolebindings: 'RoleBinding',
  clusterroles: 'ClusterRole',
  clusterrolebindings: 'ClusterRoleBinding',
  leases: 'Lease',
  servicemonitors: 'ServiceMonitor',
  podmonitors: 'PodMonitor',
};

/** Match cluster-internal Kubernetes DNS names (`<service>.<namespace>.svc(.cluster.local)?`). */
const CLUSTER_DNS_RE = /\b([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.svc(?:\.cluster\.local)?\b/g;

/** Cap Helm `values.yaml` extracted keys per file to prevent node explosion on huge value files. */
const MAX_HELM_VALUES_KEYS = 250;

function isYamlFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.yaml') || lower.endsWith('.yml');
}

function isKustomizationFile(filePath: string): boolean {
  const base = path.posix.basename(filePath).toLowerCase();
  return base === 'kustomization.yaml' || base === 'kustomization.yml';
}

function isHelmChartFile(filePath: string): boolean {
  const base = path.posix.basename(filePath).toLowerCase();
  return base === 'chart.yaml' || base === 'chart.yml';
}

function isHelmValuesFile(filePath: string): boolean {
  const base = path.posix.basename(filePath).toLowerCase();
  return base === 'values.yaml' || base === 'values.yml';
}

/** Find the enclosing Helm chart directory for a file under `<chartDir>/templates/...`, or null. */
function helmChartDirForTemplate(filePath: string): string | null {
  const norm = filePath.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/templates/');
  if (idx >= 0) return norm.slice(0, idx);
  if (norm.startsWith('templates/')) return '.';
  return null;
}

function dirOf(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const d = path.posix.dirname(norm);
  return d === '' ? '.' : d;
}

function normalizeRel(p: string): string {
  const norm = path.posix.normalize(p.replace(/\\/g, '/')).replace(/\/+$/, '');
  return norm === '' ? '.' : norm;
}

function joinRel(baseDir: string, rel: string): string {
  const cleaned = rel.replace(/\\/g, '/').replace(/^file:\/\//, '');
  if (cleaned.startsWith('/')) return normalizeRel(cleaned.slice(1));
  return normalizeRel(baseDir === '.' ? cleaned : `${baseDir}/${cleaned}`);
}

function nodeKindForK8s(k8sKind: string): NodeKind {
  if (ROUTE_KINDS.has(k8sKind)) return 'route';
  if (k8sKind === 'Namespace') return 'namespace';
  if (CONFIG_KINDS.has(k8sKind)) return 'constant';
  if (k8sKind === 'Kustomization') return 'module';
  return 'component';
}

function formatSelectorRef(ns: string, labels: Record<string, string>): string | null {
  const entries = Object.entries(labels)
    .filter(([k, v]) => k !== '' && v !== '' && !v.includes('{{'))
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return null;
  const encoded = entries.map(([k, v]) => `${k}=${v}`).join('&');
  return `k8s:sel:${ns}:${encoded}`;
}

function parseSelectorPairs(encoded: string): Array<[string, string]> {
  if (!encoded) return [];
  return encoded.split('&').map((part) => {
    const eq = part.indexOf('=');
    return eq >= 0 ? [part.slice(0, eq), part.slice(eq + 1)] : [part, ''];
  });
}

function isTemplatedString(s: string): boolean {
  return s.includes('{{') || s.includes('}}');
}

function cleanHelmName(raw: string, filePath: string, kind: string): string {
  if (!isTemplatedString(raw)) return raw;
  // Derive a readable stable name for Helm templated resources (e.g. `{{ include "app.fullname" . }}-worker` → `templates/worker` or `<fileBase>`)
  const suffix = raw.replace(/\{\{[\s\S]*?\}\}/g, '').replace(/^[-_.]+|[-_.]+$/g, '');
  const base = path.posix.basename(filePath, path.posix.extname(filePath));
  if (suffix && /^[A-Za-z0-9._-]+$/.test(suffix)) return `${base}-${suffix}`;
  return base || kind.toLowerCase();
}

function makeK8sQualifiedName(ns: string, kind: string, name: string): string {
  return ns && !CLUSTER_SCOPED_KINDS.has(kind) ? `k8s:${ns}/${kind}/${name}` : `k8s:${kind}/${name}`;
}

function makeK8sSignature(apiVersion: string, kind: string, name: string, ns: string, extra?: string): string {
  const nsPart = ns && !CLUSTER_SCOPED_KINDS.has(kind) ? ` (namespace: ${ns})` : '';
  const extraPart = extra ? ` ${extra}` : '';
  return `${apiVersion} ${kind} ${name}${nsPart}${extraPart}`.trim();
}

// ---------------------------------------------------------------------------
// Extraction: Kubernetes + Kustomize
// ---------------------------------------------------------------------------

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

function k8sResRef(ns: string, kind: string, name: string): string {
  // Put `<Kind>/<name>` after the last `:` so `referenceNameTail` yields the exact
  // node `name` (`Service/web-svc`) and incremental `sync()` retries failed refs
  // automatically when the target manifest arrives later.
  return `k8s:res:${ns}:${kind}/${name}`;
}

function k8sNsRef(ns: string): string {
  return `k8s:ns:Namespace/${ns}`;
}

function scanClusterDns(
  text: string,
  line: number,
  fromNodeId: string,
  filePath: string,
  refs: UnresolvedRef[],
  seen: Set<string>,
  kind: UnresolvedRef['referenceKind'] = 'calls'
): void {
  if (!text.includes('.svc')) return;
  CLUSTER_DNS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLUSTER_DNS_RE.exec(text)) !== null) {
    const svc = m[1]!;
    const ns = m[2]!;
    pushRef(refs, seen, fromNodeId, k8sResRef(ns, 'Service', svc), kind, line, filePath);
  }
}

function extractKustomization(
  filePath: string,
  root: YamlMap,
  now: number
): FrameworkExtractionResult {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const seen = new Set<string>();

  const dir = dirOf(filePath);
  const dirLabel = dir === '.' ? 'root' : dir;
  const ns = yamlGetString(root, 'namespace') ?? '';
  const namePrefix = yamlGetString(root, 'namePrefix') ?? '';
  const nameSuffix = yamlGetString(root, 'nameSuffix') ?? '';

  const kustId = `k8s:${filePath}:${root.startLine}:Kustomization:${dirLabel}`;
  const sigParts: string[] = ['Kustomization'];
  if (ns) sigParts.push(`(namespace: ${ns})`);
  if (namePrefix) sigParts.push(`[prefix: ${namePrefix}]`);
  if (nameSuffix) sigParts.push(`[suffix: ${nameSuffix}]`);

  nodes.push({
    id: kustId,
    kind: 'module',
    name: `Kustomization/${dirLabel}`,
    qualifiedName: `k8s:Kustomization/${dirLabel}`,
    filePath,
    startLine: root.startLine,
    endLine: root.endLine,
    startColumn: 0,
    endColumn: 0,
    language: 'yaml',
    signature: sigParts.join(' '),
    updatedAt: now,
  });

  if (ns) {
    const nsEntry = yamlGetEntry(root, 'namespace');
    pushRef(references, seen, kustId, k8sNsRef(ns), 'references', nsEntry?.keyLine ?? root.startLine, filePath);
  }

  // resources / bases / components → file or nested kustomization directory
  for (const field of ['resources', 'bases', 'components'] as const) {
    const seq = yamlGetSeq(root, field);
    if (!seq) continue;
    for (const item of seq.items) {
      if (item.kind !== 'scalar' || !item.value) continue;
      if (/^[a-z]+:\/\//i.test(item.value)) continue; // remote URL
      const targetRel = joinRel(dir, item.value);
      pushRef(references, seen, kustId, `k8s:file:${targetRel}`, 'imports', item.startLine, filePath);
    }
  }

  // patches / patchesStrategicMerge / patchesJson6902
  for (const field of ['patches', 'patchesStrategicMerge', 'patchesJson6902'] as const) {
    const seq = yamlGetSeq(root, field);
    if (!seq) continue;
    for (const item of seq.items) {
      if (item.kind === 'scalar' && item.value) {
        if (!item.value.includes('\n') && !/^[a-z]+:\/\//i.test(item.value)) {
          const targetRel = joinRel(dir, item.value);
          pushRef(references, seen, kustId, `k8s:file:${targetRel}`, 'references', item.startLine, filePath);
        }
      } else if (item.kind === 'map') {
        const patchPath = yamlGetString(item, 'path');
        if (patchPath && !/^[a-z]+:\/\//i.test(patchPath)) {
          const targetRel = joinRel(dir, patchPath);
          pushRef(references, seen, kustId, `k8s:file:${targetRel}`, 'references', item.startLine, filePath);
        }
        const target = yamlGetMap(item, 'target');
        if (target) {
          const tKind = yamlGetString(target, 'kind');
          const tName = yamlGetString(target, 'name');
          const tNs = yamlGetString(target, 'namespace') ?? ns;
          if (tKind && tName) {
            pushRef(references, seen, kustId, k8sResRef(tNs, tKind, tName), 'references', target.startLine, filePath);
          }
        }
      }
    }
  }

  // configMapGenerator / secretGenerator → generated ConfigMap / Secret nodes + input files
  const generators: Array<{ field: 'configMapGenerator' | 'secretGenerator'; k8sKind: 'ConfigMap' | 'Secret' }> = [
    { field: 'configMapGenerator', k8sKind: 'ConfigMap' },
    { field: 'secretGenerator', k8sKind: 'Secret' },
  ];
  for (const { field, k8sKind } of generators) {
    const seq = yamlGetSeq(root, field);
    if (!seq) continue;
    for (const item of seq.items) {
      if (item.kind !== 'map') continue;
      const rawName = yamlGetString(item, 'name');
      if (!rawName) continue;
      const itemNs = yamlGetString(item, 'namespace') ?? ns;
      const fullName = `${namePrefix}${rawName}${nameSuffix}`;
      const genId = `k8s:${filePath}:${item.startLine}:${k8sKind}:${itemNs}:${fullName}`;
      nodes.push({
        id: genId,
        kind: 'constant',
        name: `${k8sKind}/${fullName}`,
        qualifiedName: makeK8sQualifiedName(itemNs, k8sKind, fullName),
        filePath,
        startLine: item.startLine,
        endLine: item.endLine,
        startColumn: 0,
        endColumn: 0,
        language: 'yaml',
        signature: `kustomize ${k8sKind} ${fullName}${itemNs ? ` (namespace: ${itemNs})` : ''}`,
        updatedAt: now,
      });
      // Link Kustomization → generated resource
      pushRef(references, seen, kustId, k8sResRef(itemNs, k8sKind, fullName), 'references', item.startLine, filePath);

      // files / envs entries (handle Kustomize `key=path` form)
      for (const fField of ['files', 'envs'] as const) {
        const fSeq = yamlGetSeq(item, fField);
        if (!fSeq) continue;
        for (const fItem of fSeq.items) {
          if (fItem.kind !== 'scalar' || !fItem.value) continue;
          const eq = fItem.value.indexOf('=');
          const relPath = eq >= 0 ? fItem.value.slice(eq + 1) : fItem.value;
          if (!relPath) continue;
          pushRef(references, seen, genId, `k8s:file:${joinRel(dir, relPath)}`, 'imports', fItem.startLine, filePath);
        }
      }

      // literals: scan for cluster DNS URLs
      const litSeq = yamlGetSeq(item, 'literals');
      if (litSeq) {
        for (const lit of litSeq.items) {
          if (lit.kind === 'scalar' && lit.value) {
            scanClusterDns(lit.value, lit.startLine, genId, filePath, references, seen, 'references');
          }
        }
      }
    }
  }

  return { nodes, references };
}

function extractK8sResource(
  filePath: string,
  doc: YamlMap,
  now: number,
  nodes: Node[],
  references: UnresolvedRef[],
  seen: Set<string>
): void {
  const apiVersion = yamlGetString(doc, 'apiVersion');
  const kind = yamlGetString(doc, 'kind');
  if (!apiVersion || !kind) return;

  // Guard against non-K8s YAML that happens to have `kind`
  if (!/^[A-Z][A-Za-z0-9]*$/.test(kind)) return;

  // Handle `List` / `*List` wrapper resources by recursing into `items:`
  if (kind === 'List' || kind.endsWith('List')) {
    const items = yamlGetSeq(doc, 'items');
    if (items) {
      for (const item of items.items) {
        if (item.kind === 'map') {
          extractK8sResource(filePath, item, now, nodes, references, seen);
        }
      }
    }
    return;
  }

  const metadata = yamlGetMap(doc, 'metadata');
  const rawName = yamlGetString(metadata, 'name');
  if (!rawName) return;

  const isTemplate = helmChartDirForTemplate(filePath) !== null;
  const resName = cleanHelmName(rawName, filePath, kind);
  const rawNs = yamlGetString(metadata, 'namespace') ?? '';
  const ns = rawNs && !isTemplatedString(rawNs) ? rawNs : '';

  const nodeId = `k8s:${filePath}:${doc.startLine}:${kind}:${ns}:${resName}`;
  const spec = yamlGetMap(doc, 'spec');

  // Build concise, informative signature
  let extraSig = '';
  if (kind === 'Service') {
    const sel = yamlStringMap(yamlGetMap(spec, 'selector'));
    const selStr = Object.entries(sel).map(([k, v]) => `${k}=${v}`).join(', ');
    if (selStr) extraSig = `[selector: ${selStr}]`;
  } else if (kind === 'Ingress') {
    const cls = yamlGetString(spec, 'ingressClassName');
    if (cls) extraSig = `[class: ${cls}]`;
  }

  nodes.push({
    id: nodeId,
    kind: nodeKindForK8s(kind),
    name: `${kind}/${resName}`,
    qualifiedName: makeK8sQualifiedName(ns, kind, resName),
    filePath,
    startLine: doc.startLine,
    endLine: doc.endLine,
    startColumn: 0,
    endColumn: 0,
    language: 'yaml',
    signature: makeK8sSignature(apiVersion, kind, resName, ns, extraSig),
    updatedAt: now,
  });

  // Namespace link
  if (ns && kind !== 'Namespace') {
    const nsEntry = yamlGetEntry(metadata, 'namespace');
    pushRef(references, seen, nodeId, k8sNsRef(ns), 'references', nsEntry?.keyLine ?? doc.startLine, filePath);
  }

  // --- Kind-specific semantic references ---

  // 1. Ingress → Service + TLS Secret
  if (kind === 'Ingress' && spec) {
    extractIngressRefs(spec, ns, nodeId, filePath, references, seen);
  }

  // 2. Gateway API routes (HTTPRoute, GRPCRoute, TCPRoute, TLSRoute, UDPRoute) & Gateway
  if ((kind === 'HTTPRoute' || kind === 'GRPCRoute' || kind === 'TCPRoute' || kind === 'TLSRoute' || kind === 'UDPRoute') && spec) {
    extractGatewayRouteRefs(spec, ns, nodeId, filePath, references, seen);
  } else if (kind === 'Gateway' && spec) {
    const listeners = yamlGetSeq(spec, 'listeners');
    if (listeners) {
      for (const l of listeners.items) {
        const certRefs = yamlGetPathSeq(l, 'tls', 'certificateRefs');
        if (!certRefs) continue;
        for (const cr of certRefs.items) {
          const cName = yamlGetString(cr, 'name');
          const cKind = yamlGetString(cr, 'kind') ?? 'Secret';
          const cNs = yamlGetString(cr, 'namespace') ?? ns;
          if (cName && !isTemplatedString(cName)) {
            pushRef(references, seen, nodeId, k8sResRef(cNs, cKind, cName), 'references', cr.startLine, filePath);
          }
        }
      }
    }
  }

  // 3. Service → matching Workloads via spec.selector (runtime traffic routing)
  if (kind === 'Service' && spec) {
    const selectorMap = yamlGetMap(spec, 'selector');
    if (selectorMap) {
      const selRef = formatSelectorRef(ns, yamlStringMap(selectorMap));
      if (selRef) pushRef(references, seen, nodeId, selRef, 'calls', selectorMap.startLine, filePath);
    }
  }

  // 4. PodDisruptionBudget → matching Workloads via spec.selector.matchLabels
  if (kind === 'PodDisruptionBudget' && spec) {
    const matchLabels = yamlGetPathMap(spec, 'selector', 'matchLabels');
    if (matchLabels) {
      const selRef = formatSelectorRef(ns, yamlStringMap(matchLabels));
      if (selRef) pushRef(references, seen, nodeId, selRef, 'references', matchLabels.startLine, filePath);
    }
  }

  // 5. NetworkPolicy → target pods + specific peer pods (cross-namespace aware)
  if (kind === 'NetworkPolicy' && spec) {
    extractNetworkPolicyRefs(spec, ns, nodeId, filePath, references, seen);
  }

  // 6. HorizontalPodAutoscaler → scaleTargetRef
  if (kind === 'HorizontalPodAutoscaler' && spec) {
    const targetRef = yamlGetMap(spec, 'scaleTargetRef');
    if (targetRef) {
      const tKind = yamlGetString(targetRef, 'kind');
      const tName = yamlGetString(targetRef, 'name');
      if (tKind && tName && !isTemplatedString(tName)) {
        pushRef(references, seen, nodeId, k8sResRef(ns, tKind, tName), 'references', targetRef.startLine, filePath);
      }
    }
  }

  // 7. Prometheus Operator ServiceMonitor / PodMonitor
  if ((kind === 'ServiceMonitor' || kind === 'PodMonitor') && spec) {
    const matchLabels = yamlGetPathMap(spec, 'selector', 'matchLabels');
    if (matchLabels) {
      const selRef = formatSelectorRef(ns, yamlStringMap(matchLabels));
      if (selRef) pushRef(references, seen, nodeId, selRef, 'references', matchLabels.startLine, filePath);
    }
  }

  // 8. Workloads (Deployment, StatefulSet, DaemonSet, ReplicaSet, Job, CronJob, Pod)
  if (WORKLOAD_KINDS.has(kind) && spec) {
    const podSpec =
      kind === 'Pod'
        ? spec
        : kind === 'CronJob'
          ? yamlGetPathMap(spec, 'jobTemplate', 'spec', 'template', 'spec')
          : yamlGetPathMap(spec, 'template', 'spec');
    if (podSpec) {
      extractPodSpecRefs(podSpec, ns, nodeId, filePath, references, seen);
    }
  }

  // 9. RBAC: RoleBinding / ClusterRoleBinding → roleRef + ServiceAccount subjects
  if (kind === 'RoleBinding' || kind === 'ClusterRoleBinding') {
    const roleRef = yamlGetMap(doc, 'roleRef');
    if (roleRef) {
      const rKind = yamlGetString(roleRef, 'kind');
      const rName = yamlGetString(roleRef, 'name');
      if (rKind && rName && !isTemplatedString(rName)) {
        const rNs = rKind === 'ClusterRole' ? '' : ns;
        pushRef(references, seen, nodeId, k8sResRef(rNs, rKind, rName), 'references', roleRef.startLine, filePath);
      }
    }
    const subjects = yamlGetSeq(doc, 'subjects');
    if (subjects) {
      for (const subj of subjects.items) {
        if (subj.kind !== 'map') continue;
        const sKind = yamlGetString(subj, 'kind');
        const sName = yamlGetString(subj, 'name');
        const sNs = yamlGetString(subj, 'namespace') ?? ns;
        if (sKind === 'ServiceAccount' && sName && !isTemplatedString(sName)) {
          pushRef(references, seen, nodeId, k8sResRef(sNs, 'ServiceAccount', sName), 'references', subj.startLine, filePath);
        }
      }
    }
  }

  // 10. RBAC: Role / ClusterRole explicit `resourceNames`
  if (kind === 'Role' || kind === 'ClusterRole') {
    const rules = yamlGetSeq(doc, 'rules');
    if (rules) {
      for (const rule of rules.items) {
        if (rule.kind !== 'map') continue;
        const resTypes = yamlStringList(yamlGetSeq(rule, 'resources'));
        const resNames = yamlStringList(yamlGetSeq(rule, 'resourceNames'));
        if (resTypes.length === 0 || resNames.length === 0) continue;
        for (const rt of resTypes) {
          const targetKind = PLURAL_TO_KIND[rt.toLowerCase()];
          if (!targetKind) continue;
          for (const rn of resNames) {
            if (!isTemplatedString(rn)) {
              pushRef(references, seen, nodeId, k8sResRef(ns, targetKind, rn), 'references', rule.startLine, filePath);
            }
          }
        }
      }
    }
  }

  // Suppress unused variable lint when not a template
  void isTemplate;
}

function extractIngressRefs(
  spec: YamlMap,
  ns: string,
  fromNodeId: string,
  filePath: string,
  refs: UnresolvedRef[],
  seen: Set<string>
): void {
  // defaultBackend (v1: service.name, v1beta1: serviceName)
  const defaultSvc =
    yamlGetPathString(spec, 'defaultBackend', 'service', 'name') ??
    yamlGetPathString(spec, 'backend', 'serviceName');
  if (defaultSvc && !isTemplatedString(defaultSvc)) {
    const defNode = yamlGet(spec, 'defaultBackend') ?? yamlGet(spec, 'backend');
    pushRef(refs, seen, fromNodeId, k8sResRef(ns, 'Service', defaultSvc), 'calls', defNode?.startLine ?? spec.startLine, filePath);
  }

  // rules[].http.paths[].backend.service.name
  const rules = yamlGetSeq(spec, 'rules');
  if (rules) {
    for (const rule of rules.items) {
      const paths = yamlGetPathSeq(rule, 'http', 'paths');
      if (!paths) continue;
      for (const p of paths.items) {
        const svcName =
          yamlGetPathString(p, 'backend', 'service', 'name') ??
          yamlGetPathString(p, 'backend', 'serviceName');
        if (svcName && !isTemplatedString(svcName)) {
          pushRef(refs, seen, fromNodeId, k8sResRef(ns, 'Service', svcName), 'calls', p.startLine, filePath);
        }
      }
    }
  }

  // tls[].secretName
  const tls = yamlGetSeq(spec, 'tls');
  if (tls) {
    for (const entry of tls.items) {
      const secretName = yamlGetString(entry, 'secretName');
      if (secretName && !isTemplatedString(secretName)) {
        pushRef(refs, seen, fromNodeId, k8sResRef(ns, 'Secret', secretName), 'references', entry.startLine, filePath);
      }
    }
  }
}

function extractGatewayRouteRefs(
  spec: YamlMap,
  ns: string,
  fromNodeId: string,
  filePath: string,
  refs: UnresolvedRef[],
  seen: Set<string>
): void {
  const parentRefs = yamlGetSeq(spec, 'parentRefs');
  if (parentRefs) {
    for (const pr of parentRefs.items) {
      const pName = yamlGetString(pr, 'name');
      const pKind = yamlGetString(pr, 'kind') ?? 'Gateway';
      const pNs = yamlGetString(pr, 'namespace') ?? ns;
      if (pName && !isTemplatedString(pName)) {
        pushRef(refs, seen, fromNodeId, k8sResRef(pNs, pKind, pName), 'references', pr.startLine, filePath);
      }
    }
  }

  const rules = yamlGetSeq(spec, 'rules');
  if (rules) {
    for (const rule of rules.items) {
      const backendRefs = yamlGetSeq(rule, 'backendRefs');
      if (!backendRefs) continue;
      for (const br of backendRefs.items) {
        const bName = yamlGetString(br, 'name');
        const bKind = yamlGetString(br, 'kind') ?? 'Service';
        const bNs = yamlGetString(br, 'namespace') ?? ns;
        if (bName && !isTemplatedString(bName)) {
          pushRef(refs, seen, fromNodeId, k8sResRef(bNs, bKind, bName), 'calls', br.startLine, filePath);
        }
      }
    }
  }
}

function extractNetworkPolicyRefs(
  spec: YamlMap,
  ns: string,
  fromNodeId: string,
  filePath: string,
  refs: UnresolvedRef[],
  seen: Set<string>
): void {
  const podSel = yamlGetPathMap(spec, 'podSelector', 'matchLabels');
  if (podSel) {
    const selRef = formatSelectorRef(ns, yamlStringMap(podSel));
    if (selRef) pushRef(refs, seen, fromNodeId, selRef, 'references', podSel.startLine, filePath);
  }

  const peerDirs: Array<{ ruleField: 'ingress' | 'egress'; peerField: 'from' | 'to' }> = [
    { ruleField: 'ingress', peerField: 'from' },
    { ruleField: 'egress', peerField: 'to' },
  ];
  for (const { ruleField, peerField } of peerDirs) {
    const rules = yamlGetSeq(spec, ruleField);
    if (!rules) continue;
    for (const rule of rules.items) {
      const peers = yamlGetSeq(rule, peerField);
      if (!peers) continue;
      for (const peer of peers.items) {
        if (peer.kind !== 'map') continue;
        const peerPodLabels = yamlGetPathMap(peer, 'podSelector', 'matchLabels');
        if (!peerPodLabels) continue; // skip namespace-wide selectors to avoid N×M noise
        const nsLabels = yamlStringMap(yamlGetPathMap(peer, 'namespaceSelector', 'matchLabels'));
        const peerNs = nsLabels['kubernetes.io/metadata.name'] ?? ns;
        const selRef = formatSelectorRef(peerNs, yamlStringMap(peerPodLabels));
        if (selRef) pushRef(refs, seen, fromNodeId, selRef, 'references', peer.startLine, filePath);
      }
    }
  }
}

function extractPodSpecRefs(
  podSpec: YamlMap,
  ns: string,
  fromNodeId: string,
  filePath: string,
  refs: UnresolvedRef[],
  seen: Set<string>
): void {
  // serviceAccountName / serviceAccount
  const saEntry = yamlGetEntry(podSpec, 'serviceAccountName') ?? yamlGetEntry(podSpec, 'serviceAccount');
  if (saEntry && saEntry.value.kind === 'scalar' && saEntry.value.value && !isTemplatedString(saEntry.value.value)) {
    pushRef(refs, seen, fromNodeId, k8sResRef(ns, 'ServiceAccount', saEntry.value.value), 'references', saEntry.keyLine, filePath);
  }

  // priorityClassName
  const pcEntry = yamlGetEntry(podSpec, 'priorityClassName');
  if (pcEntry && pcEntry.value.kind === 'scalar' && pcEntry.value.value && !isTemplatedString(pcEntry.value.value)) {
    pushRef(refs, seen, fromNodeId, k8sResRef('', 'PriorityClass', pcEntry.value.value), 'references', pcEntry.keyLine, filePath);
  }

  // imagePullSecrets
  const pullSecrets = yamlGetSeq(podSpec, 'imagePullSecrets');
  if (pullSecrets) {
    for (const ps of pullSecrets.items) {
      const sName = yamlGetString(ps, 'name');
      if (sName && !isTemplatedString(sName)) {
        pushRef(refs, seen, fromNodeId, k8sResRef(ns, 'Secret', sName), 'references', ps.startLine, filePath);
      }
    }
  }

  // containers / initContainers / ephemeralContainers
  for (const cField of ['containers', 'initContainers', 'ephemeralContainers'] as const) {
    const containers = yamlGetSeq(podSpec, cField);
    if (!containers) continue;
    for (const c of containers.items) {
      if (c.kind !== 'map') continue;

      // envFrom[].configMapRef / secretRef
      const envFrom = yamlGetSeq(c, 'envFrom');
      if (envFrom) {
        for (const ef of envFrom.items) {
          const cmName = yamlGetPathString(ef, 'configMapRef', 'name');
          if (cmName && !isTemplatedString(cmName)) {
            pushRef(refs, seen, fromNodeId, k8sResRef(ns, 'ConfigMap', cmName), 'references', ef.startLine, filePath);
          }
          const secName = yamlGetPathString(ef, 'secretRef', 'name');
          if (secName && !isTemplatedString(secName)) {
            pushRef(refs, seen, fromNodeId, k8sResRef(ns, 'Secret', secName), 'references', ef.startLine, filePath);
          }
        }
      }

      // env[].valueFrom.{configMapKeyRef,secretKeyRef} + env[].value cluster DNS
      const env = yamlGetSeq(c, 'env');
      if (env) {
        for (const e of env.items) {
          const cmName = yamlGetPathString(e, 'valueFrom', 'configMapKeyRef', 'name');
          if (cmName && !isTemplatedString(cmName)) {
            pushRef(refs, seen, fromNodeId, k8sResRef(ns, 'ConfigMap', cmName), 'references', e.startLine, filePath);
          }
          const secName = yamlGetPathString(e, 'valueFrom', 'secretKeyRef', 'name');
          if (secName && !isTemplatedString(secName)) {
            pushRef(refs, seen, fromNodeId, k8sResRef(ns, 'Secret', secName), 'references', e.startLine, filePath);
          }
          const val = yamlGetString(e, 'value');
          if (val) scanClusterDns(val, e.startLine, fromNodeId, filePath, refs, seen);
        }
      }

      // args / command cluster DNS
      for (const argField of ['args', 'command'] as const) {
        const argSeq = yamlGetSeq(c, argField);
        if (!argSeq) continue;
        for (const a of argSeq.items) {
          if (a.kind === 'scalar' && a.value) {
            scanClusterDns(a.value, a.startLine, fromNodeId, filePath, refs, seen);
          }
        }
      }
    }
  }

  // volumes[]
  const volumes = yamlGetSeq(podSpec, 'volumes');
  if (volumes) {
    for (const v of volumes.items) {
      if (v.kind !== 'map') continue;
      const cmName = yamlGetPathString(v, 'configMap', 'name');
      if (cmName && !isTemplatedString(cmName)) {
        pushRef(refs, seen, fromNodeId, k8sResRef(ns, 'ConfigMap', cmName), 'references', v.startLine, filePath);
      }
      const secName = yamlGetPathString(v, 'secret', 'secretName');
      if (secName && !isTemplatedString(secName)) {
        pushRef(refs, seen, fromNodeId, k8sResRef(ns, 'Secret', secName), 'references', v.startLine, filePath);
      }
      const pvcName = yamlGetPathString(v, 'persistentVolumeClaim', 'claimName');
      if (pvcName && !isTemplatedString(pvcName)) {
        pushRef(refs, seen, fromNodeId, k8sResRef(ns, 'PersistentVolumeClaim', pvcName), 'references', v.startLine, filePath);
      }
      const projSources = yamlGetPathSeq(v, 'projected', 'sources');
      if (projSources) {
        for (const src of projSources.items) {
          const pCm = yamlGetPathString(src, 'configMap', 'name');
          if (pCm && !isTemplatedString(pCm)) {
            pushRef(refs, seen, fromNodeId, k8sResRef(ns, 'ConfigMap', pCm), 'references', src.startLine, filePath);
          }
          const pSec = yamlGetPathString(src, 'secret', 'name');
          if (pSec && !isTemplatedString(pSec)) {
            pushRef(refs, seen, fromNodeId, k8sResRef(ns, 'Secret', pSec), 'references', src.startLine, filePath);
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Resolution Index (WeakMap-cached per ResolutionContext)
// ---------------------------------------------------------------------------

interface KustomizeOverlayInfo {
  filePath: string;
  dir: string;
  namespace: string;
  namePrefix: string;
  nameSuffix: string;
  resourceFiles: string[];
  childDirs: string[];
}

interface ResourceEntry {
  node: Node;
  kind: string;
  name: string;
  rawName: string;
  namespace: string;
  podLabels: Record<string, string> | null;
}

interface K8sResolutionIndex {
  /** Effective namespace (and prefix/suffix) propagated to each manifest file from Kustomize. */
  fileMeta: Map<string, { namespace: string; namePrefix: string; nameSuffix: string }>;
  /** All K8s nodes indexed by `ns|kind|name` and `kind|name`. */
  byNsKindName: Map<string, ResourceEntry[]>;
  byKindName: Map<string, ResourceEntry[]>;
  /** Workload + Service entries with labels for selector matching. */
  labelTargets: ResourceEntry[];
  /** Namespace/<ns> nodes by namespace name. */
  namespaces: Map<string, Node>;
  /** Kustomization module nodes by their directory path. */
  kustomizationsByDir: Map<string, Node>;
  /** K8s resource nodes by filePath. */
  nodesByFile: Map<string, Node[]>;
}

interface CachedK8sIndex {
  refs: readonly [Node[], Node[], Node[], Node[], Node[]];
  index: K8sResolutionIndex;
}

const k8sIndexCache = new WeakMap<ResolutionContext, CachedK8sIndex>();

function getK8sIndex(context: ResolutionContext): K8sResolutionIndex {
  const components = context.getNodesByKind('component');
  const routes = context.getNodesByKind('route');
  const constants = context.getNodesByKind('constant');
  const nsNodes = context.getNodesByKind('namespace');
  const modules = context.getNodesByKind('module');

  const cached = k8sIndexCache.get(context);
  if (
    cached &&
    cached.refs[0] === components &&
    cached.refs[1] === routes &&
    cached.refs[2] === constants &&
    cached.refs[3] === nsNodes &&
    cached.refs[4] === modules
  ) {
    return cached.index;
  }

  const fileMeta = computeKustomizePropagation(context);
  const byNsKindName = new Map<string, ResourceEntry[]>();
  const byKindName = new Map<string, ResourceEntry[]>();
  const labelTargets: ResourceEntry[] = [];
  const namespaces = new Map<string, Node>();
  const kustomizationsByDir = new Map<string, Node>();
  const nodesByFile = new Map<string, Node[]>();

  // Gather all K8s nodes (they all have `id.startsWith('k8s:')`)
  const nodeBuckets = [components, routes, constants, nsNodes, modules];
  for (const bucket of nodeBuckets) {
    for (const node of bucket) {
      if (!node.id.startsWith('k8s:')) continue;

      let fileList = nodesByFile.get(node.filePath);
      if (!fileList) {
        fileList = [];
        nodesByFile.set(node.filePath, fileList);
      }
      fileList.push(node);

      const parsed = parseK8sNodeId(node.id);
      if (!parsed) continue;

      if (parsed.kind === 'Kustomization') {
        kustomizationsByDir.set(dirOf(node.filePath), node);
        continue;
      }

      if (parsed.kind === 'Namespace') {
        namespaces.set(parsed.name, node);
      }

      const inherited = fileMeta.get(node.filePath);
      const effectiveNs = CLUSTER_SCOPED_KINDS.has(parsed.kind)
        ? ''
        : (parsed.ns || inherited?.namespace || '');
      const rawName = parsed.name;
      // Generated ConfigMaps/Secrets from kustomization already carry prefix/suffix in their id;
      // regular manifest resources may receive prefix/suffix from an enclosing Kustomization.
      const isGenerated = node.signature?.startsWith('kustomize ') ?? false;
      const effectiveName = !isGenerated && inherited
        ? `${inherited.namePrefix}${rawName}${inherited.nameSuffix}`
        : rawName;

      const podLabels = (WORKLOAD_KINDS.has(parsed.kind) || parsed.kind === 'Service')
        ? readPodLabels(node, parsed.kind, context)
        : null;

      const entry: ResourceEntry = {
        node,
        kind: parsed.kind,
        name: effectiveName,
        rawName,
        namespace: effectiveNs,
        podLabels,
      };

      const addToMap = (nsKey: string, nameKey: string) => {
        const fullKey = `${nsKey}|${parsed.kind}|${nameKey}`;
        let list = byNsKindName.get(fullKey);
        if (!list) {
          list = [];
          byNsKindName.set(fullKey, list);
        }
        if (!list.includes(entry)) list.push(entry);

        const shortKey = `${parsed.kind}|${nameKey}`;
        let shortList = byKindName.get(shortKey);
        if (!shortList) {
          shortList = [];
          byKindName.set(shortKey, shortList);
        }
        if (!shortList.includes(entry)) shortList.push(entry);
      };

      addToMap(effectiveNs, effectiveName);
      if (rawName !== effectiveName) addToMap(effectiveNs, rawName);

      if (podLabels && Object.keys(podLabels).length > 0) {
        labelTargets.push(entry);
      }
    }
  }

  const index: K8sResolutionIndex = {
    fileMeta,
    byNsKindName,
    byKindName,
    labelTargets,
    namespaces,
    kustomizationsByDir,
    nodesByFile,
  };
  k8sIndexCache.set(context, { refs: [components, routes, constants, nsNodes, modules], index });
  return index;
}

/**
 * Parse our deterministic K8s node ID format:
 *   `k8s:<filePath>:<startLine>:<Kind>:<ns>:<name>`
 *   or `k8s:<filePath>:<startLine>:Kustomization:<dirLabel>`
 */
function parseK8sNodeId(id: string): { kind: string; ns: string; name: string } | null {
  if (!id.startsWith('k8s:')) return null;
  // Find `:<digits>:` separator (filePath itself can't contain `:<digits>:` on posix rel paths)
  const m = id.match(/^k8s:.+?:(\d+):([^:]+):(.*)$/);
  if (!m) return null;
  const kind = m[2]!;
  const rest = m[3]!;
  if (kind === 'Kustomization') {
    return { kind, ns: '', name: rest };
  }
  const colon = rest.indexOf(':');
  if (colon < 0) return null;
  return { kind, ns: rest.slice(0, colon), name: rest.slice(colon + 1) };
}

/**
 * Walk all Kustomization files in the project and propagate `namespace`,
 * `namePrefix`, and `nameSuffix` to their referenced manifests and child
 * Kustomization directories.
 */
function computeKustomizePropagation(
  context: ResolutionContext
): Map<string, { namespace: string; namePrefix: string; nameSuffix: string }> {
  const overlays = new Map<string, KustomizeOverlayInfo>();
  const allFiles = context.getAllFiles();
  const fileSet = new Set(allFiles);

  for (const f of allFiles) {
    if (!isKustomizationFile(f)) continue;
    const text = context.readFile(f);
    if (!text) continue;
    const docs = parseYamlDocuments(text);
    const root = docs[0]?.root;
    if (!root || root.kind !== 'map') continue;

    const dir = dirOf(f);
    const resourceFiles: string[] = [];
    const childDirs: string[] = [];

    for (const field of ['resources', 'bases', 'components'] as const) {
      for (const item of yamlStringList(yamlGetSeq(root, field))) {
        if (/^[a-z]+:\/\//i.test(item)) continue;
        const target = joinRel(dir, item);
        if (fileSet.has(target)) {
          resourceFiles.push(target);
        } else {
          childDirs.push(target);
        }
      }
    }

    overlays.set(dir, {
      filePath: f,
      dir,
      namespace: yamlGetString(root, 'namespace') ?? '',
      namePrefix: yamlGetString(root, 'namePrefix') ?? '',
      nameSuffix: yamlGetString(root, 'nameSuffix') ?? '',
      resourceFiles,
      childDirs,
    });
  }

  const fileMeta = new Map<string, { namespace: string; namePrefix: string; nameSuffix: string }>();

  const propagate = (
    dir: string,
    inheritedNs: string,
    inheritedPrefix: string,
    inheritedSuffix: string,
    visited: Set<string>
  ) => {
    if (visited.has(dir)) return;
    visited.add(dir);
    const ov = overlays.get(dir);
    if (!ov) return;

    const effNs = inheritedNs || ov.namespace;
    const effPrefix = `${inheritedPrefix}${ov.namePrefix}`;
    const effSuffix = `${ov.nameSuffix}${inheritedSuffix}`;

    for (const rf of ov.resourceFiles) {
      if (!fileMeta.has(rf) || (!fileMeta.get(rf)!.namespace && effNs)) {
        fileMeta.set(rf, { namespace: effNs, namePrefix: effPrefix, nameSuffix: effSuffix });
      }
    }
    for (const childDir of ov.childDirs) {
      propagate(childDir, effNs, effPrefix, effSuffix, visited);
    }
  };

  // Start propagation from top-level kustomizations (those not referenced as a child of another),
  // then cover any remaining cycles/disconnected overlays.
  const referencedDirs = new Set<string>();
  for (const ov of overlays.values()) {
    for (const c of ov.childDirs) referencedDirs.add(c);
  }
  for (const dir of overlays.keys()) {
    if (!referencedDirs.has(dir)) {
      propagate(dir, '', '', '', new Set());
    }
  }
  for (const dir of overlays.keys()) {
    propagate(dir, '', '', '', new Set());
  }

  return fileMeta;
}

/** Re-read pod template labels (for workloads) or metadata.labels (for Pod/Service) from a node's span. */
function readPodLabels(node: Node, kind: string, context: ResolutionContext): Record<string, string> | null {
  const lines = context.getFileLines?.(node.filePath) ?? context.readFile(node.filePath)?.split(/\r?\n/) ?? null;
  if (!lines) return null;
  const snippet = lines.slice(Math.max(0, node.startLine - 1), Math.min(node.endLine, lines.length)).join('\n');
  const docs = parseYamlDocuments(snippet);
  const root = docs[0]?.root;
  if (!root || root.kind !== 'map') return null;

  let labelsMap: YamlMap | null = null;
  if (kind === 'Pod' || kind === 'Service') {
    labelsMap = yamlGetPathMap(root, 'metadata', 'labels');
  } else if (kind === 'CronJob') {
    labelsMap = yamlGetPathMap(root, 'spec', 'jobTemplate', 'spec', 'template', 'metadata', 'labels');
  } else {
    labelsMap = yamlGetPathMap(root, 'spec', 'template', 'metadata', 'labels');
  }
  if (!labelsMap) return null;
  const labels = yamlStringMap(labelsMap);
  return Object.keys(labels).length > 0 ? labels : null;
}

function fanOutResult(ref: UnresolvedRef, targets: Node[], confidence: number, metadata?: Record<string, unknown>): ResolvedRef | null {
  if (targets.length === 0) return null;
  const unique: Node[] = [];
  const seenIds = new Set<string>();
  for (const t of targets) {
    if (t.id === ref.fromNodeId || seenIds.has(t.id)) continue;
    seenIds.add(t.id);
    unique.push(t);
  }
  if (unique.length === 0) return null;
  return {
    original: ref,
    targetNodeId: unique[0]!.id,
    confidence,
    resolvedBy: 'framework',
    metadata,
    ...(unique.length > 1 ? { alsoTargets: unique.slice(1).map((n) => ({ targetNodeId: n.id, metadata })) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Kubernetes + Kustomize FrameworkResolver
// ---------------------------------------------------------------------------

export const kubernetesResolver: FrameworkResolver = {
  name: 'kubernetes',
  languages: ['yaml'],

  detect(context: ResolutionContext): boolean {
    const yamlFiles = context.getAllFiles().filter(isYamlFile);
    if (yamlFiles.length === 0) return false;

    // Fast path: any Kustomization or Helm Chart file
    if (yamlFiles.some((f) => isKustomizationFile(f) || isHelmChartFile(f))) return true;

    // Otherwise check YAML files for top-level `apiVersion:` + `kind:`
    for (const file of yamlFiles) {
      if (context.fileContains && !context.fileContains(file, 'apiVersion:')) continue;
      const content = context.readFile(file);
      if (!content) continue;
      if (/^apiVersion:\s*\S/m.test(content) && /^kind:\s*[A-Z][A-Za-z0-9]*/m.test(content)) {
        return true;
      }
    }
    return false;
  },

  claimsReference(name: string): boolean {
    return name.startsWith('k8s:');
  },

  ownsReference(ref: UnresolvedRef): boolean {
    return ref.language === 'yaml' && ref.referenceName.startsWith('k8s:');
  },

  extract(filePath: string, content: string): FrameworkExtractionResult {
    if (!isYamlFile(filePath)) return { nodes: [], references: [] };
    if (isHelmChartFile(filePath) || isHelmValuesFile(filePath)) return { nodes: [], references: [] };

    const docs = parseYamlDocuments(content);
    if (docs.length === 0) return { nodes: [], references: [] };

    const now = Date.now();

    // Kustomization file (either by filename or explicit `kind: Kustomization`)
    const firstRoot = docs[0]?.root;
    if (
      firstRoot &&
      firstRoot.kind === 'map' &&
      (isKustomizationFile(filePath) || yamlGetString(firstRoot, 'kind') === 'Kustomization')
    ) {
      return extractKustomization(filePath, firstRoot, now);
    }

    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const seen = new Set<string>();

    for (const doc of docs) {
      if (doc.root && doc.root.kind === 'map') {
        extractK8sResource(filePath, doc.root, now, nodes, references, seen);
      }
    }

    return { nodes, references };
  },

  /**
   * Propagate Kustomization `namespace` into included manifest nodes'
   * `qualifiedName` and `signature` (preserving `id` so existing edges stay
   * intact, and remaining idempotent across syncs).
   */
  postExtract(context: ResolutionContext): Node[] {
    k8sIndexCache.delete(context);
    const fileMeta = computeKustomizePropagation(context);
    if (fileMeta.size === 0) return [];

    const updated: Node[] = [];
    const k8sKinds: NodeKind[] = ['component', 'route', 'constant'];

    for (const nk of k8sKinds) {
      for (const node of context.getNodesByKind(nk)) {
        if (!node.id.startsWith('k8s:')) continue;
        const parsed = parseK8sNodeId(node.id);
        if (!parsed || parsed.ns || CLUSTER_SCOPED_KINDS.has(parsed.kind)) continue;
        const meta = fileMeta.get(node.filePath);
        if (!meta?.namespace) continue;

        const targetQn = makeK8sQualifiedName(meta.namespace, parsed.kind, parsed.name);
        if (node.qualifiedName === targetQn) continue;

        const sigBase = (node.signature ?? `${parsed.kind} ${parsed.name}`).replace(/\s*\(namespace:\s*[^)]+\)/, '');
        updated.push({
          ...node,
          qualifiedName: targetQn,
          signature: `${sigBase} (namespace: ${meta.namespace})`,
        });
      }
    }

    return updated;
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.language !== 'yaml' || !ref.referenceName.startsWith('k8s:')) return null;
    const index = getK8sIndex(context);
    const name = ref.referenceName;

    // 1. Namespace reference: `k8s:ns:Namespace/<namespace>`
    if (name.startsWith('k8s:ns:')) {
      const rest = name.slice('k8s:ns:'.length);
      const nsName = rest.startsWith('Namespace/') ? rest.slice('Namespace/'.length) : rest;
      const nsNode = index.namespaces.get(nsName);
      if (!nsNode || nsNode.id === ref.fromNodeId) return null;
      return { original: ref, targetNodeId: nsNode.id, confidence: 0.95, resolvedBy: 'framework' };
    }

    // 2. Kustomize file / directory reference: `k8s:file:<relPath>`
    if (name.startsWith('k8s:file:')) {
      const targetRel = name.slice('k8s:file:'.length);
      // 2a. Directory containing a kustomization.yaml
      const kustNode = index.kustomizationsByDir.get(targetRel);
      if (kustNode) {
        return fanOutResult(ref, [kustNode], 0.95);
      }
      // 2b. YAML manifest file with K8s resource nodes
      const k8sNodes = index.nodesByFile.get(targetRel);
      if (k8sNodes && k8sNodes.length > 0) {
        return fanOutResult(ref, k8sNodes, 0.95);
      }
      // 2c. Indexed non-YAML file (e.g. script/config with a `file` node)
      const fileNodes = context.getNodesInFile(targetRel);
      const fileNode = fileNodes.find((n) => n.kind === 'file');
      if (fileNode) {
        return fanOutResult(ref, [fileNode], 0.9);
      }
      return null;
    }

    // Effective namespace of the source node (falls back to Kustomize propagation)
    const fromParsed = parseK8sNodeId(ref.fromNodeId);
    const sourceNs = fromParsed?.ns || index.fileMeta.get(ref.filePath)?.namespace || '';

    // 3. Direct resource reference: `k8s:res:<ns>:<Kind>/<name>`
    if (name.startsWith('k8s:res:')) {
      const rest = name.slice('k8s:res:'.length);
      const c1 = rest.indexOf(':');
      if (c1 < 0) return null;
      const explicitNs = rest.slice(0, c1);
      const kindAndName = rest.slice(c1 + 1);
      const slash = kindAndName.indexOf('/');
      if (slash < 0) return null;

      const targetKind = kindAndName.slice(0, slash);
      const targetName = kindAndName.slice(slash + 1);
      const effectiveNs = CLUSTER_SCOPED_KINDS.has(targetKind) ? '' : (explicitNs || sourceNs);

      // Exact (ns, kind, name) match
      const exact = index.byNsKindName.get(`${effectiveNs}|${targetKind}|${targetName}`);
      if (exact && exact.length > 0) {
        return fanOutResult(ref, exact.map((e) => e.node), 0.95);
      }

      // Kustomize namePrefix / nameSuffix rewrite for in-overlay references
      const srcMeta = index.fileMeta.get(ref.filePath);
      if (srcMeta && (srcMeta.namePrefix || srcMeta.nameSuffix)) {
        const prefixed = `${srcMeta.namePrefix}${targetName}${srcMeta.nameSuffix}`;
        const prefixedMatch = index.byNsKindName.get(`${effectiveNs}|${targetKind}|${prefixed}`);
        if (prefixedMatch && prefixedMatch.length > 0) {
          return fanOutResult(ref, prefixedMatch.map((e) => e.node), 0.95);
        }
      }

      // If ref had no explicit namespace and no Kustomize namespace, fall back to
      // unique (kind, name) match across the repo (preferring same directory).
      if (!effectiveNs) {
        const anyNs = index.byKindName.get(`${targetKind}|${targetName}`);
        if (anyNs && anyNs.length > 0) {
          const refDir = dirOf(ref.filePath);
          const sameDir = anyNs.filter((e) => dirOf(e.node.filePath) === refDir);
          if (sameDir.length > 0) {
            return fanOutResult(ref, sameDir.map((e) => e.node), 0.9);
          }
          if (anyNs.length === 1) {
            return fanOutResult(ref, [anyNs[0]!.node], 0.85);
          }
        }
      }
      return null;
    }

    // 4. Label selector reference: `k8s:sel:<ns>:<k1>=<v1>&<k2>=<v2>`
    if (name.startsWith('k8s:sel:')) {
      const rest = name.slice('k8s:sel:'.length);
      const colon = rest.indexOf(':');
      if (colon < 0) return null;
      const explicitNs = rest.slice(0, colon);
      const encoded = rest.slice(colon + 1);
      const pairs = parseSelectorPairs(encoded);
      if (pairs.length === 0) return null;

      const targetNs = explicitNs || sourceNs;
      const isServiceMonitor = fromParsed?.kind === 'ServiceMonitor';

      const matches = index.labelTargets.filter((entry) => {
        // ServiceMonitor targets Services; Services/NetworkPolicies/PDBs target Workloads
        if (isServiceMonitor) {
          if (entry.kind !== 'Service') return false;
        } else {
          if (!WORKLOAD_KINDS.has(entry.kind)) return false;
        }
        if (targetNs && entry.namespace && entry.namespace !== targetNs) return false;
        // If explicit cross-namespace selector was given (e.g. NetworkPolicy namespaceSelector),
        // require the target to actually belong to that namespace.
        if (explicitNs && entry.namespace !== explicitNs) return false;
        if (!entry.podLabels) return false;
        return pairs.every(([k, v]) => entry.podLabels![k] === v);
      });

      if (matches.length === 0) return null;

      // If no namespace was specified on either side, prefer same directory when multiple matches exist
      if (!targetNs && matches.length > 1) {
        const refDir = dirOf(ref.filePath);
        const sameDir = matches.filter((m) => dirOf(m.node.filePath) === refDir);
        if (sameDir.length > 0) {
          return fanOutResult(ref, sameDir.map((m) => m.node), 0.9);
        }
      }

      return fanOutResult(ref, matches.map((m) => m.node), 0.9);
    }

    return null;
  },
};

// ---------------------------------------------------------------------------
// Helm FrameworkResolver (Chart.yaml, values.yaml, templates/*.{yaml,yml,tpl})
// ---------------------------------------------------------------------------

const HELM_VALUES_REF_RE = /\.Values\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)/g;
const HELM_INCLUDE_REF_RE = /\b(?:include|template)\s+"([^"]+)"/g;
const HELM_DEFINE_RE = /\{\{-?\s*define\s+"([^"]+)"\s*-?\}\}/g;
const HELM_END_RE = /\{\{-?\s*end\s*-?\}\}/g;

function extractHelmChartYaml(filePath: string, content: string, now: number): FrameworkExtractionResult {
  const docs = parseYamlDocuments(content);
  const root = docs[0]?.root;
  if (!root || root.kind !== 'map') return { nodes: [], references: [] };

  const chartName = yamlGetString(root, 'name');
  if (!chartName) return { nodes: [], references: [] };
  // Guard: Chart.yaml always carries apiVersion or version
  const version = yamlGetString(root, 'version') ?? '';
  const apiVersion = yamlGetString(root, 'apiVersion') ?? '';
  if (!version && !apiVersion) return { nodes: [], references: [] };

  const chartDir = dirOf(filePath);
  const chartId = `helm:chart:${filePath}:1:${chartName}`;
  const nodes: Node[] = [{
    id: chartId,
    kind: 'module',
    name: `Chart/${chartName}`,
    qualifiedName: `helm:${chartDir}/Chart/${chartName}`,
    filePath,
    startLine: root.startLine,
    endLine: root.endLine,
    startColumn: 0,
    endColumn: 0,
    language: 'yaml',
    signature: `Helm Chart ${chartName}${version ? ` (${version})` : ''}`,
    updatedAt: now,
  }];

  const references: UnresolvedRef[] = [];
  const seen = new Set<string>();
  const deps = yamlGetSeq(root, 'dependencies');
  if (deps) {
    for (const dep of deps.items) {
      if (dep.kind !== 'map') continue;
      const repo = yamlGetString(dep, 'repository');
      if (repo && repo.startsWith('file://')) {
        const subDir = joinRel(chartDir, repo.slice('file://'.length));
        pushRef(references, seen, chartId, `helm:chart:${subDir}`, 'imports', dep.startLine, filePath);
      }
    }
  }

  return { nodes, references };
}

function extractHelmValuesYaml(filePath: string, content: string, now: number): FrameworkExtractionResult {
  const docs = parseYamlDocuments(content);
  const root = docs[0]?.root;
  if (!root || root.kind !== 'map') return { nodes: [], references: [] };
  // Never misread a K8s manifest as values.yaml
  if (yamlGetString(root, 'apiVersion') && yamlGetString(root, 'kind')) {
    return { nodes: [], references: [] };
  }

  const chartDir = dirOf(filePath);
  const nodes: Node[] = [];

  const visit = (val: YamlValue, prefix: string, depth: number) => {
    if (nodes.length >= MAX_HELM_VALUES_KEYS || depth > 5) return;
    if (val.kind !== 'map') return;
    for (const entry of val.entries) {
      if (nodes.length >= MAX_HELM_VALUES_KEYS) break;
      const keyPath = prefix ? `${prefix}.${entry.key}` : entry.key;
      nodes.push({
        id: `helm:val:${filePath}:${entry.keyLine}:${keyPath}`,
        kind: 'variable',
        name: `values:${keyPath}`,
        qualifiedName: `helm:${chartDir}:values:${keyPath}`,
        filePath,
        startLine: entry.startLine,
        endLine: entry.endLine,
        startColumn: 0,
        endColumn: 0,
        language: 'yaml',
        signature: `.Values.${keyPath}${entry.value.kind === 'scalar' && entry.value.value ? ` = ${entry.value.value.slice(0, 60)}` : ''}`,
        updatedAt: now,
      });
      if (entry.value.kind === 'map') {
        visit(entry.value, keyPath, depth + 1);
      }
    }
  };

  visit(root, '', 0);
  return { nodes, references: [] };
}

function extractHelmTemplateRefs(
  filePath: string,
  content: string,
  chartDir: string,
  nodes: Node[]
): UnresolvedRef[] {
  const refs: UnresolvedRef[] = [];
  const seen = new Set<string>();
  const lines = content.split(/\r?\n/);

  // Attach template refs to the K8s resource node whose span covers each line.
  // Re-parse doc spans cheaply via kubernetesResolver's node layout (or match by line).
  const findOwnerAt = (lineNum: number): string | null => {
    for (const n of nodes) {
      if (lineNum >= n.startLine && lineNum <= n.endLine) return n.id;
    }
    return nodes[0]?.id ?? null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.includes('{{')) continue;
    const lineNum = i + 1;
    const owner = findOwnerAt(lineNum);
    if (!owner) continue;

    HELM_VALUES_REF_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HELM_VALUES_REF_RE.exec(line)) !== null) {
      pushRef(refs, seen, owner, `helm:val:${chartDir}:${m[1]!}`, 'references', lineNum, filePath);
    }

    HELM_INCLUDE_REF_RE.lastIndex = 0;
    while ((m = HELM_INCLUDE_REF_RE.exec(line)) !== null) {
      pushRef(refs, seen, owner, `helm:tpl:${chartDir}:${m[1]!}`, 'calls', lineNum, filePath);
    }
  }

  return refs;
}

/** Extract `{{- define "name" -}}` blocks from a Helm `templates/*.tpl` file. */
function extractHelmTplHelpers(
  tplPath: string,
  chartDir: string,
  content: string,
  now: number
): { nodes: Node[]; references: UnresolvedRef[] } {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const seen = new Set<string>();
  const lines = content.split(/\r?\n/);

  // Track define blocks by matching `define "..."` to its closing `end` (accounting for nested if/with/range)
  const BLOCK_OPEN_RE = /\{\{-?\s*(?:if|range|with|define|block)\b/g;

  for (let i = 0; i < lines.length; i++) {
    HELM_DEFINE_RE.lastIndex = 0;
    const m = HELM_DEFINE_RE.exec(lines[i]!);
    if (!m) continue;
    const tplName = m[1]!;
    const startLine = i + 1;

    // Find matching `end`
    let depth = 0;
    let endLine = startLine;
    for (let j = i; j < lines.length; j++) {
      const l = lines[j]!;
      const opens = (l.match(BLOCK_OPEN_RE) ?? []).length;
      const closes = (l.match(HELM_END_RE) ?? []).length;
      depth += opens - closes;
      endLine = j + 1;
      if (depth <= 0) break;
    }

    const helperId = `helm:tpl:${tplPath}:${startLine}:${tplName}`;
    nodes.push({
      id: helperId,
      kind: 'function',
      name: `template:${tplName}`,
      qualifiedName: `helm:${chartDir}:template:${tplName}`,
      filePath: tplPath,
      startLine,
      endLine,
      startColumn: 0,
      endColumn: 0,
      language: 'yaml',
      signature: `define "${tplName}"`,
      updatedAt: now,
    });

    // Scan helper body for `.Values.*` and nested `include`/`template` calls
    for (let j = i; j < endLine; j++) {
      const l = lines[j]!;
      const lineNum = j + 1;
      HELM_VALUES_REF_RE.lastIndex = 0;
      let vm: RegExpExecArray | null;
      while ((vm = HELM_VALUES_REF_RE.exec(l)) !== null) {
        pushRef(references, seen, helperId, `helm:val:${chartDir}:${vm[1]!}`, 'references', lineNum, tplPath);
      }
      HELM_INCLUDE_REF_RE.lastIndex = 0;
      while ((vm = HELM_INCLUDE_REF_RE.exec(l)) !== null) {
        if (vm[1]! !== tplName) {
          pushRef(references, seen, helperId, `helm:tpl:${chartDir}:${vm[1]!}`, 'calls', lineNum, tplPath);
        }
      }
    }
  }

  return { nodes, references };
}

interface HelmResolutionIndex {
  chartsByDir: Map<string, Node>;
  valuesByChartKey: Map<string, Node>;
  helpersByChartName: Map<string, Node>;
}

interface CachedHelmIndex {
  refs: readonly [Node[], Node[], Node[]];
  index: HelmResolutionIndex;
}

const helmIndexCache = new WeakMap<ResolutionContext, CachedHelmIndex>();

function getHelmIndex(context: ResolutionContext): HelmResolutionIndex {
  const modules = context.getNodesByKind('module');
  const variables = context.getNodesByKind('variable');
  const functions = context.getNodesByKind('function');
  const cached = helmIndexCache.get(context);
  if (
    cached &&
    cached.refs[0] === modules &&
    cached.refs[1] === variables &&
    cached.refs[2] === functions
  ) {
    return cached.index;
  }

  const chartsByDir = new Map<string, Node>();
  const valuesByChartKey = new Map<string, Node>();
  const helpersByChartName = new Map<string, Node>();

  for (const n of modules) {
    if (n.id.startsWith('helm:chart:')) {
      chartsByDir.set(dirOf(n.filePath), n);
    }
  }
  for (const n of variables) {
    if (n.id.startsWith('helm:val:')) {
      // qualifiedName: `helm:<chartDir>:values:<keyPath>`
      const m = n.qualifiedName.match(/^helm:(.+):values:(.+)$/);
      if (m) valuesByChartKey.set(`${m[1]!}\0${m[2]!}`, n);
    }
  }
  for (const n of functions) {
    if (n.id.startsWith('helm:tpl:')) {
      const m = n.qualifiedName.match(/^helm:(.+):template:(.+)$/);
      if (m) helpersByChartName.set(`${m[1]!}\0${m[2]!}`, n);
    }
  }

  const index: HelmResolutionIndex = { chartsByDir, valuesByChartKey, helpersByChartName };
  helmIndexCache.set(context, { refs: [modules, variables, functions], index });
  return index;
}

export const helmResolver: FrameworkResolver = {
  name: 'helm',
  languages: ['yaml'],

  detect(context: ResolutionContext): boolean {
    return context.getAllFiles().some(isHelmChartFile);
  },

  claimsReference(name: string): boolean {
    return name.startsWith('helm:');
  },

  ownsReference(ref: UnresolvedRef): boolean {
    return ref.language === 'yaml' && ref.referenceName.startsWith('helm:');
  },

  extract(filePath: string, content: string): FrameworkExtractionResult {
    if (!isYamlFile(filePath)) return { nodes: [], references: [] };
    const now = Date.now();

    if (isHelmChartFile(filePath)) {
      return extractHelmChartYaml(filePath, content, now);
    }
    if (isHelmValuesFile(filePath)) {
      return extractHelmValuesYaml(filePath, content, now);
    }

    const chartDir = helmChartDirForTemplate(filePath);
    if (chartDir !== null && content.includes('{{')) {
      // Reuse kubernetesResolver's extracted resource node spans to anchor template refs.
      const k8sResult = kubernetesResolver.extract!(filePath, content);
      if (k8sResult.nodes.length > 0) {
        const refs = extractHelmTemplateRefs(filePath, content, chartDir, k8sResult.nodes);
        // Do NOT re-emit k8sResult.nodes (kubernetesResolver owns them) — only emit the
        // Helm-specific references anchored on those node IDs!
        return { nodes: [], references: refs };
      }
    }

    return { nodes: [], references: [] };
  },

  /**
   * Discover `templates/_helpers.tpl` (and any `templates/*.tpl`) inside Helm
   * charts without adding `.tpl` globally to `EXTENSION_MAP`.
   */
  crossFileNodes(context: ResolutionContext): CrossFileNodes {
    helmIndexCache.delete(context);
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();

    const chartDirs = new Set(
      context.getAllFiles().filter(isHelmChartFile).map((f) => dirOf(f))
    );

    const root = context.getProjectRoot();
    for (const chartDir of chartDirs) {
      const tplRelDir = chartDir === '.' ? 'templates' : `${chartDir}/templates`;
      const tplPaths = new Set<string>([`${tplRelDir}/_helpers.tpl`]);
      try {
        const absTplDir = path.join(root, tplRelDir);
        if (fs.existsSync(absTplDir)) {
          for (const entry of fs.readdirSync(absTplDir)) {
            if (entry.endsWith('.tpl')) {
              tplPaths.add(`${tplRelDir}/${entry}`);
            }
          }
        }
      } catch {
        // Fallback to `_helpers.tpl` only
      }

      for (const tplPath of [...tplPaths].sort()) {
        const content = context.readFile(tplPath);
        if (!content) continue;
        const extracted = extractHelmTplHelpers(tplPath, chartDir, content, now);
        nodes.push(...extracted.nodes);
        references.push(...extracted.references);
      }
    }

    return {
      kind: 'function',
      owns: (n) => n.id.startsWith('helm:tpl:'),
      nodes,
      references,
    };
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.language !== 'yaml' || !ref.referenceName.startsWith('helm:')) return null;
    const index = getHelmIndex(context);
    const name = ref.referenceName;

    // 1. Local subchart dependency: `helm:chart:<subDir>`
    if (name.startsWith('helm:chart:')) {
      const subDir = name.slice('helm:chart:'.length);
      const target = index.chartsByDir.get(subDir);
      if (!target || target.id === ref.fromNodeId) return null;
      return { original: ref, targetNodeId: target.id, confidence: 0.95, resolvedBy: 'framework' };
    }

    // 2. `.Values.<path>` reference: `helm:val:<chartDir>:<dottedKey>`
    if (name.startsWith('helm:val:')) {
      const rest = name.slice('helm:val:'.length);
      const colon = rest.lastIndexOf(':');
      if (colon < 0) return null;
      const chartDir = rest.slice(0, colon);
      let keyPath = rest.slice(colon + 1);

      // Exact match first, then walk up parent key prefixes (e.g. `.Values.image.tag` → `values:image` if only parent exists)
      while (keyPath) {
        const target = index.valuesByChartKey.get(`${chartDir}\0${keyPath}`);
        if (target && target.id !== ref.fromNodeId) {
          return { original: ref, targetNodeId: target.id, confidence: 0.9, resolvedBy: 'framework' };
        }
        const dot = keyPath.lastIndexOf('.');
        if (dot < 0) break;
        keyPath = keyPath.slice(0, dot);
      }
      return null;
    }

    // 3. `include` / `template` helper reference: `helm:tpl:<chartDir>:<helperName>`
    if (name.startsWith('helm:tpl:')) {
      const rest = name.slice('helm:tpl:'.length);
      const colon = rest.lastIndexOf(':');
      if (colon < 0) return null;
      const chartDir = rest.slice(0, colon);
      const helperName = rest.slice(colon + 1);
      const target = index.helpersByChartName.get(`${chartDir}\0${helperName}`);
      if (!target || target.id === ref.fromNodeId) return null;
      return { original: ref, targetNodeId: target.id, confidence: 0.95, resolvedBy: 'framework' };
    }

    return null;
  },
};
