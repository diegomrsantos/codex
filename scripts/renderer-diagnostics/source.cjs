const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");

const entryPath = "webview/assets/app-initial-9b95fa538c62.js";
const expectedEntryHash =
  "737070f94a072d2b4ede9f326e3e1c4142fb82198961251c2e70479b3f926275";
const digest = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

// Read the identified archive entry without loading any app module. The hash
// pins the extracted code and boundaries to the build used in the incident.
function readRendererSource() {
  const archivePath =
    process.argv[2] ?? "/Applications/ChatGPT.app/Contents/Resources/app.asar";
  if (!fs.existsSync(archivePath)) {
    throw new Error(
      "Pass the app.asar path from Codex Desktop 26.908.40834 as the first argument. See scripts/renderer-diagnostics/README.md.",
    );
  }
  const archive = fs.openSync(archivePath, "r");
  try {
    const prefix = Buffer.alloc(16);
    assert.equal(
      fs.readSync(archive, prefix, 0, prefix.length, 0),
      prefix.length,
    );
    const header = Buffer.alloc(prefix.readUInt32LE(12));
    assert.equal(
      fs.readSync(archive, header, 0, header.length, 16),
      header.length,
    );
    let entry = JSON.parse(header.toString("utf8"));
    for (const part of entryPath.split("/")) entry = entry?.files?.[part];
    assert.ok(
      entry,
      "The archive must contain the renderer entry from Desktop 26.908.40834",
    );
    const buffer = Buffer.alloc(entry.size);
    assert.equal(
      fs.readSync(
        archive,
        buffer,
        0,
        buffer.length,
        8 + prefix.readUInt32LE(4) + Number(entry.offset),
      ),
      buffer.length,
    );
    assert.equal(
      digest(buffer),
      expectedEntryHash,
      "Renderer source differs from the audited build; do not use these extraction boundaries",
    );
    return { archivePath, source: buffer.toString("utf8") };
  } finally {
    fs.closeSync(archive);
  }
}

module.exports = { readRendererSource, digest, entryPath, expectedEntryHash };
