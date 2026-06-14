// ==================== backend/server.js (FULL CODE CỐ ĐỊNH) ====================
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');
const app = express();

app.use(cors());
app.use(express.json());

// ==================== FIX: THÊM SERVE STATIC FILES CHO TEST ====================
// Nếu muốn test trực tiếp trên Render (không cần Vercel)
app.use(express.static(path.join(__dirname, 'public')));

// ==================== KẾT NỐI MONGODB ====================
const mongoUrl = process.env.MONGO_URL || 'mongodb://mongo:KQfRIDylmJWmdOplZykjxNtCLLyMCVsb@thomas.proxy.rlwy.net:49230';
const mongoOptions = {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
  family: 4
};

const connectDB = async () => {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(mongoUrl, mongoOptions);
    console.log('MongoDB connected successfully');
  } catch (err) {
    console.error('MongoDB connection error:', err.message);
    setTimeout(connectDB, 5000);
  }
};
connectDB();

// ==================== SCHEMAS ====================
const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  balance: { type: Number, default: 0 }
});
const User = mongoose.model('User', UserSchema);

const ProductSchema = new mongoose.Schema({
  name: { type: String, required: true },
  price: { type: Number, required: true },
  accountData: { type: String, required: true }
});
const Product = mongoose.model('Product', ProductSchema);

const OrderSchema = new mongoose.Schema({
  orderCode: { type: String, unique: true, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
  amount: { type: Number, required: true },
  status: { type: String, default: 'pending' },
  type: { type: String, default: 'purchase' },
  payosLink: { type: String, default: '' },
  payosOrderCode: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});
const Order = mongoose.model('Order', OrderSchema);

const PurchaseSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  accountData: { type: String, required: true },
  purchasedAt: { type: Date, default: Date.now }
});
const Purchase = mongoose.model('Purchase', PurchaseSchema);

// ==================== HÀM CHECKSUM ====================
function verifyPayOSWebhook(body, signature, checksumKey) {
  const sortedKeys = Object.keys(body).sort();
  const signString = sortedKeys.map(key => `${key}=${body[key]}`).join('&');
  const expectedSignature = crypto.createHmac('sha256', checksumKey).update(signString).digest('hex');
  return signature === expectedSignature;
}

