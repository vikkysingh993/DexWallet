import express from "express";
import dotenv from "dotenv";

import btcRoutes from "./btc-server.mjs";
import evmRoutes from "./evm.mjs";
import solanaRoutes from "./solana_server.mjs";
import cardanoRoutes from "./cardano-server.mjs";

dotenv.config();

const app = express();
app.use(express.json());

/* ===============================
   ROUTES MAPPING
================================ */

// Health check
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "DEX Wallet API is running 🚀"
  });
});

// BTC APIs
app.use("/api/btc", btcRoutes);

// EVM APIs (ETH, BSC, POLYGON, SONIC etc.)
app.use("/api/evm", evmRoutes);

// Solana APIs
app.use("/api/solana", solanaRoutes);

// Cardano APIs
app.use("/api/cardano", cardanoRoutes);

/* ===============================
   SERVER START
================================ */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
