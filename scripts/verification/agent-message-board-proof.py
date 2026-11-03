#!/usr/bin/env python3
import argparse
import hashlib
import json
import platform
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import z3 as z

z.set_param(proof=True)

IMPLEMENTATION = "fd288111060baf636aa064d3d201f33b1120ddb5"
ROOT = Path(__file__).resolve().parents[2]
SOURCE_FILES = [
    "platform/daemon/src/cross-agent-wake.ts",
    "platform/daemon/src/agent-id.ts",
    "platform/daemon/src/request-scope.ts",
    "platform/daemon/src/routes/utils.ts",
    "platform/daemon/src/board.ts",
    "platform/daemon/src/routes/hooks-routes.ts",
    "platform/daemon/src/routes/board-routes.ts",
    "platform/daemon/src/memory-lineage.ts",
    "platform/daemon/src/episodic-sources.ts",
    "platform/core/src/migrations/171-agent-wake-and-message-board.ts",
    "integrations/hermes-agent/connector/hermes-plugin/__init__.py",
    "integrations/pi/extension-base/src/wake-waiter.ts",
    "integrations/pi/extension/src/collab-tools.ts",
    "platform/daemon/src/mcp/tools.ts",
]
KINDS = ("base", "inductive-step", "elementary-lemma", "algebraic")
TRANSITION_SCOPE = (
    "Each obligation is one abstract transition. Composition assumes serialized logical delivery, "
    "one live waiter per (agent, session key), and a charge applied only after a completed claim."
)


@dataclass
class Obligation:
    name: str
    kind: str
    meaning: str
    implementation: list
    build: object
    control: str | None = None
    hypotheses: list = field(default_factory=list)


def maximum(a, b):
    return z.If(a >= b, a, b)


def claim_inv(owner, count):
    return z.And(owner >= -1, count >= 0, count <= 1, (owner == -1) == (count == 0))


def quota_inv(used, limit):
    return z.And(limit > 0, used >= 0, used <= limit)


def capacity_inv(size, pending, capacity):
    return z.And(capacity > 0, size >= 0, pending >= 0, size + pending <= capacity)


def post_inv(seq, head):
    p, q = z.Ints("inv_p inv_q")
    bounded = z.ForAll([p], z.Or(z.Select(seq, p) == 0, z.And(z.Select(seq, p) > 0, z.Select(seq, p) <= head)))
    unique = z.ForAll([p, q], z.Implies(z.And(p != q, z.Select(seq, p) > 0, z.Select(seq, q) > 0),
                                         z.Select(seq, p) != z.Select(seq, q)))
    return z.And(head >= 0, bounded, unique)


def disjoint(member):
    b1, b2, m = z.Ints("dj_b1 dj_b2 dj_m")
    return z.ForAll([b1, b2, m], z.Implies(z.And(b1 != b2, member(b1, m)), z.Not(member(b2, m))))


