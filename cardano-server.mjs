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

const BLOCKFROST_KEY = process.env.BLOCKFROST_KEY;
const NETWORK = (process.env.CARDANO_NETWORK || "mainnet").toLowerCase();

const BLOCKFROST_URL =
  NETWORK === "testnet"
    ? "https://cardano-testnet.blockfrost.io/api/v0"
    : "https://cardano-mainnet.blockfrost.io/api/v0";

const BF_HEADERS = {
  project_id: BLOCKFROST_KEY,
};


const TATUM_KEY = process.env.TATUM_API_KEY;

// Always Mainnet
const TATUM_GATEWAY = "https://cardano-mainnet.gateway.tatum.io";

const TATUM_HEADERS = {
  "x-api-key": TATUM_KEY,
  "Content-Type": "application/json",
};


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

  const paymentCred = CardanoWasm.StakeCredential.from_keyhash(
    paymentKey.to_raw_key().to_public().hash()
  );

  const stakeCred = CardanoWasm.StakeCredential.from_keyhash(
    stakeKey.to_raw_key().to_public().hash()
  );

  const baseAddr = CardanoWasm.BaseAddress.new(
    NETWORK === "testnet" ? 0 : 1,
    paymentCred,
    stakeCred
  );

  return {
    address: baseAddr.to_address().to_bech32(),
    paymentKey,
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


/* =====================================
   GET BALANCE (ADA)
===================================== */

router.get("/balance/:address", async (req, res) => {
  try {
    const { address } = req.params;

    // Basic validation
    if (!address.startsWith("addr1")) {
      return res.status(400).json({
        success: false,
        error: "Invalid mainnet Cardano address",
      });
    }

    const response = await axios.get(
      `https://api.tatum.io/v3/ada/account/${address}`,
      {
        headers: {
          accept: "application/json",
          "x-api-key": process.env.TATUM_API_KEY,
        },
      }
    );

    const adaData = response.data.find(
      (item) => item.currency.symbol === "ADA"
    );

    const lovelace = adaData ? adaData.value : "0";

    res.json({
      success: true,
      address,
      balance_ada: Number(lovelace) / 1_000_000,
      balance_lovelace: lovelace,
    });

  } catch (err) {
    console.error("Balance Error:", err.response?.data);
    res.status(500).json({
      success: false,
      error: "Unable to fetch balance",
    });
  }
});

/* ===============================
   SEND ADA (FINAL)
================================ */

router.post("/send", async (req, res) => {
  try {
    const { mnemonic, to, amount } = req.body;

    if (!mnemonic || !to || !amount) {
      return res.status(400).json({
        error: "mnemonic, to, amount required",
      });
    }

    if (!to.startsWith("addr")) {
      return res.status(400).json({
        error: "Invalid Cardano address",
      });
    }

    const amountLovelace = Math.floor(Number(amount) * 1_000_000);
    if (amountLovelace < 1_000_000) {
      return res.status(400).json({
        error: "Minimum 1 ADA required",
      });
    }

    const { address: from, paymentKey } =
      deriveKeysFromMnemonic(mnemonic);

    // Fetch UTXOs
    const utxoRes = await axios.get(
      `${BLOCKFROST_URL}/addresses/${from}/utxos`,
      { headers: BF_HEADERS }
    );

    if (!utxoRes.data.length) {
      return res.status(400).json({
        error: "No UTXO available",
      });
    }

    // TX Config (FULLY INITIALIZED)
    const txBuilderConfig =
      CardanoWasm.TransactionBuilderConfigBuilder.new()
        .fee_algo(
          CardanoWasm.LinearFee.new(
            CardanoWasm.BigNum.from_str("44"),
            CardanoWasm.BigNum.from_str("155381")
          )
        )
        .pool_deposit(CardanoWasm.BigNum.from_str("500000000"))
        .key_deposit(CardanoWasm.BigNum.from_str("2000000"))
        .coins_per_utxo_byte(CardanoWasm.BigNum.from_str("4310"))
        .max_tx_size(16384)
        .max_value_size(5000)
        .build();

    const txBuilder =
      CardanoWasm.TransactionBuilder.new(txBuilderConfig);

    // Output
    txBuilder.add_output(
      CardanoWasm.TransactionOutput.new(
        CardanoWasm.Address.from_bech32(to),
        CardanoWasm.Value.new(
          CardanoWasm.BigNum.from_str(amountLovelace.toString())
        )
      )
    );

    // Inputs
    let totalInput = 0;
    for (const u of utxoRes.data) {
      const lovelace = u.amount.find(
        (a) => a.unit === "lovelace"
      );
      if (!lovelace) continue;

      const value = Number(lovelace.quantity);
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

      if (totalInput >= amountLovelace + 3_000_000) break;
    }

    // Change
    txBuilder.add_change_if_needed(
      CardanoWasm.Address.from_bech32(from)
    );

    // Build + Sign
    const txBody = txBuilder.build();
    const txHash = CardanoWasm.hash_transaction(txBody);

    const witnesses =
      CardanoWasm.TransactionWitnessSet.new();
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

    // Submit
    const submit = await axios.post(
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
      success: true,
      from,
      to,
      amount,
      txHash: submit.data,
    });
  } catch (err) {
    console.error("CARDANO SEND ERROR:", err);
    res.status(500).json({
      error: err.message || "Transaction failed",
    });
  }
});










export default router;
