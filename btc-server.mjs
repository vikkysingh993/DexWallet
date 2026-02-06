import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import axios from 'axios';
import * as bitcoin from 'bitcoinjs-lib';
import bip39 from 'bip39';
import * as ecc from 'tiny-secp256k1';
import { BIP32Factory } from 'bip32';

dotenv.config();

/* ===============================
   INIT
================================ */

bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);

const router = express.Router();
router.use(bodyParser.json());

/* ===============================
   BTC MAINNET CONFIG (FIXED)
================================ */

const NETWORK_NAME = 'mainnet';
const NETWORK = bitcoin.networks.bitcoin;
const BLOCKSTREAM_API = 'https://blockstream.info/api';

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
    throw new Error('Invalid mnemonic');
  }

  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const root = bip32.fromSeed(seed, NETWORK);

  const path = `m/${DEFAULT_PURPOSE}'/${DEFAULT_COIN}'/${account}'/0/${addressIndex}`;
  const child = root.derivePath(path);

  return { child, path };
}

async function fetchUtxos(address) {
  const r = await axios.get(`${BLOCKSTREAM_API}/address/${address}/utxo`);
  return r.data;
}

async function fetchBalance(address) {
  const r = await axios.get(`${BLOCKSTREAM_API}/address/${address}`);
  const { chain_stats, mempool_stats } = r.data;

  const confirmed =
    (chain_stats.funded_txo_sum || 0) -
    (chain_stats.spent_txo_sum || 0);

  const mempool =
    (mempool_stats.funded_txo_sum || 0) -
    (mempool_stats.spent_txo_sum || 0);

  const total = confirmed + mempool;

  return {
    sats: total,
    btc: satsToBtc(total),
    confirmed_sats: confirmed
  };
}

async function fetchFeeRate() {
  try {
    const r = await axios.get(`${BLOCKSTREAM_API}/fee-estimates`);
    return Math.max(Math.round(r.data['1'] || 10), 1);
  } catch {
    return 10;
  }
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

async function broadcastTx(hex) {
  const r = await axios.post(
    `${BLOCKSTREAM_API}/tx`,
    hex,
    { headers: { 'Content-Type': 'text/plain' } }
  );
  return r.data;
}

/* ===============================
   ROUTES
================================ */

// Health
router.get('/health', (req, res) => {
  res.json({
    ok: true,
    network: NETWORK_NAME,
    explorer: BLOCKSTREAM_API
  });
});

// Create wallet
router.post('/wallet/create', (req, res) => {
  try {
    const { words = 12, accountIndex = 0, addressIndex = 0 } = req.body;

    if (![12, 24].includes(words)) {
      return res.status(400).json({ error: 'words must be 12 or 24' });
    }

    const strength = words === 24 ? 256 : 128;
    const mnemonic = bip39.generateMnemonic(strength);

    const { child, path } = deriveFromMnemonic(
      mnemonic,
      accountIndex,
      addressIndex
    );

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

// Import wallet (WIF)
router.post('/wallet/import', (req, res) => {
  try {
    const { privateKeyWIF } = req.body;
    if (!privateKeyWIF) {
      return res.status(400).json({ error: 'privateKeyWIF required' });
    }

    const keyPair = bitcoin.ECPair.fromWIF(privateKeyWIF, NETWORK);
    const address = bitcoin.payments.p2wpkh({
      pubkey: keyPair.publicKey,
      network: NETWORK
    }).address;

    res.json({
      network: NETWORK_NAME,
      address,
      privateKeyWIF
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Import via mnemonic
router.post('/wallet/import/mnemonic', (req, res) => {
  try {
    const { mnemonic, accountIndex = 0, addressIndex = 0 } = req.body;
    if (!mnemonic) {
      return res.status(400).json({ error: 'mnemonic required' });
    }

    const { child, path } = deriveFromMnemonic(
      mnemonic,
      accountIndex,
      addressIndex
    );

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

// Balance
router.get('/:address/balance', async (req, res) => {
  try {
    const bal = await fetchBalance(req.params.address);
    res.json({
      address: req.params.address,
      network: NETWORK_NAME,
      balance_sats: bal.sats,
      balance_btc: bal.btc,
      confirmed_sats: bal.confirmed_sats
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Send BTC
router.post('/:from/send', async (req, res) => {
  try {
    const { from } = req.params;
    const { privateKeyWIF, to, amount, feeRate } = req.body;

    if (!privateKeyWIF || !to || !amount) {
      return res.status(400).json({ error: 'privateKeyWIF, to, amount required' });
    }

    const keyPair = bitcoin.ECPair.fromWIF(privateKeyWIF, NETWORK);
    const fromAddress = bitcoin.payments.p2wpkh({
      pubkey: keyPair.publicKey,
      network: NETWORK
    }).address;

    if (fromAddress !== from) {
      return res.status(400).json({ error: 'privateKey mismatch' });
    }

    const utxos = await fetchUtxos(fromAddress);
    if (!utxos.length) {
      return res.status(400).json({ error: 'no utxos available' });
    }

    const rate = feeRate || await fetchFeeRate();
    const amountSats = btcToSats(amount);

    const { chosen, sum } = selectUtxosGreedy(
      utxos,
      amountSats + 1000
    );

    const fee = Math.ceil(
      estimateTxVsize(chosen.length, 2) * rate
    );

    if (sum < amountSats + fee) {
      return res.status(400).json({ error: 'insufficient funds' });
    }

    const psbt = new bitcoin.Psbt({ network: NETWORK });

    chosen.forEach(u => {
      psbt.addInput({
        hash: u.txid,
        index: u.vout,
        witnessUtxo: {
          script: bitcoin.payments.p2wpkh({
            pubkey: keyPair.publicKey,
            network: NETWORK
          }).output,
          value: u.value
        }
      });
    });

    psbt.addOutput({ address: to, value: amountSats });
    psbt.addOutput({
      address: fromAddress,
      value: sum - amountSats - fee
    });

    chosen.forEach((_, i) => psbt.signInput(i, keyPair));
    psbt.finalizeAllInputs();

    const txid = await broadcastTx(
      psbt.extractTransaction().toHex()
    );

    res.json({
      network: NETWORK_NAME,
      from: fromAddress,
      to,
      amount_btc: amount,
      amount_sats: amountSats,
      fee_sats: fee,
      txid
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
