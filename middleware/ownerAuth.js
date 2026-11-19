import { getAuthenticatedUser, sendAuthError } from "./getAuthenticatedUser.js";

const ownerAuth = async (req, res, next) => {
  try {
    const user = await getAuthenticatedUser(req);

    if (!user.isOwner) {
      return res.status(403).json({ success: false, message: "Owner access required" });
    }

    req.user = user;
    return next();
  } catch (error) {
    return sendAuthError(res, error);
  }
};

export default ownerAuth;
