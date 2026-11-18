import argparse
import collections
import json
import os
import re
import statistics

MARKERS = ("## Relevant Entity Context", "## Relevant Memory:")
PLUGIN = re.compile(r'<signet-plugin-context[^>]*\btarget="([a-z-]+)"')
COLUMNS = (
    "turns",
    "turnsWithMemory",
    "memoryLinesDelivered",
    "uniqueLines",
    "repeatDeliveries",
    "pluginGuidanceOnPrompts",
    "pluginGuidanceAtSessionStart",
    "injectedChars",
)
TOTALS = ("turns", "turnsWithMemory", "memoryLinesDelivered", "repeatDeliveries", "pluginGuidanceOnPrompts", "injectedChars")


def parse_args():
    parser = argparse.ArgumentParser(description="Compare two prompt-submit replay runs.")
    parser.add_argument("runs", nargs="*", default=["base", "branch"])
    parser.add_argument("--dir", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "runs"))
    return parser.parse_args()


def memory_lines(text):
    starts = [text.find(marker) for marker in MARKERS if marker in text]
    if not starts:
        return []
    lines = []
    for line in text[min(starts) :].splitlines():
        line = line.strip()
        if line.startswith("- "):
            lines.append(line)
        elif line.startswith("## ") and not line.startswith(MARKERS) and not line.startswith("## Plugin Context"):
            break
    return lines


def memory_chars(text):
    starts = [text.find(marker) for marker in MARKERS if marker in text]
    return len(text[min(starts) :]) if starts else 0


def summarize(args, dump):
    summary = {}
    for run in args.runs:
        with open(os.path.join(args.dir, f"results-{run}.jsonl")) as handle:
            rows = [json.loads(line) for line in handle]
        sessions = collections.defaultdict(list)
        for row in rows:
            sessions[row["harness"]].append(row)
        for session, items in sessions.items():
            seen = collections.Counter()
            repeats = []
            injected_turns = plugin_turns = chars = 0
            start_guidance = False
            dump.write(f"\n## {run} / {session} ({items[0]['sessionKey']})\n")
            for row in items:
                targets = PLUGIN.findall(row["text"])
                start_guidance = start_guidance or "session-start" in targets
                if row["kind"] == "session-start":
                    dump.write(f"\n### session-start: plugin guidance present = {'session-start' in targets}\n")
                    continue
                lines = memory_lines(row["text"])
                injected_turns += 1 if lines else 0
                plugin_turns += 1 if "user-prompt-submit" in targets else 0
                chars += memory_chars(row["text"])
                dump.write(f"\n### turn {row['turn']}: {len(lines)} memory lines\n")
                for line in lines:
                    if seen[line]:
                        repeats.append((row["turn"], line[:140]))
                    dump.write(f"- {line[2:200]}{' [REPEAT]' if seen[line] else ''}\n")
                    seen[line] += 1
            summary[(run, session)] = {
                "turns": sum(1 for row in items if row["kind"] == "prompt"),
                "turnsWithMemory": injected_turns,
                "memoryLinesDelivered": sum(seen.values()),
                "uniqueLines": len(seen),
                "repeatDeliveries": sum(seen.values()) - len(seen),
                "pluginGuidanceOnPrompts": plugin_turns,
                "pluginGuidanceAtSessionStart": start_guidance,
                "injectedChars": chars,
                "sessionKey": items[0]["sessionKey"],
                "repeatExamples": repeats[:3],
            }
    return summary


def ledgers(args):
    claims = collections.defaultdict(list)
    for run in args.runs:
        path = os.path.join(args.dir, f"ledger-{run}.json")
        text = open(path).read().strip() if os.path.exists(path) else ""
        for row in json.loads(text) if text else []:
            if row["surface"] == "api.hooks.user-prompt-submit":
                claims[row["session_key"]].append(row["item_id"])
    return claims


def daemon_decisions(args):
    engines = collections.defaultdict(collections.Counter)
    latency = collections.defaultdict(list)
    for run in args.runs:
        path = os.path.join(args.dir, f"daemon-log-{run}.ndjson")
        if not os.path.exists(path):
            continue
        with open(path, errors="ignore") as handle:
            for line in handle:
                if '"User prompt submit"' not in line:
                    continue
                try:
                    data = json.loads(line).get("data") or {}
                except ValueError:
                    continue
                if not str(data.get("sessionKey", "")).startswith(f"{run}-"):
                    continue
                engines[(run, data.get("sessionKey"))][data.get("engine")] += 1
                if isinstance(data.get("durationMs"), (int, float)):
                    latency[run].append(data["durationMs"])
    return engines, latency


def main():
    args = parse_args()
    with open(os.path.join(args.dir, "per-turn-evidence.md"), "w") as dump:
        summary = summarize(args, dump)
    claims = ledgers(args)
    engines, latency = daemon_decisions(args)
    print(f"{'session':16} {'run':7} " + " ".join(f"{column[:14]:>14}" for column in COLUMNS) + f" {'ledgerRows':>10} {'ledgerDup':>9}")
    for session in sorted({session for _, session in summary}):
        for run in args.runs:
            item = summary.get((run, session))
            if not item:
                continue
            rows = claims.get(item["sessionKey"], [])
            cells = " ".join(f"{str(item[column]):>14}" for column in COLUMNS)
            print(f"{session:16} {run:7} {cells} {len(rows):>10} {len(rows) - len(set(rows)):>9}")
    totals = collections.defaultdict(collections.Counter)
    for (run, _), item in summary.items():
        for column in TOTALS:
            totals[run][column] += item[column]
    print("\nTOTALS")
    for run in args.runs:
        print(run, dict(totals[run]))
    print("\nrepeat examples:")
    for (run, session), item in summary.items():
        if item["repeatExamples"]:
            turn, line = item["repeatExamples"][0]
            print(f"  {run} {session}: turn {turn}: {line}")
    print("\nENGINE DECISIONS PER SESSION (from daemon log)")
    for (run, key), counter in sorted(engines.items(), key=lambda entry: (str(entry[0][1]), entry[0][0])):
        print(f"  {run:7} {key:28} {dict(counter)}")
    for run, values in latency.items():
        values.sort()
        p90 = values[int(len(values) * 0.9)]
        print(f"prompt-submit latency {run}: n={len(values)} p50={statistics.median(values):.0f}ms p90={p90:.0f}ms max={values[-1]:.0f}ms")
    with open(os.path.join(args.dir, "summary.json"), "w") as handle:
        json.dump({f"{run}|{session}": item for (run, session), item in summary.items()}, handle, indent=1, ensure_ascii=False)


main()
