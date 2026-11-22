/**
 * Docker Compose semantic YAML extraction & resolution tests.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodeGraph } from '../src';
import { resolveNamedSymbolFlow } from '../src/graph/named-symbol-flow';
import { dockerComposeResolver } from '../src/resolution/frameworks/docker-compose';

describe('dockerComposeResolver (end-to-end graph)', () => {
  const tmpDirs: string[] = [];

  function makeRepo(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-compose-'));
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

  it('links Compose services, depends_on, extends, include, networks, named volumes, secrets, configs, and anchors', async () => {
    const root = makeRepo({
      'compose.yaml': `name: demo
include:
  - compose.db.yaml
x-common: &common
  networks: [backend]
services:
  gateway:
    <<: *common
    image: nginx:1.27
    ports: ["8080:80"]
    depends_on:
      api:
        condition: service_healthy
    configs:
      - source: nginx_conf
  api:
    <<: *common
    extends:
      file: compose.base.yaml
      service: node-base
    depends_on: [postgres]
    secrets: [db_password]
    volumes:
      - ./src:/app/src
      - uploads:/app/uploads
networks:
  backend:
    driver: bridge
volumes:
  uploads: {}
secrets:
  db_password:
    external: true
configs:
  nginx_conf:
    file: ./config/nginx.conf
`,
      'compose.base.yaml': `services:
  node-base:
    image: node:22
`,
      'compose.db.yaml': `services:
  postgres:
    image: postgres:16
    volumes:
      - type: volume
        source: pgdata
        target: /var/lib/postgresql/data
volumes:
  pgdata: {}
`,
      // Unrelated YAML must produce 0 nodes
      'config/app.yaml': `services:\n  not_compose: true\n`,
    });

    const cg = await CodeGraph.init(root, { index: true });
    try {
      const byName = (name: string) => cg.getNodesByName(name)[0];
      const targetsOf = (fromName: string): string[] => {
        const from = byName(fromName);
        expect(from, `missing node ${fromName}`).toBeDefined();
        return cg.getOutgoingEdges(from!.id).map((e) => cg.getNode(e.target)?.name ?? e.target);
      };

      expect(cg.getNodesInFile('config/app.yaml')).toEqual([]);

      // Root compose → included compose + services
      const rootTargets = targetsOf('Compose/compose.yaml');
      expect(rootTargets).toContain('Compose/compose.db.yaml');
      expect(rootTargets).toContain('ComposeService/gateway');
      expect(rootTargets).toContain('ComposeService/api');

      // gateway → api (depends_on), backend (via anchor <<), nginx_conf
      const gwTargets = targetsOf('ComposeService/gateway');
      expect(gwTargets).toContain('ComposeService/api');
      expect(gwTargets).toContain('ComposeNetwork/backend');
      expect(gwTargets).toContain('ComposeConfig/nginx_conf');

      // api → node-base (cross-file extends), postgres (cross-file depends_on), backend, uploads, db_password
      const apiTargets = targetsOf('ComposeService/api');
      expect(apiTargets).toContain('ComposeService/node-base');
      expect(apiTargets).toContain('ComposeService/postgres');
      expect(apiTargets).toContain('ComposeNetwork/backend');
      expect(apiTargets).toContain('ComposeVolume/uploads');
      expect(apiTargets).toContain('ComposeSecret/db_password');

      // postgres → pgdata (long-form volume)
      expect(targetsOf('ComposeService/postgres')).toContain('ComposeVolume/pgdata');

      // Directed Flow traces gateway → api → postgres
      const flow = resolveNamedSymbolFlow(cg, '', {
        mode: 'directed',
        from: 'ComposeService/gateway',
        to: 'ComposeService/postgres',
      });
      expect(flow.chains.length).toBeGreaterThan(0);
      expect(flow.chains[0]!.steps.map((s) => s.node.name)).toEqual([
        'ComposeService/gateway',
        'ComposeService/api',
        'ComposeService/postgres',
      ]);
    } finally {
      cg.destroy();
    }
  });

  it('converges on incremental sync when an extended Compose file is added later', async () => {
    const root = makeRepo({
      'docker-compose.yml': `services:
  web:
    extends:
      file: docker-compose.base.yml
      service: base-web
`,
    });

    const cg = await CodeGraph.init(root, { index: true });
    try {
      const webBefore = cg.getNodesByName('ComposeService/web')[0]!;
      expect(cg.getOutgoingEdges(webBefore.id)).toEqual([]);

      fs.writeFileSync(
        path.join(root, 'docker-compose.base.yml'),
        `services:
  base-web:
    image: nginx
`,
        'utf8'
      );

      await cg.sync();

      const webAfter = cg.getNodesByName('ComposeService/web')[0]!;
      const targets = cg.getOutgoingEdges(webAfter.id).map((e) => cg.getNode(e.target)?.name);
      expect(targets).toContain('ComposeService/base-web');
    } finally {
      cg.destroy();
    }
  });

  it('ignores non-Compose YAML files', () => {
    expect(dockerComposeResolver.extract!('values.yaml', 'services:\n  web:\n    image: nginx\n').nodes).toEqual([]);
  });
});
