import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import bs58 from 'bs58';
import bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction
} from '@solana/web3.js';

dotenv.config();

const router = express.Router();
router.use(bodyParser.json());

/* ===============================
   CONFIG
================================ */

const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC, 'confirmed');

/* ===============================
   HELPERS
================================ */

// m/44'/501'/0'/0'
function keypairFromMnemonic(mnemonic, account = 0, change = 0) {
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic');
  }

  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const path = `m/44'/501'/${account}'/${change}'`;
  const derived = derivePath(path, seed.toString('hex'));
  return Keypair.fromSeed(derived.key);
}

function keypairFromPrivateKeyInput(input) {
  if (!input) throw new Error('privateKey required');

  if (Array.isArray(input)) {
    return Keypair.fromSecretKey(Uint8Array.from(input.map(Number)));
  }

  try {
    const parsed = JSON.parse(input);
    if (Array.isArray(parsed)) {
      return Keypair.fromSecretKey(Uint8Array.from(parsed.map(Number)));
    }
  } catch {}

  try {
    const decoded = bs58.decode(input);
    if (decoded.length === 32) return Keypair.fromSeed(decoded);
    if (decoded.length === 64) return Keypair.fromSecretKey(decoded);
  } catch {}

  try {
    const buf = Buffer.from(input, 'base64');
    if (buf.length === 32) return Keypair.fromSeed(buf);
    if (buf.length === 64) return Keypair.fromSecretKey(Uint8Array.from(buf));
  } catch {}

  throw new Error('Unsupported privateKey format');
}

function exportKeypair(kp) {
  return {
    publicKey: kp.publicKey.toBase58(),
    privateKey: bs58.encode(Buffer.from(kp.secretKey)),
    secretKeyArray: Array.from(kp.secretKey)
  };
}

/* ===============================
   ROUTES
================================ */

// Health
router.get('/health', (req, res) => {
  res.json({ ok: true, rpc: RPC });
});

// Create wallet
router.post('/wallet/create', (req, res) => {
  try {
    const { words = 12, account = 0, change = 0 } = req.body;

    if (![12, 24].includes(words)) {
      return res.status(400).json({ error: 'words must be 12 or 24' });
    }

    const entropy = words === 12 ? 128 : 256;
    const mnemonic = bip39.generateMnemonic(entropy);
    const kp = keypairFromMnemonic(mnemonic, account, change);

    res.json({
      mnemonic,
      ...exportKeypair(kp)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Import wallet via privateKey
router.post('/wallet/import', (req, res) => {
  try {
    const { privateKey } = req.body;
    if (!privateKey) {
      return res.status(400).json({ error: 'privateKey required' });
    }

    const kp = keypairFromPrivateKeyInput(privateKey);
    res.json(exportKeypair(kp));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Import via mnemonic
router.post('/wallet/import/mnemonic', (req, res) => {
  try {
    const { mnemonic, account = 0, change = 0 } = req.body;
    if (!mnemonic) {
      return res.status(400).json({ error: 'mnemonic required' });
    }

    const kp = keypairFromMnemonic(mnemonic, account, change);
    res.json(exportKeypair(kp));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get balance
router.get('/:address/balance', async (req, res) => {
  try {
    const pub = new PublicKey(req.params.address);
    const bal = await connection.getBalance(pub);

    res.json({
      address: pub.toBase58(),
      lamports: bal,
      sol: bal / LAMPORTS_PER_SOL
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send SOL
router.post('/:from/send', async (req, res) => {
  try {
    const { from } = req.params;
    const { privateKey, to, amount } = req.body;

    if (!privateKey || !to || !amount) {
      return res.status(400).json({ error: 'privateKey, to, amount required' });
    }

    const sender = keypairFromPrivateKeyInput(privateKey);

    if (sender.publicKey.toBase58() !== from) {
      return res.status(400).json({ error: 'privateKey mismatch' });
    }

    const lamports = Math.floor(Number(amount) * LAMPORTS_PER_SOL);

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: sender.publicKey,
        toPubkey: new PublicKey(to),
        lamports
      })
    );

    const sig = await sendAndConfirmTransaction(
      connection,
      tx,
      [sender]
    );

    res.json({
      from,
      to,
      amount,
      lamports,
      txSignature: sig
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
