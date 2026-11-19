import mongoose from "mongoose";
import Order from "../model/orderModel.js";
import Product from "../model/productModel.js";
import userModel from "../model/userModel.js";

const RANGE_DAYS = { "7d": 7, "30d": 30, "6m": 183, "12m": 365 };
const OPEN_STATUSES = ["Pending", "Order Placed", "Processing", "Shipped"];
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parseMonth = (value, now) => {
  if (value === undefined) {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return null;
  const [year, month] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, 1));
  const currentMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return date > currentMonth ? null : date;
};

const monthString = (date) => date.toISOString().slice(0, 7);

const makeOrderAnalyticsPipeline = ({ now, rangeStart, rangeEnd, previousStart, selectedMonth, reportEnd }) => {
  const nextMonth = new Date(Date.UTC(selectedMonth.getUTCFullYear(), selectedMonth.getUTCMonth() + 1, 1));
  const previousMonthStart = new Date(Date.UTC(selectedMonth.getUTCFullYear(), selectedMonth.getUTCMonth() - 1, 1));
  const historyStart = new Date(Date.UTC(selectedMonth.getUTCFullYear(), selectedMonth.getUTCMonth() - 12, 1));
  const bucketFormat = rangeEnd.getTime() - rangeStart.getTime() <= 31 * 24 * 60 * 60 * 1000 ? "%Y-%m-%d" : "%Y-%m";
  const salesExpression = {
    $round: [{ $multiply: [
      { $cond: [{ $isNumber: "$activeLines.unitPrice" }, "$activeLines.unitPrice", 0] },
      { $ifNull: ["$activeLines.quantity", 0] },
    ] }, 2],
  };
  const productPerformanceStages = [
    { $match: { createdAt: { $gte: previousStart, $lt: rangeEnd }, status: { $ne: "Cancelled" } } },
    { $unwind: "$activeLines" },
    { $match: { "activeLines.unitPrice": { $type: "number" } } },
    {
      $addFields: {
        performancePeriod: { $cond: [{ $gte: ["$createdAt", rangeStart] }, "current", "previous"] },
        lineSales: salesExpression,
      },
    },
    {
      $group: {
        _id: { productId: "$activeLines.productId", period: "$performancePeriod", orderId: "$_id" },
        sales: { $sum: "$lineSales" },
        units: { $sum: { $ifNull: ["$activeLines.quantity", 0] } },
      },
    },
    {
      $group: {
        _id: { productId: "$_id.productId", period: "$_id.period" },
        sales: { $sum: "$sales" },
        units: { $sum: "$units" },
        orders: { $sum: 1 },
      },
    },
    {
      $group: {
        _id: "$_id.productId",
        currentSales: { $sum: { $cond: [{ $eq: ["$_id.period", "current"] }, "$sales", 0] } },
        previousSales: { $sum: { $cond: [{ $eq: ["$_id.period", "previous"] }, "$sales", 0] } },
        units: { $sum: { $cond: [{ $eq: ["$_id.period", "current"] }, "$units", 0] } },
        orders: { $sum: { $cond: [{ $eq: ["$_id.period", "current"] }, "$orders", 0] } },
      },
    },
    {
      $lookup: {
        from: Product.collection.name,
        localField: "_id",
        foreignField: "_id",
        as: "product",
      },
    },
    {
      $project: {
        _id: 0,
        productId: "$_id",
        name: { $ifNull: [{ $arrayElemAt: ["$product.name", 0] }, "Deleted product"] },
        category: { $ifNull: [{ $arrayElemAt: ["$product.category", 0] }, "Uncategorized"] },
        image: { $ifNull: [{ $arrayElemAt: [{ $arrayElemAt: ["$product.images", 0] }, 0] }, ""] },
        stock: { $ifNull: [{ $arrayElemAt: ["$product.stock", 0] }, null] },
        currentSales: 1,
        previousSales: 1,
        units: 1,
        orders: 1,
      },
    },
  ];

  return [
    {
      $set: {
        activeLines: {
          $filter: {
            input: { $ifNull: ["$products", []] },
            as: "line",
            cond: { $ne: ["$$line.sellerStatus", "Cancelled"] },
          },
        },
      },
    },
    {
      $set: {
        lineValue: {
          $sum: {
            $map: {
              input: "$activeLines",
              as: "line",
              in: { $round: [{
                $multiply: [
                  { $cond: [{ $isNumber: "$$line.unitPrice" }, "$$line.unitPrice", 0] },
                  { $ifNull: ["$$line.quantity", 0] },
                ],
              }, 2] },
            },
          },
        },
        itemCount: {
          $sum: {
            $map: {
              input: "$activeLines",
              as: "line",
              in: { $ifNull: ["$$line.quantity", 0] },
            },
          },
        },
        pricedItemCount: {
          $sum: {
            $map: {
              input: "$activeLines",
              as: "line",
              in: {
                $cond: [
                  { $isNumber: "$$line.unitPrice" },
                  { $ifNull: ["$$line.quantity", 0] },
                  0,
                ],
              },
            },
          },
        },
      },
    },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              totalOrders: { $sum: 1 },
              cancelledOrders: { $sum: { $cond: [{ $eq: ["$status", "Cancelled"] }, 1, 0] } },
              completedOrders: { $sum: { $cond: [{ $eq: ["$status", "Delivered"] }, 1, 0] } },
              openOrders: { $sum: { $cond: [{ $in: ["$status", OPEN_STATUSES] }, 1, 0] } },
              totalOrderValue: {
                $sum: { $cond: [{ $ne: ["$status", "Cancelled"] }, "$lineValue", 0] },
              },
              billableOrders: { $sum: { $cond: [{ $and: [{ $ne: ["$status", "Cancelled"] }, { $gt: ["$pricedItemCount", 0] }] }, 1, 0] } },
            },
          },
        ],
        periodStats: [
          { $match: { createdAt: { $gte: previousStart, $lt: rangeEnd } } },
          {
            $group: {
              _id: { $cond: [{ $gte: ["$createdAt", rangeStart] }, "current", "previous"] },
              orders: { $sum: 1 },
              cancelledOrders: { $sum: { $cond: [{ $eq: ["$status", "Cancelled"] }, 1, 0] } },
              completedOrders: { $sum: { $cond: [{ $eq: ["$status", "Delivered"] }, 1, 0] } },
              orderValue: {
                $sum: { $cond: [{ $ne: ["$status", "Cancelled"] }, "$lineValue", 0] },
              },
              billableOrders: { $sum: { $cond: [{ $and: [{ $ne: ["$status", "Cancelled"] }, { $gt: ["$pricedItemCount", 0] }] }, 1, 0] } },
            },
          },
        ],
        series: [
          { $match: { createdAt: { $gte: rangeStart, $lt: rangeEnd }, status: { $ne: "Cancelled" } } },
          { $unwind: "$activeLines" },
          { $match: { "activeLines.unitPrice": { $type: "number" } } },
          {
            $group: {
              _id: {
                orderId: "$_id",
                bucket: { $dateToString: { format: bucketFormat, date: "$createdAt", timezone: "UTC" } },
              },
              orderValue: { $sum: salesExpression },
              items: { $sum: { $ifNull: ["$activeLines.quantity", 0] } },
            },
          },
          {
            $group: {
              _id: "$_id.bucket",
              orderValue: { $sum: "$orderValue" },
              orders: { $sum: 1 },
              items: { $sum: "$items" },
            },
          },
          { $sort: { _id: 1 } },
          { $project: { _id: 0, bucket: "$_id", orderValue: 1, orders: 1, items: 1 } },
        ],
        monthlyHistory: [
          { $match: { createdAt: { $gte: historyStart, $lt: reportEnd }, status: { $ne: "Cancelled" } } },
          { $unwind: "$activeLines" },
          { $match: { "activeLines.unitPrice": { $type: "number" } } },
          {
            $group: {
              _id: {
                orderId: "$_id",
                month: { $dateToString: { format: "%Y-%m", date: "$createdAt", timezone: "UTC" } },
              },
              orderValue: { $sum: salesExpression },
            },
          },
          {
            $group: {
              _id: "$_id.month",
              orderValue: { $sum: "$orderValue" },
              orders: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
          { $project: { _id: 0, month: "$_id", orderValue: 1, orders: 1 } },
        ],
        reportCategories: [
          { $match: { createdAt: { $gte: previousMonthStart, $lt: reportEnd }, status: { $ne: "Cancelled" } } },
          { $unwind: "$activeLines" },
          { $match: { "activeLines.unitPrice": { $type: "number" } } },
          {
            $addFields: {
              reportPeriod: { $cond: [{ $gte: ["$createdAt", selectedMonth] }, "current", "previous"] },
              lineSales: salesExpression,
            },
          },
          {
            $lookup: {
              from: Product.collection.name,
              localField: "activeLines.productId",
              foreignField: "_id",
              as: "product",
            },
          },
          { $addFields: { category: { $ifNull: [{ $arrayElemAt: ["$product.category", 0] }, "Uncategorized"] } } },
          {
            $group: {
              _id: { category: "$category", period: "$reportPeriod", orderId: "$_id" },
              sales: { $sum: "$lineSales" },
            },
          },
          {
            $group: {
              _id: { category: "$_id.category", period: "$_id.period" },
              sales: { $sum: "$sales" },
            },
          },
          {
            $group: {
              _id: "$_id.category",
              currentSales: { $sum: { $cond: [{ $eq: ["$_id.period", "current"] }, "$sales", 0] } },
              previousSales: { $sum: { $cond: [{ $eq: ["$_id.period", "previous"] }, "$sales", 0] } },
            },
          },
          { $project: { _id: 0, category: "$_id", currentSales: 1, previousSales: 1 } },
          { $sort: { currentSales: -1, previousSales: -1 } },
          { $limit: 12 },
        ],
        reportProducts: [
          { $match: { createdAt: { $gte: previousMonthStart, $lt: reportEnd }, status: { $ne: "Cancelled" } } },
          { $unwind: "$activeLines" },
          { $match: { "activeLines.unitPrice": { $type: "number" } } },
          {
            $addFields: {
              reportPeriod: { $cond: [{ $gte: ["$createdAt", selectedMonth] }, "current", "previous"] },
              lineSales: salesExpression,
            },
          },
          {
            $group: {
              _id: { productId: "$activeLines.productId", period: "$reportPeriod", orderId: "$_id" },
              sales: { $sum: "$lineSales" },
              units: { $sum: { $ifNull: ["$activeLines.quantity", 0] } },
            },
          },
          {
            $group: {
              _id: { productId: "$_id.productId", period: "$_id.period" },
              sales: { $sum: "$sales" },
              units: { $sum: "$units" },
            },
          },
          {
            $group: {
              _id: "$_id.productId",
              currentSales: { $sum: { $cond: [{ $eq: ["$_id.period", "current"] }, "$sales", 0] } },
              previousSales: { $sum: { $cond: [{ $eq: ["$_id.period", "previous"] }, "$sales", 0] } },
              units: { $sum: { $cond: [{ $eq: ["$_id.period", "current"] }, "$units", 0] } },
            },
          },
          {
            $lookup: {
              from: Product.collection.name,
              localField: "_id",
              foreignField: "_id",
              as: "product",
            },
          },
          {
            $project: {
              _id: 0,
              productId: "$_id",
              name: { $ifNull: [{ $arrayElemAt: ["$product.name", 0] }, "Deleted product"] },
              category: { $ifNull: [{ $arrayElemAt: ["$product.category", 0] }, "Uncategorized"] },
              currentSales: 1,
              previousSales: 1,
              units: 1,
            },
          },
          { $sort: { currentSales: -1, previousSales: -1 } },
          { $limit: 12 },
        ],
        monthComparison: [
          {
            $match: {
              createdAt: { $gte: previousMonthStart, $lt: reportEnd },
            },
          },
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m", date: "$createdAt", timezone: "UTC" } },
              orders: { $sum: 1 },
              cancelledOrders: { $sum: { $cond: [{ $eq: ["$status", "Cancelled"] }, 1, 0] } },
              completedOrders: { $sum: { $cond: [{ $eq: ["$status", "Delivered"] }, 1, 0] } },
              orderValue: {
                $sum: { $cond: [{ $ne: ["$status", "Cancelled"] }, "$lineValue", 0] },
              },
              billableOrders: { $sum: { $cond: [{ $and: [{ $ne: ["$status", "Cancelled"] }, { $gt: ["$pricedItemCount", 0] }] }, 1, 0] } },
            },
          },
          { $sort: { _id: 1 } },
          { $project: { _id: 0, month: "$_id", orders: 1, cancelledOrders: 1, completedOrders: 1, orderValue: 1, billableOrders: 1 } },
        ],
        currentMonthComparison: [
          { $match: { createdAt: { $gte: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)), $lt: now } } },
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m", date: "$createdAt", timezone: "UTC" } },
              orders: { $sum: 1 },
              cancelledOrders: { $sum: { $cond: [{ $eq: ["$status", "Cancelled"] }, 1, 0] } },
              completedOrders: { $sum: { $cond: [{ $eq: ["$status", "Delivered"] }, 1, 0] } },
              orderValue: { $sum: { $cond: [{ $ne: ["$status", "Cancelled"] }, "$lineValue", 0] } },
              billableOrders: { $sum: { $cond: [{ $and: [{ $ne: ["$status", "Cancelled"] }, { $gt: ["$pricedItemCount", 0] }] }, 1, 0] } },
            },
          },
          { $sort: { _id: 1 } },
          { $project: { _id: 0, month: "$_id", orders: 1, cancelledOrders: 1, completedOrders: 1, orderValue: 1, billableOrders: 1 } },
        ],
        statusDistribution: [
          { $group: { _id: { $ifNull: ["$status", "Unknown"] }, orders: { $sum: 1 } } },
          { $sort: { orders: -1, _id: 1 } },
          { $project: { _id: 0, status: "$_id", orders: 1 } },
        ],
        topProducts: [
          ...productPerformanceStages,
          { $sort: { currentSales: -1, orders: -1 } },
          { $limit: 8 },
        ],
        decliningProducts: [
          ...productPerformanceStages,
          { $match: { $expr: { $gt: ["$previousSales", "$currentSales"] } } },
          { $sort: { currentSales: 1, previousSales: -1 } },
          { $limit: 5 },
        ],
        categoryPerformance: [
          { $match: { createdAt: { $gte: previousStart, $lt: now }, status: { $ne: "Cancelled" } } },
          { $unwind: "$activeLines" },
          { $match: { "activeLines.unitPrice": { $type: "number" } } },
          {
            $addFields: {
              performancePeriod: { $cond: [{ $gte: ["$createdAt", rangeStart] }, "current", "previous"] },
              lineSales: salesExpression,
            },
          },
          {
            $lookup: {
              from: Product.collection.name,
              localField: "activeLines.productId",
              foreignField: "_id",
              as: "product",
            },
          },
          { $addFields: { category: { $ifNull: [{ $arrayElemAt: ["$product.category", 0] }, "Uncategorized"] } } },
          {
            $group: {
              _id: { category: "$category", period: "$performancePeriod", orderId: "$_id" },
              sales: { $sum: "$lineSales" },
              units: { $sum: { $ifNull: ["$activeLines.quantity", 0] } },
            },
          },
          {
            $group: {
              _id: { category: "$_id.category", period: "$_id.period" },
              sales: { $sum: "$sales" },
              units: { $sum: "$units" },
              orders: { $sum: 1 },
            },
          },
          {
            $group: {
              _id: "$_id.category",
              currentSales: { $sum: { $cond: [{ $eq: ["$_id.period", "current"] }, "$sales", 0] } },
              previousSales: { $sum: { $cond: [{ $eq: ["$_id.period", "previous"] }, "$sales", 0] } },
              units: { $sum: { $cond: [{ $eq: ["$_id.period", "current"] }, "$units", 0] } },
              orders: { $sum: { $cond: [{ $eq: ["$_id.period", "current"] }, "$orders", 0] } },
            },
          },
          { $project: { _id: 0, category: "$_id", currentSales: 1, previousSales: 1, units: 1, orders: 1 } },
          { $sort: { currentSales: -1 } },
          { $limit: 8 },
        ],
        topCustomers: [
          { $match: { status: { $ne: "Cancelled" }, pricedItemCount: { $gt: 0 } } },
          {
            $group: {
              _id: "$userId",
              orderValue: { $sum: "$lineValue" },
              orderCount: { $sum: 1 },
            },
          },
          { $sort: { orderValue: -1, orderCount: -1 } },
          { $limit: 5 },
          {
            $lookup: {
              from: userModel.collection.name,
              localField: "_id",
              foreignField: "_id",
              as: "customer",
            },
          },
          {
            $project: {
              _id: 0,
              userId: "$_id",
              name: { $ifNull: [{ $arrayElemAt: ["$customer.name", 0] }, "Deleted customer"] },
              orderValue: 1,
              orderCount: 1,
            },
          },
        ],
        repeatPurchase: [
          { $match: { status: { $ne: "Cancelled" }, pricedItemCount: { $gt: 0 } } },
          { $group: { _id: "$userId", orderCount: { $sum: 1 } } },
          {
            $group: {
              _id: null,
              buyers: { $sum: 1 },
              repeatBuyers: { $sum: { $cond: [{ $gt: ["$orderCount", 1] }, 1, 0] } },
            },
          },
        ],
        topSellers: [
          { $match: { status: { $ne: "Cancelled" } } },
          { $unwind: "$activeLines" },
          { $match: { "activeLines.unitPrice": { $type: "number" } } },
          {
            $lookup: {
              from: Product.collection.name,
              localField: "activeLines.productId",
              foreignField: "_id",
              as: "sourceProduct",
            },
          },
          {
            $addFields: {
              sellerId: { $ifNull: ["$activeLines.sellerId", { $arrayElemAt: ["$sourceProduct.sellerId", 0] }] },
            },
          },
          { $match: { sellerId: { $ne: null } } },
          {
            $group: {
              _id: { sellerId: "$sellerId", orderId: "$_id" },
              orderValue: { $sum: salesExpression },
              items: { $sum: { $ifNull: ["$activeLines.quantity", 0] } },
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
              sales: { $sum: "$orderValue" },
              itemCount: { $sum: "$items" },
              orderCount: { $sum: 1 },
            },
          },
          { $sort: { sales: -1, orderCount: -1, _id: 1 } },
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
              orderCount: 1,
              itemCount: 1,
              productCount: { $ifNull: [{ $arrayElemAt: ["$productStats.count", 0] }, 0] },
            },
          },
        ],
        recentOrders: [
          { $sort: { createdAt: -1, _id: -1 } },
          { $limit: 8 },
          {
            $lookup: {
              from: userModel.collection.name,
              localField: "userId",
              foreignField: "_id",
              as: "customer",
            },
          },
          {
            $project: {
              _id: 1,
              createdAt: 1,
              status: { $ifNull: ["$status", "Unknown"] },
              customerName: { $ifNull: [{ $arrayElemAt: ["$customer.name", 0] }, "Customer"] },
              itemCount: "$itemCount",
              orderValue: { $cond: [{ $ne: ["$status", "Cancelled"] }, "$lineValue", 0] },
            },
          },
        ],
        unpricedOrderLines: [
          { $match: { status: { $ne: "Cancelled" } } },
          { $unwind: "$activeLines" },
          { $match: { $or: [{ "activeLines.unitPrice": { $exists: false } }, { "activeLines.unitPrice": null }] } },
          { $count: "count" },
        ],
      },
    },
  ];
};

