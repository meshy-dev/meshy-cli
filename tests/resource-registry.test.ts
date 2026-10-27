/**
 * The registry is the executable contract: routing, verbs, media fields and
 * billing for every resource, and no path ever built from user input.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  CREATIVE_LAB_PRODUCTS,
  creativeLabResource,
  QUERY_RESOURCES,
  requireTaskResource,
  resourceIndex,
  TASK_RESOURCES,
} from "../src/client/resource-registry.js";

test("no resource is retried automatically; query resources keep their paths and billing", () => {
  for (const r of TASK_RESOURCES) assert.equal(r.automaticRetry, false, r.id);
  assert.equal(QUERY_RESOURCES.find((q) => q.id === "animation-catalog")?.relativePath, "/animations/library");
  assert.equal(QUERY_RESOURCES.find((q) => q.id === "showcases")?.billing, "may-charge");
});

test("Creative Lab: every two-stage product × 2 stages, exact paths, no path built from user strings (T-022, T-023)", () => {
  for (const product of CREATIVE_LAB_PRODUCTS) {
    for (const stage of ["prototype", "build"] as const) {
      const r = creativeLabResource(product, stage);
      assert.ok(r, `${product}/${stage}`);
      assert.equal(r.relativePath, `/${product}/v1/${stage}`);
      assert.equal(r.endpoint, `/openapi/creative-lab/${product}/v1/${stage}`);
      assert.equal(r.creativeLab?.product, product);
      assert.equal(r.creativeLab?.stage, stage);
      assert.equal(r.mediaFields.length, stage === "prototype" ? 1 : 0);
    }
  }
  for (const [p, s] of [["../figure", "prototype"], ["figure", "../build"], ["https://evil.example/", "build"], ["figure prototype", "build"], ["Figure", "prototype"], ["", "prototype"], ["teapot", "build"], ["fidget-collapsible", "build"]]) {
    assert.equal(creativeLabResource(p!, s!), undefined, `${p}/${s} must not resolve`);
  }
  // The one single-stage product sits on the product root.
  const fidget = requireTaskResource("creative-lab.fidget-collapsible");
  assert.deepEqual([...fidget.commandPath], ["creative-lab", "fidget-collapsible"]);
  assert.equal(fidget.endpoint, "/openapi/creative-lab/fidget-collapsible/v1");
  assert.equal(fidget.creativeLab?.stage, null);
});

test("routing facts: animate → /animations, text-to-3d on v2, rigging list enabled", () => {
  assert.equal(TASK_RESOURCES.find((r) => r.id === "animate")?.relativePath, "/animations");
  assert.equal(TASK_RESOURCES.find((r) => r.id === "text-to-3d")?.base, "v2");
  assert.equal(TASK_RESOURCES.find((r) => r.id === "rigging")?.supports.list, true);
  assert.equal(TASK_RESOURCES.find((r) => r.id === "analyze-printability")?.billing.create, "none");
});

test("resourceIndex classifies every entry and never invents a verb", () => {
  const idx = resourceIndex();
  const kinds = new Set(idx.map((e) => e.kind));
  assert.deepEqual([...kinds].sort(), ["action", "local", "query", "task"]);
  // delete reaches the API and is destructive: never listed as an offline helper.
  const del = idx.find((e) => e.name === "delete");
  assert.equal(del?.kind, "action");
  assert.equal(del?.endpoint, "/openapi/v2/text-to-3d");
  for (const e of idx.filter((x) => x.kind === "task")) {
    assert.deepEqual(e.verbs, ["create", "get", "list", "wait", "stream", "delete"]);
    assert.match(e.command, /^meshy /);
  }
  for (const e of idx.filter((x) => x.kind !== "task")) assert.equal(e.verbs, null);
});
