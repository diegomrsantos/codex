const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const os = require("node:os");
const {
  readRendererSource,
  digest: sha256,
  expectedEntryHash,
} = require("./source.cjs");
const { source } = readRendererSource();
const frameStart = source.indexOf("TKt=class{");
const frameEnd = source.indexOf(")),DKt", frameStart);
assert.ok(frameStart >= 0 && frameEnd > frameStart);
const frameClass = source.slice(frameStart + "TKt=".length, frameEnd - 1);
const signatureStart = source.indexOf("function Qzt(e){");
const signatureEnd = source.indexOf("function $zt(", signatureStart);
const signatureSource = source.slice(signatureStart, signatureEnd);
const retentionStart = source.indexOf(
  "getInactiveOwnerConversationIdsToUnsubscribe(e){",
);
const retentionEnd = source.indexOf(
  "async unsubscribeInactiveConversation(e){",
  retentionStart,
);
const retentionMethods = source.slice(retentionStart, retentionEnd);
assert.ok(retentionStart >= 0 && retentionEnd > retentionStart);
const constants = {};
for (const name of ["CKt", "wKt", "SKt", "tKt", "rKt"]) {
  const expression = source.match(
    new RegExp(`\\b${name}=([\\d.e*]+)(?=[,;])`),
  )?.[1];
  assert.ok(expression, `Missing source constant ${name}`);
  constants[name] = vm.runInNewContext(expression, {}, { timeout: 1000 });
}
const context = vm.createContext(
  {
    ...constants,
    Gg: (conversation) => conversation.turns,
    Jg: (conversation) => conversation.turns.at(-1),
    XIt: (conversation) => conversation.turns,
    XGt: (conversation) => conversation.pendingUserInteraction ?? null,
    OIt: (item) => item.testIsRunning === true,
    eKt: (conversation) => conversation.ephemeral === true,
  },
  { codeGeneration: { strings: false, wasm: false } },
);
const FrameBuffer = vm.runInContext(`(${frameClass})`, context);
const signature = vm.runInContext(`(${signatureSource})`, context);
const Retention = vm.runInContext(`(class {${retentionMethods}})`, context);
const results = [];

function scheduler() {
  let visible = true;
  const frames = new Set();
  const fallback = new Set();
  const visibilityListeners = new Set();
  return {
    api: {
      canUseAnimationFrame: () => visible,
      scheduleAnimationFrame(callback) {
        frames.add(callback);
        return () => frames.delete(callback);
      },
      schedule(callback) {
        fallback.add(callback);
        return () => fallback.delete(callback);
      },
      subscribeVisibilityChange(callback) {
        visibilityListeners.add(callback);
        return () => visibilityListeners.delete(callback);
      },
    },
    frame() {
      const ready = [...frames];
      frames.clear();
      for (const callback of ready) callback();
      return ready.length;
    },
    hide() {
      visible = false;
      for (const callback of [...visibilityListeners]) callback();
    },
    state() {
      return {
        frames: frames.size,
        fallback: fallback.size,
        visibilityListeners: visibilityListeners.size,
      };
    },
  };
}

function message(conversationId, delta, target = { type: "agentMessage" }) {
  return { conversationId, turnId: "turn", itemId: "message", target, delta };
}

// A visible document lets both selected and background task buffers drain.
{
  const clock = scheduler();
  const delivered = [];
  const buffer = new FrameBuffer({
    scheduler: clock.api,
    onFlush: (batch) => delivered.push(batch),
  });
  buffer.enqueue(message("selected-task", "a".repeat(48)));
  buffer.enqueue(message("background-task", "b".repeat(48)));
  assert.equal(delivered.length, 0);
  assert.equal(
    clock.state().frames,
    1,
    "Enqueues must share a scheduled frame",
  );

  clock.frame();
  assert.deepEqual(
    Array.from(delivered[0], (item) => [item.conversationId, item.delta]),
    [
      ["selected-task", "a".repeat(24)],
      ["background-task", "b".repeat(24)],
    ],
  );
  clock.frame();
  assert.equal(delivered.length, 2);
  assert.equal(buffer.buffers.size, 0);
  assert.deepEqual(clock.state(), {
    frames: 0,
    fallback: 0,
    visibilityListeners: 0,
  });
  results.push({
    scenario:
      "Visible document drains both task IDs and releases drained buffers",
    passed: true,
    frames: 2,
    charactersPerTaskPerFrame: 24,
  });
}