export const getOwnerAnalytics = async (req, res) => {
  try {
    const range = req.query.range === undefined ? "30d" : req.query.range;
    if (typeof range !== "string" || (!Object.hasOwn(RANGE_DAYS, range) && range !== "custom")) {
      return res.status(400).json({ success: false, message: "Invalid analytics date range" });
    }

    const now = new Date();
    let rangeStart;
    let rangeEnd = now;
    let previousStart;
    if (range === "custom") {
      const { from, to } = req.query;
      if (typeof from !== "string" || typeof to !== "string"
        || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        return res.status(400).json({ success: false, message: "Custom range needs valid from and to dates" });
      }
      rangeStart = new Date(`${from}T00:00:00.000Z`);
      const inclusiveEnd = new Date(`${to}T00:00:00.000Z`);
      if (!Number.isFinite(rangeStart.getTime()) || !Number.isFinite(inclusiveEnd.getTime())
        || rangeStart.toISOString().slice(0, 10) !== from || inclusiveEnd.toISOString().slice(0, 10) !== to
        || inclusiveEnd < rangeStart || inclusiveEnd > now) {
        return res.status(400).json({ success: false, message: "Custom date range is invalid or in the future" });
      }
      rangeEnd = new Date(inclusiveEnd.getTime() + 24 * 60 * 60 * 1000);
      if (rangeEnd.getTime() - rangeStart.getTime() > 366 * 24 * 60 * 60 * 1000) {
        return res.status(400).json({ success: false, message: "Custom range cannot exceed 366 days" });
      }
      previousStart = new Date(rangeStart.getTime() - (rangeEnd.getTime() - rangeStart.getTime()));
    } else {
      const rangeMonths = range === "6m" ? 6 : range === "12m" ? 12 : 0;
      rangeStart = rangeMonths
        ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - rangeMonths + 1, 1))
        : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - RANGE_DAYS[range] + 1));
      previousStart = rangeMonths
        ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - rangeMonths * 2 + 1, 1))
        : new Date(rangeStart.getTime() - RANGE_DAYS[range] * 24 * 60 * 60 * 1000);
    }
    const selectedMonth = parseMonth(req.query.month, now);
    if (!selectedMonth) {
      return res.status(400).json({ success: false, message: "Invalid report month" });
    }

    const nextMonth = new Date(Date.UTC(selectedMonth.getUTCFullYear(), selectedMonth.getUTCMonth() + 1, 1));
    const reportEnd = new Date(Math.min(nextMonth.getTime(), now.getTime()));
    const historyStart = new Date(Date.UTC(selectedMonth.getUTCFullYear(), selectedMonth.getUTCMonth() - 12, 1));
    const monthStart = selectedMonth;
    const monthEnd = reportEnd;
    const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const currentMonthEnd = now;
    const previousMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

    const [orderResults, userResults, productResults] = await Promise.all([
      Order.aggregate(makeOrderAnalyticsPipeline({ now, rangeStart, rangeEnd, previousStart, selectedMonth, reportEnd }))
        .option({ maxTimeMS: 10000 }),
      userModel.aggregate([
        {
          $facet: {
            totals: [
              { $match: { isAdmin: { $ne: true }, isOwner: { $ne: true } } },
              { $count: "customers" },
            ],
            sellers: [
              { $match: { isAdmin: true, isOwner: { $ne: true }, isDeliveryMan: { $ne: true } } },
              { $count: "count" },
            ],
            signupCoverage: [
              { $match: { isAdmin: { $ne: true }, isOwner: { $ne: true } } },
              {
                $group: {
                  _id: null,
                  tracked: { $sum: { $cond: [{ $ne: [{ $ifNull: ["$createdAt", null] }, null] }, 1, 0] } },
                  missing: { $sum: { $cond: [{ $eq: [{ $ifNull: ["$createdAt", null] }, null] }, 1, 0] } },
                },
              },
            ],
            selectedMonth: [
              { $match: { isAdmin: { $ne: true }, isOwner: { $ne: true } } },
              { $match: { createdAt: { $gte: monthStart, $lt: monthEnd } } },
              { $count: "count" },
            ],
            currentMonthSignups: [
              { $match: { isAdmin: { $ne: true }, isOwner: { $ne: true } } },
              { $match: { createdAt: { $gte: currentMonthStart, $lt: currentMonthEnd } } },
              { $count: "count" },
            ],
            acquisitionHistory: [
              { $match: { isAdmin: { $ne: true }, isOwner: { $ne: true } } },
              { $match: { createdAt: { $gte: historyStart, $lt: reportEnd } } },
              {
                $group: {
                  _id: { $dateToString: { format: "%Y-%m", date: "$createdAt", timezone: "UTC" } },
                  customers: { $sum: 1 },
                },
              },
              { $sort: { _id: 1 } },
              { $project: { _id: 0, month: "$_id", customers: 1 } },
            ],
            recent: [
              { $match: { isAdmin: { $ne: true }, isOwner: { $ne: true } } },
              { $match: { createdAt: { $gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) } } },
              { $sort: { createdAt: -1, _id: -1 } },
              { $limit: 6 },
              { $project: { _id: 1, name: 1, createdAt: 1 } },
            ],
          },
        },
      ]).option({ maxTimeMS: 5000 }),
      Product.aggregate([
        {
          $facet: {
            totals: [
              {
                $group: {
                  _id: null,
                  products: { $sum: 1 },
                  available: { $sum: { $cond: [{ $eq: ["$isAvailable", true] }, 1, 0] } },
                  outOfStock: { $sum: { $cond: [{ $lte: ["$stock", 0] }, 1, 0] } },
                },
              },
            ],
            outOfStockProducts: [
              { $match: { stock: { $lte: 0 } } },
              { $sort: { updatedAt: -1, _id: -1 } },
              { $limit: 5 },
              { $project: { _id: 1, name: 1, category: 1, stock: 1 } },
            ],
          },
        },
      ]).option({ maxTimeMS: 5000 }),
    ]);

    const orderData = orderResults[0] || {};
    const totals = orderData.totals?.[0] || {};
    const periods = Object.fromEntries((orderData.periodStats || []).map((item) => [item._id, item]));
    const monthly = Object.fromEntries((orderData.monthComparison || []).map((item) => [item.month, item]));
    const calendarMonthly = Object.fromEntries((orderData.currentMonthComparison || []).map((item) => [item.month, item]));
    const currentMonthKey = monthString(currentMonthStart);
    const previousMonthKey = monthString(previousMonthStart);
    const reportMonthKey = monthString(selectedMonth);
    const reportPreviousMonthKey = monthString(new Date(Date.UTC(selectedMonth.getUTCFullYear(), selectedMonth.getUTCMonth() - 1, 1)));
    const reportMonth = monthly[reportMonthKey] || { orders: 0, cancelledOrders: 0, completedOrders: 0, orderValue: 0, billableOrders: 0 };
    const reportPreviousMonth = monthly[reportPreviousMonthKey] || { orders: 0, cancelledOrders: 0, completedOrders: 0, orderValue: 0, billableOrders: 0 };
    const currentMonth = calendarMonthly[currentMonthKey] || { orders: 0, cancelledOrders: 0, completedOrders: 0, orderValue: 0, billableOrders: 0 };
    const previousMonth = calendarMonthly[previousMonthKey] || { orders: 0, cancelledOrders: 0, completedOrders: 0, orderValue: 0, billableOrders: 0 };
    const users = userResults[0] || {};
    const signupCoverage = users.signupCoverage?.[0] || { tracked: 0, missing: 0 };
    const products = productResults[0] || {};

    return res.json({
      success: true,
      analytics: {
        range,
        generatedAt: now.toISOString(),
        period: { start: rangeStart, end: rangeEnd, previousStart, previousEnd: rangeStart },
        kpis: {
          totalOrders: totals.totalOrders || 0,
          cancelledOrders: totals.cancelledOrders || 0,
          completedOrders: totals.completedOrders || 0,
          openOrders: totals.openOrders || 0,
          totalOrderValue: totals.totalOrderValue || 0,
          averageOrderValue: totals.billableOrders ? totals.totalOrderValue / totals.billableOrders : 0,
          currentOrderValue: periods.current?.orderValue || 0,
          previousOrderValue: periods.previous?.orderValue || 0,
          currentAverageOrderValue: periods.current?.billableOrders
            ? periods.current.orderValue / periods.current.billableOrders
            : 0,
          previousAverageOrderValue: periods.previous?.billableOrders
            ? periods.previous.orderValue / periods.previous.billableOrders
            : 0,
          currentOrders: periods.current?.orders || 0,
          previousOrders: periods.previous?.orders || 0,
          currentCompletedOrders: periods.current?.completedOrders || 0,
          previousCompletedOrders: periods.previous?.completedOrders || 0,
          currentCancelledOrders: periods.current?.cancelledOrders || 0,
          previousCancelledOrders: periods.previous?.cancelledOrders || 0,
          totalCustomers: users.totals?.[0]?.customers || 0,
          newCustomersThisMonth: users.currentMonthSignups?.[0]?.count || 0,
          selectedMonthNewCustomers: users.selectedMonth?.[0]?.count || 0,
          customersWithSignupDate: signupCoverage.tracked,
          customersMissingSignupDate: signupCoverage.missing,
          totalSellers: users.sellers?.[0]?.count || 0,
          totalProducts: products.totals?.[0]?.products || 0,
          availableProducts: products.totals?.[0]?.available || 0,
          outOfStockProducts: products.totals?.[0]?.outOfStock || 0,
          currentMonthOrderValue: currentMonth.orderValue,
          previousMonthOrderValue: previousMonth.orderValue,
          currentMonthOrders: currentMonth.orders,
          previousMonthOrders: previousMonth.orders,
          currentMonthAverageOrderValue: currentMonth.billableOrders ? currentMonth.orderValue / currentMonth.billableOrders : 0,
          previousMonthAverageOrderValue: previousMonth.billableOrders ? previousMonth.orderValue / previousMonth.billableOrders : 0,
          currentMonthCancellations: currentMonth.cancelledOrders,
          previousMonthCancellations: previousMonth.cancelledOrders,
          repeatPurchaseRate: orderData.repeatPurchase?.[0]?.buyers
            ? orderData.repeatPurchase[0].repeatBuyers / orderData.repeatPurchase[0].buyers
            : null,
          repeatBuyers: orderData.repeatPurchase?.[0]?.repeatBuyers || 0,
          uniqueBuyers: orderData.repeatPurchase?.[0]?.buyers || 0,
        },
        month: {
          value: reportMonthKey,
          orderValue: reportMonth.orderValue,
          previousOrderValue: reportPreviousMonth.orderValue,
          orders: reportMonth.orders,
          previousOrders: reportPreviousMonth.orders,
          completedOrders: reportMonth.completedOrders,
          cancelledOrders: reportMonth.cancelledOrders,
          averageOrderValue: reportMonth.billableOrders ? reportMonth.orderValue / reportMonth.billableOrders : 0,
          previousAverageOrderValue: reportPreviousMonth.billableOrders ? reportPreviousMonth.orderValue / reportPreviousMonth.billableOrders : 0,
          categories: orderData.reportCategories || [],
          products: orderData.reportProducts || [],
        },
        series: orderData.series || [],
        monthlyHistory: orderData.monthlyHistory || [],
        customerHistory: users.acquisitionHistory || [],
        customerSignupsThisMonth: users.currentMonthSignups?.[0]?.count || 0,
        statuses: orderData.statusDistribution || [],
        topProducts: orderData.topProducts || [],
        decliningProducts: orderData.decliningProducts || [],
        categories: orderData.categoryPerformance || [],
        topCustomers: orderData.topCustomers || [],
        topSellers: orderData.topSellers || [],
        dataQuality: {
          nonCancelledLinesMissingStoredPrice: orderData.unpricedOrderLines?.[0]?.count || 0,
        },
        activity: [
          ...(orderData.recentOrders || []).map((order) => ({
            type: "order",
            id: order._id,
            createdAt: order.createdAt,
            title: `Order #${String(order._id).slice(-7)}`,
            detail: `${order.customerName} · ${order.itemCount} item${order.itemCount === 1 ? "" : "s"}`,
            status: order.status,
            orderValue: order.orderValue,
          })),
          ...(users.recent || []).map((customer) => ({
            type: "customer",
            id: customer._id,
            createdAt: customer.createdAt,
            title: "New customer account",
            detail: customer.name || "Unnamed customer",
            status: "Registered",
          })),
        ].sort((first, second) => new Date(second.createdAt) - new Date(first.createdAt)).slice(0, 12),
        inventory: {
          outOfStock: products.totals?.[0]?.outOfStock || 0,
          products: products.outOfStockProducts || [],
        },
        signupTracking: {
          complete: signupCoverage.missing === 0,
          trackedAccounts: signupCoverage.tracked,
          legacyAccountsWithoutDate: signupCoverage.missing,
        },
      },
    });
  } catch (error) {
    console.error("Owner analytics failed:", error.message);
    return res.status(error.code === 50 ? 503 : 500).json({
      success: false,
      message: error.code === 50 ? "Analytics query timed out. Narrow the date range and try again." : "Could not load owner analytics",
    });
  }
};

