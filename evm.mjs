import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import {
  Wallet,
  JsonRpcProvider,
  formatEther,
  parseEther,
  parseUnits,          // ✅ ADD THIS
  Contract,
  isAddress,
  formatUnits
} from 'ethers';


dotenv.config();

const router = express.Router();
router.use(bodyParser.json());

/* ===============================
   CHAINS (SONIC + EVM)
================================ */

export const CHAINS = {
  sonic: {
    name: 'sonic',
    chainId: 146,
    rpc: process.env.SONIC_RPC || 'https://sonic-mainnet.g.alchemy.com/v2/mRmzPjBZX6OXLO4gK5bON',
    explorer: 'https://sonicscan.org'
  },
  ethereum: {
    name: 'ethereum',
    chainId: 1,
    rpc: process.env.ETH_RPC || 'https://site1.moralis-nodes.com/eth/edf69d74486f40a0a22fac09f265daad',
    explorer: 'https://etherscan.io'
  },
  base: {
    name: 'base',
    chainId: 8453,
    rpc: process.env.BASE_RPC || 'https://site1.moralis-nodes.com/base/c33a445381944db09bb4440571d2ac9c',
    explorer: 'https://basescan.org'
  },
  polygon: {
    name: 'polygon',
    chainId: 137,
    rpc: process.env.POLY_RPC || 'https://site1.moralis-nodes.com/polygon/1df3791b7c6b4df0a1f691fb1b1f902a',
    explorer: 'https://polygonscan.com'
  }
};

/* ===============================
   PROVIDER / WALLET HELPERS
================================ */

function getProvider(chain = 'ethereum') {
  const cfg = CHAINS[chain];
  if (!cfg) throw new Error(`Unsupported chain: ${chain}`);
  return new JsonRpcProvider(cfg.rpc, cfg.chainId);
}

function loadWalletFromPrivateKey(pk, chain = 'ethereum') {
  return new Wallet(pk, getProvider(chain));
}

/* ===============================
   ROUTES
================================ */

// Health
router.get('/health', (req, res) => {
  res.json({
    ok: true,
    chains: Object.keys(CHAINS)
  });
});

