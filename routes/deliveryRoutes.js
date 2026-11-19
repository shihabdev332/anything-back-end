import express from "express";
import sellerAuth from "../middleware/sellerAuth.js";
import deliveryAuth from "../middleware/deliveryAuth.js";
import { assignDelivery, createDeliveryAccount, getAssignedDeliveries, listDeliveryTeam, removeDeliveryAccount, updateDeliveryStatus } from "../controller/deliveryController.js";

const router = express.Router();

router.get("/team", sellerAuth, listDeliveryTeam);
router.post("/team", sellerAuth, createDeliveryAccount);
router.delete("/team/:deliveryManId", sellerAuth, removeDeliveryAccount);
router.post("/assign", sellerAuth, assignDelivery);
router.get("/deliveries", deliveryAuth, getAssignedDeliveries);
router.put("/deliveries/status", deliveryAuth, updateDeliveryStatus);

export default router;