export const getOwnerOrders = async (req, res) => {
  try {
    if (req.query.limit !== undefined && typeof req.query.limit !== "string") {
      return res.status(400).json({ success: false, message: "Invalid page size" });
    }
    const requestedLimit = req.query.limit === undefined ? 20 : Number(req.query.limit);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
      return res.status(400).json({ success: false, message: "Invalid page size" });
    }
    const limit = Math.min(requestedLimit, 50);
    const allowedStatuses = new Set(["Pending", "Order Placed", "Processing", "Shipped", "Delivered", "Cancelled"]);
    const filter = {};

    if (req.query.status !== undefined && req.query.status !== "all") {
      if (typeof req.query.status !== "string" || !allowedStatuses.has(req.query.status)) {
        return res.status(400).json({ success: false, message: "Invalid order status" });
      }
      filter.status = req.query.status;
    }
    if (req.query.cursor !== undefined) {
      if (typeof req.query.cursor !== "string" || !mongoose.isValidObjectId(req.query.cursor)) {
        return res.status(400).json({ success: false, message: "Invalid pagination cursor" });
      }
      filter._id = { $lt: new mongoose.Types.ObjectId(req.query.cursor) };
    }
    if (req.query.search !== undefined) {
      if (typeof req.query.search !== "string" || req.query.search.length > 80) {
        return res.status(400).json({ success: false, message: "Invalid order search" });
      }
      const search = req.query.search.trim();
      if (search) {
        if (mongoose.isValidObjectId(search)) {
          if (req.query.cursor !== undefined) {
            return res.status(400).json({ success: false, message: "Order ID search cannot be combined with a page cursor" });
          }
          filter._id = new mongoose.Types.ObjectId(search);
        }
        else return res.status(400).json({ success: false, message: "Search orders by their order ID" });
      }
    }

    const rows = await Order.find(filter)
      .select("userId products status paymentMethod createdAt")
      .populate("userId", "name")
      .populate("products.productId", "name")
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const orders = page.map((order) => {
      const lines = (order.products || []).map((line) => ({
        name: line.productId?.name || "Deleted product",
        quantity: Number(line.quantity) || 0,
        sellerStatus: line.sellerStatus || order.status,
      }));
      const orderValue = order.status === "Cancelled" ? 0 : (order.products || []).reduce((total, line) => (
        line.sellerStatus === "Cancelled"
          ? total
          : total + Number(line.unitPrice || 0) * Number(line.quantity || 0)
      ), 0);
      return {
        _id: order._id,
        createdAt: order.createdAt,
        status: order.status || "Unknown",
        paymentMethod: order.paymentMethod || "Cash on Delivery",
        customerName: order.userId?.name || "Deleted customer",
        itemCount: lines.filter((line) => line.sellerStatus !== "Cancelled").reduce((sum, line) => sum + line.quantity, 0),
        orderValue: Math.round((orderValue + Number.EPSILON) * 100) / 100,
        products: lines,
      };
    });

    return res.json({
      success: true,
      orders,
      hasMore,
      nextCursor: hasMore ? String(page[page.length - 1]._id) : null,
    });
  } catch (error) {
    console.error("Owner orders query failed:", error.message);
    return res.status(500).json({ success: false, message: "Could not load orders" });
  }
};

