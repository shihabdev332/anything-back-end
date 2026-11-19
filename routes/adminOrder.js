import express from "express";
import mongoose from "mongoose";
import Order from "../model/orderModel.js";
import { 
  getAllOrders, 
  getSellerOrders,
  updateSellerOrderStatus,
  updateOrderStatus, 
  clientCancelOrder,
  getUserOrders,
} from "../controller/orderController.js";
import sellerAuth from "../middleware/sellerAuth.js";
import ownerAuth from "../middleware/ownerAuth.js";
import { verifyToken } from "../middleware/verifyToken.js";
import Product from "../model/productModel.js";
import userModel from "../model/userModel.js";

const router = express.Router();

const checkoutError = (message, statusCode = 400) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const hasSellerRole = (user) => Boolean(user.isAdmin && !user.isOwner && !user.isDeliveryMan);

/**
 * @route   POST /api/order/create
 * @desc    Create a new order
 */
router.post("/create", verifyToken, async (req, res) => {
  const reservedStock = [];
  let orderSaved = false;

  try {
    const requestedProducts = Array.isArray(req.body.products) ? req.body.products : [];

    if (requestedProducts.length === 0) {
      throw checkoutError("Your cart is empty.");
    }

    // Merge duplicate product lines before checking or reserving stock.
    const quantitiesByProduct = new Map();
    for (const item of requestedProducts) {
      if (!item || !mongoose.isValidObjectId(item.productId)) {
        throw checkoutError("The cart contains an invalid product.");
      }

      const quantity = Number(item.quantity);
      if (!Number.isSafeInteger(quantity) || quantity < 1) {
        throw checkoutError("Product quantities must be positive whole numbers.");
      }

      const productId = String(item.productId);
      const combinedQuantity = (quantitiesByProduct.get(productId) || 0) + quantity;
      if (!Number.isSafeInteger(combinedQuantity)) {
        throw checkoutError("The requested quantity is too large.");
      }
      quantitiesByProduct.set(productId, combinedQuantity);
    }

    const productIds = [...quantitiesByProduct.keys()];

    const address = typeof req.body.address === "string"
      ? req.body.address.trim()
      : req.body.address;
    const validAddress = typeof address === "string"
      ? address.length > 0
      : address && typeof address === "object" && !Array.isArray(address) && Object.keys(address).length > 0;
    if (!validAddress) {
      throw checkoutError("A delivery address is required.");
    }

    const paymentMethod = req.body.paymentMethod || "Cash on Delivery";
    if (paymentMethod !== "Cash on Delivery") {
      throw checkoutError("The selected payment method is not available.");
    }

    if (hasSellerRole(req.user)) {
      const sellerCount = await userModel.countDocuments({
        isAdmin: true,
        isOwner: { $ne: true },
        isDeliveryMan: { $ne: true },
      });
      if (sellerCount === 1) {
        await Product.updateMany(
          { $or: [{ sellerId: { $exists: false } }, { sellerId: null }] },
          { $set: { sellerId: req.user.id } }
        );
      }
    }

    const productRecords = await Product.find({ _id: { $in: productIds } })
      .select("_id name sellerId price stock isAvailable");
    const productById = new Map(productRecords.map((product) => [product._id.toString(), product]));
    if (productById.size !== quantitiesByProduct.size) {
      throw checkoutError("One or more products are no longer available.", 409);
    }

    const orderProducts = [...quantitiesByProduct.entries()].map(([productId, quantity]) => {
      const product = productById.get(productId);
      const unitPrice = Number(product.price);
      const stock = Number(product.stock);

      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        throw checkoutError("A product has an invalid price.", 409);
      }
      if (!product.isAvailable || !Number.isSafeInteger(stock) || stock < quantity) {
        throw checkoutError(`${product.name || "A product"} does not have enough stock.`, 409);
      }

      return {
        productId: product._id,
        sellerId: product.sellerId,
        unitPrice,
        quantity,
        sellerStatus: "Order Placed",
        stockReserved: true,
      };
    });

    const ownProduct = orderProducts.find((item) => item.sellerId?.toString() === req.user.id);
    if (ownProduct) {
      return res.status(403).json({
        success: false,
        message: "You cannot purchase your own product. Remove it from your cart to continue.",
      });
    }

    const unassignedProduct = hasSellerRole(req.user) && orderProducts.some((item) => !item.sellerId);
    if (unassignedProduct) {
      return res.status(403).json({
        success: false,
        message: "This product has no assigned seller, so seller accounts cannot purchase it.",
      });
    }

    const totalAmountInCents = orderProducts.reduce(
      (sum, item) => sum + Math.round(item.unitPrice * 100) * item.quantity,
      0
    );
    if (!Number.isSafeInteger(totalAmountInCents)) {
      throw checkoutError("The order total is invalid.", 409);
    }
    const totalAmount = totalAmountInCents / 100;

    // Reserve each line atomically so concurrent checkouts cannot oversell.
    for (const item of orderProducts) {
      const sourceProduct = productById.get(item.productId.toString());
      const reservedProduct = await Product.findOneAndUpdate(
        {
          _id: item.productId,
          sellerId: sourceProduct.sellerId ?? null,
          price: item.unitPrice,
          isAvailable: true,
          stock: { $gte: item.quantity },
        },
        { $inc: { stock: -item.quantity } },
        { new: true }
      );

      if (!reservedProduct) {
        throw checkoutError("Stock or product details changed. Please review your cart and try again.", 409);
      }
      if (reservedProduct.stock === 0) {
        await Product.updateOne({ _id: item.productId, stock: 0 }, { $set: { isAvailable: false } });
      }
      reservedStock.push({ productId: item.productId, quantity: item.quantity });
    }

    const newOrder = new Order({
      userId: req.user.id,
      products: orderProducts,
      totalAmount,
      address,
      paymentMethod,
      // status is intentionally omitted; the schema supplies the initial status.
    });
    await newOrder.save();
    orderSaved = true;
    
    res.status(201).json({ 
      success: true, 
      message: "Order placed successfully!",
      order: newOrder 
    });
  } catch (error) {
    if (!orderSaved && reservedStock.length > 0) {
      const rollbackResults = await Promise.allSettled(
        reservedStock.map(async ({ productId, quantity }) => {
          await Product.updateOne({ _id: productId }, { $inc: { stock: quantity } });
          await Product.updateOne(
            { _id: productId, isAvailable: false, $expr: { $gt: ["$stock", 0] } },
            { $set: { isAvailable: true } }
          );
        })
      );
      if (rollbackResults.some((result) => result.status === "rejected")) {
        console.error("Checkout stock rollback failed for one or more products.");
      }
    }

    const statusCode = error.statusCode || 500;
    const message = statusCode >= 500 ? "Could not place the order. Please try again." : error.message;
    res.status(statusCode).json({ success: false, message });
  }
});

/**
 * @route   GET /api/order/user/:userId
 * @desc    Get all orders for a specific user
 */
router.get("/user/:userId", verifyToken, async (req, res) => {
  return getUserOrders(req, res);
});

/**
 * @route   PUT /api/order/cancel
 * @desc    Cancel order by client (Added this to fix 404)
 */
router.put("/cancel", verifyToken, clientCancelOrder);

/**
 * @route   GET /api/order/all
 * @desc    Admin: Get all orders
 */
router.get("/all", ownerAuth, getAllOrders);

router.get("/seller", sellerAuth, getSellerOrders);

router.put("/seller/status", sellerAuth, updateSellerOrderStatus);

/**
 * @route   PUT /api/order/status
 * @desc    Admin: Update status
 */
router.put("/status", ownerAuth, updateOrderStatus);

export default router;
