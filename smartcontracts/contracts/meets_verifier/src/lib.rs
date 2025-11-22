#![no_std]
extern crate alloc;

use alloc::{string::String as StdString, vec::Vec as StdVec};
use core::str;

use sha3::{Digest, Keccak256};
use soroban_sdk::{contract, contracterror, contractimpl, symbol_short, Bytes, BytesN, Env, Symbol};

use ark_bn254::{Fq, G1Affine};
use ark_ff::PrimeField;

use ultrahonk_rust_verifier::{types::G1Point, types::VerificationKey, UltraHonkVerifier};

fn fq_from_be_bytes(bytes_be: &[u8; 32]) -> Fq {
    Fq::from_be_bytes_mod_order(bytes_be)
}

fn hex_str_to_be32(s: &str) -> Option<[u8; 32]> {
    fn hex_val(b: u8) -> Option<u8> {
        match b {
            b'0'..=b'9' => Some(b - b'0'),
            b'a'..=b'f' => Some(10 + (b - b'a')),
            b'A'..=b'F' => Some(10 + (b - b'A')),
            _ => None,
        }
    }
    let hex = s.trim_start_matches("0x").as_bytes();
    let mut out = [0u8; 32];
    let mut oi = 32usize;
    let mut i = hex.len();
    while i > 0 && oi > 0 {
        let low = hex_val(hex[i - 1])?;
        i -= 1;
        let high = if i > 0 {
            let v = hex_val(hex[i - 1])?;
            i -= 1;
            v
        } else {
            0
        };
        oi -= 1;
        out[oi] = (high << 4) | low;
    }
    Some(out)
}

fn or_with_left_shift_bytes(lo: &[u8; 32], hi: &[u8; 32], shift_bytes: usize) -> [u8; 32] {
    let mut out = [0u8; 32];
    if shift_bytes >= 32 {
        out.copy_from_slice(lo);
        return out;
    }
    for i in 0..32 {
        let hi_byte = if i + shift_bytes < 32 { hi[i + shift_bytes] } else { 0 };
        out[i] = lo[i] | hi_byte;
    }
    out
}

fn parse_json_array_of_strings(s: &str) -> Result<StdVec<StdString>, Error> {
    let mut out: StdVec<StdString> = StdVec::new();
    let mut chars = s.chars().peekable();
    while let Some(&c) = chars.peek() {
        if c.is_whitespace() { chars.next(); } else { break; }
    }
    if chars.next() != Some('[') { return Err(Error::VkJsonFormatError); }
    loop {
        while let Some(&c) = chars.peek() {
            if c.is_whitespace() || c == ',' { chars.next(); } else { break; }
        }
        if let Some(&']') = chars.peek() { chars.next(); break; }
        if chars.next() != Some('"') { return Err(Error::VkJsonFormatError); }
        let mut buf = StdString::new();
        while let Some(c) = chars.next() {
            if c == '"' { break; }
            if c == '\\' { if let Some(next) = chars.next() { buf.push(next); } } else { buf.push(c); }
        }
        out.push(buf);
    }
    Ok(out)
}

fn read_g1_from_limbs(lx: &[u8; 32], hx: &[u8; 32], ly: &[u8; 32], hy: &[u8; 32]) -> Option<G1Point> {
    let shifts = [136usize, 128usize];
    for &shift in &shifts {
        let sbytes = shift / 8;
        let bx = or_with_left_shift_bytes(lx, hx, sbytes);
        let by = or_with_left_shift_bytes(ly, hy, sbytes);
        let px = fq_from_be_bytes(&bx);
        let py = fq_from_be_bytes(&by);
        let aff = G1Affine::new_unchecked(px, py);
        if aff.is_on_curve() && aff.is_in_correct_subgroup_assuming_on_curve() {
            return Some(G1Point { x: aff.x, y: aff.y });
        }
        let bx = or_with_left_shift_bytes(ly, hy, sbytes);
        let by = or_with_left_shift_bytes(lx, hx, sbytes);
        let px = fq_from_be_bytes(&bx);
        let py = fq_from_be_bytes(&by);
        let aff = G1Affine::new_unchecked(px, py);
        if aff.is_on_curve() && aff.is_in_correct_subgroup_assuming_on_curve() {
            return Some(G1Point { x: aff.x, y: aff.y });
        }
    }
    None
}

