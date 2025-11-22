// app.js
const express = require("express");
const dotenv = require("dotenv");
const helmet = require("helmet");
const morgan = require("morgan");
const cors = require("cors");

const fs = require("fs");
const path = require("path");

const { UltraHonkBackend } = require("@aztec/bb.js");
const { NoirService } = require("./services/NoirService");
const { StellarContractService } = require("./services/StellarContractService");
const {
  Horizon,
  Keypair,
  Networks,
  TransactionBuilder,
} = require("@stellar/stellar-sdk");
let ContractClient;
let ContractSpec;

dotenv.config();

const app = express();

// Middlewares
app.use(helmet());
app.use(morgan("dev"));
app.use(cors());
app.use(express.json());
const S = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  blue: "\x1b[34m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  red: "\x1b[31m",
};
const header = (title) => {
  console.log("");
  console.log(`${S.bold}${S.blue}▮ ${title}${S.reset}`);
  console.log("");
};
const detail = (label, obj) => {
  console.log(`${S.magenta}${label}${S.reset}`, obj);
};
const warn = (msg) => {
  console.warn(`${S.yellow}⚠ ${msg}${S.reset}`);
};
const ok = (msg, obj) => {
  console.log(`${S.green}${msg}${S.reset}`, obj ?? "");
};
const fail = (msg, err) => {
  console.error(`${S.red}❌ ${msg}${S.reset}`, err ?? "");
};

// ZK circuit/backend initialization
let zkBackend;
function initializeZK() {
  try {
    header("ZK initialization");
    const circuitPath = path.join(__dirname, "..", "public", "circuit.json");
    const circuitRaw = fs.readFileSync(circuitPath, "utf-8");
    const circuit = JSON.parse(circuitRaw);
    zkBackend = new UltraHonkBackend(circuit.bytecode);
    ok("ZK circuit loaded and backend initialized");
  } catch (err) {
    fail("Failed to initialize ZK circuit", err);
    process.exit(1);
  }
}

// Load Stellar account
let stellarServer;
let stellarAccount;
let ultraClient;
let ultraClientReadyPromise;

async function initializeStellar() {
  try {
    const NETWORK = process.env.STELLAR_NETWORK || "LOCALNET";
    const HORIZON = process.env.STELLAR_HORIZON || "http://localhost:8000";
    header("Stellar initialization");
    detail("Config:", { NETWORK, HORIZON });

    if (NETWORK !== "TESTNET") {
      warn(
        "Using non-TESTNET network. Ensure friendbot funding is available for your network."
      );
    }

    stellarServer = new Horizon.Server(HORIZON, { allowHttp: true });
    let keypair;
    const SECRET = process.env.SECRET;
    if (SECRET) {
      keypair = Keypair.fromSecret(SECRET);
    } else {
      keypair = Keypair.random();
    }

    stellarAccount = {
      publicKey: keypair.publicKey(),
      secret: keypair.secret(),
      keypair,
    };

    header("Stellar wallet initialized");
    detail("Address:", stellarAccount.publicKey);
    detail(
      "Secret (hidden):",
      `${stellarAccount.secret.slice(0, 4)}****${stellarAccount.secret.slice(
        -4
      )}`
    );

    if (NETWORK === "TESTNET") {
      const friendbotUrl = `https://friendbot.stellar.org/?addr=${stellarAccount.publicKey}`;
      header("Requesting funds from Friendbot");
      const resp = await fetch(friendbotUrl);
      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw new Error(
          `Friendbot failed: ${resp.status} ${resp.statusText} ${txt}`
        );
      }
      ok("💰 Account funded by Friendbot");
    } else if (NETWORK === "LOCALNET") {
      const base = HORIZON.replace(/\/$/, "");
      const friendbotUrl = `${base}/friendbot?addr=${stellarAccount.publicKey}`;
      header("Requesting local Friendbot funds");
      const resp = await fetch(friendbotUrl);
      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw new Error(
          `Local Friendbot failed: ${resp.status} ${resp.statusText} ${txt}`
        );
      }
      ok("💰 Local account funded by Friendbot");
    }

    const account = await stellarServer.loadAccount(stellarAccount.publicKey);
    const balances = account.balances.map(
      (b) =>
        `${b.balance} ${
          b.asset_type === "native"
            ? "XLM"
            : `${b.asset_code}:${b.asset_issuer}`
        }`
    );
    detail("Balances:", balances.join(", "));
    ok("Stellar init complete.");
  } catch (error) {
    fail("Failed to initialize Stellar:", error);
    process.exit(1);
  }
}

