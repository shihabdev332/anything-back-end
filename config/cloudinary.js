import { v2 as cloudinary } from "cloudinary";

const HEALTH_CHECK_CACHE_MS = 30_000;
let lastCheckAt = 0;
let cloudinaryReady = false;
let inFlightCheck = null;

const hasCredentials = () =>
  Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET,
  );

const pingCloudinary = () => {
  if (inFlightCheck) return inFlightCheck;

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  const apiPrefix = (cloudinary.config().upload_prefix || "https://api.cloudinary.com")
    .replace(/\/+$/, "");
  const endpoint = `${apiPrefix}/v1_1/${encodeURIComponent(cloudName)}/ping`;

  inFlightCheck = fetch(endpoint, {
    method: "GET",
    headers: {
      Authorization: `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`,
    },
    signal: AbortSignal.timeout(5000),
  })
    .then(async (response) => {
      await response.body?.cancel();
      if (!response.ok) {
        throw new Error(`Cloudinary ping returned HTTP ${response.status}`);
      }
      cloudinaryReady = true;
      lastCheckAt = Date.now();
      return true;
    })
    .catch((error) => {
      cloudinaryReady = false;
      lastCheckAt = Date.now();
      throw error;
    })
    .finally(() => {
      inFlightCheck = null;
    });

  return inFlightCheck;
};

export const getCloudinaryReadiness = async () => {
  if (!hasCredentials()) {
    cloudinaryReady = false;
    return { ready: false, status: "not_configured" };
  }

  if (!lastCheckAt || Date.now() - lastCheckAt >= HEALTH_CHECK_CACHE_MS) {
    try {
      await pingCloudinary();
    } catch {
      // The health response reports the failed dependency without leaking API details.
    }
  }

  return {
    ready: cloudinaryReady,
    status: cloudinaryReady ? "connected" : "unavailable",
    checkedAt: lastCheckAt ? new Date(lastCheckAt).toISOString() : null,
  };
};

const connectCloudinary = async () => {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });

  if (!hasCredentials()) {
    cloudinaryReady = false;
    lastCheckAt = Date.now();
    throw new Error("Cloudinary credentials are missing");
  }

  try {
    await pingCloudinary();
    console.log("Cloudinary connection verified");
  } catch {
    throw new Error("Cloudinary connection failed");
  }
};

export default connectCloudinary;