// Visibility loss must release all queued text and the scheduled frame.
{
  const clock = scheduler();
  const delivered = [];
  const buffer = new FrameBuffer({
    scheduler: clock.api,
    onFlush: (batch) => delivered.push(batch),
  });
  const payload = "hidden-control ".repeat(100);
  buffer.enqueue(message("task", payload));
  clock.hide();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0][0].delta, payload);
  assert.equal(buffer.buffers.size, 0);
  assert.deepEqual(clock.state(), {
    frames: 0,
    fallback: 0,
    visibilityListeners: 0,
  });
  results.push({
    scenario: "Hiding the document flushes text and cancels pending frame work",
    passed: true,
    characters: payload.length,
  });
}

// Completion is an observable barrier: the callback runs after all text arrives.
{
  const clock = scheduler();
  let text = "";
  let completed = 0;
  const payload = "c".repeat(2400);
  const buffer = new FrameBuffer({
    scheduler: clock.api,
    onFlush: (batch) => {
      for (const item of batch) text += item.delta;
    },
  });
  buffer.enqueue(message("task", payload));
  assert.equal(
    buffer.drainBefore(() => {
      assert.equal(text, payload);
      completed++;
    }),
    true,
  );
  for (let frame = 0; frame < 7; frame++) {
    clock.frame();
    assert.equal(completed, 0);
  }
  clock.frame();
  assert.equal(completed, 1);
  assert.equal(text, payload);
  assert.deepEqual(clock.state(), {
    frames: 0,
    fallback: 0,
    visibilityListeners: 0,
  });
  results.push({
    scenario:
      "Completion accelerates 2400 buffered characters into eight frames before callback",
    passed: true,
    frames: 8,
  });
}

// Reasoning summaries are a useful control against assuming every target is chunked.
{
  const clock = scheduler();
  const delivered = [];
  const buffer = new FrameBuffer({
    scheduler: clock.api,
    onFlush: (batch) => delivered.push(batch),
  });
  const payload = "r".repeat(2400);
  buffer.enqueue(
    message("task", payload, { type: "reasoningSummary", summaryIndex: 0 }),
  );
  clock.frame();
  assert.equal(delivered[0][0].delta, payload);
  assert.equal(buffer.buffers.size, 0);
  results.push({
    scenario: "Reasoning summary text is delivered in one frame",
    passed: true,
    frames: 1,
  });
}

// Compose the two real mechanisms explicitly. The bridge is synthetic: this does
// not pretend to exercise the app's notification or React subscription machinery.
for (const mode of ["ordinary", "completion", "hidden"]) {
  let itemReads = 0;
  const items = Array.from({ length: 10000 }, () => ({
    text: "",
    get type() {
      itemReads++;
      return "agentMessage";
    },
  }));
  const conversation = { turns: [{ items }] };
  const initialSignature = signature(conversation);
  itemReads = 0;
  const clock = scheduler();
  let notifications = 0;
  const buffer = new FrameBuffer({
    scheduler: clock.api,
    onFlush: (batch) => {
      for (const item of batch) items[0].text += item.delta;
      notifications++;
      assert.equal(signature(conversation), initialSignature);
    },
  });
  buffer.enqueue(message("task", "x".repeat(2400)));
  if (mode === "completion") buffer.drainBefore(() => {});
  if (mode === "hidden") clock.hide();
  for (let frame = 0; buffer.buffers.size > 0 && frame < 101; frame++)
    clock.frame();

  const expectedNotifications = { ordinary: 100, completion: 8, hidden: 1 }[
    mode
  ];
  assert.equal(
    buffer.buffers.size,
    0,
    "Bounded scheduler must fully drain the workload",
  );
  assert.equal(items[0].text, "x".repeat(2400));
  assert.equal(notifications, expectedNotifications);
  assert.equal(
    itemReads,
    { ordinary: 1000000, completion: 80000, hidden: 10000 }[mode],
  );
  assert.deepEqual(clock.state(), {
    frames: 0,
    fallback: 0,
    visibilityListeners: 0,
  });
  results.push({
    scenario: `Streaming plus signature scan: ${mode}`,
    passed: true,
    loadedItems: 10000,
    characters: 2400,
    notifications,
    itemReads,
  });
}