// ==================== API AUTH ====================
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    const existing = await User.findOne({ username });
    if (existing) return res.status(400).json({ error: 'Username already exists' });
    const user = new User({ username, password });
    await user.save();
    res.json({ success: true, userId: user._id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username, password });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    res.json({ success: true, userId: user._id, username: user.username, balance: user.balance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/user/:userId/balance', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ balance: user.balance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== API PRODUCTS ====================
app.get('/api/products', async (req, res) => {
  try {
    const products = await Product.find();
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== API TẠO ĐƠN MUA HÀNG ====================
app.post('/api/create-order', async (req, res) => {
  try {
    const { userId, productId } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const product = await Product.findById(productId);
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const orderCodeStr = `ORD${Date.now()}${Math.floor(Math.random() * 10000)}`;
    const payosOrderCode = parseInt(Date.now().toString().slice(-9) + Math.floor(Math.random() * 1000));
    
    const order = new Order({
      orderCode: orderCodeStr,
      userId,
      productId,
      amount: product.price,
      type: 'purchase',
      payosOrderCode: payosOrderCode
    });
    await order.save();

    const payosPayload = {
      orderCode: payosOrderCode,
      amount: product.price,
      description: `Mua ${product.name.substring(0, 25)}`,
      returnUrl: `${process.env.FRONTEND_URL || 'https://websitepro-one.vercel.app'}/success.html`,
      cancelUrl: `${process.env.FRONTEND_URL || 'https://websitepro-one.vercel.app'}/cancel.html`
    };

    const payosRes = await axios.post('https://api.payos.vn/v1/payment-requests', payosPayload, {
      headers: {
        'x-client-id': process.env.PAYOS_CLIENT_ID,
        'x-api-key': process.env.PAYOS_API_KEY,
        'x-checksum-key': process.env.PAYOS_CHECKSUM_KEY,
        'Content-Type': 'application/json'
      }
    });

    if (payosRes.data.code === '00') {
      order.payosLink = payosRes.data.data.checkoutUrl;
      await order.save();
      res.json({ checkoutUrl: payosRes.data.data.checkoutUrl, orderCode: order.orderCode });
    } else {
      throw new Error('PayOS error: ' + JSON.stringify(payosRes.data));
    }
  } catch (err) {
    console.error('Create order error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== API NẠP TIỀN ====================
app.post('/api/deposit', async (req, res) => {
  try {
    console.log('=== DEPOSIT REQUEST ===');
    const { userId, amount } = req.body;
    
    if (!userId || !amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid data' });
    }

    const orderCodeStr = `DEP${Date.now()}${Math.floor(Math.random() * 10000)}`;
    const payosOrderCode = parseInt(Date.now().toString().slice(-9) + Math.floor(Math.random() * 1000));
    
    const order = new Order({
      orderCode: orderCodeStr,
      userId,
      amount: amount,
      type: 'deposit',
      productId: null,
      payosOrderCode: payosOrderCode
    });
    await order.save();

    const payosPayload = {
      orderCode: payosOrderCode,
      amount: amount,
      description: `Nap tien ${amount} VND`,
      returnUrl: `${process.env.FRONTEND_URL || 'https://websitepro-one.vercel.app'}/success.html`,
      cancelUrl: `${process.env.FRONTEND_URL || 'https://websitepro-one.vercel.app'}/cancel.html`
    };

    console.log('Calling PayOS API...');
    const payosRes = await axios.post('https://api.payos.vn/v1/payment-requests', payosPayload, {
      headers: {
        'x-client-id': process.env.PAYOS_CLIENT_ID,
        'x-api-key': process.env.PAYOS_API_KEY,
        'x-checksum-key': process.env.PAYOS_CHECKSUM_KEY,
        'Content-Type': 'application/json'
      }
    });

    console.log('PayOS response:', payosRes.data);

    if (payosRes.data.code === '00') {
      order.payosLink = payosRes.data.data.checkoutUrl;
      await order.save();
      res.json({ checkoutUrl: payosRes.data.data.checkoutUrl, orderCode: order.orderCode });
    } else {
      throw new Error('PayOS error: ' + JSON.stringify(payosRes.data));
    }
  } catch (err) {
    console.error('Deposit error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// ==================== WEBHOOK ====================
app.post('/api/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-signature'] || req.headers['x-checksum'];
    const webhookBody = req.body;
    
    if (!verifyPayOSWebhook(webhookBody, signature, process.env.PAYOS_CHECKSUM_KEY)) {
      console.error('Invalid webhook signature');
      return res.status(400).json({ error: 'Invalid signature' });
    }
    
    const { orderCode, status } = webhookBody;
    
    if (status === 'PAID') {
      let foundOrder = await Order.findOne({ payosOrderCode: orderCode });
      if (!foundOrder) {
        foundOrder = await Order.findOne({ orderCode: { $regex: `.*${orderCode}.*` } });
      }
      
      if (foundOrder && foundOrder.status === 'pending') {
        foundOrder.status = 'completed';
        await foundOrder.save();

        if (foundOrder.type === 'purchase') {
          const product = await Product.findById(foundOrder.productId);
          const user = await User.findById(foundOrder.userId);
          if (product && user) {
            const purchase = new Purchase({
              userId: user._id,
              productId: product._id,
              accountData: product.accountData
            });
            await purchase.save();
            console.log(`[AUTO] Sent account ${product.accountData} to user ${user.username}`);
          }
        } else if (foundOrder.type === 'deposit') {
          const user = await User.findById(foundOrder.userId);
          if (user) {
            user.balance += foundOrder.amount;
            await user.save();
            console.log(`[AUTO] Added ${foundOrder.amount} to user ${user.username}`);
          }
        }
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== API LẤY ORDER ====================
app.get('/api/my-orders/:userId', async (req, res) => {
  try {
    const orders = await Order.find({ userId: req.params.userId, status: 'completed' }).populate('productId').sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/my-purchases/:userId', async (req, res) => {
  try {
    const purchases = await Purchase.find({ userId: req.params.userId }).populate('productId').sort({ purchasedAt: -1 });
    res.json(purchases);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== API ADMIN ====================
app.get('/api/admin/orders', async (req, res) => {
  try {
    const orders = await Order.find().populate('userId', 'username').populate('productId', 'name').sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/orders/:orderId/status', async (req, res) => {
  try {
    const { status } = req.body;
    const order = await Order.findByIdAndUpdate(req.params.orderId, { status }, { new: true });
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/products', async (req, res) => {
  try {
    const { name, price, accountData } = req.body;
    const product = new Product({ name, price, accountData });
    await product.save();
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/products/:productId', async (req, res) => {
  try {
    await Product.findByIdAndDelete(req.params.productId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/products/:productId', async (req, res) => {
  try {
    const { name, price, accountData } = req.body;
    const product = await Product.findByIdAndUpdate(req.params.productId, { name, price, accountData }, { new: true });
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/users', async (req, res) => {
  try {
    const users = await User.find().select('-password');
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/users/:userId/balance', async (req, res) => {
  try {
    const { amount } = req.body;
    const user = await User.findByIdAndUpdate(req.params.userId, { $inc: { balance: amount } }, { new: true });
    res.json({ balance: user.balance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/users/:userId', async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.userId);
    await Order.deleteMany({ userId: req.params.userId });
    await Purchase.deleteMany({ userId: req.params.userId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== INIT DATA ====================
const initData = async () => {
  try {
    const productCount = await Product.countDocuments();
    if (productCount === 0) {
      await Product.create([
        { name: 'Pro VIP 1 tháng', price: 100000, accountData: 'vipuser1:pass123' },
        { name: 'Pro VIP 3 tháng', price: 250000, accountData: 'vipuser3:pass456' },
        { name: 'Pro VIP 1 năm', price: 800000, accountData: 'vipuser12:pass789' }
      ]);
      console.log('Sample products created');
    }
  } catch (err) {
    console.error('Init error:', err.message);
  }
};

mongoose.connection.once('open', () => {
  console.log('MongoDB ready, initializing...');
  initData();
});

// ==================== DEBUG ====================
app.get('/api/debug', (req, res) => {
  res.json({ message: 'Backend OK', timestamp: Date.now(), mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' });
});

// ==================== FALLBACK CHO FRONTEND ====================
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>Shop Pro API</title></head>
    <body>
      <h1>Backend is running!</h1>
      <p>API endpoints:</p>
      <ul>
        <li><a href="/api/products">/api/products</a></li>
        <li><a href="/api/debug">/api/debug</a></li>
      </ul>
      <p>Frontend: <a href="https://websitepro-one.vercel.app">https://websitepro-one.vercel.app</a></p>
    </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
