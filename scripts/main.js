// 1. Import libs (async)
// 2. Load a Circuit
// 3. Load a ultraplonkBackend
// 4. Generate a witness
// 5. Generate a Proof
// 6. Submit to Stellar

import { readFile } from "fs/promises";

async function main() {
  const BACKEND = process.env.BACKEND ?? "http://localhost:3000/api/verify";
  console.log("Backend URL:", BACKEND);

  try {
    console.log("10%", "Loading circuit...");
    const { UltraHonkBackend } = await import("@aztec/bb.js");
    const { Noir } = await import("@noir-lang/noir_js");
    const circuit = JSON.parse(
      await readFile(new URL("./circuit.json", import.meta.url), "utf-8")
    );

    console.log("25%", "Initializing circuit...");
    const noir = new Noir(circuit);
    const backend = new UltraHonkBackend(circuit.bytecode);

    // Use current year dynamically
    const currentYear = new Date().getFullYear();

    // Validate inputs before generating proof
    const birthYearArg = Number(process.argv[2] ?? process.env.BIRTH_YEAR);
    if (!Number.isInteger(birthYearArg)) {
      throw new Error("Informe o birthYear via argv ou env BIRTH_YEAR");
    }
    const birthYear = birthYearArg;
    const age = currentYear - birthYear;
    if (age < 18 || age > 100) {
      throw new Error(
        `Age must be between 18 and 100 years. Current age: ${age}`
      );
    }

    console.log("40%", "Generating witness...");
    const { witness } = await noir.execute({
      birth_year: birthYear,
      current_year: currentYear,
    });

    console.log("60%", "Generating proof...");
    const { proof, publicInputs } = await backend.generateProof(witness);
    const vk = await backend.getVerificationKey();
    console.log("Proof/publicInputs/vk sizes:", {
      publicInputsLen: publicInputs.length,
      proofLen: proof.length,
      vkLen: vk.length,
    });

    console.log("80%", "Submitting to blockchain...");
    try {
      const response = await fetch(BACKEND, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publicInputs: publicInputs[0],
          proof: Array.from(proof),
          vk: Array.from(vk),
        }),
      });

      if (!response.ok) {
        const rawText = await response.text().catch(() => "");
        console.error("Backend non-OK response:", {
          status: response.status,
          statusText: response.statusText,
          rawText,
        });
        let errorData;
        try {
          errorData = JSON.parse(rawText);
        } catch {
          errorData = { error: rawText || "Unknown error" };
        }
        throw new Error(
          errorData.error || `HTTP ${response.status}: ${response.statusText}`
        );
      }

      const responseData = await response.json();
      return responseData;
    } catch (err) {
      console.error("❌ Backend request failed", err);
      throw new Error(err?.message || "Failed to submit proof to blockchain");
    }
  } catch (err) {
    console.error("💔 Proof generation failed", err);
    throw new Error(err?.message || "Proof generation failed");
  }
}

main()
  .then((res) => {
    console.log("✅ Success:", res);
  })
  .catch((err) => {
    console.error("❌ Error:", err?.message ?? err);
    process.exitCode = 1;
  });