fn try_read_g1(vk_fields: &[StdString], i: usize) -> Option<(G1Point, usize)> {
    if i + 3 >= vk_fields.len() { return None; }
    let lx = hex_str_to_be32(&vk_fields[i])?;
    let hx = hex_str_to_be32(&vk_fields[i + 1])?;
    let ly = hex_str_to_be32(&vk_fields[i + 2])?;
    let hy = hex_str_to_be32(&vk_fields[i + 3])?;
    let pt = read_g1_from_limbs(&lx, &hx, &ly, &hy)?;
    Some((pt, i + 4))
}

fn find_first_g1_start(vk_fields: &[StdString], start_guess: usize, max_probe: usize) -> Option<usize> {
    const TOTAL_POINTS: usize = 27;
    const TOTAL_LIMBS: usize = TOTAL_POINTS * 4;
    let end = core::cmp::min(vk_fields.len(), start_guess + max_probe);
    'probe: for i in start_guess..end {
        if i + TOTAL_LIMBS > vk_fields.len() { break; }
        let mut idx = i;
        for _ in 0..TOTAL_POINTS {
            if let Some((_pt, next)) = try_read_g1(vk_fields, idx) { idx = next; } else { continue 'probe; }
        }
        return Some(i);
    }
    None
}

fn load_vk_from_json_no_serde(json_data: &str) -> Result<VerificationKey, Error> {
    let vk_fields = parse_json_array_of_strings(json_data)?;
    if vk_fields.len() < 7 { return Err(Error::VkJsonTooShort); }
    fn parse_u64_hex_lsb(s: &str) -> u64 {
        let h = s.trim_start_matches("0x");
        let n = core::cmp::min(16, h.len());
        let slice = &h[h.len() - n..];
        let mut out: u64 = 0;
        for ch in slice.chars() {
            let v = match ch {
                '0'..='9' => ch as u64 - '0' as u64,
                'a'..='f' => 10 + (ch as u64 - 'a' as u64),
                'A'..='F' => 10 + (ch as u64 - 'A' as u64),
                _ => 0,
            };
            out = (out << 4) | v;
        }
        out
    }
    let h0 = parse_u64_hex_lsb(&vk_fields[0]);
    let public_inputs_size = if vk_fields.len() > 1 { parse_u64_hex_lsb(&vk_fields[1]) } else { 0 };
    let pub_inputs_offset = if vk_fields.len() > 2 { parse_u64_hex_lsb(&vk_fields[2]) } else { 0 };
    let (circuit_size, log_circuit_size) = if h0 != 0 && (h0 & (h0 - 1)) == 0 {
        let mut lg = 0u64;
        let mut n = h0;
        while n > 1 { n >>= 1; lg += 1; }
        (h0, lg)
    } else {
        let cs = 1u64.checked_shl(h0 as u32).ok_or(Error::VkJsonFormatError)?;
        (cs, h0)
    };
    let mut idx = find_first_g1_start(&vk_fields, 3, 64).ok_or(Error::VkG1ReadStartNotFound)?;
    macro_rules! read_g1 { () => {{ let (pt, next) = try_read_g1(&vk_fields, idx).ok_or(Error::G1PointDecodeError)?; idx = next; pt }} }
    let qm = read_g1!();
    let qc = read_g1!();
    let ql = read_g1!();
    let qr = read_g1!();
    let qo = read_g1!();
    let q4 = read_g1!();
    let q_lookup = read_g1!();
    let q_arith = read_g1!();
    let q_delta_range = read_g1!();
    let q_elliptic = read_g1!();
    let q_memory = read_g1!();
    let q_poseidon2_external = read_g1!();
    let q_poseidon2_internal = read_g1!();
    let s1 = read_g1!();
    let s2 = read_g1!();
    let s3 = read_g1!();
    let s4 = read_g1!();
    let id1 = read_g1!();
    let id2 = read_g1!();
    let id3 = read_g1!();
    let id4 = read_g1!();
    let t1 = read_g1!();
    let t2 = read_g1!();
    let t3 = read_g1!();
    let t4 = read_g1!();
    let lagrange_first = read_g1!();
    let lagrange_last = read_g1!();
    Ok(VerificationKey {
        circuit_size,
        log_circuit_size,
        public_inputs_size,
        pub_inputs_offset,
        qm,
        qc,
        ql,
        qr,
        qo,
        q4,
        q_lookup,
        q_arith,
        q_delta_range,
        q_elliptic,
        q_memory,
        q_nnf: G1Point { x: Fq::from(0u64), y: Fq::from(0u64) },
        q_poseidon2_external,
        q_poseidon2_internal,
        s1,
        s2,
        s3,
        s4,
        id1,
        id2,
        id3,
        id4,
        t1,
        t2,
        t3,
        t4,
        lagrange_first,
        lagrange_last,
    })
}