def obligations():
    def base():
        owner, count, used, limit, size, pending, capacity, head = z.Ints("b_owner b_count b_used b_limit b_size b_pending b_cap b_head")
        seq = z.Array("b_seq", z.IntSort(), z.IntSort())
        mem = z.Function("b_mem", z.IntSort(), z.IntSort(), z.BoolSort())
        b, m, p = z.Ints("b_b b_m b_p")
        init = [owner == -1, count == 0, used == 0, limit > 0, size == 0, pending == 0, capacity > 0, head == 0,
                z.ForAll([p], z.Select(seq, p) == 0), z.ForAll([b, m], z.Not(mem(b, m)))]
        prop = z.And(claim_inv(owner, count), quota_inv(used, limit), capacity_inv(size, pending, capacity),
                     post_inv(seq, head), disjoint(mem))
        return init, prop
    yield Obligation(
        "base.initial-state-satisfies-all-invariants", "base",
        "The empty initial store satisfies the same claim, quota, capacity, post and batch-disjointness invariants used by the inductive steps.",
        ["platform/core/src/migrations/171-agent-wake-and-message-board.ts:up", "platform/daemon/src/cross-agent-wake.ts:WakeHistory"],
        lambda mutated: base(),
    )

    def identity_resolution(mutated):
        token, requested, inferred, daemon = z.Ints("token request_field key_inferred daemon_default")
        has_field, has_key, agent_scoped = z.Bools("has_field has_key agent_scoped")
        request = z.If(has_field, requested, inferred)
        has_request = z.Or(has_field, has_key)
        fallback = daemon if mutated else z.If(agent_scoped, token, daemon)
        effective = z.If(has_request, request, fallback)
        return [agent_scoped, z.Not(has_field), z.Not(has_key)], effective == token
    yield Obligation(
        "identity.omitted-request-resolves-to-token", "algebraic",
        "With no field identity and no key-inferred identity, an agent-scoped token resolves to its own agent; a field or key-derived identity is the requested identity.",
        ["platform/daemon/src/agent-id.ts:requestedAgentId", "platform/daemon/src/request-scope.ts:resolveScopedAgent"],
        identity_resolution, "fallback to the daemon default instead of the token agent",
    )

    def identity_guard(mutated):
        token, effective, owner, old, change = z.Ints("g_token g_effective g_owner g_old g_change")
        protected, active, accepted = z.Bools("g_protected g_active g_accepted")
        guard = z.And(effective == token, z.Or(z.Not(active), owner == effective))
        weakened = effective == token
        admitted = weakened if mutated else guard
        hypothesis = z.Implies(accepted, admitted)
        after = z.If(accepted, change, old)
        prop = z.Implies(z.And(protected, after != old), z.And(effective == token, z.Or(z.Not(active), owner == effective)))
        return [protected, change != old, hypothesis], prop
    yield Obligation(
        "identity.guarded-transition-conditional", "inductive-step",
        "Conditional on hypothesis H-guard (a request is accepted only if effective identity equals the token agent and any active session is owned by it), a state change by an enforced non-admin agent-scoped token implies that guard. Does not cover admin, local or project-only access.",
        ["platform/daemon/src/routes/utils.ts:validateSessionAgentBinding", "platform/daemon/src/request-scope.ts:resolveScopedAgent", "platform/daemon/src/routes/hooks-routes.ts:resolveCrossAgentScope"],
        identity_guard, "H-guard weakened to omit the session-owner check",
        ["H-guard: accepted implies effective == token and (active -> owner == effective); this follows from the source only by reading resolveScopedAgent, checkScope and validateSessionAgentBinding, not from the solver."],
    )

    def claim_step(mutated):
        owner, count, contender = z.Ints("c_owner c_count c_contender")
        eligible = z.Bool("c_eligible")
        can = z.And(eligible, z.BoolVal(True) if mutated else owner == -1)
        owner_next = z.If(can, contender, owner)
        count_next = z.If(can, count + 1, count)
        return [claim_inv(owner, count), contender >= 0], claim_inv(owner_next, count_next)
    yield Obligation(
        "wake.claim-insert-if-absent-step", "inductive-step",
        "Insert-if-absent on one message preserves 'at most one successful claim per unreleased epoch'.",
        ["platform/core/src/migrations/171-agent-wake-and-message-board.ts:cross_agent_message_wakes primary key", "platform/daemon/src/cross-agent-wake.ts:claimDirectMessageWakes"],
        claim_step, "claim written unconditionally (no absence check)",
    )

    def release_step(mutated):
        owner, count, releaser = z.Ints("r_owner r_count r_releaser")
        match = z.BoolVal(True) if mutated else releaser == owner
        owner_next = z.If(match, -1, owner)
        count_next = z.If(match, 0, count)
        prop = z.And(claim_inv(owner_next, count_next), z.Implies(releaser != owner, owner_next == owner))
        return [claim_inv(owner, count), owner >= 0, releaser >= 0], prop
    yield Obligation(
        "wake.release-by-owner-step", "inductive-step",
        "A release by a non-owner leaves the claim untouched; an owner release returns to the empty epoch.",
        ["platform/daemon/src/cross-agent-wake.ts:releaseDirectMessageWakes"],
        release_step, "release deletes regardless of owner",
    )

    def quota_step(mutated):
        used, limit = z.Ints("q_used q_limit")
        claimed = z.Bool("q_claimed")
        admitted = z.And(claimed, used <= limit if mutated else used < limit)
        return [quota_inv(used, limit)], quota_inv(z.If(admitted, used + 1, used), limit)
    yield Obligation(
        "wake.quota-charge-step", "inductive-step",
        "A charge applied only after a completed claim and only when used < limit keeps used <= limit. Premise: logical deliveries are serialized per key and one waiter completes at most one charge per admission test.",
        ["platform/daemon/src/cross-agent-wake.ts:rateLimitRetryAfter", "platform/daemon/src/cross-agent-wake.ts:attemptClaim"],
        quota_step, "admission test off by one (used <= limit)",
        ["H-serial: one live waiter per key; admission test and charge are not interleaved with another charge for the same key."],
    )

    def capacity_step(mutated):
        size, pending, capacity = z.Ints("k_size k_pending k_cap")
        op = z.Int("k_op")
        room = size < capacity if mutated else size + pending < capacity
        reserve = z.And(op == 0, room)
        complete = z.And(op == 1, pending > 0)
        size_next = z.If(complete, size + 1, size)
        pending_next = z.If(reserve, pending + 1, z.If(complete, pending - 1, pending))
        return [capacity_inv(size, pending, capacity), op >= 0, op <= 1], capacity_inv(size_next, pending_next, capacity)
    yield Obligation(
        "wake.capacity-pending-reservation-step", "inductive-step",
        "History slots allocated plus pending claim reservations never exceed capacity (reserve and complete transitions). Here pending counts distinct newly reserved history keys, not the source pendingClaims counter of in-flight requests; the source map already includes reserved keys.",
        ["platform/daemon/src/cross-agent-wake.ts:attemptClaim pendingClaims reservation"],
        capacity_step, "admission checks only stored size, ignoring pending reservations",
    )

    def batch_disjoint(mutated):
        mem = z.Function("m_mem", z.IntSort(), z.IntSort(), z.BoolSort())
        ret = z.Function("m_ret", z.IntSort(), z.BoolSort())
        ins = z.Function("m_ins", z.IntSort(), z.BoolSort())
        new_batch, expired, op = z.Ints("m_new m_exp m_op")
        b, m = z.Ints("m_b m_m")

        def nxt(bb, mm):
            return z.If(op == 0, z.Or(mem(bb, mm), z.And(bb == new_batch, ins(mm))),
                        z.If(op == 1, z.And(mem(bb, mm), z.Not(ret(mm))), z.And(mem(bb, mm), bb != expired)))
        exclusive = z.ForAll([b, m], z.Implies(ins(m), z.Not(mem(b, m))))
        premises = [disjoint(mem), op >= 0, op <= 2]
        if not mutated:
            premises.append(exclusive)
        return premises, disjoint(nxt)
    yield Obligation(
        "wake.live-batches-pairwise-disjoint-step", "inductive-step",
        "Under claim, release and whole-batch expiry transitions, no message ID is in two live batches. Conditional on H-exclusive. Expiry modelled here only as charge deletion; whether expiry also deletes claim rows is not modelled.",
        ["platform/daemon/src/cross-agent-wake.ts:WakeHistory", "platform/daemon/src/cross-agent-wake.ts:releaseDirectMessageWakes"],
        batch_disjoint, "claim inserts an ID that is already in a live batch (H-exclusive violated)",
        ["H-exclusive: newly inserted message IDs occur in no live batch. Linking claim-row absence to batch absence requires a source lifecycle invariant; the primary key alone does not prove that link."],
    )

    def release_removes_everywhere(mutated):
        mem = z.Function("e_mem", z.IntSort(), z.IntSort(), z.BoolSort())
        ret = z.Function("e_ret", z.IntSort(), z.BoolSort())
        released_batch, b, m = z.Ints("e_rb e_b e_m")
        def nxt(bb, mm):
            drop = z.And(ret(mm), bb == released_batch) if mutated else ret(mm)
            return z.And(mem(bb, mm), z.Not(drop))
        prop = z.ForAll([b, m], z.Implies(ret(m), z.Not(nxt(b, m))))
        return [disjoint(mem)], prop
    yield Obligation(
        "wake.release-removes-ids-from-all-batches", "inductive-step",
        "A returned ID is absent from every batch afterwards; the model removes it from all batches as the source does.",
        ["platform/daemon/src/cross-agent-wake.ts:releaseDirectMessageWakes"],
        release_removes_everywhere, "release removes the ID from only one named batch",
    )

    def partial_release(mutated):
        mem = z.Function("p_mem", z.IntSort(), z.IntSort(), z.BoolSort())
        ret = z.Function("p_ret", z.IntSort(), z.BoolSort())
        b, m, r = z.Ints("p_b p_m p_r")
        def nxt(bb, mm):
            if mutated:
                return z.And(mem(bb, mm), z.Not(z.Exists([r], z.And(ret(r), mem(bb, r)))))
            return z.And(mem(bb, mm), z.Not(ret(mm)))
        prop = z.ForAll([b, m], z.Implies(z.And(mem(b, m), z.Not(ret(m))), nxt(b, m)))
        return [], prop
    yield Obligation(
        "wake.partial-release-keeps-unreleased-members", "inductive-step",
        "A batch member whose ID was not returned stays in its batch, so the batch is still charged.",
        ["platform/daemon/src/cross-agent-wake.ts:releaseDirectMessageWakes"],
        partial_release, "release drops the whole batch when any member is returned",
    )

    def clock(mutated):
        recorded, now, window, step = z.Reals("t_recorded t_now t_window t_step")
        wall_recorded = z.Real("t_wall_recorded")
        elapsed = now - recorded
        wall_now = wall_recorded + elapsed - step
        measured = wall_now - wall_recorded if mutated else elapsed
        return [window > 0, recorded >= 0, elapsed >= window, step > 0], z.Not(measured < window)
    yield Obligation(
        "wake.expiry-uses-elapsed-clock", "elementary-lemma",
        "Rate-window retention is measured on the elapsed clock; after a full real window the charge is not retained. The control substitutes a wall clock stepped backwards.",
        ["platform/daemon/src/cross-agent-wake.ts:recentWakes", "platform/daemon/src/cross-agent-wake.ts:performance.now"],
        clock, "retention measured on a wall clock that was stepped backwards",
        ["H-monotonic: performance.now is monotonic within the daemon process."],
    )

    def session_end(mutated):
        delivered, global_seq, boundary = z.Ints("s_delivered s_global s_boundary")
        counted = delivered > boundary
        boundary_next = z.If(counted, boundary if mutated else global_seq, boundary)
        return [boundary >= 0, global_seq >= delivered, delivered >= 0], z.Not(delivered > boundary_next)
    yield Obligation(
        "wake.session-end-consumes-delivery-once", "inductive-step",
        "After a session-end consume the boundary covers the delivered sequence, so a second Stop with no new delivery counts nothing.",
        ["platform/daemon/src/cross-agent-wake.ts:consumeSessionEndWake"],
        session_end, "boundary not advanced when a delivery is counted",
    )

    def append(mutated):
        seq = z.Array("a_seq", z.IntSort(), z.IntSort())
        head, fresh = z.Ints("a_head a_fresh")
        value = head if mutated else head + 1
        seq_next = z.Store(seq, fresh, value)
        premises = [post_inv(seq, head), z.Select(seq, fresh) == 0]
        if mutated:
            top = z.Int("a_top")
            premises = [head >= 1, top != fresh, seq == z.Store(z.K(z.IntSort(), z.IntVal(0)), top, head)]
            clash = z.Implies(z.And(top != fresh, z.Select(seq_next, top) > 0, z.Select(seq_next, fresh) > 0),
                              z.Select(seq_next, top) != z.Select(seq_next, fresh))
            return premises, clash
        return premises, post_inv(seq_next, head + 1)
    yield Obligation(
        "board.append-preserves-post-invariant", "inductive-step",
        "Appending a post with sequence MAX+1 preserves 'every live sequence is in 1..head and unique'. Mutation reuses the current head value.",
        ["platform/daemon/src/board.ts:createBoardThread", "platform/daemon/src/board.ts:replyToBoardThread"],
        append, "new post is assigned the current head sequence",
    )

    def delete_post(mutated):
        seq = z.Array("d_seq", z.IntSort(), z.IntSort())
        head, victim = z.Ints("d_head d_victim")
        seq_next = z.Store(seq, victim, 0)
        return [post_inv(seq, head)], post_inv(seq_next, head)
    yield Obligation(
        "board.delete-preserves-post-invariant", "inductive-step",
        "Deleting one live post preserves the same bounded-unique invariant. The abstract deletion retains its previous upper bound. Reduction of the actual SQL MAX after deleting a maximal post is not modelled by this transition.",
        ["platform/daemon/src/board.ts:deleteBoardThread"],
        delete_post,
    )

    def read_snapshot(mutated):
        read, cutoff, later, head = z.Ints("rs_read rs_cutoff rs_later rs_head")
        written = maximum(read, head) if mutated else maximum(read, cutoff)
        return [read >= 0, cutoff >= read, later > cutoff, head >= later], later > written
    yield Obligation(
        "board.snapshot-read-leaves-later-post-unread", "inductive-step",
        "Marking the post ID returned by the first-page read leaves a strictly later post unread.",
        ["platform/daemon/src/board.ts:readBoardThread", "platform/daemon/src/board.ts:markBoardThreadRead"],
        read_snapshot, "cursor set to the live head at write time",
    )

    def read_monotonic(mutated):
        read, cutoff = z.Ints("rm_read rm_cutoff")
        written = cutoff if mutated else maximum(read, cutoff)
        return [read >= 0, cutoff >= 0], written >= read
    yield Obligation(
        "board.read-cursor-monotonic", "elementary-lemma",
        "An out-of-order older read cannot move the stored cursor backwards.",
        ["platform/daemon/src/board.ts:markBoardThreadRead ON CONFLICT WHERE"],
        read_monotonic, "cursor overwritten by the incoming value",
    )

    def offset_page(mutated):
        read, cutoff, offset = z.Ints("o_read o_cutoff o_offset")
        marks = z.BoolVal(True) if mutated else offset == 0
        read_next = z.If(marks, maximum(read, cutoff), read)
        return [offset > 0, read >= 0, cutoff > read], read_next == read
    yield Obligation(
        "board.offset-page-leaves-cursor", "inductive-step",
        "An offset page does not advance the cursor past skipped posts, given the client-side guard offset == 0 before marking.",
        ["platform/daemon/src/mcp/tools.ts:board_read", "integrations/pi/extension/src/collab-tools.ts:board_read", "integrations/hermes-agent/connector/hermes-plugin/__init__.py:board_read"],
        offset_page, "client marks read regardless of offset",
        ["H-client: each of the three clients applies the offset guard; raw HTTP mark-to-head is a separate explicit operation."],
    )

    def notice(mutated):
        read, last_notice, own_last, scanned, later, head = z.Ints("n_read n_notice n_own n_scanned n_later n_head")
        written = maximum(last_notice, head) if mutated else maximum(last_notice, scanned)
        seen = maximum(maximum(read, written), own_last)
        return [read >= 0, last_notice >= 0, own_last >= 0, scanned >= 0, later > read, later > last_notice,
                later > own_last, later > scanned, head >= later], later > seen
    yield Obligation(
        "board.notice-snapshot-leaves-later-reply-eligible", "inductive-step",
        "A notice records the scanned sequence; a later reply stays eligible.",
        ["platform/daemon/src/board.ts:claimBoardActivityNotices"],
        notice, "notice cursor set to the live head at write time",
    )

    def evidence(mutated):
        artifacts = z.Array("v_artifacts", z.IntSort(), z.BoolSort())
        key = z.Int("v_key")
        once = z.Store(artifacts, key, True)
        second_key = key + 1 if mutated else key
        return [], z.Store(once, second_key, True) == once
    yield Obligation(
        "evidence.same-identity-upsert-idempotent", "elementary-lemma",
        "Source-row existence is idempotent when the complete identity is unchanged. Real rows also update hash and metadata; this is existence only.",
        ["platform/daemon/src/memory-lineage.ts:indexExternalMemoryArtifact"],
        evidence, "second upsert uses a different identity",
    )


