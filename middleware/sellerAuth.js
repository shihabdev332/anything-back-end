import { getAuthenticatedUser, sendAuthError } from "./getAuthenticatedUser.js";

const sellerAuth = async (req, res, next) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user.isAdmin || user.isOwner || user.isDeliveryMan) {
      return res.status(403).json({ success: false, message: "Seller access required." });
    }
    req.user = user;
    return next();
  } catch (error) {
    return sendAuthError(res, error);
  }
};

export default sellerAuth;
