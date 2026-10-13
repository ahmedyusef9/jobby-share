import assert from "node:assert/strict";
import { test } from "node:test";
import QRCode from "../web/node_modules/qrcode/lib/index.js";

const OPTIONS = {
  errorCorrectionLevel: "M",
  margin: 1,
  width: 240,
  color: { dark: "#10211A", light: "#FFFFFF" },
};

test("MCP QR data URL encodes the connection URL as PNG", async () => {
  const url = "https://example.test/mcp/jb_123";
  const dataUrl = await QRCode.toDataURL(url, OPTIONS);
  assert.match(dataUrl, /^data:image\/png;base64,/);
  assert.ok(Buffer.from(dataUrl.split(",")[1], "base64").length > 100);
});
