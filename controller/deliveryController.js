import bcrypt from "bcrypt";
import mongoose from "mongoose";
import validator from "validator";
import Order from "../model/orderModel.js";
import Product from "../model/productModel.js";
import userModel from "../model/userModel.js";
import { issueDeliveryCode, matchesDeliveryCode } from "../config/deliveryVerification.js";

const stages = ["Assigned", "Picked Up", "Out for Delivery", "Delivered"];
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const sellerLines = (order, sellerId) => order.products.filter((item) => {
  const productSellerId = item.productId?.sellerId;
  const ownerId = item.sellerId || productSellerId;
  return ownerId && ownerId.toString() === sellerId;
});

export const listDeliveryTeam = async (req, res) => {
  try {
    const team = await userModel.find({
      isDeliveryMan: true,
      deliverySellerId: req.user.id,
      isAdmin: { $ne: true },
      isOwner: { $ne: true },
    }).select("_id name email avatar deliveryPhone createdAt").sort({ createdAt: -1 }).lean();
    return res.json({ success: true, team });
  } catch (error) {
    console.error("Seller delivery team lookup failed:", error.message);
    return res.status(500).json({ success: false, message: "Could not load your delivery team." });
  }
};

export const createDeliveryAccount = async (req, res) => {
  try {
    const body = req.body || {};
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const phone = typeof body.phone === "string" ? body.phone.trim().slice(0, 30) : "";

    if (name.length < 2 || name.length > 80) return res.status(400).json({ success: false, message: "Name must be 2 to 80 characters." });
    if (!validator.isEmail(email) || email.length > 254) return res.status(400).json({ success: false, message: "Enter a valid email address." });
    if (password.length < 10 || Buffer.byteLength(password, "utf8") > 72) return res.status(400).json({ success: false, message: "Password must be at least 10 characters and no more than 72 bytes." });
    if (phone && phone.length < 5) return res.status(400).json({ success: false, message: "Enter a valid delivery contact number." });

    const existing = await userModel.findOne({ email: new RegExp(`^${escapeRegex(email)}$`, "i") }).select("_id").lean();
    if (existing) return res.status(409).json({ success: false, message: "An account already uses this email." });

    const passwordHash = await bcrypt.hash(password, 12);
    const deliveryMan = await userModel.create({
      name,
      email,
      password: passwordHash,
      deliveryPhone: phone,
      isAdmin: false,
      isOwner: false,
      isDeliveryMan: true,
      deliverySellerId: req.user.id,
    });

    return res.status(201).json({
      success: true,
      message: "Delivery account created.",
      deliveryMan: {
        _id: deliveryMan._id,
        name: deliveryMan.name,
        email: deliveryMan.email,
        deliveryPhone: deliveryMan.deliveryPhone,
        createdAt: deliveryMan.createdAt,
      },
    });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ success: false, message: "An account already uses this email." });
    console.error("Delivery account creation failed:", error.message);
    return res.status(500).json({ success: false, message: "Could not create the delivery account." });
  }
};

export const removeDeliveryAccount = async (req, res) => {
  try {
    const { deliveryManId } = req.params;
    if (!mongoose.isValidObjectId(deliveryManId)) {
      return res.status(400).json({ success: false, message: "Invalid delivery account." });
    }

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const member = await userModel.findOne({
          _id: deliveryManId,
          isDeliveryMan: true,
          deliverySellerId: req.user.id,
          isAdmin: { $ne: true },
          isOwner: { $ne: true },
        }).select("_id").session(session).lean();
        if (!member) throw fail("Delivery person not found in your team.", 404);

        const activeAssignment = await Order.exists({
          status: { $ne: "Cancelled" },
          products: { $elemMatch: {
            deliveryManId: member._id,
            sellerId: req.user.id,
            sellerStatus: { $ne: "Cancelled" },
            deliveryStatus: { $ne: "Delivered" },
          } },
        }).session(session);
        if (activeAssignment) throw fail("Reassign or complete this person's active deliveries before removing access.", 409);

        const result = await userModel.updateOne(
          { _id: member._id, deliverySellerId: req.user.id, isDeliveryMan: true },
          { $set: { isDeliveryMan: false, deliverySellerId: null, deliveryPhone: "" }, $inc: { deliveryAssignmentRevision: 1 } },
          { session }
        );
        if (!result.modifiedCount) throw fail("Delivery person is no longer on your team.", 409);
      });
    } finally {
      await session.endSession();
    }
    return res.json({ success: true, message: "Delivery access removed. This account can still shop as a customer." });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
    console.error("Seller delivery access removal failed:", error.message);
    return res.status(500).json({ success: false, message: "Could not remove delivery access." });
  }
};

