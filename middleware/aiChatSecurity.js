import { createHmac } from "node:crypto";
import mongoose from "mongoose";
import aiRateLimitModel from "../model/aiRateLimitModel.js";
import { getAuthenticatedUser, sendAuthError } from "./getAuthenticatedUser.js";

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_MINUTE = 10;

export const optionalAiAuthentication = async (req, res, next) => {
  const hasAuthorization = Boolean(req.headers.authorization || req.headers.token);
  if (!hasAuthorization) return next();

  try {
    req.aiUser = await getAuthenticatedUser(req);
    return next();
  } catch (error) {
    return sendAuthError(res, error);
  }
};

const incrementQuota = async ({ secret, scope, identity, windowStart, expiresAt }) => {
  const id = createHmac("sha256", secret)
    .update(`${scope}:${identity}:${windowStart}`)
    .digest("hex");
  const update = {
    $setOnInsert: { expiresAt },
    $inc: { count: 1 },
  };

  try {
    const record = await aiRateLimitModel.findOneAndUpdate({ _id: id }, update, {
      upsert: true,
      new: true,
    });
    return record.count;
  } catch (error) {
    // Concurrent first requests can race to insert the same bucket.
    if (error.code !== 11000) throw error;
    const record = await aiRateLimitModel.findOneAndUpdate(
      { _id: id },
      { $inc: { count: 1 } },
      { new: true },
    );
    if (!record) throw error;
    return record.count;
  }
};

export const aiRateLimit = async (req, res, next) => {
  const secret = process.env.AI_RATE_LIMIT_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    return res.status(503).json({
      success: false,
      message: "Assistant is temporarily unavailable.",
    });
  }

  if (mongoose.connection.readyState === 2) {
    try {
      await mongoose.connection.asPromise();
    } catch {
      return res.status(503).json({
        success: false,
        message: "Assistant is temporarily unavailable.",
      });
    }
  }

  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      success: false,
      message: "Assistant is temporarily unavailable.",
    });
  }

  const now = Date.now();
  const windowStart = Math.floor(now / WINDOW_MS);
  const expiresAt = new Date((windowStart + 2) * WINDOW_MS);
  const identities = [
    { scope: "ip", value: req.ip || req.socket.remoteAddress || "unknown" },
  ];

  if (req.aiUser?.id) {
    identities.push({ scope: "user", value: req.aiUser.id });
  }

  try {
    const counts = await Promise.all(
      identities.map(({ scope, value }) =>
        incrementQuota({ secret, scope, identity: value, windowStart, expiresAt }),
      ),
    );

    if (counts.some((count) => count > MAX_REQUESTS_PER_MINUTE)) {
      const retryAfter = Math.max(
        1,
        Math.ceil(((windowStart + 1) * WINDOW_MS - Date.now()) / 1000),
      );
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({
        success: false,
        message: "Too many chat requests. Please try again shortly.",
        retryAfter,
      });
    }

    return next();
  } catch (error) {
    console.error("AI rate limit store failed:", error.message);
    return res.status(503).json({
      success: false,
      message: "Assistant is temporarily unavailable.",
    });
  }
};
