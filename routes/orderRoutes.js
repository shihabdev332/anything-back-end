import express from "express";
import { getAllOrders, updateOrderStatus, clientCancelOrder, getUserOrders } from "../controller/orderController.js";
import ownerAuth from "../middleware/ownerAuth.js";
import { verifyToken } from "../middleware/verifyToken.js";

const orderRoute = express.Router();

// GET all orders (admin)
orderRoute.get("/", ownerAuth, getAllOrders);

// GET orders of a user (client)
orderRoute.get("/user/:userId", verifyToken, getUserOrders);

// UPDATE order status (admin)
orderRoute.put("/", ownerAuth, updateOrderStatus);

// CLIENT cancel order
orderRoute.put("/cancel", verifyToken, clientCancelOrder);

export default orderRoute;
