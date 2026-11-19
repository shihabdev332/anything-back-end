import express from "express";
import { getAiResponse } from "../controller/aiController.js";
import { aiRateLimit, optionalAiAuthentication } from "../middleware/aiChatSecurity.js";

const aiRouter = express.Router();
aiRouter.post("/chat", optionalAiAuthentication, aiRateLimit, getAiResponse);

export default aiRouter;
