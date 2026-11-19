import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import mongoose from "mongoose";
import userModel from "../model/userModel.js";
import Order from "../model/orderModel.js";
import Product from "../model/productModel.js";
import adminAuth from "../middleware/adminAuth.js";
import deliveryAuth from "../middleware/deliveryAuth.js";
import ownerAuth from "../middleware/ownerAuth.js";
import sellerAuth from "../middleware/sellerAuth.js";
import { verifyToken } from "../middleware/verifyToken.js";
import userRoutes from "../routes/userRouters.js";
import productRoutes from "../routes/productsRoute.js";
import orderRoutes from "../routes/adminOrder.js";
import legacyOrderRoutes from "../routes/orderRoutes.js";
import deliveryRoutes from "../routes/deliveryRoutes.js";
import ownerRoutes from "../routes/ownerRoutes.js";
import { getSellerOrders, getUserOrders } from "../controller/orderController.js";
import { updateProduct } from "../controller/productController.js";
import { getAssignedDeliveries, updateDeliveryStatus } from "../controller/deliveryController.js";
import { adminLogin, userRegister } from "../controller/userController.js";

const secret = "rbac-tests-only-secret-with-sufficient-entropy";
const ids = {
  buyer: "64b000000000000000000001",
  seller: "64b000000000000000000002",
  owner: "64b000000000000000000003",
  delivery: "64b000000000000000000004",
  otherDelivery: "64b000000000000000000005",
  otherBuyer: "64b000000000000000000006",
};

const baseUsers = new Map([
  [ids.buyer, { _id: ids.buyer, email: "buyer@example.test", isAdmin: false, isOwner: false, isDeliveryMan: false }],
  [ids.seller, { _id: ids.seller, email: "seller@example.test", isAdmin: true, isOwner: false, isDeliveryMan: false }],
  [ids.owner, { _id: ids.owner, email: "owner@example.test", isAdmin: false, isOwner: true, isDeliveryMan: false }],
  [ids.delivery, { _id: ids.delivery, email: "delivery@example.test", isAdmin: false, isOwner: false, isDeliveryMan: true, deliverySellerId: ids.seller }],
  [ids.otherDelivery, { _id: ids.otherDelivery, email: "other-delivery@example.test", isAdmin: false, isOwner: false, isDeliveryMan: true, deliverySellerId: ids.seller }],
]);

const originals = {};
let users = new Map(baseUsers);

const query = (value) => ({
  then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  select() { return this; },
  session() { return Promise.resolve(value); },
  lean: async () => value,
});

before(() => {
  process.env.JWT_SECRET = secret;
  originals.findById = userModel.findById;
  originals.findOne = userModel.findOne;
  userModel.findById = (id) => query(users.get(String(id)) || null);
  userModel.findOne = (filter) => {
    if (filter?._id) return query(users.get(String(filter._id)) || null);
    const emailFilter = filter?.email;
    const matched = [...users.values()].find((user) => emailFilter instanceof RegExp
      ? emailFilter.test(user.email)
      : user.email === emailFilter);
    return query(matched || null);
  };
});

after(() => {
  userModel.findById = originals.findById;
  userModel.findOne = originals.findOne;
  delete process.env.JWT_SECRET;
});

const tokenFor = (id, claims = {}, options = { expiresIn: "1h" }) => jwt.sign({ id, ...claims }, secret, options);

const invoke = async (middleware, token) => {
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {}, body: { isAdmin: true } };
  const res = {
    statusCode: 200,
    body: null,
    status(statusCode) { this.statusCode = statusCode; return this; },
    json(body) { this.body = body; return this; },
  };
  let calledNext = false;
  await middleware(req, res, () => { calledNext = true; });
  return { req, res, calledNext };
};

const routeStack = (router, path, method) => {
  const layer = router.stack.find((entry) => entry.route?.path === path && entry.route.methods[method]);
  assert.ok(layer, `Expected ${method.toUpperCase()} ${path} route`);
  return layer.route.stack.map((entry) => entry.handle);
};