#[contract]
pub struct MeetsVerifierContract;

#[contracterror]
#[repr(u32)]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Error {
    VkParseError = 1,
    ProofParseError = 2,
    VerificationFailed = 3,
    VkNotSet = 4,
    VkUtf8Error = 5,
    VkJsonFormatError = 6,
    VkJsonTooShort = 7,
    VkG1ReadStartNotFound = 8,
    G1PointDecodeError = 9,
    ProofSplitError = 10,
}

#[contractimpl]
impl MeetsVerifierContract {
    fn key_vk() -> Symbol { symbol_short!("vk") }
    fn key_vk_hash() -> Symbol { symbol_short!("vk_hash") }

    fn keccak32(data: &[u8]) -> [u8; 32] {
        let mut hasher = Keccak256::new();
        hasher.update(data);
        let digest = hasher.finalize();
        let mut out = [0u8; 32];
        out.copy_from_slice(&digest);
        out
    }

    fn split_inputs_and_proof_bytes(packed: &[u8]) -> Result<(StdVec<StdVec<u8>>, StdVec<u8>), Error> {
        if packed.len() < 4 { return Err(Error::ProofSplitError); }
        let rest = &packed[4..];
        if rest.len() % 32 != 0 { return Err(Error::ProofSplitError); }
        for &pf in &[456usize, 440usize] {
            let need = pf * 32;
            if rest.len() >= need {
                let pis_len = rest.len() - need;
                if pis_len % 32 == 0 {
                    let mut pub_inputs_bytes: StdVec<StdVec<u8>> = StdVec::with_capacity(pis_len / 32);
                    for chunk in rest[..pis_len].chunks(32) { pub_inputs_bytes.push(chunk.to_vec()); }
                    let proof_bytes = rest[pis_len..].to_vec();
                    return Ok((pub_inputs_bytes, proof_bytes));
                }
            }
        }
        Err(Error::ProofSplitError)
    }

    pub fn verify_proof(env: Env, vk_json: Bytes, proof_blob: Bytes) -> Result<BytesN<32>, Error> {
        let proof_vec: StdVec<u8> = proof_blob.to_alloc_vec();
        let proof_hash = Self::keccak32(&proof_vec);
        let proof_id_bytes: BytesN<32> = BytesN::from_array(&env, &proof_hash);
        let vk_vec: StdVec<u8> = vk_json.to_alloc_vec();
        let vk_str = str::from_utf8(&vk_vec).map_err(|_| Error::VkUtf8Error)?;
        let vk = load_vk_from_json_no_serde(vk_str)?;
        let verifier = UltraHonkVerifier::new_with_vk(vk);
        let (pub_inputs_bytes, proof_bytes) = Self::split_inputs_and_proof_bytes(&proof_vec)?;
        verifier.verify(&proof_bytes, &pub_inputs_bytes).map_err(|_| Error::VerificationFailed)?;
        env.storage().instance().set(&proof_id_bytes, &true);
        Ok(proof_id_bytes)
    }

    pub fn set_vk(env: Env, vk_json: Bytes) -> Result<BytesN<32>, Error> {
        env.storage().instance().set(&Self::key_vk(), &vk_json);
        let vk_vec = vk_json.to_alloc_vec();
        let hash_arr = Self::keccak32(&vk_vec);
        let hash_bn = BytesN::from_array(&env, &hash_arr);
        env.storage().instance().set(&Self::key_vk_hash(), &hash_bn);
        Ok(hash_bn)
    }

    pub fn verify_proof_with_stored_vk(env: Env, proof_blob: Bytes) -> Result<BytesN<32>, Error> {
        let vk_json: Bytes = env.storage().instance().get(&Self::key_vk()).ok_or(Error::VkNotSet)?;
        Self::verify_proof(env, vk_json, proof_blob)
    }

    pub fn is_verified(env: Env, proof_id: BytesN<32>) -> bool {
        env.storage().instance().get(&proof_id).unwrap_or(false)
    }
}