import mongoose from "mongoose";
import Order from "../model/orderModel.js";
import Product from "../model/productModel.js";
import userModel from "../model/userModel.js";
import { issueDeliveryCode, revealDeliveryCode } from "../config/deliveryVerification.js";

const orderActionError = (message, statusCode) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const claimLegacyProductsForSingleSeller = async (sellerId) => {
  const sellerCount = await userModel.countDocuments({
    isAdmin: true,
    isOwner: { $ne: true },
    isDeliveryMan: { $ne: true },
  });
  if (sellerCount === 1) {
    await Product.updateMany(
      { $or: [{ sellerId: { $exists: false } }, { sellerId: null }] },
      { $set: { sellerId } }
    );
  }
};

const restoreReservedStock = async (productId, quantity, session) => {
  const options = session ? { session } : {};
  const restoredQuantity = Number(quantity) || 1;
  await Product.updateOne({ _id: productId }, { $inc: { stock: restoredQuantity } }, options);
  await Product.updateOne(
    { _id: productId, isAvailable: false, $expr: { $gt: ["$stock", 0] } },
    { $set: { isAvailable: true } },
    options
  );
};

/**
 * ✅ Get all orders with full details (Admin Only)
 */
export const getAllOrders = async (req, res) => {
  try {
    const orders = await Order.find()
      .populate("products.productId", "name images price") // English Comment: Changed 'image' to 'images' to match your schema
      .populate("userId", "name email")
      .sort({ createdAt: -1 });

    res.status(200).json({ 
      success: true, 
      count: orders.length, 
      orders 
    });
  } catch (err) {
    console.error("❌ Admin Fetch Error:", err.message);
    res.status(500).json({ success: false, message: "Error fetching database records" });
  }
};

export const getSellerOrders = async (req, res) => {
  try {
    const sellerId = req.user.id;
    await claimLegacyProductsForSingleSeller(sellerId);
    const sellerProducts = await Product.find({ sellerId }).select("_id");
    const productIds = sellerProducts.map(({ _id }) => _id);

    const orders = await Order.find({
      $or: [
        { "products.productId": { $in: productIds } },
        { "products.sellerId": sellerId },
      ],
    })
      .populate("products.productId", "name images price sellerId")
      .populate("userId", "name email")
      .sort({ createdAt: -1 });

    const sellerOrders = orders.map((order) => {
      const ownedLines = order.products.filter((item) => {
        const ownerId = item.sellerId || item.productId?.sellerId;
        return ownerId && ownerId.toString() === sellerId;
      });
      if (!ownedLines.length) return null;

      const products = ownedLines.map((item) => {
        const line = item.toObject();
        const previousStatus = line.sellerStatus || order.status || "Order Placed";
        line.sellerStatus = previousStatus === "Pending" ? "Order Placed" : previousStatus;
        line.unitPrice = line.unitPrice || item.productId?.price || 0;
        return line;
      });
      const statuses = products.map((item) => item.sellerStatus);
      const status = statuses.every((value) => value === statuses[0]) ? statuses[0] : "Processing";
      const sellerTotalAmount = products.reduce(
        (sum, item) => sum + Number(item.unitPrice || 0) * Number(item.quantity || 0),
        0
      );

      return {
        ...order.toObject(),
        products,
        status,
        // Do not expose the full marketplace order total to a single seller.
        totalAmount: sellerTotalAmount,
        sellerTotalAmount,
      };
    }).filter(Boolean);

    res.status(200).json({ success: true, orders: sellerOrders });
  } catch (err) {
    console.error("Seller order fetch error:", err.message);
    res.status(500).json({ success: false, message: "Error fetching your orders" });
  }
};