// Initialize Stellar wallet
initializeStellar();
initializeZK();

async function initUltraClient() {
  const NETWORK_PASSPHRASE =
    process.env.NETWORK_PASSPHRASE || "Standalone Network ; February 2017";
  const RPC_URL = process.env.STELLAR_RPC_URL || "http://localhost:8000/rpc";
  const CONTRACT_ID = process.env.ULTRAHONK_CONTRACT_ID || "CCYOG5RLITFKOVERLBDXOHAZ6R65A7LLDP3NU7Y3X7A6D3RL5YDTB6KT";
  const { Client: VerifierClient } = await import(
    path.join(__dirname, "verifier-lib", "dist", "index.js")
  );
  ultraClient = new VerifierClient({
    networkPassphrase: NETWORK_PASSPHRASE,
    contractId: CONTRACT_ID,
    rpcUrl: RPC_URL,
    allowHttp: true,
    publicKey: undefined,
  });
}

ultraClientReadyPromise = initUltraClient().catch((e) => {
  fail("Failed to initialize UltraClient", e);
});

// Hello World route
app.get("/hello", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Hello World</title>
      </head>
      <body>
        <h1>Hello World!</h1>
      </body>
    </html>
  `);
});

// PreFlight request for /api/verify
app.options("/api/verify", cors(), (req, res) => {
  res.sendStatus(204);
});

// Verify proof route
app.post("/api/verify", async (req, res) => {
  try {
    if (ultraClientReadyPromise) {
      await ultraClientReadyPromise;
    }
    if (!ultraClient) {
      throw new Error("Contract client not initialized");
    }
    header("1. receive request");
    detail("Headers:", req.headers);
    const { proof, publicInputs, vk } = req.body;
    detail("Body keys:", Object.keys(req.body));

    header("2. validate input");
    if (!publicInputs || !proof || !vk) {
      return res.status(400).json({
        error: "Invalid proof data",
      });
    }

    // ###############################################################
    // VERIFY PROOF
    // ###############################################################
    const toUint8 = (v) => {
      if (v instanceof Uint8Array) return v;
      if (Buffer.isBuffer(v)) return new Uint8Array(v);
      if (Array.isArray(v)) return Uint8Array.from(v);
      if (typeof v === "string") {
        const s = v.trim();
        const isHex = /^0x[0-9a-fA-F]+$/.test(s) || /^[0-9a-fA-F]+$/.test(s);
        if (isHex) {
          const hex = s.startsWith("0x") ? s.slice(2) : s;
          const out = new Uint8Array(hex.length / 2);
          for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
          return out;
        }
        try {
          const b = Buffer.from(s, "base64");
          return new Uint8Array(b);
        } catch (_) {}
      }
      if (v && typeof v === "object" && "data" in v && Array.isArray(v.data)) return Uint8Array.from(v.data);
      throw new Error("Unsupported input format");
    };

    const proofBytes = toUint8(proof);
    const pubInputsBytes = toUint8(publicInputs);
    const vkBytes = toUint8(vk);

    const noirSvc = new NoirService();
    const { proofBlob } = noirSvc.buildProofBlob(pubInputsBytes, proofBytes);

    // ###############################################################
    // MONT TX
    // ###############################################################
    ultraClient.options.publicKey = stellarAccount.publicKey;
    const tx = await ultraClient.verify_proof({
      vk_json: Buffer.from(vkBytes),
      proof_blob: StellarContractService.toBuffer(proofBlob),
    });

    // ###############################################################
    // SIGN TX
    // ###############################################################
    const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE || "Standalone Network ; February 2017";
    const walletSignTransaction = async (xdr) => {
      const txObj = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE);
      txObj.sign(stellarAccount.keypair);
      return { signedTxXdr: txObj.toXDR(), signerAddress: stellarAccount.publicKey };
    };

    // ###############################################################
    // SEND TO CONTRACT
    // ###############################################################
    const result = await tx.signAndSend({ signTransaction: walletSignTransaction });
    const cpu = StellarContractService.extractCpuInstructions(tx);
    const txData = StellarContractService.extractTransactionData(result);
    return res.status(200).json({ success: true, txHash: txData.txHash, fee: txData.fee, cpuInstructions: cpu });
  } catch (error) {
    fail("Error processing request:", error?.message || error);
    detail("Stack:", error?.stack);
    return res.status(500).json({
      error: "Internal server error",
      message: error?.message,
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Internal server error" });
});

module.exports = app;
