import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import * as bitcoin from "bitcoinjs-lib";
import bip39 from "bip39";
import * as ecc from "tiny-secp256k1";
import { BIP32Factory } from "bip32";
import { ECPairFactory } from "ecpair";

dotenv.config();

/* ===============================
   INIT
================================ */

bitcoin.initEccLib(ecc);

const bip32 = BIP32Factory(ecc);
const ECPair = ECPairFactory(ecc);

const router = express.Router();

/* ===============================
   TATUM CONFIG (BTC MAINNET)
================================ */

const NETWORK_NAME = "mainnet";
const NETWORK = bitcoin.networks.bitcoin;

const TATUM_API = "https://api.tatum.io/v3";
const TATUM_HEADERS = {
  "x-api-key": process.env.TATUM_API_KEY,
  "Content-Type": "application/json"
};

// BIP84 Native SegWit
const DEFAULT_PURPOSE = 84;
const DEFAULT_COIN = 0;

/* ===============================
   UTILS
================================ */

const satsToBtc = (sats) => Number(sats) / 1e8;
const btcToSats = (btc) => Math.floor(Number(btc) * 1e8);

const VBYTE_PER_INPUT = 68;
const VBYTE_PER_OUTPUT = 31;
const TX_OVERHEAD_VBYTES = 10;

/* ===============================
   HELPERS
================================ */

function buildAddressFromNode(node) {
  return bitcoin.payments.p2wpkh({
    pubkey: node.publicKey,
    network: NETWORK
  }).address;
}

function deriveFromMnemonic(mnemonic, account = 0, addressIndex = 0) {
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error("Invalid mnemonic");
  }

  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const root = bip32.fromSeed(seed, NETWORK);

  const path = `m/${DEFAULT_PURPOSE}'/${DEFAULT_COIN}'/${account}'/0/${addressIndex}`;
  const child = root.derivePath(path);

  return { child, path };
}

/* ===============================
   TATUM API HELPERS
================================ */

// Fetch UTXOs
async function fetchUtxos(address) {
  const r = await axios.get(
    `${TATUM_API}/bitcoin/utxo/${address}`,
    { headers: TATUM_HEADERS }
  );

  // Convert to bitcoinjs format
  return r.data.map(u => ({
    txid: u.hash,
    vout: u.index,
    value: Number(u.value)
  }));
}

// Fetch fee rate (sat/vB)
async function fetchFeeRate() {
  const r = await axios.get(
    `${TATUM_API}/bitcoin/fees`,
    { headers: TATUM_HEADERS }
  );

  return Math.max(Number(r.data.fast), 1);
}

// Broadcast transaction
async function broadcastTx(hex) {
  const r = await axios.post(
    `${TATUM_API}/bitcoin/broadcast`,
    { txData: hex },
    { headers: TATUM_HEADERS }
  );

  return r.data.txId;
}

function estimateTxVsize(inputs, outputs) {
  return (
    inputs * VBYTE_PER_INPUT +
    outputs * VBYTE_PER_OUTPUT +
    TX_OVERHEAD_VBYTES
  );
}

function selectUtxosGreedy(utxos, target) {
  const sorted = [...utxos].sort((a, b) => a.value - b.value);
  let sum = 0;
  const chosen = [];

  for (const u of sorted) {
    chosen.push(u);
    sum += u.value;
    if (sum >= target) break;
  }

  return { chosen, sum };
}

/* ===============================
   ROUTES
================================ */

// Health
router.get("/health", (req, res) => {
  res.json({
    ok: true,
    network: NETWORK_NAME,
    provider: "tatum"
  });
});

