import { getAuthenticatedUser, sendAuthError } from "./getAuthenticatedUser.js";

/**
 * Middleware to verify seller access using the account's current database role.
 * It checks for token in both 'Authorization' header and a custom 'token' header.
 */
const adminAuth = async (req, res, next) => {
  try {
    const user = await getAuthenticatedUser(req);

    // `isAdmin` is the legacy seller flag. Treat the role as exclusive so a
    // mixed/legacy owner or delivery record cannot inherit seller access.
    if (!user.isAdmin || user.isOwner || user.isDeliveryMan) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: Seller access required.",
      });
    }

    req.user = user;
    return next();
  } catch (error) {
    return sendAuthError(res, error);
  }
};

export default adminAuth;
