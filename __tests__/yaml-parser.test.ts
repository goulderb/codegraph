/**
 * Unit tests for the shared zero-dependency, line-aware YAML parser.
 */

import { describe, expect, it } from 'vitest';
import {
  parseYamlDocuments,
  yamlGetPathMap,
  yamlGetPathString,
  yamlGetSeq,
  yamlStringList,
  yamlStringMap,
} from '../src/resolution/frameworks/yaml-parser';

describe('yaml-parser', () => {
  it('parses multi-document streams with exact line spans, flow syntax, and block scalars', () => {
    const src = `apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  selector: {app.kubernetes.io/name: web, tier: frontend}
  ports: [{protocol: TCP, port: 80}]
---
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources: [namespace.yaml, deploy.yaml]
patches:
  - target: {kind: Deployment, name: web}
    patch: |-
      - op: replace
        path: /spec/replicas
        value: 3
`;
    const docs = parseYamlDocuments(src);
    expect(docs).toHaveLength(2);

    const svc = docs[0]!;
    expect(svc.startLine).toBe(1);
    expect(svc.endLine).toBe(7);
    expect(yamlGetPathString(svc.root, 'metadata', 'name')).toBe('web');
    expect(yamlStringMap(yamlGetPathMap(svc.root, 'spec', 'selector'))).toEqual({
      'app.kubernetes.io/name': 'web',
      tier: 'frontend',
    });

    const kust = docs[1]!;
    expect(kust.startLine).toBe(9);
    expect(yamlStringList(yamlGetSeq(kust.root, 'resources'))).toEqual(['namespace.yaml', 'deploy.yaml']);
    const patches = yamlGetSeq(kust.root, 'patches');
    expect(patches?.items).toHaveLength(1);
    expect(yamlGetPathString(patches!.items[0], 'target', 'kind')).toBe('Deployment');
    expect(yamlGetPathString(patches!.items[0], 'target', 'name')).toBe('web');
    expect(yamlGetPathString(patches!.items[0], 'patch')).toContain('/spec/replicas');
  });

  it('tolerates Helm Go-template control lines without breaking document structure', () => {
    const src = `{{- if .Values.enabled }}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "demo.fullname" . }}
  labels:
    {{- include "demo.labels" . | nindent 4 }}
    app.kubernetes.io/component: api
spec:
  replicas: {{ .Values.replicaCount }}
  template:
    metadata:
      labels:
        app: demo
    spec:
      serviceAccountName: {{ .Values.serviceAccount.name }}
{{- end }}
`;
    const docs = parseYamlDocuments(src);
    expect(docs).toHaveLength(1);
    expect(yamlGetPathString(docs[0]!.root, 'kind')).toBe('Deployment');
    expect(yamlGetPathString(docs[0]!.root, 'metadata', 'name')).toBe('{{ include "demo.fullname" . }}');
    expect(yamlStringMap(yamlGetPathMap(docs[0]!.root, 'spec', 'template', 'metadata', 'labels'))).toEqual({
      app: 'demo',
    });
  });

  it('handles compact block sequences at the same indent as their mapping key', () => {
    const src = `resources:
- a.yaml
- b.yaml
`;
    const docs = parseYamlDocuments(src);
    expect(yamlStringList(yamlGetSeq(docs[0]!.root, 'resources'))).toEqual(['a.yaml', 'b.yaml']);
  });

  it('resolves YAML anchors, aliases, and merge keys (<<:)', () => {
    const src = `x-base: &base
  restart: always
  networks: [backend]
x-env: &env
  env_file: [.env]
services:
  api:
    <<: [*base, *env]
    image: example/api
    restart: unless-stopped
`;
    const docs = parseYamlDocuments(src);
    const api = yamlGetPathMap(docs[0]!.root, 'services', 'api');
    expect(yamlGetPathString(api, 'image')).toBe('example/api');
    // Explicit key overrides merged key
    expect(yamlGetPathString(api, 'restart')).toBe('unless-stopped');
    expect(yamlStringList(yamlGetSeq(api, 'networks'))).toEqual(['backend']);
    expect(yamlStringList(yamlGetSeq(api, 'env_file'))).toEqual(['.env']);
  });
});
