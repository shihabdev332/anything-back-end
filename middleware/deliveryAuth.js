import userModel from "../model/userModel.js";
import { getAuthenticatedUser, sendAuthError } from "./getAuthenticatedUser.js";

const deliveryAuth = async (req, res, next) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user.isDeliveryMan || !user.deliverySellerId || user.isOwner || user.isAdmin) {
      return res.status(403).json({ success: false, message: "Delivery access required." });
    }

    const seller = await userModel.findOne({
      _id: user.deliverySellerId,
      isAdmin: true,
      isOwner: { $ne: true },
      isDeliveryMan: { $ne: true },
    }).select("_id").lean();

    if (!seller) {
      return res.status(403).json({ success: false, message: "This delivery account is no longer active." });
    }

    req.user = user;
    return next();
  } catch (error) {
    return sendAuthError(res, error);
  }
};

export default deliveryAuth;
