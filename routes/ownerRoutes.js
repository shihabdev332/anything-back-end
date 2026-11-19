import express from "express";
import ownerAuth from "../middleware/ownerAuth.js";
import {
  createOwnerSeller,
  getOwnerCustomers,
  getOwnerDashboardSummary,
  getOwnerSellers,
  updateSellerAccess,
} from "../controller/ownerController.js";
import {
  getOwnerAnalytics,
  getOwnerOrders,
  getOwnerProducts,
} from "../controller/ownerAnalyticsController.js";

const ownerRouter = express.Router();

ownerRouter.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

ownerRouter.get("/summary", ownerAuth, getOwnerDashboardSummary);
ownerRouter.get("/analytics", ownerAuth, getOwnerAnalytics);
ownerRouter.get("/orders", ownerAuth, getOwnerOrders);
ownerRouter.get("/products", ownerAuth, getOwnerProducts);
ownerRouter.get("/sellers", ownerAuth, getOwnerSellers);
ownerRouter.post("/sellers", ownerAuth, createOwnerSeller);
ownerRouter.get("/customers", ownerAuth, getOwnerCustomers);
ownerRouter.patch("/users/:userId/seller-access", ownerAuth, updateSellerAccess);

export default ownerRouter;