export const updateSellerOrderStatus = async (req, res) => {
  let session;
  try {
    const { orderId, status } = req.body;
    const sellerId = req.user.id;
    const allowedStatuses = ["Order Placed", "Processing", "Shipped", "Delivered", "Cancelled"];
    const statusFlow = ["Order Placed", "Processing", "Shipped", "Delivered"];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid order status" });
    }

    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      const order = await Order.findById(orderId)
        .populate("products.productId", "sellerId")
        .session(session);
      if (!order) throw orderActionError("Order not found", 404);

      const ownedLines = order.products.filter((item) => {
        const ownerId = item.sellerId || item.productId?.sellerId;
        return ownerId && ownerId.toString() === sellerId;
      });
      if (!ownedLines.length) {
        throw orderActionError("No items from your store in this order", 403);
      }

      for (const item of ownedLines) {
        const storedStatus = item.sellerStatus || order.status || "Order Placed";
        const currentStatus = storedStatus === "Pending" ? "Order Placed" : storedStatus;
        if (["Delivered", "Cancelled"].includes(currentStatus)) {
          throw orderActionError(`Status cannot change after ${currentStatus}`, 400);
        }
        const currentIndex = statusFlow.indexOf(currentStatus);
        const nextIndex = statusFlow.indexOf(status);
        if (status !== "Cancelled" && nextIndex < currentIndex) {
          throw orderActionError(`Invalid sequence from ${currentStatus} to ${status}`, 400);
        }

        if (status === "Cancelled" && item.stockReserved) {
          const productId = item.productId?._id || item.productId;
          await restoreReservedStock(productId, item.quantity, session);
          item.stockReserved = false;
        }

        item.sellerId = sellerId;
        item.sellerStatus = status;
      }

      await order.save({ session });
    });

    res.json({ success: true, message: `Your items updated to ${status}`, status });
  } catch (err) {
    console.error("Seller order update error:", err.message);
    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({
      success: false,
      message: statusCode >= 500 ? "Could not update your order items" : err.message,
    });
  } finally {
    if (session) await session.endSession();
  }
};

/**
 * ✅ Get orders for a specific user
 */
export const getUserOrders = async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    const { userId } = req.params;

    if (req.user.id !== userId && !req.user.isOwner) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const orders = await Order.find({ userId })
      .select("+deliveryConfirmations")
      .populate("products.productId", "name images price")
      .populate("products.sellerId", "name")
      .sort({ createdAt: -1 });

    const buyerOrders = await Promise.all(orders.map(async (order) => {
      const record = order.toObject();
      const activeSellerIds = new Set((record.products || [])
        .filter((line) => line.deliveryStatus !== "Delivered" && line.sellerStatus !== "Cancelled" && record.status !== "Cancelled")
        .map((line) => String(line.sellerId?._id || line.sellerId || ""))
        .filter((sellerId) => mongoose.isValidObjectId(sellerId)));
      let confirmations = record.deliveryConfirmations || [];
      if (req.user.id === userId) {
        for (const sellerId of activeSellerIds) {
          if (confirmations.some((item) => item.sellerId.toString() === sellerId && item.codeEncrypted)) continue;
          const issued = issueDeliveryCode();
          const sellerObjectId = new mongoose.Types.ObjectId(sellerId);
          const result = await Order.updateOne(
            { _id: record._id, deliveryConfirmations: { $not: { $elemMatch: { sellerId: sellerObjectId } } } },
            {
              $push: { deliveryConfirmations: { sellerId: sellerObjectId, codeHash: issued.codeHash, codeEncrypted: issued.codeEncrypted, failedAttempts: 0, lockedUntil: null } },
              $inc: { __v: 1 },
            }
          );
          if (result.modifiedCount) {
            confirmations = [...confirmations, { sellerId: sellerObjectId, codeHash: issued.codeHash, codeEncrypted: issued.codeEncrypted }];
          } else {
            const latest = await Order.findById(record._id).select("+deliveryConfirmations").lean();
            confirmations = latest?.deliveryConfirmations || confirmations;
          }
        }
      }
      record.deliveryCodes = req.user.id === userId
        ? confirmations
          .filter((item) => activeSellerIds.has(item.sellerId.toString()) && item.codeEncrypted)
          .map((item) => ({
            sellerId: item.sellerId.toString(),
            sellerName: record.products.find((line) => String(line.sellerId?._id || line.sellerId || "") === item.sellerId.toString())?.sellerId?.name || "Seller",
            code: revealDeliveryCode(item.codeEncrypted),
          }))
        : [];
      delete record.deliveryConfirmations;
      return record;
    }));

    res.status(200).json({ success: true, orders: buyerOrders });
  } catch (err) {
    res.status(500).json({ success: false, message: "Error fetching your orders" });
  }
};

