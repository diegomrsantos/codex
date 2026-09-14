const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const {
  readRendererSource,
  digest,
  entryPath,
  expectedEntryHash,
} = require("./source.cjs");
const { archivePath, source: entrySource } = readRendererSource();
const start = entrySource.indexOf("function Qzt(e){");
assert.ok(start >= 0);
const end = entrySource.indexOf("function $zt(", start);
assert.ok(end > start);
const exactSource = entrySource.slice(start, end);
assert.equal(
  digest(exactSource),
  "1db9cc6012dd89e7fd7492d220bbd82e975bead641855dde58ad6217d747703f",
  "The extracted function must match the audited signature implementation",
);

const scenarios = [];
for (const itemCount of [100, 1000, 10000]) {
  for (const withCollabItem of [false, true]) {
    let counters;
    const items = Array.from({ length: itemCount }, (_, index) => {
      const isCollab = withCollabItem && index === itemCount - 1;
      const item = { text: "initial content" };
      Object.defineProperty(item, "type", {
        get() {
          counters.itemTypeReads++;
          return isCollab ? "collabAgentToolCall" : "agentMessage";
        },
      });
      if (isCollab) {
        Object.defineProperty(item, "receiverThreadIds", {
          get() {
            counters.receiverArrayReads++;
            return ["agent-a", "agent-b", "agent-c"];
          },
        });
        Object.defineProperty(item, "agentsStates", {
          get() {
            counters.agentStateReads++;
            return {
              "agent-a": { status: "running" },
              "agent-b": { status: "completed" },
              "agent-c": { status: "running" },
            };
          },
        });
      }
      return item;
    });
    const synthetic = { turns: [{ items }] };
    const context = vm.createContext(
      {
        Gg: (conversation) => {
          counters.turnViewCalls++;
          return conversation.turns;
        },
      },
      { codeGeneration: { strings: false, wasm: false } },
    );
    const signature = new vm.Script(`(${exactSource})`).runInContext(context);
    const calls = [];
    let initialSignature;
    for (let call = 0; call < 5; call++) {
      counters = {
        turnViewCalls: 0,
        itemTypeReads: 0,
        receiverArrayReads: 0,
        agentStateReads: 0,
      };
      // Mutating ordinary message text cannot change subagent membership or status.
      if (call > 0) items[0].text = `ordinary text update ${call}`;
      const output = signature(synthetic);
      if (call === 0) initialSignature = output;
      assert.equal(
        output,
        initialSignature,
        "Changes to ordinary text must leave the signature unchanged",
      );
      assert.deepEqual(counters, {
        turnViewCalls: 1,
        itemTypeReads: itemCount,
        receiverArrayReads: withCollabItem ? 1 : 0,
        agentStateReads: withCollabItem ? 3 : 0,
      });
      calls.push({
        kind: call === 0 ? "initial" : "ordinary text update",
        ...counters,
      });
    }
    scenarios.push({
      itemCount,
      withCollabItem,
      unchangedSignature: initialSignature,
      calls,
      totalItemTypeReads: calls.reduce(
        (sum, call) => sum + call.itemTypeReads,
        0,
      ),
    });
  }
}
// A changed agent status must change the signature, so an accidentally constant
// function cannot satisfy the assertions for unchanged content by itself.
const agentState = { status: "running" };
const statusConversation = {
  turns: [
    {
      items: [
        {
          type: "collabAgentToolCall",
          receiverThreadIds: ["agent-a"],
          agentsStates: { "agent-a": agentState },
        },
      ],
    },
  ],
};
const statusContext = vm.createContext(
  { Gg: (conversation) => conversation.turns },
  { codeGeneration: { strings: false, wasm: false } },
);
const statusSignature = new vm.Script(`(${exactSource})`).runInContext(
  statusContext,
);
const runningSignature = statusSignature(statusConversation);
agentState.status = "completed";
const completedSignature = statusSignature(statusConversation);
assert.notEqual(
  completedSignature,
  runningSignature,
  "A changed agent state must affect the projection",
);

const result = {
  archivePath,
  entryPath,
  entrySha256: expectedEntryHash,
  functionSourceSha256: digest(exactSource),
  verification:
    "PASS: all 30 invocations scanned every item; all 24 ordinary text updates preserved the signature.",
  scenarios,
  changedStatusControl: { passed: true, runningSignature, completedSignature },
  limits:
    "Synthetic structural check only. No time benchmark, incident attribution, app invocation, network, timer, or production data. Gg is an instrumented synthetic turn view, so this does not test canonical flattening or notification scheduling.",
};
const outputDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "codex-renderer-signature-"),
);
const outputPath = path.join(outputDirectory, "report.json");
fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n");
process.stdout.write(
  JSON.stringify(
    {
      outputPath,
      verification: result.verification,
      functionSourceSha256: result.functionSourceSha256,
      cases: scenarios.map(
        ({ itemCount, withCollabItem, totalItemTypeReads }) => ({
          itemCount,
          withCollabItem,
          totalItemTypeReads,
        }),
      ),
    },
    null,
    2,
  ) + "\n",
);