def source_manifest(implementation):
    result = []
    for relative in SOURCE_FILES:
        blob = subprocess.run(["git", "show", f"{implementation}:{relative}"], cwd=ROOT, capture_output=True, check=True).stdout
        current = (ROOT / relative).read_bytes()
        if blob != current:
            raise RuntimeError(f"production source differs from pinned implementation: {relative}")
        result.append({"path": relative, "sha256": hashlib.sha256(blob).hexdigest()})
    return result


def check_mapping(rows):
    fingerprinted = set(SOURCE_FILES)
    for row in rows:
        for entry in row["implementation"]:
            path = entry.split(":", 1)[0]
            if path not in fingerprinted:
                raise RuntimeError(f"mapped path is not fingerprinted: {path} in {row['name']}")


def query(path, assumptions, property):
    solver = z.Solver()
    solver.set(timeout=20_000, random_seed=0)
    solver.add(*assumptions)
    if property is not None:
        solver.add(z.Not(property))
    path.write_text(solver.to_smt2())
    verdict = solver.check()
    if verdict == z.unsat:
        path.with_suffix(".derivation.sexpr").write_text(solver.proof().sexpr() + "\n")
    witness = None
    if verdict == z.sat:
        model = solver.model()
        witness = {str(d): str(model[d]) for d in model.decls() if d.arity() == 0}
        witness["_full_model"] = str(model)
    return str(verdict), witness


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--implementation-sha", default=IMPLEMENTATION)
    parser.add_argument("--output", type=Path, default=ROOT / "docs/proofs/agent-message-board/formal")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    smt = args.output / "smt"
    smt.mkdir(exist_ok=True)
    for stale in list(smt.glob("*.smt2")) + list(smt.glob("*.sexpr")):
        stale.unlink()
    started = time.monotonic()
    rows = []
    for ob in obligations():
        if ob.kind not in KINDS:
            raise RuntimeError(f"unknown kind {ob.kind}")
        assumptions, prop = ob.build(False)
        feasible, _ = query(smt / f"{ob.name}.nonvacuity.smt2", assumptions, None)
        proof, _ = query(smt / f"{ob.name}.proof.smt2", assumptions, prop)
        row = {"name": ob.name, "kind": ob.kind, "meaning": ob.meaning, "implementation": ob.implementation,
               "refinement_hypotheses": ob.hypotheses, "premises_satisfiable": feasible, "negated_property": proof,
               "control_description": ob.control, "control_result": None, "control_countermodel": None}
        passed = feasible == "sat" and proof == "unsat"
        if ob.control is not None:
            m_assumptions, m_prop = ob.build(True)
            control, witness = query(smt / f"{ob.name}.control.smt2", m_assumptions, m_prop)
            row["control_result"] = control
            row["control_countermodel"] = witness
            passed = passed and control == "sat"
        row["pass"] = passed
        rows.append(row)
        print(f"{'PASS' if passed else 'FAIL'} [{ob.kind}] {ob.name}: feasible={feasible} proof={proof} control={row['control_result']}")
    check_mapping(rows)
    domain = z.DeclareSort("SourceIdentity")
    board_key, transcript_key = z.Consts("board_source transcript_source", domain)
    payload = z.Array("event_payload", domain, z.StringSort())
    solver = z.Solver()
    solver.add(board_key != transcript_key, z.Select(payload, board_key) == "SYNTHETIC_SHARED_BOARD_EVENT",
               z.Select(payload, transcript_key) == "SYNTHETIC_SHARED_BOARD_EVENT")
    (smt / "evidence.cross-source-illustration.smt2").write_text(solver.to_smt2())
    illustration = str(solver.check())
    kinds = {}
    for row in rows:
        entry = kinds.setdefault(row["kind"], {"total": 0, "passed": 0})
        entry["total"] += 1
        entry["passed"] += int(row["pass"])
    report = {
        "implementation_sha": args.implementation_sha,
        "scope": "Z3-checked abstract transition obligations. Not a whole-program proof and not an automatic code-to-model refinement; the model/source mapping is by manual inspection.",
        "transition_scope": TRANSITION_SCOPE,
        "solver": z.get_full_version(), "python": platform.python_version(),
        "runner_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "source_manifest": source_manifest(args.implementation_sha),
        "source_manifest_note": "Fingerprints detect drift of the named files; they are not a proof link between model and code.",
        "obligation_count": len(rows), "passed": sum(row["pass"] for row in rows),
        "by_kind": kinds,
        "with_mutation_control": sum(1 for row in rows if row["control_result"] is not None),
        "proof_terms": "Z3 derivation terms are exported but not independently kernel-checked.",
        "elapsed_seconds": round(time.monotonic() - started, 6), "obligations": rows,
        "cross_source_illustration": {"result": illustration,
            "label": "illustration: a constructed witness that two distinct source identities may carry equal payloads. Not an existence claim about the system; the Dreaming probe is the real-data evidence."},
        "remaining_refinement_assumptions": [
            "H-guard: acceptance implies the modelled identity guard, for enforced non-admin agent-scoped tokens only. local mode, admin tokens, project-only tokens and hybrid without claims bypass enforcement and receive no protection claim.",
            "H-exclusive: newly inserted IDs occur in no live batch; claim-row absence must be linked to batch absence by a separate source lifecycle argument.",
            "H-serial: serialized logical delivery, one live waiter per (agent, session key), charge only after a completed claim; no general concurrency proof.",
            "H-monotonic: performance.now is monotonic in-process.",
            "H-client: all three board clients apply the offset guard.",
            "Expiry/eviction deletion resetting claim rows is not modelled.",
            "SQLite atomicity and unique constraints; exact JS/SQLite integer representation.",
        ],
        "not_proved": [
            "Whole-program refinement, compiler/runtime/OS correctness, absence of implementation bugs.",
            "Fair scheduling, host availability, unconditional liveness, exactly-once host execution.",
            "Semantic deduplication of board events repeated in transcripts; retraction of derived claims after thread deletion.",
            "Protection for non-enforced auth modes.",
        ],
    }
    (args.output / "results.json").write_text(json.dumps(report, indent=2) + "\n")
    ok = all(row["pass"] for row in rows) and illustration == "sat"
    print(json.dumps({"passed": report["passed"], "total": len(rows), "by_kind": kinds, "pass": ok}))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
