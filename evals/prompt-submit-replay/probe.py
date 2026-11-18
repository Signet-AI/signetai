import argparse
import json
import os
import re
import sys
import urllib.request

PROVENANCE = re.compile(r"\[([^\[\]\n]{0,80}\bprovenance)\][\s\S]*?\[/\1\]", re.I)

parser = argparse.ArgumentParser(description="Record direct recall candidates for every replayed turn.")
parser.add_argument("run")
parser.add_argument("port")
parser.add_argument("--dir", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "runs"))
parser.add_argument("--agent-id", default="default")
args = parser.parse_args()

with open(os.path.join(args.dir, "transcripts.json")) as handle:
    transcripts = json.load(handle)
with open(os.path.join(args.dir, f"candidates-{args.run}.jsonl"), "w") as output:
    for session, item in transcripts.items():
        for index, turn in enumerate(item["turns"], 1):
            query = PROVENANCE.sub("", turn).strip()
            body = json.dumps({"query": query, "agentId": args.agent_id, "limit": 5}).encode()
            request = urllib.request.Request(
                f"http://127.0.0.1:{args.port}/api/memory/recall",
                data=body,
                headers={"content-type": "application/json"},
            )
            with urllib.request.urlopen(request, timeout=120) as response:
                data = json.loads(response.read())
            top = [
                {"score": round(row["score"], 3), "id": row["id"], "content": row["content"][:140]}
                for row in data["results"]
            ]
            row = {
                "session": session,
                "turn": index,
                "query": query[:160],
                "totalMs": round(data["meta"]["timings"]["totalMs"]),
                "top": top,
            }
            output.write(json.dumps(row, ensure_ascii=False) + "\n")
print("candidates probed", file=sys.stderr)
