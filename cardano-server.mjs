import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import axios from "axios";
import bip39 from "bip39";
import CardanoWasm from "@emurgo/cardano-serialization-lib-nodejs";

dotenv.config();

const router = express.Router();
router.use(bodyParser.json());

/* ===============================
   CONFIG
================================ */

const BLOCKFROST_KEY = process.env.BLOCKFROST_KEY || "";
const NETWORK = (process.env.CARDANO_NETWORK || "mainnet").toLowerCase();

const BLOCKFROST_URL = "https://cardano-mainnet.blockfrost.io/api/v0";


const BF_HEADERS = { project_id: BLOCKFROST_KEY };

/* ===============================
   HELPERS
================================ */

// m/1852'/1815'/0'/0/0
function deriveKeysFromMnemonic(mnemonic) {
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error("Invalid mnemonic");
  }

  const entropy = bip39.mnemonicToEntropy(mnemonic);

  const rootKey = CardanoWasm.Bip32PrivateKey.from_bip39_entropy(
    Buffer.from(entropy, "hex"),
    Buffer.from("")
  );

  const accountKey = rootKey
    .derive(1852 | 0x80000000)
    .derive(1815 | 0x80000000)
    .derive(0 | 0x80000000);

  const paymentKey = accountKey.derive(0).derive(0);
  const stakeKey = accountKey.derive(2).derive(0);

  const paymentPub = paymentKey.to_public();
  const stakePub = stakeKey.to_public();

  const networkId = NETWORK === "mainnet" ? 1 : 0;

  // ✅ FIX IS HERE
  const paymentCred = CardanoWasm.StakeCredential.from_keyhash(
    paymentPub.to_raw_key().hash()
  );

  const stakeCred = CardanoWasm.StakeCredential.from_keyhash(
    stakePub.to_raw_key().hash()
  );

  const baseAddr = CardanoWasm.BaseAddress.new(
    networkId,
    paymentCred,
    stakeCred
  );

  return {
    address: baseAddr.to_address().to_bech32(),
    paymentKey,
    stakeKey
  };
}

/* ===============================
   ROUTES
================================ */

// Create Wallet
router.post("/wallet/create", (req, res) => {
  try {
    const { words = 24 } = req.body;
    const strength = words === 24 ? 256 : 128;

    const mnemonic = bip39.generateMnemonic(strength);
    const { address } = deriveKeysFromMnemonic(mnemonic);

    res.json({ network: NETWORK, mnemonic, address });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Import Wallet
router.post("/wallet/import", (req, res) => {
  try {
    const { mnemonic } = req.body;
    if (!mnemonic) {
      return res.status(400).json({ error: "Mnemonic required" });
    }

    const { address } = deriveKeysFromMnemonic(mnemonic);

    res.json({ network: NETWORK, mnemonic, address });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Balance
router.get("/:address/balance", async (req, res) => {
  try {
    const { address } = req.params;

    const r = await axios.get(
      `${BLOCKFROST_URL}/addresses/${address}`,
      { headers: BF_HEADERS }
    );

    const lovelace = r.data.amount.find(a => a.unit === "lovelace");
    const qty = lovelace ? Number(lovelace.quantity) : 0;

    res.json({
      address,
      balance_lovelace: qty,
      balance_ada: qty / 1_000_000,
    });
  } catch (err) {
    res.status(500).json({
      error: err.response?.data || err.message,
    });
  }
});

// Send ADA
router.post("/send", async (req, res) => {
  try {
    const { mnemonic, to, amount } = req.body;

    if (!mnemonic || !to || !amount) {
      return res.status(400).json({
        error: "mnemonic, to, amount required",
      });
    }

    const amountLovelace = Math.floor(Number(amount) * 1_000_000);
    const { paymentKey, address: from } = deriveKeysFromMnemonic(mnemonic);

    const utxos = await axios.get(
      `${BLOCKFROST_URL}/addresses/${from}/utxos`,
      { headers: BF_HEADERS }
    );

    if (!utxos.data.length) {
      return res.status(400).json({ error: "No UTXO available" });
    }

    const txBuilder = CardanoWasm.TransactionBuilder.new(
      CardanoWasm.LinearFee.new(
        CardanoWasm.BigNum.from_str("44"),
        CardanoWasm.BigNum.from_str("155381")
      ),
      CardanoWasm.BigNum.from_str("1000000"),
      CardanoWasm.BigNum.from_str("500000000"),
      CardanoWasm.BigNum.from_str("2000000")
    );

    txBuilder.add_output(
      CardanoWasm.TransactionOutput.new(
        CardanoWasm.Address.from_bech32(to),
        CardanoWasm.Value.new(
          CardanoWasm.BigNum.from_str(amountLovelace.toString())
        )
      )
    );

    let totalInput = 0;

    for (const u of utxos.data) {
      const lov = u.amount.find(a => a.unit === "lovelace");
      const value = lov ? Number(lov.quantity) : 0;

      totalInput += value;

      txBuilder.add_input(
        CardanoWasm.Address.from_bech32(from),
        CardanoWasm.TransactionInput.new(
          CardanoWasm.TransactionHash.from_bytes(
            Buffer.from(u.tx_hash, "hex")
          ),
          u.tx_index
        ),
        CardanoWasm.Value.new(
          CardanoWasm.BigNum.from_str(value.toString())
        )
      );

      if (totalInput >= amountLovelace + 2_000_000) break;
    }

    txBuilder.add_change_if_needed(
      CardanoWasm.Address.from_bech32(from)
    );

    const txBody = txBuilder.build();
    const txHash = CardanoWasm.hash_transaction(txBody);

    const witnesses = CardanoWasm.TransactionWitnessSet.new();
    const vkeys = CardanoWasm.Vkeywitnesses.new();

    vkeys.add(
      CardanoWasm.make_vkey_witness(
        txHash,
        paymentKey.to_raw_key()
      )
    );

    witnesses.set_vkeys(vkeys);

    const signedTx = CardanoWasm.Transaction.new(
      txBody,
      witnesses
    );

    const submitRes = await axios.post(
      `${BLOCKFROST_URL}/tx/submit`,
      Buffer.from(signedTx.to_bytes()),
      {
        headers: {
          ...BF_HEADERS,
          "Content-Type": "application/cbor",
        },
      }
    );

    res.json({
      from,
      to,
      amount,
      txHash: submitRes.data,
    });
  } catch (err) {
    res.status(500).json({
      error: err.response?.data || err.message,
    });
  }
});

export default router;