// Create wallet
router.post("/wallet/create", (req, res) => {
  try {
    const { words = 12 } = req.body;

    if (![12, 24].includes(words)) {
      return res.status(400).json({ error: "words must be 12 or 24" });
    }

    const strength = words === 24 ? 256 : 128;
    const mnemonic = bip39.generateMnemonic(strength);

    const { child, path } = deriveFromMnemonic(mnemonic);

    res.json({
      network: NETWORK_NAME,
      mnemonic,
      derivationPath: path,
      address: buildAddressFromNode(child),
      privateKeyWIF: child.toWIF()
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



/* ===============================
   IMPORT WALLET FROM WIF
================================ */
router.post("/wallet/import", (req, res) => {
  try {
    const { privateKeyWIF } = req.body;

    if (!privateKeyWIF) {
      return res.status(400).json({
        error: "privateKeyWIF required",
      });
    }

    // Create key pair from WIF
    const keyPair = ECPair.fromWIF(privateKeyWIF, NETWORK);

    // Generate Native SegWit address
    const { address } = bitcoin.payments.p2wpkh({
      pubkey: keyPair.publicKey,
      network: NETWORK,
    });

    res.json({
      success: true,
      network: NETWORK_NAME,
      address,
      privateKeyWIF,
    });
  } catch (err) {
    res.status(500).json({
      error: "Invalid WIF or failed to import wallet",
      details: err.message,
    });
  }
});




/* ===============================
   IMPORT WALLET FROM MNEMONIC
================================ */
router.post("/wallet/import/mnemonic", (req, res) => {
  try {
    const {
      mnemonic,
      accountIndex = 0,
      addressIndex = 0,
    } = req.body;

    if (!mnemonic) {
      return res.status(400).json({
        error: "mnemonic required",
      });
    }

    if (!bip39.validateMnemonic(mnemonic)) {
      return res.status(400).json({
        error: "Invalid mnemonic",
      });
    }

    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const root = bip32.fromSeed(seed, NETWORK);

    const path = `m/${DEFAULT_PURPOSE}'/${DEFAULT_COIN}'/${accountIndex}'/0/${addressIndex}`;
    const child = root.derivePath(path);

    const address = buildAddressFromNode(child);

    res.json({
      success: true,
      network: NETWORK_NAME,
      derivationPath: path,
      address,
      privateKeyWIF: child.toWIF(),
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to import mnemonic",
      details: err.message,
    });
  }
});






/* ===============================
   GET BTC BALANCE (TATUM)
================================ */
router.get("/:address/balance", async (req, res) => {
  try {
    const { address } = req.params;

    const r = await axios.get(
      `${TATUM_API}/bitcoin/address/balance/${address}`,
      { headers: TATUM_HEADERS }
    );

    // 🔥 IMPORTANT: values are in BTC
    const incomingBtc = Number(r.data.incoming || 0);
    const outgoingBtc = Number(r.data.outgoing || 0);

    const balanceBtc = incomingBtc - outgoingBtc;
    const balanceSats = Math.round(balanceBtc * 1e8);

    res.json({
      success: true,
      chain: "BTC",
      address,
      balance_btc: balanceBtc,
      balance_sats: balanceSats,
      incoming_btc: incomingBtc,
      outgoing_btc: outgoingBtc,
    });
  } catch (err) {
    console.error("BTC BALANCE ERROR 👉", err.response?.data || err.message);
    res.status(500).json({
      error: err.response?.data || err.message,
    });
  }
});



router.post("/:from/send", async (req, res) => {
  try {
    const { from } = req.params;
    const { to, amount, privateKey } = req.body;

    if (!from || !to || !amount || !privateKey) {
      return res.status(400).json({
        error: "from, to, amount, privateKey required",
      });
    }

    // 🔹 Tatum BTC send payload
    const payload = {
      fromAddress: [
        {
          address: from,
          privateKey: privateKey,
        },
      ],
      to: [
        {
          address: to,
          value: Number(amount),
        },
      ],
    };

    const r = await axios.post(
      `${TATUM_API}/bitcoin/transaction`,
      payload,
      { headers: TATUM_HEADERS }
    );

    res.json({
      success: true,
      chain: "BTC",
      from,
      to,
      amount,
      txId: r.data.txId,
    });
  } catch (err) {
    console.error("BTC TATUM SEND ERROR 👉", err.response?.data || err.message);

    res.status(500).json({
      error: err.response?.data || err.message,
    });
  }
});



export default router;
