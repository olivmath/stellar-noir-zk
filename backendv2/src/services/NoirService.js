const { keccak_256 } = require('@noble/hashes/sha3.js');

class NoirService {
  encodePublicInputs(circuit, inputs) {
    const publicParams = circuit.abi.parameters.filter((p) => p.visibility === 'public');
    const fields = [];
    const encodeField = (value, elementType, width) => {
      const field = new Uint8Array(32);
      let val = BigInt(value);
      const numBytes = elementType === 'integer' && width ? width / 8 : 32;
      for (let i = 0; i < numBytes; i++) {
        field[32 - 1 - i] = Number(val & BigInt(0xff));
        val >>= BigInt(8);
      }
      return field;
    };
    publicParams.forEach((p) => {
      const v = inputs[p.name];
      if (p.type.kind === 'array') {
        const elementType = p.type.type.kind;
        const elementWidth = p.type.type.width;
        v.forEach((el) => fields.push(encodeField(el, elementType, elementWidth)));
      } else if (p.type.kind === 'integer') {
        fields.push(encodeField(v, 'integer', p.type.width));
      } else if (p.type.kind === 'field') {
        fields.push(encodeField(v, 'field'));
      } else {
        throw new Error(`Unsupported public parameter type: ${p.type.kind}`);
      }
    });
    const out = new Uint8Array(fields.length * 32);
    fields.forEach((f, i) => out.set(f, i * 32));
    return out;
  }

  buildProofBlob(publicInputsBytes, proofBytes) {
    const totalFields = proofBytes.length / 32 + publicInputsBytes.length / 32;
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, totalFields, false);
    const proofBlob = new Uint8Array(header.length + publicInputsBytes.length + proofBytes.length);
    proofBlob.set(header, 0);
    proofBlob.set(publicInputsBytes, header.length);
    proofBlob.set(proofBytes, header.length + publicInputsBytes.length);
    const proofIdBytes = keccak_256(proofBlob);
    const proofId = Array.from(proofIdBytes).map((b) => b.toString(16).padStart(2, '0')).join('');
    return { proofBlob, proofId };
  }
}

module.exports = { NoirService };