import {
  MemoryRecallGateResultSchema,
  MemoryRecordV2Schema,
  MemoryVersionReferenceSchema,
  RetrievedMemoryHitSchema,
  type MemoryRecallGateResult,
  type MemoryRecordV2,
  type RetrievedMemoryHit,
} from "@tracegraph/contracts";
import { estimateTokens } from "@tracegraph/context";
import { sha256 } from "../../kernel/crypto.js";

export interface RankEligibleV2MemoryInput {
  readonly records: readonly unknown[];
  readonly gate: MemoryRecallGateResult;
  readonly query: string;
  readonly maxHits: number;
  readonly maxTokens: number;
}

/** Rank only exact identities returned by the governance gate. No store fallback exists here. */
export function rankEligibleV2Memory(input: RankEligibleV2MemoryInput): RetrievedMemoryHit[] {
  const gate = MemoryRecallGateResultSchema.parse(input.gate);
  const records = input.records.map((value) => MemoryRecordV2Schema.parse(value));
  const byIdentity = new Map(records.map((record) => [`${record.memoryId}\u0000${record.version}`, record]));
  const queryTerms = terms(input.query);
  if (queryTerms.size === 0) return [];
  const eligible = gate.eligible.flatMap((identity) => {
    const record = byIdentity.get(`${identity.memoryId}\u0000${identity.version}`);
    if (record === undefined) throw new TypeError("Eligibility gate references a missing Memory record");
    const score = overlap(queryTerms, terms(record.claim));
    return score > 0 ? [{ record, score }] : [];
  }).sort((left, right) => right.score - left.score
    || left.record.memoryId.localeCompare(right.record.memoryId)
    || left.record.version - right.record.version);
  const hits: RetrievedMemoryHit[] = [];
  let usedTokens = 0;
  for (const [index, { record, score }] of eligible.entries()) {
    if (hits.length >= input.maxHits) break;
    const tokenCount = Math.max(1, estimateTokens(record.claim));
    if (usedTokens + tokenCount > input.maxTokens) continue;
    usedTokens += tokenCount;
    const contentHash = record.contentDigest ?? sha256(record.claim);
    const sourcePath = `memory/${encodeURIComponent(record.memoryId)}.md`;
    const memoryRef = MemoryVersionReferenceSchema.parse({
      record_schema_version: "tracegraph.memory-record.v2",
      memory_id: record.memoryId,
      version: record.version,
      content_hash: contentHash,
      evidence_refs: record.provenance.evidenceRefs.flatMap((ref) => (
        "source_id" in ref
          ? [{ source_id: ref.source_id, source_type: ref.source_type, trust: ref.trust }]
          : []
      )),
    });
    hits.push(RetrievedMemoryHitSchema.parse({
      content: record.claim,
      attribution: {
        rank: index + 1,
        hit_id: `memory-hit:${sha256(`${record.memoryId}:${record.version}`).slice(7, 39)}`,
        content_hash: contentHash,
        score,
        source_path: sourcePath,
        start_line: 1,
        end_line: Math.max(1, record.claim.split("\n").length),
        heading_path: ["V2 Memory"],
        injected_tokens: tokenCount,
        memory_ref: memoryRef,
      },
    }));
  }
  return hits;
}

function terms(value: string): Set<string> {
  const normalized = value.normalize("NFKC").toLocaleLowerCase("und");
  const result = new Set(normalized.split(/[^\p{L}\p{N}]+/u).filter((part) => part.length > 1));
  for (const match of normalized.matchAll(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+/gu)) {
    const run = match[0];
    if (run.length === 1) result.add(run);
    for (let index = 0; index < run.length - 1; index += 1) result.add(run.slice(index, index + 2));
  }
  return result;
}

function overlap(query: ReadonlySet<string>, content: ReadonlySet<string>): number {
  let matched = 0;
  for (const term of query) if (content.has(term)) matched += 1;
  return matched / query.size;
}