export const getOwnerProducts = async (req, res) => {
  try {
    if (req.query.limit !== undefined && typeof req.query.limit !== "string") {
      return res.status(400).json({ success: false, message: "Invalid page size" });
    }
    const requestedLimit = req.query.limit === undefined ? 20 : Number(req.query.limit);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
      return res.status(400).json({ success: false, message: "Invalid page size" });
    }
    const limit = Math.min(requestedLimit, 50);
    if (req.query.search !== undefined && (typeof req.query.search !== "string" || req.query.search.length > 80)) {
      return res.status(400).json({ success: false, message: "Invalid product search" });
    }
    const filter = {};
    const search = (req.query.search || "").trim();
    if (search) {
      const safeSearch = new RegExp(escapeRegex(search), "i");
      filter.$or = [{ name: safeSearch }, { brand: safeSearch }, { category: safeSearch }];
    }
    if (req.query.stock === "out") filter.stock = { $lte: 0 };
    else if (req.query.stock === "available") filter.stock = { $gt: 0 };
    else if (req.query.stock !== undefined && req.query.stock !== "all") {
      return res.status(400).json({ success: false, message: "Invalid stock filter" });
    }
    if (req.query.cursor !== undefined) {
      if (typeof req.query.cursor !== "string" || !mongoose.isValidObjectId(req.query.cursor)) {
        return res.status(400).json({ success: false, message: "Invalid pagination cursor" });
      }
      filter._id = { $lt: new mongoose.Types.ObjectId(req.query.cursor) };
    }

    const rows = await Product.find(filter)
      .select("_id name brand category images price stock isAvailable updatedAt")
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return res.json({
      success: true,
      products: page.map((product) => ({ ...product, image: product.images?.[0] || "" })),
      hasMore,
      nextCursor: hasMore ? String(page[page.length - 1]._id) : null,
    });
  } catch (error) {
    console.error("Owner products query failed:", error.message);
    return res.status(500).json({ success: false, message: "Could not load products" });
  }
};
