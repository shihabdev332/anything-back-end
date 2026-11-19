import { getAuthenticatedUser, sendAuthError } from "./getAuthenticatedUser.js";

export const verifyToken = async (req, res, next) => {
  try {
    req.user = await getAuthenticatedUser(req);
    return next();
  } catch (error) {
    return sendAuthError(res, error);
  }
};
