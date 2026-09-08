/**
 * The registry is the executable contract; docs/skill-parity/endpoint-contracts.json
 * is its documentation. They must agree field by field (T-020, T-022).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CREATIVE_LAB_PRODUCTS,
  creativeLabResource,
  QUERY_RESOURCES,
  resourceIndex,
  TASK_RESOURCES,
  taskResourceByCommandPath,
} from "../src/client/resource-registry.js";

interface DocResource {
  id: string;
  commandPath: string[];
  base: string;
  relativePath: string;
  legacyEndpoint: string;
  supports: Record<string, boolean>;
  mediaFields: Array<{ path: string; kind: string; many: boolean; formats?: string[] }>;
  taskTypes: string[];
  billing: { create: string };
}

const docs = JSON.parse(readFileSync(new URL("../docs/skill-parity/endpoint-contracts.json", import.meta.url), "utf8")) as {
  task_resources: DocResource[];
  query_resources: Array<{ id: string; commandPath: string[]; base: string; relativePath: string; auth: string }>;
};

test("every documented task resource exists in the registry with the same routing and media fields", () => {
  assert.equal(TASK_RESOURCES.length, docs.task_resources.length, "resource count drifted");
  for (const d of docs.task_resources) {
    const r = TASK_RESOURCES.find((x) => x.id === d.id);
    assert.ok(r, `registry is missing ${d.id}`);
    assert.deepEqual([...r.commandPath], d.commandPath, `${d.id} commandPath`);
    assert.equal(r.base, d.base, `${d.id} base`);
    assert.equal(r.relativePath, d.relativePath, `${d.id} relativePath`);
    assert.equal(r.legacyEndpoint, d.legacyEndpoint, `${d.id} legacyEndpoint`);
    assert.deepEqual({ ...r.supports }, d.supports, `${d.id} supports`);
    assert.deepEqual(
      r.mediaFields.map((m) => ({ path: m.path, kind: m.kind, many: m.many, ...(m.formats ? { formats: [...m.formats] } : {}) })),
      d.mediaFields,
      `${d.id} mediaFields`,
    );
    assert.deepEqual([...r.taskTypes], d.taskTypes, `${d.id} taskTypes`);
    assert.equal(r.billing.create, d.billing.create, `${d.id} billing`);
    assert.equal(r.automaticRetry, false);
  }
});

test("query resources agree with the documentation and the catalog carries no credential", () => {
  for (const d of docs.query_resources) {
    const q = QUERY_RESOURCES.find((x) => x.id === d.id);
    assert.ok(q, `registry is missing query ${d.id}`);
    assert.deepEqual([...q.commandPath], d.commandPath);
    assert.equal(q.base, d.base);
    assert.equal(q.relativePath, d.relativePath);
    assert.equal(q.auth, d.auth);
  }
  assert.equal(QUERY_RESOURCES.find((q) => q.id === "animation-catalog")?.auth, "none");
  assert.equal(QUERY_RESOURCES.find((q) => q.id === "showcases")?.billing, "may-charge");
});

test("Creative Lab: 4 products × 2 stages, exact paths, no path built from user strings (T-022, T-023)", () => {
  for (const product of CREATIVE_LAB_PRODUCTS) {
    for (const stage of ["prototype", "build"] as const) {
      const r = creativeLabResource(product, stage);
      assert.ok(r, `${product}/${stage}`);
      assert.equal(r.relativePath, `/${product}/v1/${stage}`);
      assert.equal(r.legacyEndpoint, `/openapi/creative-lab/${product}/v1/${stage}`);
      assert.equal(r.creativeLab?.product, product);
      assert.equal(r.creativeLab?.stage, stage);
      assert.equal(r.mediaFields.length, stage === "prototype" ? 1 : 0);
    }
  }
  for (const [p, s] of [["../figure", "prototype"], ["figure", "../build"], ["https://evil.example/", "build"], ["figure prototype", "build"], ["Figure", "prototype"], ["", "prototype"], ["keycap", "build"]]) {
    assert.equal(creativeLabResource(p!, s!), undefined, `${p}/${s} must not resolve`);
  }
  assert.equal(taskResourceByCommandPath(["creative-lab", "lamp", "build"])?.id, "creative-lab.lamp.build");
  assert.equal(taskResourceByCommandPath(["creative-lab", "lamp"]), undefined);
});

test("legacy routing facts: animate → /animations, text-to-3d on v2, rigging list enabled", () => {
  assert.equal(TASK_RESOURCES.find((r) => r.id === "animate")?.relativePath, "/animations");
  assert.equal(TASK_RESOURCES.find((r) => r.id === "text-to-3d")?.base, "v2");
  assert.equal(TASK_RESOURCES.find((r) => r.id === "rigging")?.supports.list, true);
  assert.equal(TASK_RESOURCES.find((r) => r.id === "analyze-printability")?.billing.create, "none");
});

test("resourceIndex classifies every entry and never invents a verb", () => {
  const idx = resourceIndex();
  const kinds = new Set(idx.map((e) => e.kind));
  assert.deepEqual([...kinds].sort(), ["local", "query", "task"]);
  for (const e of idx.filter((x) => x.kind === "task")) {
    assert.deepEqual(e.verbs, ["create", "get", "list", "wait", "stream", "delete"]);
    assert.match(e.command, /^meshy /);
  }
  for (const e of idx.filter((x) => x.kind !== "task")) assert.equal(e.verbs, null);
});
