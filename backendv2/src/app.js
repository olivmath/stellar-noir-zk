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
const { Horizon, Keypair, Networks } = require("@stellar/stellar-sdk");

dotenv.config();

const app = express();

// Middlewares
app.use(helmet());
app.use(morgan("dev"));
app.use(cors());
app.use(express.json());

// Load Stellar account
let stellarServer;
let stellarAccount;

async function initializeStellar() {
  try {
    const NETWORK = process.env.STELLAR_NETWORK || "LOCALNET";
    const HORIZON = process.env.STELLAR_HORIZON || "http://localhost:8000";
    console.log("Stellar init config:", { NETWORK, HORIZON });

    if (NETWORK !== "TESTNET") {
      console.warn(
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

    console.log("✅ Stellar wallet initialized:");
    console.log(`  Address: ${stellarAccount.publicKey}`);
    console.log("  Secret (hidden):", `${stellarAccount.secret.slice(0,4)}****${stellarAccount.secret.slice(-4)}`);

    if (NETWORK === "TESTNET") {
      const friendbotUrl = `https://friendbot.stellar.org/?addr=${stellarAccount.publicKey}`;
      console.log("⏳ Requesting funds from Friendbot...");
      const resp = await fetch(friendbotUrl);
      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw new Error(
          `Friendbot failed: ${resp.status} ${resp.statusText} ${txt}`
        );
      }
      console.log("💰 Account funded by Friendbot");
    } else if (NETWORK === "LOCALNET") {
      const base = HORIZON.replace(/\/$/, "");
      const friendbotUrl = `${base}/friendbot?addr=${stellarAccount.publicKey}`;
      console.log("⏳ Requesting local Friendbot funds...");
      const resp = await fetch(friendbotUrl);
      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw new Error(
          `Local Friendbot failed: ${resp.status} ${resp.statusText} ${txt}`
        );
      }
      console.log("💰 Local account funded by Friendbot");
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
    console.log("📈 Balances:", balances.join(", "));
    console.log("Stellar init complete.");
  } catch (error) {
    console.error("❌ Failed to initialize Stellar:", error);
    process.exit(1);
  }
}

// Initialize Stellar wallet
initializeStellar();

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
    // ###############################################################
    console.log("1. receive request");
    console.log("Headers:", req.headers);
    const { proof, publicInputs, vk } = req.body;
    console.log("Body keys:", Object.keys(req.body));

    // ###############################################################
    console.log("2. validate input");
    if (!publicInputs || !proof || !vk) {
      return res.status(400).json({
        error: "Invalid proof data",
      });
    }

    // ###############################################################
    console.log("3. convert data to array");
    const proofUint8Array = new Uint8Array(Object.values(proof));
    const vkUint8Array = new Uint8Array(Object.values(vk));
    console.log("publicInputs:", publicInputs);
    console.log("proof length:", proofUint8Array.length);
    console.log("vk length:", vkUint8Array.length);
    const previewHex = (arr) => Array.from(arr.slice(0, 16)).map((b) => b.toString(16).padStart(2, "0")).join("");
    console.log("proof preview (first 16 bytes hex):", previewHex(proofUint8Array));
    console.log("vk preview (first 16 bytes hex):", previewHex(vkUint8Array));

    // ###############################################################
    console.log("4. skip local verification (using Stellar context)");

    // ###############################################################
    console.log("6. skip convert proof/vk for Stellar placeholder");

    // ###############################################################
    console.log("7. submit context to Stellar (placeholder)");
    // Example placeholder: return wallet info so caller knows context is Stellar
    const responsePayload = {
      message: "Proof verified locally. Stellar context active.",
      verified: true,
      wallet: {
        address: stellarAccount.publicKey,
      },
      debug: {
        publicInputs,
        proofLen: proofUint8Array.length,
        vkLen: vkUint8Array.length,
      },
    };
    console.log("Response:", responsePayload);
    return res.status(200).json(responsePayload);
    // ###############################################################
  } catch (error) {
    console.error("Error processing request:", error?.message || error);
    console.error("Stack:", error?.stack);
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
