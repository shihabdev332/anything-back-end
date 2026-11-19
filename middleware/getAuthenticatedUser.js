import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import userModel from "../model/userModel.js";

const authError = (message, statusCode) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

export const getAuthenticatedUser = async (req) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : req.headers.token;

  if (!token) {
    throw authError("No token provided", 401);
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
  } catch {
    throw authError("Invalid or expired token", 401);
  }

  // Every application-issued token has an expiry. Reject otherwise valid but
  // non-expiring tokens as well as expired or incorrectly signed tokens.
  if (!Number.isFinite(decoded.exp) || decoded.exp <= Math.floor(Date.now() / 1000)) {
    throw authError("Invalid or expired token", 401);
  }

  const userId = decoded.id || decoded._id;
  if (!mongoose.isValidObjectId(userId)) {
    throw authError("Invalid or expired token", 401);
  }

  let account;
  try {
    account = await userModel
      .findById(userId)
      .select("_id email isAdmin isOwner isDeliveryMan deliverySellerId deliveryPhone")
      .lean();
  } catch (error) {
    console.error("Authentication account lookup failed:", error.message);
    throw authError("Authentication service unavailable", 503);
  }

  if (!account) {
    throw authError("Account no longer exists. Please sign in again.", 401);
  }

  // Roles always come from the current database record, never from JWT claims.
  return {
    id: account._id.toString(),
    _id: account._id.toString(),
    email: account.email,
    // Role flags must be actual stored booleans; truthy strings such as
    // "false" must never grant a role if a malformed legacy record exists.
    isAdmin: account.isAdmin === true,
    isOwner: account.isOwner === true,
    isDeliveryMan: account.isDeliveryMan === true,
    deliverySellerId: account.deliverySellerId?.toString() || null,
    deliveryPhone: account.deliveryPhone || "",
  };
};

export const sendAuthError = (res, error) => {
  const statusCode = error.statusCode || 401;
  const message = statusCode === 503
    ? "Authentication service unavailable"
    : error.message || "Authentication failed";

  return res.status(statusCode).json({ success: false, message });
};