function retainedTask(id, runtimeStatus, turnStatus) {
  return {
    id,
    rolloutPath: "/synthetic/rollout",
    resumeState: "resumed",
    threadRuntimeStatus: { type: runtimeStatus },
    turns: [{ status: turnStatus, items: [{ type: "agentMessage" }] }],
  };
}

function retentionPolicy(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const policy = new Retention();
  policy.inactiveOwnerConversationSinceById = new Map(
    tasks.map((task, index) => [task.id, index * 1000]),
  );
  policy.inactiveOwnerConversationRetryAtById = new Map();
  policy.unsubscribingConversationIds = new Set();
  policy.params = {
    threadStore: { getConversation: (id) => byId.get(id) },
    streamState: {
      ownsConversationHistoryStream: () => true,
      getStreamRole: () => ({ role: "owner" }),
    },
    logger: { debug() {} },
  };
  policy.hasActiveConversationView = () => false;
  policy.hasOwnedStreamFollowers = () => false;
  return policy;
}

// The inactive control is selected for expiry; running states remain excluded.
{
  const tasks = [
    retainedTask("completed", "idle", "completed"),
    retainedTask("runtime-active", "active", "completed"),
    retainedTask("unfinished-turn", "idle", "inProgress"),
  ];
  const policy = retentionPolicy(tasks);
  const afterFourHours = 4 * 60 * 60 * 1000;
  assert.deepEqual(
    Array.from(
      policy.getInactiveOwnerConversationIdsToUnsubscribe(afterFourHours),
    ),
    ["completed"],
  );

  tasks[1].threadRuntimeStatus.type = "idle";
  tasks[2].turns[0].status = "completed";
  assert.deepEqual(
    Array.from(
      policy.getInactiveOwnerConversationIdsToUnsubscribe(afterFourHours),
    ),
    tasks.map((task) => task.id),
  );
  results.push({
    scenario:
      "Active and unfinished tasks avoid expiry until their state completes",
    passed: true,
    elapsedHours: 4,
  });
}

// Ten is a target for eligible inactive tasks, not a cap on every loaded task.
{
  const tasks = [
    ...Array.from({ length: 12 }, (_, index) =>
      retainedTask(`done-${index}`, "idle", "completed"),
    ),
    ...Array.from({ length: 20 }, (_, index) =>
      retainedTask(`running-${index}`, "active", "inProgress"),
    ),
  ];
  const policy = retentionPolicy(tasks);
  assert.deepEqual(
    Array.from(
      policy.getInactiveOwnerConversationIdsToUnsubscribe(20 * 60 * 1000),
    ),
    ["done-0", "done-1"],
  );
  results.push({
    scenario:
      "Capacity selection evicts oldest eligible tasks but excludes active tasks",
    passed: true,
    completed: 12,
    active: 20,
    selectedForUnsubscribe: 2,
  });
}

const report = {
  capturedAtUtc: new Date().toISOString(),
  sourceSha256: expectedEntryHash,
  constants,
  extractedSourceHashes: {
    frameClass: sha256(frameClass),
    signature: sha256(signatureSource),
    retentionMethods: sha256(retentionMethods),
  },
  results,
  limits: [
    "Exact source ran in an isolated Node VM with synthetic conversation data and a deterministic scheduler.",
    "This counts work, not elapsed time, allocations, frame pacing or retained heap.",
    "Gg and retention dependencies use synthetic views. No real app subscriptions, canonical history flattening or unsubscribe I/O are exercised.",
    "The composition test explicitly invokes Qzt from onFlush; source audit supports the production connection but this test does not execute that connection.",
    "These tests reproduce mechanisms and controls, not the complete 2.5 GB incident or message durability loss.",
  ],
};
const outputDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "codex-renderer-streaming-"),
);
const outputPath = path.join(outputDirectory, "report.json");
fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify(
    {
      outputPath,
      passedScenarios: results.length,
      results,
      sourceSha256: expectedEntryHash,
    },
    null,
    2,
  ),
);