export const assignDelivery = async (req, res) => {
  let session;
  try {
    const { orderId, deliveryManId } = req.body;
    if (!mongoose.isValidObjectId(orderId) || !mongoose.isValidObjectId(deliveryManId)) {
      return res.status(400).json({ success: false, message: "Choose a valid order and delivery person." });
    }
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      const deliveryMan = await userModel.findOneAndUpdate({
        _id: deliveryManId,
        isDeliveryMan: true,
        deliverySellerId: req.user.id,
        isAdmin: { $ne: true },
        isOwner: { $ne: true },
      }, { $inc: { deliveryAssignmentRevision: 1 } }, { new: true, session }).select("_id").lean();
      if (!deliveryMan) throw fail("Delivery person not found in your team.", 404);

      const order = await Order.findById(orderId)
        .select("+deliveryConfirmations")
        .populate("products.productId", "sellerId")
        .session(session);
      if (!order) throw fail("Order not found.", 404);
      const lines = sellerLines(order, req.user.id);
      if (!lines.length) throw fail("This order has no products from your store.", 403);
      const assignable = lines.filter((line) => !["Cancelled", "Delivered"].includes(line.sellerStatus || order.status));
      if (!assignable.length) throw fail("There are no active products to assign in this order.");
      if (assignable.some((line) => line.deliveryStatus && line.deliveryStatus !== "Assigned")) {
        throw fail("A delivery has already been picked up and cannot be reassigned.", 409);
      }
      for (const line of assignable) {
        line.sellerId = req.user.id;
        line.deliveryManId = deliveryMan._id;
        line.deliveryStatus = "Assigned";
        line.deliveryUpdatedAt = new Date();
        line.deliveredAt = null;
      }
      let confirmation = order.deliveryConfirmations.find((item) => item.sellerId.toString() === req.user.id);
      if (!confirmation) {
        const issued = issueDeliveryCode();
        order.deliveryConfirmations.push({
          sellerId: req.user.id,
          codeHash: issued.codeHash,
          codeEncrypted: issued.codeEncrypted,
          failedAttempts: 0,
          lockedUntil: null,
        });
      }
      await order.save({ session });
    });
    return res.json({ success: true, message: "Order assigned to the delivery person." });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error("Delivery assignment failed:", error.message);
    return res.status(status).json({ success: false, message: status >= 500 ? "Could not assign this delivery." : error.message });
  } finally {
    if (session) await session.endSession();
  }
};

const deliveryAddress = (address) => {
  if (typeof address === "string") return { fullAddress: address };
  if (!address || typeof address !== "object" || Array.isArray(address)) return { fullAddress: "" };
  const allowed = ["fullAddress", "address", "street", "city", "upazila", "district", "postalCode", "phone", "mobile", "contactNumber", "position", "coordinates", "lat", "lng", "latitude", "longitude"];
  return Object.fromEntries(allowed.filter((key) => address[key] !== undefined && address[key] !== null).map((key) => [key, address[key]]));
};

const makeCursor = (order) => Buffer.from(JSON.stringify({ date: order.createdAt.toISOString(), id: order._id.toString() })).toString("base64url");

