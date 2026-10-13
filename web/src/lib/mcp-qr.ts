import QRCode from "qrcode";

export const MCP_QR_DATA_URL_OPTIONS = Object.freeze({
  errorCorrectionLevel: "M" as const,
  margin: 1,
  width: 240,
  color: {
    dark: "#10211A",
    light: "#FFFFFF",
  },
});

export async function mcpQrDataUrl(value: string): Promise<string> {
  if (!value.trim()) throw new Error("MCP QR value is required");
  return QRCode.toDataURL(value, MCP_QR_DATA_URL_OPTIONS);
}