test("protected API routes use the intended current-role middleware", () => {
  assert.equal(routeStack(userRoutes, "/me", "get")[0], verifyToken);
  assert.equal(routeStack(userRoutes, "/seller/store-profile", "put")[0], sellerAuth);
  assert.equal(routeStack(userRoutes, "/users", "get")[0], ownerAuth);
  assert.equal(routeStack(userRoutes, "/remove", "post")[0], ownerAuth);
  assert.equal(routeStack(userRoutes, "/update/:_id", "put")[0], ownerAuth);

  for (const [path, method] of [["/ai-generate", "post"], ["/add", "post"], ["/update/:id", "post"], ["/remove", "post"], ["/mine", "get"]]) {
    assert.equal(routeStack(productRoutes, path, method)[0], sellerAuth, `${method.toUpperCase()} ${path}`);
  }

  assert.equal(routeStack(orderRoutes, "/create", "post")[0], verifyToken);
  assert.equal(routeStack(orderRoutes, "/user/:userId", "get")[0], verifyToken);
  assert.equal(routeStack(orderRoutes, "/cancel", "put")[0], verifyToken);
  assert.equal(routeStack(orderRoutes, "/all", "get")[0], ownerAuth);
  assert.equal(routeStack(orderRoutes, "/status", "put")[0], ownerAuth);
  assert.equal(routeStack(orderRoutes, "/seller", "get")[0], sellerAuth);
  assert.equal(routeStack(orderRoutes, "/seller/status", "put")[0], sellerAuth);

  assert.equal(routeStack(legacyOrderRoutes, "/", "get")[0], ownerAuth);
  assert.equal(routeStack(legacyOrderRoutes, "/", "put")[0], ownerAuth);
  assert.equal(routeStack(legacyOrderRoutes, "/user/:userId", "get")[0], verifyToken);
  assert.equal(routeStack(legacyOrderRoutes, "/cancel", "put")[0], verifyToken);

  for (const [path, method] of [["/team", "get"], ["/team", "post"], ["/team/:deliveryManId", "delete"], ["/assign", "post"]]) {
    assert.equal(routeStack(deliveryRoutes, path, method)[0], sellerAuth, `${method.toUpperCase()} ${path}`);
  }
  for (const [path, method] of [["/deliveries", "get"], ["/deliveries/status", "put"]]) {
    assert.equal(routeStack(deliveryRoutes, path, method)[0], deliveryAuth, `${method.toUpperCase()} ${path}`);
  }
  for (const layer of ownerRoutes.stack.filter((entry) => entry.route)) {
    assert.equal(layer.route.stack[0].handle, ownerAuth, `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);
  }
});

test("missing, malformed, unsigned-algorithm, non-expiring, and expired JWTs are rejected", async () => {
  const malformed = "not-a-jwt";
  const wrongAlgorithm = jwt.sign({ id: ids.buyer }, secret, { algorithm: "HS512", expiresIn: "1h" });
  const noExpiry = jwt.sign({ id: ids.buyer }, secret);
  const expired = tokenFor(ids.buyer, {}, { expiresIn: -1 });

  for (const value of [null, malformed, wrongAlgorithm, noExpiry, expired]) {
    const { res, calledNext } = await invoke(verifyToken, value);
    assert.equal(calledNext, false);
    assert.equal(res.statusCode, 401);
  }
});

test("database roles override client-controlled JWT claims and immediately revoke stale seller access", async () => {
  const escalatedBuyerToken = tokenFor(ids.buyer, { isAdmin: true, isOwner: true, isDeliveryMan: true });
  const verified = await invoke(verifyToken, escalatedBuyerToken);
  assert.equal(verified.calledNext, true);
  assert.equal(verified.req.user.isAdmin, false);
  assert.equal(verified.req.user.isOwner, false);

  assert.equal((await invoke(sellerAuth, escalatedBuyerToken)).res.statusCode, 403);

  const oldSellerToken = tokenFor(ids.seller, { isAdmin: true });
  users.set(ids.seller, { ...baseUsers.get(ids.seller), isAdmin: false });
  const revoked = await invoke(sellerAuth, oldSellerToken);
  assert.equal(revoked.calledNext, false);
  assert.equal(revoked.res.statusCode, 403);
  users.set(ids.seller, baseUsers.get(ids.seller));

  const deletedAccount = await invoke(verifyToken, tokenFor(ids.otherBuyer));
  assert.equal(deletedAccount.calledNext, false);
  assert.equal(deletedAccount.res.statusCode, 401);
});

test("seller middleware denies buyer, owner, and mixed delivery roles; only a current seller passes", async () => {
  const sellerToken = tokenFor(ids.seller, { isAdmin: false });
  assert.equal((await invoke(sellerAuth, sellerToken)).calledNext, true);
  assert.equal((await invoke(adminAuth, sellerToken)).calledNext, true);
  assert.equal((await invoke(sellerAuth, tokenFor(ids.buyer))).res.statusCode, 403);
  assert.equal((await invoke(adminAuth, tokenFor(ids.buyer))).res.statusCode, 403);

  users.set(ids.owner, { ...baseUsers.get(ids.owner), isAdmin: true });
  users.set(ids.delivery, { ...baseUsers.get(ids.delivery), isAdmin: true });
  assert.equal((await invoke(sellerAuth, tokenFor(ids.owner))).res.statusCode, 403);
  assert.equal((await invoke(adminAuth, tokenFor(ids.owner))).res.statusCode, 403);
  assert.equal((await invoke(sellerAuth, tokenFor(ids.delivery))).res.statusCode, 403);
  assert.equal((await invoke(adminAuth, tokenFor(ids.delivery))).res.statusCode, 403);

  users.set(ids.buyer, { ...baseUsers.get(ids.buyer), isAdmin: "true", isOwner: "false", isDeliveryMan: "false" });
  assert.equal((await invoke(sellerAuth, tokenFor(ids.buyer))).res.statusCode, 403);
  users = new Map(baseUsers);
});

test("seller login rejects owners and delivery accounts even when legacy flags conflict", async () => {
  const passwordHash = await bcrypt.hash("test-password", 4);
  users.set(ids.seller, { ...baseUsers.get(ids.seller), password: passwordHash });
  users.set(ids.owner, { ...baseUsers.get(ids.owner), isAdmin: true, password: passwordHash });
  users.set(ids.delivery, { ...baseUsers.get(ids.delivery), isAdmin: true, password: passwordHash });
  users.set(ids.otherBuyer, { _id: ids.otherBuyer, email: "malformed-role@example.test", isAdmin: "true", isOwner: "false", isDeliveryMan: "false", password: passwordHash });

  const login = async (email) => {
    const res = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await adminLogin({ body: { email, password: "test-password" } }, res);
    return res;
  };

  try {
    const sellerLogin = await login("seller@example.test");
    assert.equal(sellerLogin.statusCode, 200, sellerLogin.body?.message);
    assert.equal((await login("owner@example.test")).statusCode, 401);
    assert.equal((await login("delivery@example.test")).statusCode, 401);
    assert.equal((await login("malformed-role@example.test")).statusCode, 401);
  } finally {
    users = new Map(baseUsers);
  }
});

test("public registration ignores submitted role and seller ownership fields", async () => {
  const originalSave = userModel.prototype.save;
  let savedUser;
  userModel.prototype.save = async function saveForRbacTest() {
    savedUser = this;
    return this;
  };
  try {
    const res = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await userRegister({ body: {
      name: "New Buyer",
      email: "new-buyer@example.com",
      password: "secure-test-password",
      isAdmin: true,
      isOwner: true,
      isDeliveryMan: true,
      deliverySellerId: ids.otherBuyer,
    } }, res);
    assert.equal(res.body.success, true);
    assert.equal(savedUser.isAdmin, false);
    assert.equal(savedUser.isOwner, false);
    assert.equal(savedUser.isDeliveryMan, false);
    assert.equal(savedUser.deliverySellerId, null);
  } finally {
    userModel.prototype.save = originalSave;
  }
});

test("owner and delivery middleware enforce their own database roles and seller association", async () => {
  assert.equal((await invoke(ownerAuth, tokenFor(ids.owner))).calledNext, true);
  assert.equal((await invoke(ownerAuth, tokenFor(ids.seller))).res.statusCode, 403);
  assert.equal((await invoke(deliveryAuth, tokenFor(ids.delivery))).calledNext, true);
  assert.equal((await invoke(deliveryAuth, tokenFor(ids.seller))).res.statusCode, 403);

  users.set(ids.delivery, { ...baseUsers.get(ids.delivery), deliverySellerId: ids.otherBuyer });
  assert.equal((await invoke(deliveryAuth, tokenFor(ids.delivery))).res.statusCode, 403);
  users = new Map(baseUsers);
});

test("buyer cannot read another user's order history by changing the path ID", async () => {
  const originalFind = Order.find;
  let queried = false;
  Order.find = () => { queried = true; throw new Error("Order query should not run"); };
  try {
    const req = { user: { id: ids.buyer, isOwner: false }, params: { userId: ids.otherBuyer } };
    const res = {
      statusCode: 200,
      body: null,
      set() { return this; },
      status(statusCode) { this.statusCode = statusCode; return this; },
      json(body) { this.body = body; return this; },
    };
    await getUserOrders(req, res);
    assert.equal(res.statusCode, 403);
    assert.equal(queried, false);
  } finally {
    Order.find = originalFind;
  }
});

test("seller order response hides other vendors' lines and full marketplace total", async () => {
  const originalCount = userModel.countDocuments;
  const originalProductFind = Product.find;
  const originalOrderFind = Order.find;
  const ownProductId = "64b000000000000000000011";
  const sellerLine = {
    productId: { _id: ownProductId, sellerId: ids.seller, price: 100 },
    sellerId: ids.seller,
    unitPrice: 100,
    quantity: 1,
    sellerStatus: "Processing",
    toObject() { return { ...this, toObject: undefined }; },
  };
  const otherSellerLine = {
    productId: { _id: "64b000000000000000000012", sellerId: ids.otherBuyer, price: 900 },
    sellerId: ids.otherBuyer,
    unitPrice: 900,
    quantity: 1,
    sellerStatus: "Processing",
    toObject() { return { ...this, toObject: undefined }; },
  };
  const order = {
    _id: "64b000000000000000000013",
    products: [sellerLine, otherSellerLine],
    totalAmount: 1000,
    status: "Processing",
    toObject() { return { _id: this._id, products: this.products, totalAmount: this.totalAmount, status: this.status }; },
  };
  userModel.countDocuments = async () => 2;
  Product.find = () => ({ select: async () => [{ _id: ownProductId }] });
  Order.find = () => ({
    populate() { return this; },
    sort: async () => [order],
  });
  try {
    const response = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await getSellerOrders({ user: { id: ids.seller } }, response);
    const sellerOrder = response.body.orders[0];
    assert.equal(response.statusCode, 200);
    assert.equal(sellerOrder.products.length, 1);
    assert.equal(sellerOrder.totalAmount, 100);
    assert.equal(sellerOrder.sellerTotalAmount, 100);
  } finally {
    userModel.countDocuments = originalCount;
    Product.find = originalProductFind;
    Order.find = originalOrderFind;
  }
});

test("seller product update query stays scoped to the authenticated seller", async () => {
  const originalCount = userModel.countDocuments;
  const originalUpdate = Product.findOneAndUpdate;
  let updateFilter;
  let updateDocument;
  userModel.countDocuments = async () => 2;
  Product.findOneAndUpdate = async (filter, update) => {
    updateFilter = filter;
    updateDocument = update;
    return null;
  };
  try {
    const res = {
      statusCode: 200,
      body: null,
      status(statusCode) { this.statusCode = statusCode; return this; },
      json(body) { this.body = body; return this; },
    };
    await updateProduct({
      params: { id: "64b000000000000000000099" },
      body: {
        name: "Changed",
        sellerId: ids.otherBuyer,
        $set: { sellerId: ids.otherBuyer },
        rating: 5,
        numReviews: 999,
      },
      files: {},
      user: { id: ids.seller },
    }, res);
    assert.equal(updateFilter.sellerId, ids.seller);
    assert.deepEqual(updateDocument, { name: "Changed" });
    assert.equal(res.body.success, false);
  } finally {
    userModel.countDocuments = originalCount;
    Product.findOneAndUpdate = originalUpdate;
  }
});

test("delivery list and status queries include both the delivery account and its seller", async () => {
  const originalFind = Order.find;
  const originalAggregate = Order.aggregate;
  const originalFindById = userModel.findById;
  let listFilter;
  Order.find = (filter) => {
    listFilter = filter;
    return {
      sort() { return this; },
      limit() { return this; },
      populate() { return this; },
      lean: async () => [],
    };
  };
  Order.aggregate = async () => [];
  userModel.findById = () => query({ name: "Seller" });
  try {
    const response = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await getAssignedDeliveries({
      user: { id: ids.delivery, deliverySellerId: ids.seller },
      query: { status: "active", limit: "20" },
    }, response);
    assert.equal(String(listFilter.products.$elemMatch.deliveryManId), ids.delivery);
    assert.equal(String(listFilter.products.$elemMatch.sellerId), ids.seller);
    assert.equal(response.statusCode, 200);
  } finally {
    Order.find = originalFind;
    Order.aggregate = originalAggregate;
    userModel.findById = originalFindById;
  }
});

test("delivery stage mutation scopes the order lookup to its assignee and seller", async () => {
  const originalStartSession = mongoose.startSession;
  const originalFindOne = Order.findOne;
  const originalFindOneAndUpdate = userModel.findOneAndUpdate;
  let orderFilter;
  mongoose.startSession = async () => ({
    withTransaction: async (callback) => callback(),
    endSession: async () => {},
  });
  userModel.findOneAndUpdate = () => query({ _id: ids.delivery });
  Order.findOne = (filter) => {
    orderFilter = filter;
    return { select() { return this; }, session: async () => null };
  };
  try {
    const response = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await updateDeliveryStatus({
      user: { id: ids.delivery, deliverySellerId: ids.seller },
      body: { orderId: "64b000000000000000000098", status: "Picked Up" },
    }, response);
    assert.equal(String(orderFilter.products.$elemMatch.deliveryManId), ids.delivery);
    assert.equal(String(orderFilter.products.$elemMatch.sellerId), ids.seller);
    assert.equal(response.statusCode, 404);
  } finally {
    mongoose.startSession = originalStartSession;
    Order.findOne = originalFindOne;
    userModel.findOneAndUpdate = originalFindOneAndUpdate;
  }
});