export const getAssignedDeliveries = async (req, res) => {
  try {
    const allowedStatuses = [...stages, "all", "active"];
    if (req.query.status !== undefined && !allowedStatuses.includes(req.query.status)) throw fail("Invalid delivery status filter.");
    const status = req.query.status || "all";
    const requestedLimit = req.query.limit === undefined ? 20 : Number(req.query.limit);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) throw fail("Invalid page size.");
    const limit = Math.min(50, requestedLimit);
    const filter = {
      status: { $ne: "Cancelled" },
      products: { $elemMatch: {
        deliveryManId: new mongoose.Types.ObjectId(req.user.id),
        sellerId: new mongoose.Types.ObjectId(req.user.deliverySellerId),
        sellerStatus: { $ne: "Cancelled" },
      } },
    };
    if (status === "active") filter.products.$elemMatch.deliveryStatus = { $in: [...stages.slice(0, 3), null] };
    else if (status !== "all") filter.products.$elemMatch.deliveryStatus = status;

    if (req.query.cursor) {
      if (typeof req.query.cursor !== "string" || req.query.cursor.length > 512) throw fail("Invalid pagination cursor.");
      let cursor;
      try { cursor = JSON.parse(Buffer.from(String(req.query.cursor), "base64url").toString("utf8")); } catch { throw fail("Invalid pagination cursor."); }
      const date = new Date(cursor.date);
      if (!mongoose.isValidObjectId(cursor.id) || Number.isNaN(date.getTime())) throw fail("Invalid pagination cursor.");
      filter.$or = [{ createdAt: { $lt: date } }, { createdAt: date, _id: { $lt: new mongoose.Types.ObjectId(cursor.id) } }];
    }

    const [orders, rawStats, seller] = await Promise.all([
      Order.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1)
        .populate("products.productId", "name images")
        .populate("userId", "name email")
        .lean(),
      Order.aggregate([
        { $unwind: "$products" },
        { $match: {
          "products.deliveryManId": new mongoose.Types.ObjectId(req.user.id),
          "products.sellerId": new mongoose.Types.ObjectId(req.user.deliverySellerId),
          "products.sellerStatus": { $ne: "Cancelled" },
          status: { $ne: "Cancelled" },
        } },
        { $group: { _id: { orderId: "$_id", status: { $ifNull: ["$products.deliveryStatus", "Assigned"] } } } },
        { $group: { _id: "$_id.status", orders: { $sum: 1 } } },
      ]),
      userModel.findById(req.user.deliverySellerId).select("name").lean(),
    ]);

    const hasMore = orders.length > limit;
    if (hasMore) orders.pop();
    const deliveries = orders.map((order) => {
      const assignedItems = order.products.filter((item) => item.deliveryManId?.toString() === req.user.id && item.sellerId?.toString() === req.user.deliverySellerId && item.sellerStatus !== "Cancelled" && order.status !== "Cancelled");
      const firstItem = assignedItems[0];
      return {
        _id: order._id,
        createdAt: order.createdAt,
        status: firstItem?.deliveryStatus || "Assigned",
        completedAt: firstItem?.deliveredAt || null,
        paymentMethod: order.paymentMethod,
        buyer: { name: order.userId?.name || "Customer", email: order.userId?.email || "" },
        seller: { name: seller?.name || "Store" },
        address: deliveryAddress(order.address),
        products: assignedItems.map((item) => ({
          name: item.productId?.name || "Product",
          image: item.productId?.images?.[0] || "",
          quantity: item.quantity,
          status: item.deliveryStatus || "Assigned",
        })),
      };
    });

    const stats = Object.fromEntries(stages.map((stage) => [stage, 0]));
    rawStats.forEach((item) => { stats[item._id] = item.orders; });
    return res.json({
      success: true,
      deliveries,
      stats: {
        assigned: stats.Assigned || 0,
        pickedUp: stats["Picked Up"] || 0,
        outForDelivery: stats["Out for Delivery"] || 0,
        delivered: stats.Delivered || 0,
        total: Object.values(stats).reduce((sum, count) => sum + count, 0),
      },
      nextCursor: hasMore ? makeCursor(orders.at(-1)) : null,
      hasMore,
    });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error("Assigned delivery lookup failed:", error.message);
    return res.status(status).json({ success: false, message: status >= 500 ? "Could not load assigned deliveries." : error.message });
  }
};