// Create wallet
router.post('/wallet/create', async (req, res) => {
  try {
    const wallet = Wallet.createRandom();
    res.json({
      address: wallet.address,
      privateKey: wallet.privateKey,
      mnemonic: wallet.mnemonic.phrase
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Import via private key
router.post('/wallet/import', async (req, res) => {
  try {
    const { privateKey, chain = 'ethereum' } = req.body;
    if (!privateKey) {
      return res.status(400).json({ error: 'privateKey required' });
    }

    const wallet = loadWalletFromPrivateKey(privateKey, chain);

    res.json({
      address: wallet.address,
      chain
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Import via mnemonic
router.post('/wallet/import/mnemonic', async (req, res) => {
  try {
    const { mnemonic, chain = 'ethereum' } = req.body;
    if (!mnemonic) {
      return res.status(400).json({ error: 'mnemonic required' });
    }

    const provider = getProvider(chain);
    const wallet = Wallet.fromPhrase(mnemonic).connect(provider);

    res.json({
      address: wallet.address,
      privateKey: wallet.privateKey,
      chain
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Native balance
router.get('/wallet/:address/balance', async (req, res) => {
  try {
    const { chain = 'ethereum' } = req.query;
    const address = req.params.address;

    if (!isAddress(address)) {
      return res.status(400).json({ error: 'invalid address' });
    }

    const provider = getProvider(chain);
    const bal = await provider.getBalance(address);

    res.json({
      chain,
      address,
      balance: formatEther(bal)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Send native token (AUTO GAS + MAX SUPPORT)
router.post('/wallet/:from/send', async (req, res) => {
  try {
    const { from } = req.params;
    let { to, amount, privateKey, chain = 'ethereum', gasLimit } = req.body;

    if (!isAddress(from) || !isAddress(to)) {
      return res.status(400).json({ error: 'invalid address' });
    }

    if (!privateKey) {
      return res.status(400).json({ error: 'privateKey required' });
    }

    const wallet = loadWalletFromPrivateKey(privateKey, chain);

    if (wallet.address.toLowerCase() !== from.toLowerCase()) {
      return res.status(400).json({ error: 'privateKey mismatch' });
    }

    const provider = wallet.provider;

    /* ===============================
       BALANCE
    ================================ */

    const balanceWei = await provider.getBalance(from);

    if (balanceWei <= 0n) {
      return res.status(400).json({ error: 'insufficient balance' });
    }

    /* ===============================
       PREP TX (for gas estimate)
    ================================ */

    let valueWei = 0n;
    const feeData = await provider.getFeeData();

    const txForEstimate = {
      from,
      to,
      value: 0n
    };

    const estimatedGas =
      gasLimit ??
      (await provider.estimateGas(txForEstimate));

    const gasPrice =
      feeData.maxFeePerGas ?? feeData.gasPrice;

    const gasCost = estimatedGas * gasPrice;

    /* ===============================
       AMOUNT LOGIC
       - "max" OR undefined = full balance - gas
       - else numeric (8 decimals)
    ================================ */

    if (!amount || amount === 'max') {
      if (balanceWei <= gasCost) {
        return res.status(400).json({ error: 'balance too low for gas' });
      }

      valueWei = balanceWei - gasCost;
    } else {
      // limit to 18 decimals
      const fixed = Number(amount).toFixed(18);
      valueWei = parseEther(fixed);

      if (valueWei + gasCost > balanceWei) {
        return res.status(400).json({
          error: 'amount + gas exceeds balance'
        });
      }
    }

    /* ===============================
       FINAL TX
    ================================ */

    const tx = await wallet.sendTransaction({
      to,
      value: valueWei,
      gasLimit: estimatedGas,
      maxFeePerGas: feeData.maxFeePerGas ?? undefined,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? undefined
    });

    res.json({
      chain,
      from,
      to,
      sentAmount: formatEther(valueWei),
      gasUsed: estimatedGas.toString(),
      gasCost: formatEther(gasCost),
      txHash: tx.hash
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



/* ===============================
   ERC20
================================ */

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function decimals() view returns (uint8)'
];

// ERC20 balance
router.get('/token/:chain/:tokenAddress/balance/:owner', async (req, res) => {
  try {
    const { chain, tokenAddress, owner } = req.params;

    if (!isAddress(tokenAddress) || !isAddress(owner)) {
      return res.status(400).json({ error: 'invalid address' });
    }

    const provider = getProvider(chain);
    const token = new Contract(tokenAddress, ERC20_ABI, provider);

    const raw = await token.balanceOf(owner);
    const dec = await token.decimals().catch(() => 18);

    res.json({
      chain,
      tokenAddress,
      owner,
      balance: formatUnits(raw, dec)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ERC20 transfer (FAST RESPONSE – DEX WALLET STYLE)

router.post('/token/:chain/:tokenAddress/transfer', async (req, res) => {
  try {
    const { chain, tokenAddress } = req.params;
    const { privateKey, to, amount } = req.body;

    if (!privateKey || !to || !amount) {
      return res.status(400).json({
        success: false,
        error: 'privateKey, to, amount required'
      });
    }

    if (!isAddress(to) || !isAddress(tokenAddress)) {
      return res.status(400).json({
        success: false,
        error: 'invalid address'
      });
    }

    const wallet = loadWalletFromPrivateKey(privateKey, chain);
    const token = new Contract(tokenAddress, ERC20_ABI, wallet);

    const decimals = await token.decimals();
    const value = parseUnits(amount.toString(), decimals);

    const tx = await token.transfer(to, value);

    // ✅ CLEAN RESPONSE (NO BigInt)
    res.json({
      success: true,
      status: 'submitted',
      chain,
      tokenAddress,
      from: wallet.address,
      to,
      amount,
      txHash: tx.hash
    });

  } catch (e) {
    res.status(500).json({
      success: false,
      error: e.message
    });
  }
});


export default router;