/**
 * ✅ Update order status (Premium State Machine Logic)
 */
export const updateOrderStatus = async (req, res) => {
  let session;
  try {
    const { orderId, status } = req.body;
    const statusFlow = ["Order Placed", "Processing", "Shipped", "Delivered"];
    const finalStatuses = ["Delivered", "Cancelled"];
    const allowedStatuses = [...statusFlow, "Cancelled"];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid order status" });
    }

    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      const order = await Order.findById(orderId).session(session);
      if (!order) throw orderActionError("Order not found", 404);

      if (finalStatuses.includes(order.status)) {
        throw orderActionError(`Status cannot be changed. Order is already ${order.status}.`, 400);
      }

      const currentIndex = statusFlow.indexOf(order.status);
      const newIndex = statusFlow.indexOf(status);
      if (status !== "Cancelled" && newIndex < currentIndex) {
        throw orderActionError(`Invalid sequence. You cannot move from ${order.status} to ${status}.`, 400);
      }

      if (status === "Cancelled") {
        for (const item of order.products) {
          if (item.stockReserved) {
            await restoreReservedStock(item.productId, item.quantity, session);
            item.stockReserved = false;
          }
          item.sellerStatus = "Cancelled";
        }
      }

      order.status = status;
      await order.save({ session });
    });

    res.json({ 
      success: true, 
      message: `Order successfully updated to ${status}`,
      status
    });
  } catch (err) {
    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({
      success: false,
      message: statusCode >= 500 ? "Order status update failed" : err.message,
    });
  } finally {
    if (session) await session.endSession();
  }
};

/**
 * ✅ Client Self-Cancellation (Enhanced Security)
 */
export const clientCancelOrder = async (req, res) => {
  let session;
  try {
    const { orderId } = req.body;
    const userId = req.user.id;
    let cancelledOrder;

    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      const order = await Order.findById(orderId).session(session);
      if (!order) throw orderActionError("Order record missing", 404);

      if (order.userId.toString() !== userId) {
        throw orderActionError("Unauthorized action", 403);
      }

      if (order.status !== "Order Placed" && order.status !== "Pending") {
        throw orderActionError(`Cancellation locked. Order is already in ${order.status} stage.`, 400);
      }

      const cancellableLineStatuses = new Set(["Order Placed", "Pending", "Cancelled"]);
      const hasProgressedLine = order.products.some((item) => {
        const lineStatus = item.sellerStatus || order.status || "Order Placed";
        return !cancellableLineStatuses.has(lineStatus);
      });
      if (hasProgressedLine) {
        throw orderActionError("Cancellation is locked after a seller starts processing an item.", 400);
      }

      for (const item of order.products) {
        if (item.stockReserved) {
          await restoreReservedStock(item.productId, item.quantity, session);
          item.stockReserved = false;
        }
        item.sellerStatus = "Cancelled";
      }

      order.status = "Cancelled";
      await order.save({ session });
      cancelledOrder = order;
    });

    res.json({ success: true, message: "Order revoked successfully", order: cancelledOrder });
  } catch (err) {
    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({
      success: false,
      message: statusCode >= 500 ? "Cancellation process interrupted" : err.message,
    });
  } finally {
    if (session) await session.endSession();
  }
};
