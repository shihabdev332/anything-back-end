import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";

const secret = () => process.env.DELIVERY_CODE_SECRET || process.env.JWT_SECRET;

const deriveKey = (purpose) => {
  const value = secret();
  if (!value) throw new Error("A server secret is required for delivery verification codes.");
  return createHash("sha256").update(`${purpose}:${value}`).digest();
};

const digestCode = (code) => createHmac("sha256", deriveKey("delivery-code-hmac")).update(code).digest();

export const issueDeliveryCode = () => {
  const code = String(randomInt(100000, 1000000));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey("delivery-code-encryption"), iv);
  const encrypted = Buffer.concat([cipher.update(code, "utf8"), cipher.final()]);
  return {
    code,
    codeHash: digestCode(code).toString("base64url"),
    codeEncrypted: `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`,
  };
};

export const revealDeliveryCode = (encryptedValue) => {
  const [ivValue, tagValue, cipherValue] = String(encryptedValue || "").split(".");
  if (!ivValue || !tagValue || !cipherValue) throw new Error("Delivery verification code is unavailable.");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveKey("delivery-code-encryption"),
    Buffer.from(ivValue, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(cipherValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
};

export const matchesDeliveryCode = (code, expectedHash) => {
  if (typeof code !== "string" || !/^\d{6}$/.test(code) || !expectedHash) return false;
  const expected = Buffer.from(expectedHash, "base64url");
  const actual = digestCode(code);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};
