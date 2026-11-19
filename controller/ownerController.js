import mongoose from "mongoose";
import bcrypt from "bcrypt";
import validator from "validator";
import userModel from "../model/userModel.js";
import Product from "../model/productModel.js";
import Order from "../model/orderModel.js";

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const getOwnerDashboardSummary = async (req, res) => {
  try {
    const [userStats, productStats, orderStats] = await Promise.all([
      userModel.aggregate([
        {
          $group: {
            _id: null,
            sellers: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: [{ $ifNull: ["$isAdmin", false] }, true] },
                      { $ne: [{ $ifNull: ["$isOwner", false] }, true] },
                      { $ne: [{ $ifNull: ["$isDeliveryMan", false] }, true] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            customers: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $ne: [{ $ifNull: ["$isAdmin", false] }, true] },
                      { $ne: [{ $ifNull: ["$isOwner", false] }, true] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),
      Product.aggregate([
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            available: {
              $sum: { $cond: [{ $eq: ["$isAvailable", true] }, 1, 0] },
            },
          },
        },
      ]),
      Order.aggregate([
        {
          $facet: {
            totals: [
              {
                $group: {
                  _id: null,
                  total: { $sum: 1 },
                  open: {
                    $sum: {
                      $cond: [
                        { $in: ["$status", ["Pending", "Order Placed", "Processing", "Shipped"]] },
                        1,
                        0,
                      ],
                    },
                  },
                  orderValue: {
                    $sum: {
                      $cond: [
                        { $ne: ["$status", "Cancelled"] },
                        { $ifNull: ["$totalAmount", 0] },
                        0,
                      ],
                    },
                  },
                },
              },
            ],
            topSellers: [
              { $match: { status: { $ne: "Cancelled" } } },
              { $unwind: "$products" },
              { $match: { "products.sellerStatus": { $ne: "Cancelled" } } },
              {
                $lookup: {
                  from: Product.collection.name,
                  localField: "products.productId",
                  foreignField: "_id",
                  as: "sourceProduct",
                },
              },
              {
                $addFields: {
                  sellerId: {
                    $ifNull: ["$products.sellerId", { $arrayElemAt: ["$sourceProduct.sellerId", 0] }],
                  },
                  linePrice: {
                    $ifNull: ["$products.unitPrice", { $arrayElemAt: ["$sourceProduct.price", 0] }],
                  },
                  lineQuantity: { $ifNull: ["$products.quantity", 1] },
                },
              },
              { $match: { sellerId: { $ne: null } } },
              {
                $group: {
                  _id: { sellerId: "$sellerId", orderId: "$_id" },
                  sales: { $sum: { $multiply: ["$linePrice", "$lineQuantity"] } },
                  items: { $sum: "$lineQuantity" },
                },
              },
              {
                $lookup: {
                  from: userModel.collection.name,
                  localField: "_id.sellerId",
                  foreignField: "_id",
                  as: "seller",
                },
              },
              { $unwind: "$seller" },
              { $match: { "seller.isAdmin": true, "seller.isOwner": { $ne: true }, "seller.isDeliveryMan": { $ne: true } } },
              {
                $group: {
                  _id: "$_id.sellerId",
                  name: { $first: "$seller.name" },
                  email: { $first: "$seller.email" },
                  avatar: { $first: "$seller.avatar" },
                  sales: { $sum: "$sales" },
                  items: { $sum: "$items" },
                  orders: { $sum: 1 },
                },
              },
              { $sort: { sales: -1, orders: -1, _id: 1 } },
              { $limit: 3 },
              {
                $lookup: {
                  from: Product.collection.name,
                  let: { sellerId: "$_id" },
                  pipeline: [
                    { $match: { $expr: { $eq: ["$sellerId", "$$sellerId"] } } },
                    { $count: "count" },
                  ],
                  as: "productStats",
                },
              },
              {
                $project: {
                  _id: 1,
                  name: 1,
                  email: 1,
                  avatar: { $ifNull: ["$avatar", ""] },
                  sales: 1,
                  orderCount: "$orders",
                  itemCount: "$items",
                  productCount: { $ifNull: [{ $arrayElemAt: ["$productStats.count", 0] }, 0] },
                },
              },
            ],
          },
        },
      ]),
    ]);

    const users = userStats[0] || { sellers: 0, customers: 0 };
    const products = productStats[0] || { total: 0, available: 0 };
    const orderData = orderStats[0] || {};
    const orders = orderData.totals?.[0] || { total: 0, open: 0, orderValue: 0 };

    return res.json({
      success: true,
      summary: {
        sellers: users.sellers,
        customers: users.customers,
        products: products.total,
        availableProducts: products.available,
        orders: orders.total,
        openOrders: orders.open,
        orderValue: orders.orderValue,
      },
      topSellers: orderData.topSellers || [],
    });
  } catch (error) {
    console.error("Owner dashboard summary failed:", error.message);
    return res.status(500).json({ success: false, message: "Could not load dashboard summary" });
  }
};

export const getOwnerSellers = async (req, res) => {
  try {
    if (req.query.limit !== undefined && typeof req.query.limit !== "string") {
      return res.status(400).json({ success: false, message: "Invalid page size" });
    }
    const requestedLimit = req.query.limit === undefined ? 12 : Number(req.query.limit);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
      return res.status(400).json({ success: false, message: "Invalid page size" });
    }
    const limit = Math.min(requestedLimit, 50);

    const searchValue = req.query.search === undefined ? "" : req.query.search;
    if (typeof searchValue !== "string" || searchValue.length > 80) {
      return res.status(400).json({ success: false, message: "Invalid seller search" });
    }
    const search = searchValue.trim();

    const filter = { isAdmin: true, isOwner: { $ne: true }, isDeliveryMan: { $ne: true } };
    if (search) {
      const safeSearch = new RegExp(escapeRegex(search), "i");
      filter.$or = [{ name: safeSearch }, { email: safeSearch }];
    }

    if (req.query.cursor !== undefined) {
      if (typeof req.query.cursor !== "string" || !mongoose.isValidObjectId(req.query.cursor)) {
        return res.status(400).json({ success: false, message: "Invalid pagination cursor" });
      }
      filter._id = { $lt: new mongoose.Types.ObjectId(req.query.cursor) };
    }

    const rows = await userModel
      .find(filter)
      .select("_id name email avatar createdAt")
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = rows.length > limit;
    const sellers = hasMore ? rows.slice(0, limit) : rows;

    return res.json({
      success: true,
      sellers,
      hasMore,
      nextCursor: hasMore ? sellers[sellers.length - 1]._id.toString() : null,
    });
  } catch (error) {
    console.error("Owner seller list failed:", error.message);
    return res.status(500).json({ success: false, message: "Could not load sellers" });
  }
};

