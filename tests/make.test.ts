/**
 * Tests for `make` — the planner is pure, so the interesting behaviour (route
 * choice, budget refusal, resume hand-off) is all testable offline.
 *
 * What matters most here is the money: a wrong route or a missed budget check
 * spends real credits, and neither has a cheap undo.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { classifyInput, planMake } from "../src/internal/make-plan.js";
import { CREDIT_ESTIMATES } from "../src/internal/pricing.js";
import { resumeCommand } from "../src/cmd/make.js";
import { RESOURCES } from "../src/cmd/resources.js";
import { UsageError } from "../src/internal/errors.js";
import { buildRootCommand } from "../src/root.js";
import type { Runtime } from "../src/internal/runtime.js";

function tempImage(name = "cat.png"): string {
  const dir = mkdtempSync(join(tmpdir(), "meshy-make-"));
  const file = join(dir, name);
  // PNG magic so the file-input MIME sniff would accept it too.
  writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return file;
}

function runtimeWith(output?: string): Runtime {
  return { flags: { output, format: "json", verbose: false } } as unknown as Runtime;
}

test("a prompt plans the documented two-stage text flow", () => {
  const plan = planMake("a red sports car");
  assert.equal(plan.route, "text");
  assert.deepEqual(
    plan.steps.map((s) => `${s.resource}:${s.action}`),
    ["text-to-3d:preview", "text-to-3d:refine"],
  );
  assert.equal(
    plan.estimatedCredits,
    CREDIT_ESTIMATES["text-to-3d:preview"] + CREDIT_ESTIMATES["text-to-3d:refine"],
  );
});

test("an image plans a single textured image-to-3d task", () => {
  for (const input of [tempImage(), "https://example.com/cat.png"]) {
    const plan = planMake(input);
    assert.equal(plan.route, "image", input);
    assert.equal(plan.steps.length, 1, input);
    assert.equal(plan.steps[0]?.action, "textured", input);
    assert.equal(plan.estimatedCredits, CREDIT_ESTIMATES["image-to-3d:textured"], input);
  }
});

test("a path-shaped argument that does not exist is an error, not a prompt", () => {
  // Generating "./cat.png" as text would bill a typo.
  for (const input of ["./cat.png", "/tmp/definitely-missing-9k2.png", "out/model.jpg"]) {
    assert.throws(() => classifyInput(input), UsageError, input);
  }
});

test("prompts that merely contain punctuation stay prompts", () => {
  for (const input of ["a cat, 3/4 view", "low-poly rock", "a red sports car"]) {
    assert.equal(classifyInput(input), "text", input);
  }
});

test("data: URIs and empty input are refused before any spend", () => {
  assert.throws(() => classifyInput("data:image/png;base64,AAAA"), UsageError);
  assert.throws(() => classifyInput("   "), UsageError);
});

test("resume is offered only where a hand-off exists", () => {
  const text = planMake("a red sports car");
  const image = planMake("https://example.com/cat.png");

  assert.equal(
    resumeCommand(text, "task-1", runtimeWith()),
    "meshy text-to-3d create --mode refine --preview-task-id task-1",
  );
  // -o rides along so the resumed step still lands the artifacts on disk.
  assert.match(resumeCommand(text, "task-1", runtimeWith("out/car/")) ?? "", / -o out\/car\/$/);
  // Nothing succeeded yet → no command to suggest.
  assert.equal(resumeCommand(text, "", runtimeWith()), undefined);
  // A single-task route has nothing to resume from.
  assert.equal(resumeCommand(image, "task-1", runtimeWith()), undefined);
});

test("the root help leads with make and hides the endpoint commands", () => {
  const root = buildRootCommand();
  const visible = root.commands.filter((c) => !(c as Command & { _hidden?: boolean })._hidden);
  assert.deepEqual(
    visible.map((c) => c.name()).sort(),
    ["api", "auth", "balance", "make", "resources"],
  );

  // Hidden is a help-text decision: every endpoint command is still wired.
  const registered = new Set(root.commands.map((c) => c.name()));
  for (const entry of RESOURCES) {
    assert.ok(registered.has(entry.name), `${entry.name} is no longer registered`);
  }
});

test("make advertises the budget and dry-run guards", () => {
  const make = buildRootCommand().commands.find((c) => c.name() === "make");
  assert.ok(make);
  const flags = new Set(make.options.map((o) => o.long ?? ""));
  for (const flag of ["--dry-run", "--max-credits", "--async", "--timeout"]) {
    assert.ok(flags.has(flag), `make is missing ${flag}`);
  }
});
