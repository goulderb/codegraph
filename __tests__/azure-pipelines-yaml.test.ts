/**
 * Azure DevOps Pipelines semantic YAML extraction & resolution tests.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodeGraph } from '../src';
import { azurePipelinesResolver } from '../src/resolution/frameworks/azure-pipelines';

describe('azurePipelinesResolver (end-to-end graph)', () => {
  const tmpDirs: string[] = [];

  function makeRepo(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-azdo-'));
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

  it('links Azure Pipelines stages, jobs, deployment jobs, dependsOn, template includes, ${{ if }} wrappers, and scripts', async () => {
    const root = makeRepo({
      'azure-pipelines.yml': `trigger:
  branches:
    include: [main]
pool:
  vmImage: ubuntu-latest
variables:
  - template: templates/vars.yml
stages:
  - stage: Build
    jobs:
      - job: Compile
        steps:
          - template: templates/setup-steps.yml
          - script: node scripts/build.mjs
      - job: Lint
        dependsOn: Compile
        steps:
          - task: PythonScript@0
            inputs:
              scriptPath: scripts/lint.py
  - stage: Deploy
    dependsOn: [Build]
    jobs:
      - deployment: ProdDeploy
        environment: production
        strategy:
          runOnce:
            deploy:
              steps:
                - \${{ if eq(variables['Build.SourceBranch'], 'refs/heads/main') }}:
                    - template: /templates/release-steps.yml@self
                - template: shared/external.yml@otherRepo
`,
      'templates/vars.yml': `parameters:
  - name: env
    default: prod
variables:
  APP_ENV: \${{ parameters.env }}
`,
      'templates/setup-steps.yml': `parameters:
  - name: nodeVersion
    default: '22'
steps:
  - bash: python scripts/prepare.py
`,
      'templates/release-steps.yml': `steps:
  - task: Bash@3
    inputs:
      targetType: inline
      script: |
        python scripts/deploy.py --prod
`,
      'scripts/build.mjs': `export const build = true;\n`,
      'scripts/lint.py': `def lint(): pass\n`,
      'scripts/prepare.py': `def prepare(): pass\n`,
      'scripts/deploy.py': `def deploy(): pass\n`,
      // Unrelated YAML must produce 0 nodes
      'config/unrelated.yaml': `foo: bar\n`,
    });

    const cg = await CodeGraph.init(root, { index: true });
    try {
      const byName = (name: string) => cg.getNodesByName(name)[0];
      const targetsOf = (fromName: string): string[] => {
        const from = byName(fromName);
        expect(from, `missing node ${fromName}`).toBeDefined();
        return cg.getOutgoingEdges(from!.id).map((e) => cg.getNode(e.target)?.name ?? e.target);
      };

      expect(cg.getNodesInFile('config/unrelated.yaml')).toEqual([]);

      // Root pipeline → variable template + stages
      const pipeTargets = targetsOf('AzurePipeline/azure-pipelines');
      expect(pipeTargets).toContain('AzurePipeline/templates/vars');
      expect(pipeTargets).toContain('AzureStage/azure-pipelines/Build');
      expect(pipeTargets).toContain('AzureStage/azure-pipelines/Deploy');

      // Build stage → Compile + Lint jobs
      const buildTargets = targetsOf('AzureStage/azure-pipelines/Build');
      expect(buildTargets).toContain('AzureJob/azure-pipelines/Compile');
      expect(buildTargets).toContain('AzureJob/azure-pipelines/Lint');

      // Compile job → setup-steps template + build.mjs
      const compileTargets = targetsOf('AzureJob/azure-pipelines/Compile');
      expect(compileTargets).toContain('AzurePipeline/templates/setup-steps');
      expect(compileTargets).toContain('build.mjs');

      // Step template → prepare.py
      expect(targetsOf('AzurePipeline/templates/setup-steps')).toContain('prepare.py');

      // Lint job → dependsOn Compile + PythonScript@0 lint.py
      const lintTargets = targetsOf('AzureJob/azure-pipelines/Lint');
      expect(lintTargets).toContain('AzureJob/azure-pipelines/Compile');
      expect(lintTargets).toContain('lint.py');

      // Deploy stage → dependsOn Build + ProdDeploy deployment job
      const deployStageTargets = targetsOf('AzureStage/azure-pipelines/Deploy');
      expect(deployStageTargets).toContain('AzureStage/azure-pipelines/Build');
      expect(deployStageTargets).toContain('AzureJob/azure-pipelines/ProdDeploy');

      // Deployment job → unwrapped `${{ if }}` `@self` release-steps template (and NOT external `@otherRepo`)
      const prodTargets = targetsOf('AzureJob/azure-pipelines/ProdDeploy');
      expect(prodTargets).toContain('AzurePipeline/templates/release-steps');
      expect(targetsOf('AzurePipeline/templates/release-steps')).toContain('deploy.py');
    } finally {
      cg.destroy();
    }
  });

  it('supports extends.template and converges on incremental sync when the template arrives later', async () => {
    const root = makeRepo({
      'pipelines/release.yml': `trigger: [main]
extends:
  template: ../templates/base-pipeline.yml
`,
    });

    const cg = await CodeGraph.init(root, { index: true });
    try {
      const pipeBefore = cg.getNodesByName('AzurePipeline/pipelines/release')[0]!;
      expect(cg.getOutgoingEdges(pipeBefore.id)).toEqual([]);

      fs.mkdirSync(path.join(root, 'templates'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'templates/base-pipeline.yml'),
        `parameters:
  - name: env
    default: staging
stages:
  - stage: Release
    jobs:
      - job: Publish
        steps:
          - script: echo publish
`,
        'utf8'
      );

      await cg.sync();

      const pipeAfter = cg.getNodesByName('AzurePipeline/pipelines/release')[0]!;
      const targets = cg.getOutgoingEdges(pipeAfter.id).map((e) => cg.getNode(e.target)?.name);
      expect(targets).toContain('AzurePipeline/templates/base-pipeline');
    } finally {
      cg.destroy();
    }
  });

  it('ignores non-Azure YAML files (K8s, GitHub Actions, Compose, OpenAPI)', () => {
    expect(azurePipelinesResolver.extract!('.github/workflows/ci.yml', 'on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n').nodes).toEqual([]);
    expect(azurePipelinesResolver.extract!('deploy.yaml', 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\n').nodes).toEqual([]);
    expect(azurePipelinesResolver.extract!('config.yaml', 'hello: world\n').nodes).toEqual([]);
  });
});
