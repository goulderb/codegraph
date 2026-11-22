/**
 * OpenAPI 3.x & Swagger 2.0 semantic YAML extraction & resolution tests.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodeGraph } from '../src';
import { openApiResolver } from '../src/resolution/frameworks/openapi';

describe('openApiResolver (end-to-end graph)', () => {
  const tmpDirs: string[] = [];

  function makeRepo(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-openapi-'));
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

  it('extracts endpoints, local + cross-file $refs, and bridges OpenAPI routes to Express routes & operationId handlers', async () => {
    const root = makeRepo({
      'package.json': JSON.stringify({ dependencies: { express: '^4.18.0' } }),
      'api/openapi.yaml': `openapi: 3.1.0
info:
  title: Shop API
  version: 1.0.0
paths:
  /users/{id}:
    get:
      operationId: getUser
      summary: Fetch one user
      parameters:
        - $ref: '#/components/parameters/UserId'
      responses:
        '200':
          $ref: '#/components/responses/UserResponse'
  /orders:
    post:
      operationId: createOrderHandler
      requestBody:
        $ref: '#/components/requestBodies/CreateOrder'
      responses:
        '201':
          description: Created
          content:
            application/json:
              schema:
                $ref: './schemas/order.yaml'
components:
  parameters:
    UserId:
      name: id
      in: path
      required: true
      schema:
        type: string
  responses:
    UserResponse:
      description: OK
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/User'
  requestBodies:
    CreateOrder:
      content:
        application/json:
          schema:
            $ref: './schemas/models.yaml#/OrderInput'
  schemas:
    User:
      type: object
      properties:
        id: { type: string }
        address:
          $ref: './schemas/models.yaml#/Address'
`,
      'api/schemas/order.yaml': `type: object
properties:
  id: { type: string }
  buyer:
    $ref: '../openapi.yaml#/components/schemas/User'
`,
      'api/schemas/models.yaml': `OrderInput:
  type: object
  properties:
    shipping:
      $ref: '#/Address'
Address:
  type: object
  properties:
    city: { type: string }
`,
      'src/server.ts': `import express from 'express';
const app = express();
export function fetchUser(req: any, res: any) { return res.json({}); }
export function createOrderHandler(req: any, res: any) { return res.json({}); }
app.get('/users/:id', fetchUser);
`,
      // Unrelated YAML must produce 0 nodes
      'config/plain.yaml': `greeting: hello\n`,
    });

    const cg = await CodeGraph.init(root, { index: true });
    try {
      const targetsOf = (node: { id: string }): Array<{ name: string; filePath: string }> =>
        cg.getOutgoingEdges(node.id).map((e) => {
          const t = cg.getNode(e.target)!;
          return { name: t.name, filePath: t.filePath };
        });

      expect(cg.getNodesInFile('config/plain.yaml')).toEqual([]);

      const spec = cg.getNodesByName('OpenAPI/openapi')[0]!;
      expect(spec).toBeDefined();
      expect(targetsOf(spec).map((t) => t.name)).toEqual(expect.arrayContaining(['GET /users/{id}', 'POST /orders']));

      // GET /users/{id} → local $refs (Parameter/UserId, Response/UserResponse) + Express route `GET /users/:id`
      const getUsers = cg.getNodesInFile('api/openapi.yaml').find((n) => n.name === 'GET /users/{id}')!;
      const getTargets = targetsOf(getUsers);
      expect(getTargets.map((t) => t.name)).toContain('Parameter/UserId');
      expect(getTargets.map((t) => t.name)).toContain('Response/UserResponse');
      expect(getTargets).toContainEqual({ name: 'GET /users/:id', filePath: 'src/server.ts' });

      // Response/UserResponse → Schema/User → cross-file Schema/Address
      const userResp = cg.getNodesByName('Response/UserResponse')[0]!;
      expect(targetsOf(userResp).map((t) => t.name)).toContain('Schema/User');
      const userSchema = cg.getNodesByName('Schema/User')[0]!;
      expect(targetsOf(userSchema)).toContainEqual({ name: 'Schema/Address', filePath: 'api/schemas/models.yaml' });

      // POST /orders → RequestBody/CreateOrder + whole-file Schema/order + operationId fallback `createOrderHandler`
      const postOrders = cg.getNodesInFile('api/openapi.yaml').find((n) => n.name === 'POST /orders')!;
      const postTargets = targetsOf(postOrders);
      expect(postTargets.map((t) => t.name)).toContain('RequestBody/CreateOrder');
      expect(postTargets).toContainEqual({ name: 'Schema/order', filePath: 'api/schemas/order.yaml' });
      expect(postTargets).toContainEqual({ name: 'createOrderHandler', filePath: 'src/server.ts' });

      // Cross-file circular/back-ref: Schema/order → Schema/User, and Schema/OrderInput → Schema/Address
      const orderSchema = cg.getNodesByName('Schema/order')[0]!;
      expect(targetsOf(orderSchema)).toContainEqual({ name: 'Schema/User', filePath: 'api/openapi.yaml' });
      const orderInput = cg.getNodesByName('Schema/OrderInput')[0]!;
      expect(targetsOf(orderInput)).toContainEqual({ name: 'Schema/Address', filePath: 'api/schemas/models.yaml' });
    } finally {
      cg.destroy();
    }
  });

  it('supports Swagger 2.0 basePath and definitions $ref + converges on incremental sync', async () => {
    const root = makeRepo({
      'swagger.yaml': `swagger: "2.0"
info:
  title: Legacy API
  version: "2.0"
basePath: /v2
paths:
  /items:
    get:
      responses:
        '200':
          schema:
            $ref: './models.yaml#/Item'
`,
    });

    const cg = await CodeGraph.init(root, { index: true });
    try {
      const opBefore = cg.getNodesInFile('swagger.yaml').find((n) => n.name === 'GET /v2/items')!;
      expect(opBefore).toBeDefined();
      expect(cg.getOutgoingEdges(opBefore.id)).toEqual([]);

      fs.writeFileSync(
        path.join(root, 'models.yaml'),
        `Item:
  type: object
  properties:
    sku: { type: string }
`,
        'utf8'
      );

      await cg.sync();

      const opAfter = cg.getNodesInFile('swagger.yaml').find((n) => n.name === 'GET /v2/items')!;
      const targets = cg.getOutgoingEdges(opAfter.id).map((e) => cg.getNode(e.target)?.name);
      expect(targets).toContain('Schema/Item');
    } finally {
      cg.destroy();
    }
  });

  it('ignores non-OpenAPI YAML files', () => {
    expect(openApiResolver.extract!('config.yaml', 'key: value\n').nodes).toEqual([]);
  });
});
