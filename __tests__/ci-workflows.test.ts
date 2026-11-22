/**
 * GitHub Actions, Forgejo/Gitea Actions, and GitLab CI semantic YAML tests.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodeGraph } from '../src';
import { actionsWorkflowResolver, gitlabCiResolver } from '../src/resolution/frameworks/ci-workflows';

describe('CI/CD semantic YAML resolvers', () => {
  const tmpDirs: string[] = [];

  function makeRepo(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ci-'));
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

  it('indexes GitHub & Forgejo workflows: jobs, needs, reusable workflows, composite actions, and local scripts', async () => {
    const root = makeRepo({
      '.forgejo/workflows/ci.yml': `name: ci
on:
  pull_request_target:
    branches: [main]
  push:
    branches: [main]
jobs:
  plan:
    runs-on: linux
    steps:
      - uses: ./.forgejo/actions/setup-env
      - run: |
          python -I "$work/harness/scripts/plan_runner.py" --plan-only
          python -I "$work/harness/scripts/pr_comment.py"
  test:
    needs: [plan]
    runs-on: linux
    steps:
      - run: node ./scripts/verify.mjs
  deploy:
    needs: test
    uses: ./.forgejo/workflows/deploy.yml
`,
      '.forgejo/workflows/deploy.yml': `name: deploy
on:
  workflow_call:
jobs:
  ship:
    runs-on: linux
    steps:
      - run: python scripts/ship.py
`,
      '.forgejo/actions/setup-env/action.yml': `name: Setup Env
runs:
  using: composite
  steps:
    - run: node scripts/bootstrap.mjs
      shell: bash
`,
      'scripts/plan_runner.py': `def main():\n    return 0\n`,
      'scripts/pr_comment.py': `def post():\n    return True\n`,
      'scripts/verify.mjs': `export function verify() { return true; }\n`,
      'scripts/ship.py': `def ship():\n    return True\n`,
      'scripts/bootstrap.mjs': `export function boot() { return true; }\n`,
      // Unrelated YAML must produce 0 nodes
      'config/settings.yaml': `feature: true\n`,
    });

    const cg = await CodeGraph.init(root, { index: true });
    try {
      const byName = (name: string) => cg.getNodesByName(name)[0];
      const targetsOf = (fromName: string): string[] => {
        const from = byName(fromName);
        expect(from, `missing node ${fromName}`).toBeDefined();
        return cg.getOutgoingEdges(from!.id).map((e) => cg.getNode(e.target)?.name ?? e.target);
      };

      expect(cg.getNodesInFile('config/settings.yaml')).toEqual([]);

      // Workflow → jobs
      const wfTargets = targetsOf('Workflow/ci');
      expect(wfTargets).toEqual(expect.arrayContaining(['Job/ci/plan', 'Job/ci/test', 'Job/ci/deploy']));

      // Job plan → local composite action + variable-prefixed Python scripts
      const planTargets = targetsOf('Job/ci/plan');
      expect(planTargets).toContain('Action/.forgejo/actions/setup-env');
      expect(planTargets).toContain('plan_runner.py');
      expect(planTargets).toContain('pr_comment.py');

      // Composite action → bootstrap script
      expect(targetsOf('Action/.forgejo/actions/setup-env')).toContain('bootstrap.mjs');

      // Job test → needs Job/ci/plan + direct script
      const testTargets = targetsOf('Job/ci/test');
      expect(testTargets).toContain('Job/ci/plan');
      expect(testTargets).toContain('verify.mjs');

      // Job deploy → needs Job/ci/test + reusable workflow Workflow/deploy
      const deployTargets = targetsOf('Job/ci/deploy');
      expect(deployTargets).toContain('Job/ci/test');
      expect(deployTargets).toContain('Workflow/deploy');

      // Reusable workflow → its ship job → ship.py
      expect(targetsOf('Workflow/deploy')).toContain('Job/deploy/ship');
      expect(targetsOf('Job/deploy/ship')).toContain('ship.py');
    } finally {
      cg.destroy();
    }
  });

  it('indexes GitLab CI pipelines: include local, extends templates, needs, trigger child pipeline, and scripts', async () => {
    const root = makeRepo({
      '.gitlab-ci.yml': `stages: [build, test, deploy]
include:
  - local: .gitlab/ci/base.yml

build_app:
  stage: build
  extends: .node_job
  script:
    - node scripts/build.mjs

test_app:
  stage: test
  extends: [.node_job]
  needs:
    - job: build_app
  script:
    - python scripts/run_tests.py

deploy_child:
  stage: deploy
  needs: [test_app]
  trigger:
    include:
      - local: .gitlab/ci/deploy.yml
`,
      '.gitlab/ci/base.yml': `.node_job:
  image: node:22
  before_script:
    - node scripts/setup.mjs
`,
      '.gitlab/ci/deploy.yml': `stages: [release]
release_prod:
  stage: release
  script:
    - python scripts/release.py
`,
      'scripts/build.mjs': `export const ok = 1;\n`,
      'scripts/run_tests.py': `def run(): pass\n`,
      'scripts/setup.mjs': `export const setup = 1;\n`,
      'scripts/release.py': `def release(): pass\n`,
    });

    const cg = await CodeGraph.init(root, { index: true });
    try {
      const byName = (name: string) => cg.getNodesByName(name)[0];
      const targetsOf = (fromName: string): string[] => {
        const from = byName(fromName);
        expect(from, `missing node ${fromName}`).toBeDefined();
        return cg.getOutgoingEdges(from!.id).map((e) => cg.getNode(e.target)?.name ?? e.target);
      };

      // Root pipeline → included base pipeline + jobs
      const pipeTargets = targetsOf('Pipeline/.gitlab-ci');
      expect(pipeTargets).toContain('Pipeline/base');
      expect(pipeTargets).toContain('Job/build_app');
      expect(pipeTargets).toContain('Job/test_app');

      // extends cross-file template + script
      const buildTargets = targetsOf('Job/build_app');
      expect(buildTargets).toContain('Job/.node_job');
      expect(buildTargets).toContain('build.mjs');

      // Hidden template → before_script
      expect(targetsOf('Job/.node_job')).toContain('setup.mjs');

      // needs + extends + script
      const testTargets = targetsOf('Job/test_app');
      expect(testTargets).toContain('Job/.node_job');
      expect(testTargets).toContain('Job/build_app');
      expect(testTargets).toContain('run_tests.py');

      // Child pipeline trigger
      const deployTargets = targetsOf('Job/deploy_child');
      expect(deployTargets).toContain('Job/test_app');
      expect(deployTargets).toContain('Pipeline/deploy');
      expect(targetsOf('Job/release_prod')).toContain('release.py');
    } finally {
      cg.destroy();
    }
  });

  it('converges on incremental sync when a referenced reusable workflow is added later', async () => {
    const root = makeRepo({
      '.github/workflows/ci.yml': `name: CI
on: push
jobs:
  call_reusable:
    uses: ./.github/workflows/reusable.yml
`,
    });

    const cg = await CodeGraph.init(root, { index: true });
    try {
      const jobBefore = cg.getNodesByName('Job/ci/call_reusable')[0]!;
      expect(cg.getOutgoingEdges(jobBefore.id)).toEqual([]);

      fs.writeFileSync(
        path.join(root, '.github/workflows/reusable.yml'),
        `name: Reusable
on: workflow_call
jobs:
  ping:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`,
        'utf8'
      );

      await cg.sync();

      const jobAfter = cg.getNodesByName('Job/ci/call_reusable')[0]!;
      const targets = cg.getOutgoingEdges(jobAfter.id).map((e) => cg.getNode(e.target)?.name);
      expect(targets).toContain('Workflow/reusable');
    } finally {
      cg.destroy();
    }
  });

  it('ignores non-CI YAML files', () => {
    expect(actionsWorkflowResolver.extract!('config.yml', 'foo: bar\n').nodes).toEqual([]);
    expect(gitlabCiResolver.extract!('k8s.yml', 'apiVersion: v1\nkind: Service\nmetadata:\n  name: web\n').nodes).toEqual([]);
  });
});
