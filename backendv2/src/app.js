// app.js
const express = require("express");
const dotenv = require("dotenv");
const helmet = require("helmet");
const morgan = require("morgan");
const cors = require("cors");

const fs = require("fs");
const path = require("path");

const {
  convertProof,
  convertVerificationKey,
} = require("olivmath-ultraplonk-zk-verify");
const { UltraHonkBackend } = require("@aztec/bb.js");
const { Horizon, Keypair, Networks, TransactionBuilder } = require("@stellar/stellar-sdk");
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
  const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE || "Standalone Network ; February 2017";
  const RPC_URL = process.env.STELLAR_RPC_URL || "http://localhost:8000/rpc";
  const CONTRACT_ID = process.env.ULTRAHONK_CONTRACT_ID || "CCYOG5RLITFKOVERLBDXOHAZ6R65A7LLDP3NU7Y3X7A6D3RL5YDTB6KT";
  const mod = await import("@stellar/stellar-sdk/contract");
  ContractClient = mod.ContractClient || mod.Client;
  ContractSpec = mod.ContractSpec || mod.Spec;
  if (!ContractClient || !ContractSpec) {
    throw new Error("Failed to load stellar-sdk/contract module exports");
  }
  class UltraClient extends ContractClient {
    constructor(options) {
      super(
        new ContractSpec([
          "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAABAAAAAAAAAAMVmtQYXJzZUVycm9yAAAAAQAAAAAAAAAPUHJvb2ZQYXJzZUVycm9yAAAAAAIAAAAAAAAAElZlcmlmaWNhdGlvbkZhaWxlZAAAAAAAAwAAAAAAAAAIVmtOb3RTZXQAAAAE",
          "AAAAAAAAAE5WZXJpZnkgYW4gVWx0cmFIb25rIHByb29mOyBvbiBzdWNjZXNzIHN0b3JlIHByb29mX2lkICg9IGtlY2NhazI1Nihwcm9vZl9ibG9iKSkAAAAAAAx2ZXJpZnlfcHJvb2YAAAACAAAAAAAAAAd2a19qc29uAAAAAA4AAAAAAAAACnByb29mX2Jsb2IAAAAAAA4AAAABAAAD6QAAA+4AAAAgAAAAAw==",
          "AAAAAAAAAD1TZXQgdmVyaWZpY2F0aW9uIGtleSBKU09OIGFuZCBjYWNoZSBpdHMgaGFzaC4gUmV0dXJucyB2a19oYXNoAAAAAAAABnNldF92awAAAAAAAQAAAAAAAAAHdmtfanNvbgAAAAAOAAAAAQAAA+kAAAPuAAAAIAAAAAM=",
          "AAAAAAAAACNWZXJpZnkgdXNpbmcgdGhlIG9uLWNoYWluIHN0b3JlZCBWSwAAAAAbdmVyaWZ5X3Byb29mX3dpdGhfc3RvcmVkX3ZrAAAAAAEAAAAAAAAACnByb29mX2Jsb2IAAAAAAA4AAAABAAAD6QAAA+4AAAAgAAAAAw==",
          "AAAAAAAAACtRdWVyeSBpZiBhIHByb29mX2lkIHdhcyBwcmV2aW91c2x5IHZlcmlmaWVkAAAAAAtpc192ZXJpZmllZAAAAAABAAAAAAAAAAhwcm9vZl9pZAAAA+4AAAAgAAAAAQAAAAE="
        ]),
        options
      );
    }
  }
  ultraClient = new UltraClient({
    networkPassphrase: NETWORK_PASSPHRASE,
    contractId: CONTRACT_ID,
    rpcUrl: RPC_URL,
    allowHttp: true,
    publicKey: undefined
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

    header("3. convert data to array");
    const toUint8 = (v) => {
      if (v instanceof Uint8Array) return v;
      if (Array.isArray(v)) return new Uint8Array(v);
      if (typeof v === "string") {
        const hex = v.startsWith("0x") ? v.slice(2) : v;
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < bytes.length; i++) {
          bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
        }
        return bytes;
      }
      return new Uint8Array(Object.values(v));
    };
    const proofUint8Array = toUint8(proof);
    const vkUint8Array = toUint8(vk);
    const publicInputsUint8Array = toUint8(publicInputs);
    detail("publicInputs:", publicInputs);
    detail("proof length:", proofUint8Array.length);
    detail("vk length:", vkUint8Array.length);
    const previewHex = (arr) =>
      Array.from(arr.slice(0, 16))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    detail("proof preview (first 16 bytes hex):", previewHex(proofUint8Array));
    detail("vk preview (first 16 bytes hex):", previewHex(vkUint8Array));

    const totalFields = proofUint8Array.length / 32 + publicInputsUint8Array.length / 32;
    const headerBytes = new Uint8Array(4);
    new DataView(headerBytes.buffer).setUint32(0, totalFields, false);
    const proofBlob = new Uint8Array(headerBytes.length + publicInputsUint8Array.length + proofUint8Array.length);
    proofBlob.set(headerBytes, 0);
    proofBlob.set(publicInputsUint8Array, headerBytes.length);
    proofBlob.set(proofUint8Array, headerBytes.length + publicInputsUint8Array.length);

    let vkJsonInput;
    try {
      const convertedVk = convertVerificationKey(vkUint8Array);
      vkJsonInput = typeof convertedVk === "string" ? convertedVk : JSON.stringify(convertedVk);
    } catch (_) {
      vkJsonInput = Buffer.from(vkUint8Array).toString("utf-8");
    }
    const vkBuffer = Buffer.from(vkJsonInput);
    const proofBlobBuffer = Buffer.from(proofBlob);

    ultraClient.options.publicKey = stellarAccount.publicKey;
    const tx = await ultraClient.verify_proof({
      vk_json: vkBuffer,
      proof_blob: proofBlobBuffer,
    });
    const result = await tx.signAndSend({
      signTransaction: async (xdr) => {
        const passphrase = ultraClient.options.networkPassphrase;
        const txObj = TransactionBuilder.fromXDR(xdr, passphrase);
        txObj.sign(stellarAccount.keypair);
        return { signedTxXdr: txObj.toXDR(), signerAddress: stellarAccount.publicKey };
      },
    });
    const hash = result?.hash || result?.transactionHash || "";
    const payload = { success: true, txHash: hash };
    detail("Response:", payload);
    return res.status(200).json(payload);
    // ###############################################################
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