export const updateDeliveryStatus = async (req, res) => {
  let session;
  let verificationError = null;
  try {
    const { orderId, status, verificationCode } = req.body || {};
    if (!mongoose.isValidObjectId(orderId) || !stages.includes(status)) return res.status(400).json({ success: false, message: "Choose a valid order and delivery stage." });
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      verificationError = null;
      const deliveryMan = await userModel.findOneAndUpdate({
        _id: req.user.id,
        isDeliveryMan: true,
        deliverySellerId: req.user.deliverySellerId,
        isAdmin: { $ne: true },
        isOwner: { $ne: true },
      }, { $inc: { deliveryAssignmentRevision: 1 } }, { new: true, session }).select("_id").lean();
      if (!deliveryMan) throw fail("This delivery account is no longer active.", 403);

      const order = await Order.findOne({
        _id: orderId,
        status: { $ne: "Cancelled" },
        products: { $elemMatch: {
          deliveryManId: req.user.id,
          sellerId: req.user.deliverySellerId,
          sellerStatus: { $ne: "Cancelled" },
        } },
      }).select("+deliveryConfirmations").session(session);
      if (!order) throw fail("Assigned delivery not found.", 404);
      const lines = order.products.filter((item) => item.deliveryManId?.toString() === req.user.id && item.sellerId?.toString() === req.user.deliverySellerId && item.sellerStatus !== "Cancelled");
      if (!lines.length) throw fail("This delivery is no longer active.", 409);
      const current = lines[0]?.deliveryStatus || "Assigned";
      if (lines.some((item) => (item.deliveryStatus || "Assigned") !== current)) throw fail("Delivery items are in different stages. Contact the seller.", 409);
      if (current === "Delivered") throw fail("This delivery is already complete.", 409);
      const nextIndex = stages.indexOf(status);
      if (nextIndex !== stages.indexOf(current) + 1) throw fail(`Move this delivery from ${current} to ${stages[stages.indexOf(current) + 1]}.`, 400);

      let confirmation;
      if (status === "Delivered") {
        confirmation = order.deliveryConfirmations.find((item) => item.sellerId.toString() === req.user.deliverySellerId);
        if (!confirmation?.codeHash || !confirmation.codeEncrypted) {
          throw fail("This order has no buyer verification code. Ask the seller to reassign the delivery.", 409);
        }
        const now = new Date();
        if (confirmation.lockedUntil && confirmation.lockedUntil > now) {
          throw fail("Too many incorrect codes. Ask the buyer to wait 10 minutes before trying again.", 429);
        }
        if (!matchesDeliveryCode(verificationCode, confirmation.codeHash)) {
          confirmation.failedAttempts = (confirmation.failedAttempts || 0) + 1;
          if (confirmation.failedAttempts >= 5) confirmation.lockedUntil = new Date(now.getTime() + 10 * 60 * 1000);
          await order.save({ session });
          verificationError = confirmation.lockedUntil
            ? { status: 429, message: "Too many incorrect codes. Try again in 10 minutes." }
            : { status: 400, message: "The buyer verification code is incorrect." };
          return;
        }
        confirmation.codeHash = undefined;
        confirmation.codeEncrypted = undefined;
        confirmation.failedAttempts = 0;
        confirmation.lockedUntil = null;
      }
      const updatedAt = new Date();
      lines.forEach((item) => {
        item.deliveryStatus = status;
        item.deliveryUpdatedAt = updatedAt;
        if (status === "Delivered") item.deliveredAt = updatedAt;
      });
      await order.save({ session });
    });
    if (verificationError) return res.status(verificationError.status).json({ success: false, message: verificationError.message });
    return res.json({ success: true, message: `Delivery updated to ${status}.`, status });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error("Delivery status update failed:", error.message);
    return res.status(status).json({ success: false, message: status >= 500 ? "Could not update delivery status." : error.message });
  } finally {
    if (session) await session.endSession();
  }
};
