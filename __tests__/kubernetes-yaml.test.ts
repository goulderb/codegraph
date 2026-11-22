/**
 * Kubernetes, Kustomize, and Helm semantic YAML extraction & resolution tests.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodeGraph } from '../src';
import { resolveNamedSymbolFlow } from '../src/graph/named-symbol-flow';
import { kubernetesResolver, helmResolver } from '../src/resolution/frameworks/kubernetes';

describe('kubernetesResolver & helmResolver (end-to-end graph)', () => {
  const tmpDirs: string[] = [];

  function makeRepo(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-k8s-'));
    tmpDirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, 'utf8');
    }
    return dir;
  }

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('connects Ingress → Service → Deployment → ConfigMap/Secret/SA/PVC + cluster DNS + RBAC + NetworkPolicy + Kustomize', async () => {
    const root = makeRepo({
      'deploy/app/kustomization.yaml': `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: shop
resources: [namespace.yaml, api.yaml, ingress.yaml, netpol.yaml, pdb.yaml, hpa.yaml, rbac.yaml]
configMapGenerator:
  - name: app-settings
    literals:
      - db.url=postgres://shop@postgres.db.svc.cluster.local:5432/shop
patches:
  - target: {kind: Deployment, name: shop-api}
    patch: |-
      - op: replace
        path: /spec/replicas
        value: 3
`,
      'deploy/app/namespace.yaml': `apiVersion: v1
kind: Namespace
metadata:
  name: shop
`,
      'deploy/app/api.yaml': `apiVersion: v1
kind: ServiceAccount
metadata:
  name: shop-api
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: shop-data
---
apiVersion: v1
kind: Secret
metadata:
  name: shop-creds
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: shop-api
spec:
  selector:
    matchLabels: {app.kubernetes.io/name: shop-api}
  template:
    metadata:
      labels: {app.kubernetes.io/name: shop-api, tier: backend}
    spec:
      serviceAccountName: shop-api
      containers:
        - name: api
          image: example/shop-api:1.0
          args:
            - --metrics-url
            - http://metrics.obs.svc.cluster.local:9090
          envFrom:
            - configMapRef: {name: app-settings}
          env:
            - name: DB_PASS
              valueFrom:
                secretKeyRef: {name: shop-creds, key: password}
      volumes:
        - name: data
          persistentVolumeClaim: {claimName: shop-data}
---
apiVersion: v1
kind: Service
metadata:
  name: shop-api
spec:
  selector: {app.kubernetes.io/name: shop-api}
  ports: [{protocol: TCP, port: 8080}]
`,
      'deploy/app/ingress.yaml': `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: shop-web
spec:
  tls:
    - secretName: shop-creds
  rules:
    - http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: shop-api
                port: {number: 8080}
`,
      'deploy/app/pdb.yaml': `apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: shop-api
spec:
  minAvailable: 1
  selector: {matchLabels: {app.kubernetes.io/name: shop-api}}
`,
      'deploy/app/hpa.yaml': `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: shop-api
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: shop-api
  minReplicas: 2
  maxReplicas: 6
`,
      'deploy/app/netpol.yaml': `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: shop-api-netpol
spec:
  podSelector: {matchLabels: {app.kubernetes.io/name: shop-api}}
  egress:
    - to:
        - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: db}}
          podSelector: {matchLabels: {app.kubernetes.io/name: postgres}}
`,
      'deploy/app/rbac.yaml': `apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: deployer
rules:
  - apiGroups: [apps]
    resources: [deployments]
    resourceNames: [shop-api]
    verbs: [get, patch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: deployer
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: deployer
subjects:
  - {kind: ServiceAccount, name: shop-api, namespace: shop}
`,
      'deploy/db/postgres.yaml': `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: db
spec:
  template:
    metadata:
      labels: {app.kubernetes.io/name: postgres}
    spec:
      containers:
        - name: pg
          image: postgres:16
---
apiVersion: v1
kind: Service
metadata:
  name: postgres
  namespace: db
spec:
  selector: {app.kubernetes.io/name: postgres}
`,
      'deploy/obs/metrics.yaml': `apiVersion: v1
kind: Service
metadata:
  name: metrics
  namespace: obs
spec:
  ports: [{port: 9090}]
`,
      // Non-K8s YAML in the same repo must produce zero K8s nodes
      'deploy/obs/alerts.rules.yml': `groups:
  - name: alerts
    rules:
      - alert: HighLatency
        expr: latency > 1
`,
    });

    const cg = await CodeGraph.init(root, { index: true });
    try {
      const byName = (name: string) => cg.getNodesByName(name)[0];
      const targetsOf = (fromName: string): string[] => {
        const from = byName(fromName);
        expect(from, `missing node ${fromName}`).toBeDefined();
        return cg.getOutgoingEdges(from!.id).map((e) => cg.getNode(e.target)?.name ?? e.target);
      };

      // Non-K8s YAML produced no nodes
      expect(cg.getNodesInFile('deploy/obs/alerts.rules.yml')).toEqual([]);

      // Kustomize propagated namespace `shop` into manifests lacking metadata.namespace
      expect(byName('Deployment/shop-api')?.qualifiedName).toBe('k8s:shop/Deployment/shop-api');
      expect(byName('Service/shop-api')?.qualifiedName).toBe('k8s:shop/Service/shop-api');

      // Kustomization links to resources, generated ConfigMap, and patched Deployment
      const kustTargets = targetsOf('Kustomization/deploy/app');
      expect(kustTargets).toContain('Namespace/shop');
      expect(kustTargets).toContain('Ingress/shop-web');
      expect(kustTargets).toContain('Deployment/shop-api');
      expect(kustTargets).toContain('ConfigMap/app-settings');

      // Generated ConfigMap literal cluster DNS links to db Service/postgres
      expect(targetsOf('ConfigMap/app-settings')).toContain('Service/postgres');

      // Ingress → Service + TLS Secret
      const ingTargets = targetsOf('Ingress/shop-web');
      expect(ingTargets).toContain('Service/shop-api');
      expect(ingTargets).toContain('Secret/shop-creds');

      // Service → Deployment via label selector
      expect(targetsOf('Service/shop-api')).toContain('Deployment/shop-api');

      // Deployment → ServiceAccount, ConfigMap (generated), Secret, PVC, and cluster DNS Service/metrics
      const depTargets = targetsOf('Deployment/shop-api');
      expect(depTargets).toContain('ServiceAccount/shop-api');
      expect(depTargets).toContain('ConfigMap/app-settings');
      expect(depTargets).toContain('Secret/shop-creds');
      expect(depTargets).toContain('PersistentVolumeClaim/shop-data');
      expect(depTargets).toContain('Service/metrics');

      // PDB & HPA → Deployment
      expect(targetsOf('PodDisruptionBudget/shop-api')).toContain('Deployment/shop-api');
      expect(targetsOf('HorizontalPodAutoscaler/shop-api')).toContain('Deployment/shop-api');

      // NetworkPolicy → own Deployment + cross-namespace egress peer StatefulSet/postgres
      const npTargets = targetsOf('NetworkPolicy/shop-api-netpol');
      expect(npTargets).toContain('Deployment/shop-api');
      expect(npTargets).toContain('StatefulSet/postgres');

      // RBAC: RoleBinding → Role + ServiceAccount; Role → explicitly named Deployment
      const rbTargets = targetsOf('RoleBinding/deployer');
      expect(rbTargets).toContain('Role/deployer');
      expect(rbTargets).toContain('ServiceAccount/shop-api');
      expect(targetsOf('Role/deployer')).toContain('Deployment/shop-api');

      // End-to-end directed Flow connects Ingress → Service → Deployment → downstream Service
      const flow = resolveNamedSymbolFlow(cg, '', {
        mode: 'directed',
        from: 'Ingress/shop-web',
        to: 'Service/metrics',
      });
      expect(flow.chains.length).toBeGreaterThan(0);
      expect(flow.chains[0]!.steps.map((s) => s.node.name)).toEqual([
        'Ingress/shop-web',
        'Service/shop-api',
        'Deployment/shop-api',
        'Service/metrics',
      ]);
    } finally {
      cg.destroy();
    }
  });

  it('respects Kustomize namePrefix and namespace isolation across duplicate resource names', async () => {
    const root = makeRepo({
      'envs/alpha/kustomization.yaml': `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: alpha
namePrefix: alpha-
resources: [job.yaml]
configMapGenerator:
  - name: cfg
`,
      'envs/alpha/job.yaml': `apiVersion: batch/v1
kind: Job
metadata:
  name: runner
spec:
  template:
    spec:
      containers:
        - name: run
          envFrom:
            - configMapRef: {name: cfg}
`,
      'envs/beta/kustomization.yaml': `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: beta
namePrefix: beta-
resources: [job.yaml]
configMapGenerator:
  - name: cfg
`,
      'envs/beta/job.yaml': `apiVersion: batch/v1
kind: Job
metadata:
  name: runner
spec:
  template:
    spec:
      containers:
        - name: run
          envFrom:
            - configMapRef: {name: cfg}
`,
    });

    const cg = await CodeGraph.init(root, { index: true });
    try {
      const alphaJob = cg.getNodesInFile('envs/alpha/job.yaml').find((n) => n.name === 'Job/runner')!;
      const betaJob = cg.getNodesInFile('envs/beta/job.yaml').find((n) => n.name === 'Job/runner')!;
      expect(alphaJob).toBeDefined();
      expect(betaJob).toBeDefined();

      const alphaTargets = cg.getOutgoingEdges(alphaJob.id).map((e) => cg.getNode(e.target)?.name);
      const betaTargets = cg.getOutgoingEdges(betaJob.id).map((e) => cg.getNode(e.target)?.name);

      expect(alphaTargets).toEqual(['ConfigMap/alpha-cfg']);
      expect(betaTargets).toEqual(['ConfigMap/beta-cfg']);
    } finally {
      cg.destroy();
    }
  });

  it('indexes Helm charts: Chart.yaml local deps, values.yaml keys, template .Values + _helpers.tpl defines', async () => {
    const root = makeRepo({
      'charts/webapp/Chart.yaml': `apiVersion: v2
name: webapp
version: 1.2.0
dependencies:
  - name: common
    version: 0.1.0
    repository: file://../common
`,
      'charts/common/Chart.yaml': `apiVersion: v2
name: common
version: 0.1.0
`,
      'charts/webapp/values.yaml': `replicaCount: 2
image:
  repository: ghcr.io/example/webapp
  tag: v1.0.0
fullnameOverride: ""
`,
      'charts/webapp/templates/_helpers.tpl': `{{- define "webapp.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 }}
{{- else }}
{{- .Release.Name }}
{{- end }}
{{- end }}
`,
      'charts/webapp/templates/deployment.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "webapp.fullname" . }}
spec:
  replicas: {{ .Values.replicaCount }}
  template:
    spec:
      containers:
        - name: web
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
`,
    });

    const cg = await CodeGraph.init(root, { index: true });
    try {
      const byName = (name: string) => cg.getNodesByName(name)[0];
      const targetsOf = (fromName: string): string[] => {
        const from = byName(fromName);
        expect(from, `missing node ${fromName}`).toBeDefined();
        return cg.getOutgoingEdges(from!.id).map((e) => cg.getNode(e.target)?.name ?? e.target);
      };

      // Chart → local subchart dependency
      expect(targetsOf('Chart/webapp')).toContain('Chart/common');

      // Deployment template → _helpers.tpl define + values.yaml keys
      const depTargets = targetsOf('Deployment/deployment');
      expect(depTargets).toContain('template:webapp.fullname');
      expect(depTargets).toContain('values:replicaCount');
      expect(depTargets).toContain('values:image.repository');
      expect(depTargets).toContain('values:image.tag');

      // _helpers.tpl define → values.yaml key
      expect(targetsOf('template:webapp.fullname')).toContain('values:fullnameOverride');
    } finally {
      cg.destroy();
    }
  });

  it('supports Gateway API HTTPRoute → Gateway + Service and never leaks YAML refs to code symbols', async () => {
    const root = makeRepo({
      'src/api.ts': `export function api() { return 'ok'; }\n`,
      'k8s/gateway.yaml': `apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: edge
  namespace: prod
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-route
  namespace: prod
spec:
  parentRefs:
    - name: edge
  rules:
    - backendRefs:
        - name: api
          port: 80
        - name: external-unindexed
          port: 80
---
apiVersion: v1
kind: Service
metadata:
  name: api
  namespace: prod
spec:
  ports: [{port: 80}]
`,
    });

    const cg = await CodeGraph.init(root, { index: true });
    try {
      const route = cg.getNodesByName('HTTPRoute/api-route')[0]!;
      expect(route.kind).toBe('route');
      const targets = cg.getOutgoingEdges(route.id).map((e) => cg.getNode(e.target));
      expect(targets.map((t) => t?.name)).toEqual(expect.arrayContaining(['Gateway/edge', 'Service/api']));
      // Must NOT bind to `src/api.ts` function `api` or resolve `external-unindexed`
      expect(targets.some((t) => t?.filePath === 'src/api.ts')).toBe(false);
    } finally {
      cg.destroy();
    }
  });

  it('produces zero nodes for non-Kubernetes YAML and does not false-detect', () => {
    expect(kubernetesResolver.extract!('config.yaml', 'foo: bar\nbaz: [1, 2]\n').nodes).toEqual([]);
    expect(helmResolver.extract!('config.yaml', 'foo: bar\n').nodes).toEqual([]);
  });

  it('converges on incremental sync when a referenced Service is added later', async () => {
    const root = makeRepo({
      'k8s/ingress.yaml': `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web
  namespace: prod
spec:
  rules:
    - http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web-svc
                port: {number: 80}
`,
    });

    const cg = await CodeGraph.init(root, { index: true });
    try {
      const ingBefore = cg.getNodesByName('Ingress/web')[0]!;
      expect(cg.getOutgoingEdges(ingBefore.id)).toEqual([]);

      // Add the target Service and Deployment, then sync
      fs.writeFileSync(
        path.join(root, 'k8s/service.yaml'),
        `apiVersion: v1
kind: Service
metadata:
  name: web-svc
  namespace: prod
spec:
  selector: {app: web}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: prod
spec:
  template:
    metadata:
      labels: {app: web}
    spec:
      containers:
        - name: web
          image: nginx
`,
        'utf8'
      );

      await cg.sync();

      const ingAfter = cg.getNodesByName('Ingress/web')[0]!;
      const targets = cg.getOutgoingEdges(ingAfter.id).map((e) => cg.getNode(e.target)?.name);
      expect(targets).toContain('Service/web-svc');

      const svc = cg.getNodesByName('Service/web-svc')[0]!;
      const svcTargets = cg.getOutgoingEdges(svc.id).map((e) => cg.getNode(e.target)?.name);
      expect(svcTargets).toContain('Deployment/web');
    } finally {
      cg.destroy();
    }
  });
});