export const getOwnerCustomers = async (req, res) => {
  try {
    if (req.query.limit !== undefined && typeof req.query.limit !== "string") {
      return res.status(400).json({ success: false, message: "Invalid page size" });
    }
    const requestedLimit = req.query.limit === undefined ? 12 : Number(req.query.limit);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
      return res.status(400).json({ success: false, message: "Invalid page size" });
    }
    const limit = Math.min(requestedLimit, 50);

    const searchValue = req.query.search === undefined ? "" : req.query.search;
    if (typeof searchValue !== "string" || searchValue.length > 80) {
      return res.status(400).json({ success: false, message: "Invalid customer search" });
    }
    const search = searchValue.trim();

    const filter = { isAdmin: { $ne: true }, isOwner: { $ne: true } };
    if (search) {
      const safeSearch = new RegExp(escapeRegex(search), "i");
      filter.$or = [{ name: safeSearch }, { email: safeSearch }];
    }

    if (req.query.cursor !== undefined) {
      if (typeof req.query.cursor !== "string" || !mongoose.isValidObjectId(req.query.cursor)) {
        return res.status(400).json({ success: false, message: "Invalid pagination cursor" });
      }
      filter._id = { $lt: new mongoose.Types.ObjectId(req.query.cursor) };
    }

    const rows = await userModel
      .find(filter)
      .select("_id name email avatar createdAt")
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = rows.length > limit;
    const customers = hasMore ? rows.slice(0, limit) : rows;

    return res.json({
      success: true,
      customers,
      hasMore,
      nextCursor: hasMore ? customers[customers.length - 1]._id.toString() : null,
    });
  } catch (error) {
    console.error("Owner customer lookup failed:", error.message);
    return res.status(500).json({ success: false, message: "Could not load customer accounts" });
  }
};

export const createOwnerSeller = async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    const cleanName = typeof name === "string" ? name.trim() : "";
    const cleanEmail = typeof email === "string" ? email.trim() : "";

    if (cleanName.length < 2 || cleanName.length > 80) {
      return res.status(400).json({ success: false, message: "Name must be between 2 and 80 characters" });
    }
    if (!validator.isEmail(cleanEmail) || cleanEmail.length > 254) {
      return res.status(400).json({ success: false, message: "Enter a valid email address" });
    }
    if (
      typeof password !== "string" ||
      password.length < 8 ||
      Buffer.byteLength(password, "utf8") > 72
    ) {
      return res.status(400).json({ success: false, message: "Password must be 8 or more characters and no more than 72 bytes" });
    }

    const existingUser = await userModel
      .findOne({ email: new RegExp(`^${escapeRegex(cleanEmail)}$`, "i") })
      .select("_id")
      .lean();
    if (existingUser) {
      return res.status(409).json({ success: false, message: "An account with this email already exists" });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    const seller = await userModel.create({
      name: cleanName,
      email: cleanEmail,
      password: hashedPassword,
      isAdmin: true,
      isOwner: false,
    });

    return res.status(201).json({
      success: true,
      seller: {
        _id: seller._id,
        name: seller.name,
        email: seller.email,
        avatar: seller.avatar || "",
        isAdmin: true,
        isOwner: false,
        createdAt: seller.createdAt,
      },
    });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, message: "An account with this email already exists" });
    }
    console.error("Owner seller creation failed:", error.message);
    return res.status(500).json({ success: false, message: "Could not create seller account" });
  }
};

export const updateSellerAccess = async (req, res) => {
  try {
    const { userId } = req.params;
    const { isAdmin } = req.body || {};
    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ success: false, message: "Invalid account ID" });
    }
    if (typeof isAdmin !== "boolean") {
      return res.status(400).json({ success: false, message: "Seller access must be true or false" });
    }

    const updatedUser = await userModel
      .findOneAndUpdate(
        { _id: userId, isOwner: { $ne: true }, isDeliveryMan: { $ne: true } },
        {
          $set: isAdmin
            ? { isAdmin: true }
            : { isAdmin: false },
        },
        { new: true, runValidators: true }
      )
      .select("_id name email avatar isAdmin isOwner createdAt")
      .lean();

    if (!updatedUser) {
      const account = await userModel.findById(userId).select("isOwner isDeliveryMan").lean();
      return res.status(account ? 403 : 404).json({
        success: false,
        message: account?.isOwner
          ? "Owner accounts cannot be changed to seller accounts"
          : account?.isDeliveryMan
            ? "Delivery accounts cannot be granted seller access while delivery access is active"
            : "Account not found",
      });
    }

    return res.json({ success: true, user: updatedUser });
  } catch (error) {
    console.error("Seller permission update failed:", error.message);
    return res.status(500).json({ success: false, message: "Could not update seller access" });
  }
};
